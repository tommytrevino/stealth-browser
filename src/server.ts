import express, { Request, Response } from 'express';
import { Camoufox } from 'camoufox-js';

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

/**
 * Scrapes photos from Zillow or Redfin URL using Camoufox.
 */
async function scrapePhotos(url: string): Promise<string[]> {
  console.log(`[Scraper] Launching Camoufox for URL: ${url}`);
  const browser = await Camoufox(LAUNCH_OPTIONS);

  try {
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

    console.log(`[Scraper] Successfully extracted ${cleaned.length} photos.`);
    return cleaned;
  } finally {
    console.log(`[Scraper] Closing Camoufox browser.`);
    await browser.close();
  }
}

// Simple lock queue to prevent concurrent browser launches (saves memory)
let activePromise: Promise<any> = Promise.resolve();

async function scrapeQueue(url: string): Promise<string[]> {
  const currentPromise = activePromise;
  
  // Create a new promise that resolves after the current scrape is completed
  let resolveNext: (value: any) => void = () => {};
  activePromise = new Promise((resolve) => {
    resolveNext = resolve;
  });

  try {
    // Wait for the previous scrape to finish
    await currentPromise;
    return await scrapePhotos(url);
  } finally {
    resolveNext(null);
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
    const photos = await scrapeQueue(url);
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
