import express, { Request, Response } from 'express';
import { Camoufox } from 'camoufox-js';
import { request } from 'playwright-core';

const app = express();
app.use(express.json());

const PORT = 9377;
const ACCESS_KEY = process.env.PHOTO_RESOLVER_TOKEN || process.env.CAMOFOX_ACCESS_KEY;

// Browser launch options
const LAUNCH_OPTIONS: Record<string, any> = {
  headless: true,
  geoip: true,
  firefoxUserPrefs: {
    'security.sandbox.content.level': 0,
    'security.sandbox.plugin.level': 0,
    'security.sandbox.level': 0,
    'webgl.disabled': true,
    'layers.acceleration.disabled': true,
    'gfx.webrender.software': true,
  },
};

// Configure proxy support if PROXY_URL is defined (crucial for scaling to 1000s of users)
if (process.env.PROXY_URL) {
  try {
    const proxyUrl = new URL(process.env.PROXY_URL);
    LAUNCH_OPTIONS.proxy = {
      server: `${proxyUrl.protocol}//${proxyUrl.host}`,
    };
    if (proxyUrl.username) {
      LAUNCH_OPTIONS.proxy.username = decodeURIComponent(proxyUrl.username);
    }
    if (proxyUrl.password) {
      LAUNCH_OPTIONS.proxy.password = decodeURIComponent(proxyUrl.password);
    }
    console.log(`[Scraper] Stealth proxy loaded: ${LAUNCH_OPTIONS.proxy.server}`);
  } catch (error) {
    console.error(`[Scraper] Failed to parse PROXY_URL environment variable:`, error);
  }
}

class Semaphore {
  private activeCount = 0;
  private queue: (() => void)[] = [];

  constructor(private maxConcurrency: number) {}

  async acquire(): Promise<void> {
    if (this.activeCount < this.maxConcurrency) {
      this.activeCount++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.activeCount--;
    const next = this.queue.shift();
    if (next) {
      this.activeCount++;
      next();
    }
  }
}

// Guarantee maximum 3 browser instances at once to stay safe on resource usage
const browserSemaphore = new Semaphore(3);

function extractPhotosFromHtml(html: string): string[] {
  // Normalize escaped slashes (\/) in JSON strings to standard slashes (/) first
  const normalizedHtml = html.replace(/\\\//g, '/');
  
  const redfinMatches = normalizedHtml.match(/https:\/\/ssl\.cdn-redfin\.com\/photo\/[^\s"'>\\,;`]+/g) || [];
  const zillowMatches = normalizedHtml.match(/https:\/\/photos\.zillowstatic\.com\/fp\/[^\s"'>\\,;`]+/g) || [];
  const realtorMatches = normalizedHtml.match(/https:\/\/[a-z0-9-.]+\.rdcpix\.com\/[^\s"'>\\,;`]+/g) || [];

  const photos = [...redfinMatches, ...zillowMatches, ...realtorMatches];

  // Clean, de-duplicate, and filter out tracking pixels
  return Array.from(new Set(photos)).filter(
    (p) => !p.includes('pixel') && !p.includes('tracking')
  );
}

function isCaptchaOrBlockPage(html: string): boolean {
  const lowercase = html.toLowerCase();
  return (
    lowercase.includes('px-captcha') ||
    lowercase.includes('perimeterx') ||
    lowercase.includes('g-recaptcha') ||
    lowercase.includes('h-captcha') ||
    lowercase.includes('sec-cpt') ||
    lowercase.includes('captcha-container') ||
    (lowercase.includes('access denied') && lowercase.includes('reference #')) ||
    lowercase.includes('unusual traffic from your computer network')
  );
}

/**
 * Scrapes photos from Zillow or Redfin URL using Camoufox.
 */
async function scrapePhotos(url: string): Promise<string[]> {
  // Layer 1: Try standalone HTTP GET request first (requires 0 browser process launch overhead!)
  try {
    console.log(`[Scraper] Attempting standalone HTTP GET for URL: ${url}`);
    const requestContext = await request.newContext({
      proxy: LAUNCH_OPTIONS.proxy,
      extraHTTPHeaders: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    });

    const response = await requestContext.get(url, { timeout: 8000 });
    const status = response.status();
    console.log(`[Scraper] Standalone HTTP GET response status: ${status}`);

    if (status === 200) {
      const html = await response.text();
      
      if (isCaptchaOrBlockPage(html)) {
        console.log(`[Scraper] Standalone HTTP GET hit a Captcha/Block page.`);
        await requestContext.dispose();
      } else {
        const photos = extractPhotosFromHtml(html);
        await requestContext.dispose();
        if (photos.length > 0) {
          console.log(`[Scraper] Standalone HTTP GET successful. Extracted ${photos.length} photos.`);
          return photos;
        }
      }
    } else {
      await requestContext.dispose();
    }
  } catch (err) {
    console.warn(`[Scraper] Standalone HTTP GET failed: ${(err as Error).message}`);
  }

  // Layer 2: Launch browser & try browser-context request (inherits Camoufox TLS signatures)
  console.log(`[Scraper] Entering browser queue for URL: ${url}`);
  await browserSemaphore.acquire();

  try {
    console.log(`[Scraper] Launching Camoufox browser for URL: ${url}`);
    const browser = await Camoufox(LAUNCH_OPTIONS);

    try {
      try {
        console.log(`[Scraper] Attempting browser-context HTTP GET...`);
        const context = await browser.newContext();
        
        const response = await context.request.get(url, { timeout: 10000 });
        const status = response.status();
        console.log(`[Scraper] Browser-context HTTP GET response status: ${status}`);

        if (status === 200) {
          const html = await response.text();
          
          if (isCaptchaOrBlockPage(html)) {
            throw new Error('Blocked by bot shield / captcha');
          }

          const photos = extractPhotosFromHtml(html);
          await context.close();

          if (photos.length > 0) {
            console.log(`[Scraper] Browser-context HTTP GET successful. Extracted ${photos.length} photos.`);
            return photos;
          }
        } else if (status === 403 || status === 429 || status === 503) {
          throw new Error(`Target page returned HTTP block status ${status}`);
        } else {
          await context.close();
        }
      } catch (err) {
        console.warn(`[Scraper] Browser-context HTTP GET failed or blocked: ${(err as Error).message}`);
      }

      // Layer 3: Fallback to full browser page loading and rendering
      console.log(`[Scraper] Opening page tab for rendering...`);
      const page = await browser.newPage();

      // Block heavy resources (images, stylesheets, fonts, media) to save memory and bandwidth
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'stylesheet', 'media', 'font'].includes(type)) {
          route.abort();
        } else {
          route.continue();
        }
      });

      // Navigate to listing page (with 15s timeout)
      console.log(`[Scraper] Navigating to page...`);
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const status = response?.status() ?? 0;
      if (status >= 400) {
        throw new Error(`Target page returned HTTP status ${status}`);
      }

      const html = await page.content();
      if (isCaptchaOrBlockPage(html)) {
        throw new Error('Blocked by bot shield / captcha page during render');
      }

      // Wait a brief moment to ensure dynamic images begin loading
      await page.waitForTimeout(1000);

      console.log(`[Scraper] Extracting page content...`);
      const result = await page.evaluate(() => {
        // 1. Gather all raw script text contents (includes JSON-LD, __NEXT_DATA__, Redfin state, etc.)
        const scriptTexts = Array.from(document.querySelectorAll('script'))
          .map((s) => s.textContent || '');

        // 2. Gather standard image elements
        const imgs = Array.from(document.images).map((img: HTMLImageElement) => img.src);

        return { scriptTexts, imgs };
      });

      const photos: string[] = [];

      if (result) {
        // 1. Search text contents of all script tags using regex patterns for CDN URLs
        // Normalize escaped slashes (\/) in JSON strings to standard slashes (/) first
        const fullText = result.scriptTexts.join('\n').replace(/\\\//g, '/');
        
        const redfinMatches = fullText.match(/https:\/\/ssl\.cdn-redfin\.com\/photo\/[^\s"'>\\,;`]+/g) || [];
        const zillowMatches = fullText.match(/https:\/\/photos\.zillowstatic\.com\/fp\/[^\s"'>\\,;`]+/g) || [];
        const realtorMatches = fullText.match(/https:\/\/[a-z0-9-.]+\.rdcpix\.com\/[^\s"'>\\,;`]+/g) || [];

        photos.push(...redfinMatches, ...zillowMatches, ...realtorMatches);

        // 2. Search standard image elements
        result.imgs.forEach((src: string) => {
          if (!src) return;
          if (src.includes('ssl.cdn-redfin.com') || src.includes('photos.zillowstatic.com') || src.includes('rdcpix.com')) {
            photos.push(src);
          }
        });
      }

      // Clean, de-duplicate, and filter out tracking pixels
      const cleaned = Array.from(new Set(photos)).filter(
        p => !p.includes('pixel') && !p.includes('tracking')
      );

      if (cleaned.length === 0) {
        throw new Error('No photos extracted from listing page (likely blocked or empty)');
      }

      console.log(`[Scraper] Successfully extracted ${cleaned.length} photos.`);
      return cleaned;
    } finally {
      console.log(`[Scraper] Closing Camoufox browser.`);
      await browser.close();
    }
  } finally {
    browserSemaphore.release();
    console.log(`[Scraper] Released browser queue for URL: ${url}`);
  }
}

// Scrape API endpoint
app.post('/scrape', async (req: Request, res: Response) => {
  // Simple Authorization header check
  if (ACCESS_KEY) {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${ACCESS_KEY}`) {
      console.warn(`[Scraper] Unauthorized access attempt blocked.`);
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'Missing parameter "url" in request body.' });
  }

  try {
    const photos = await scrapePhotos(url);
    res.json({ photos });
  } catch (error) {
    console.error(`[Scraper] Scrape failed for ${url}:`, error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`Stealth Scraper Server running on port ${PORT}`);
});
