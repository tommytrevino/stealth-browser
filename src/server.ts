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

class TargetBlockedError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'TargetBlockedError';
  }
}

interface ScrapeRecord {
  timestamp: number;
  target: string;
  success: boolean;
  blocked: boolean;
}

interface TargetStats {
  attempts: number;
  successes: number;
  blocks: number;
}

// Global rolling history array (last 24 hours)
const scrapeHistory: ScrapeRecord[] = [];
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24-hour rolling window

function getUrlTarget(url: string): string {
  const lowercase = url.toLowerCase();
  if (lowercase.includes('redfin.com')) return 'redfin';
  if (lowercase.includes('zillow.com')) return 'zillow';
  if (lowercase.includes('realtor.com')) return 'realtor';
  return 'other';
}

function recordScrapeResult(url: string, success: boolean, blocked: boolean) {
  const target = getUrlTarget(url);
  scrapeHistory.push({
    timestamp: Date.now(),
    target,
    success,
    blocked,
  });
  pruneHistory();
}

function pruneHistory() {
  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  while (scrapeHistory.length > 0 && scrapeHistory[0].timestamp < cutoff) {
    scrapeHistory.shift();
  }
}

function getRollingStats(): Record<string, TargetStats> {
  pruneHistory();
  const rolling: Record<string, TargetStats> = {
    redfin: { attempts: 0, successes: 0, blocks: 0 },
    zillow: { attempts: 0, successes: 0, blocks: 0 },
    realtor: { attempts: 0, successes: 0, blocks: 0 },
    other: { attempts: 0, successes: 0, blocks: 0 },
  };

  for (const entry of scrapeHistory) {
    rolling[entry.target].attempts++;
    if (entry.success) rolling[entry.target].successes++;
    if (entry.blocked) rolling[entry.target].blocks++;
  }

  return rolling;
}

function deriveStatus(): string {
  pruneHistory();
  if (scrapeHistory.length === 0) return 'ok';

  const rolling = getRollingStats();
  const targets = Object.keys(rolling).filter((t) => rolling[t].attempts > 0);
  const totalSuccesses = targets.reduce((sum, t) => sum + rolling[t].successes, 0);

  if (totalSuccesses === 0) {
    return 'down'; // Completely down (zero successes across all recent attempts)
  }

  let degraded = false;
  for (const t of targets) {
    // If a specific target has at least 3 attempts but 0 successes, the service is degraded
    if (rolling[t].attempts >= 3 && rolling[t].successes === 0) {
      degraded = true;
    }
  }

  return degraded ? 'degraded' : 'ok';
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

function getLaunchOptionsForAttempt(attempt: number): Record<string, any> {
  const options = JSON.parse(JSON.stringify(LAUNCH_OPTIONS));
  if (options.proxy && options.proxy.username) {
    const baseUsername = options.proxy.username;
    // Strip any existing session/id suffixes to prevent build-up
    const cleanUsername = baseUsername.replace(/-session-[\w]+/g, '').replace(/-id-[\w]+/g, '');
    
    // Webshare does NOT support username session suffixes (it breaks auth).
    // Only apply session randomizers for providers like Bright Data, Oxylabs, Smartproxy, etc.
    if (options.proxy.server.includes('webshare')) {
      options.proxy.username = cleanUsername;
    } else {
      const randomId = Math.random().toString(36).substring(2, 10);
      options.proxy.username = `${cleanUsername}-session-${randomId}`;
      console.log(`[Scraper] Attempt ${attempt}: Rotating proxy session username to ${options.proxy.username}`);
    }
  }
  return options;
}

async function scrapePhotosAttempt(url: string, attempt: number, options: Record<string, any>): Promise<string[]> {
  // Layer 1: Try standalone HTTP GET request first (requires 0 browser process launch overhead!)
  try {
    console.log(`[Scraper] Attempt ${attempt}: Standalone HTTP GET for URL: ${url}`);
    const requestContext = await request.newContext({
      proxy: options.proxy,
      extraHTTPHeaders: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    });

    const response = await requestContext.get(url, { timeout: 8000 });
    const status = response.status();
    console.log(`[Scraper] Attempt ${attempt}: Standalone HTTP GET response status: ${status}`);

    if (status === 200) {
      const html = await response.text();
      
      if (isCaptchaOrBlockPage(html)) {
        console.log(`[Scraper] Attempt ${attempt}: Standalone HTTP GET hit a Captcha/Block page.`);
        await requestContext.dispose();
      } else {
        const photos = extractPhotosFromHtml(html);
        await requestContext.dispose();
        if (photos.length > 0) {
          console.log(`[Scraper] Attempt ${attempt}: Standalone HTTP GET successful. Extracted ${photos.length} photos.`);
          return photos;
        }
      }
    } else {
      await requestContext.dispose();
    }
  } catch (err) {
    console.warn(`[Scraper] Attempt ${attempt}: Standalone HTTP GET failed: ${(err as Error).message}`);
  }

  // Layer 2: Launch browser & try browser-context request (inherits Camoufox TLS signatures)
  console.log(`[Scraper] Attempt ${attempt}: Entering browser queue for URL: ${url}`);
  await browserSemaphore.acquire();

  try {
    console.log(`[Scraper] Attempt ${attempt}: Launching Camoufox browser for URL: ${url}`);
    const browser = await Camoufox(options);

    try {
      try {
        console.log(`[Scraper] Attempt ${attempt}: Attempting browser-context HTTP GET...`);
        const context = await browser.newContext();
        
        const response = await context.request.get(url, { timeout: 10000 });
        const status = response.status();
        console.log(`[Scraper] Attempt ${attempt}: Browser-context HTTP GET response status: ${status}`);

        if (status === 200) {
          const html = await response.text();
          
          if (isCaptchaOrBlockPage(html)) {
            throw new TargetBlockedError(429, 'Target page returned HTTP status 429');
          }

          const photos = extractPhotosFromHtml(html);
          await context.close();

          if (photos.length > 0) {
            console.log(`[Scraper] Attempt ${attempt}: Browser-context HTTP GET successful. Extracted ${photos.length} photos.`);
            return photos;
          }
        } else if (status === 403 || status === 429 || status === 503) {
          throw new TargetBlockedError(status, `Target page returned HTTP status ${status}`);
        } else {
          await context.close();
        }
      } catch (err) {
        if (err instanceof TargetBlockedError) throw err;
        console.warn(`[Scraper] Attempt ${attempt}: Browser-context HTTP GET failed or blocked: ${(err as Error).message}`);
      }

      // Layer 3: Fallback to full browser page loading and rendering
      console.log(`[Scraper] Attempt ${attempt}: Opening page tab for rendering...`);
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
      console.log(`[Scraper] Attempt ${attempt}: Navigating to page...`);
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const status = response?.status() ?? 0;
      if (status >= 400) {
        throw new TargetBlockedError(status, `Target page returned HTTP status ${status}`);
      }

      const html = await page.content();
      if (isCaptchaOrBlockPage(html)) {
        throw new TargetBlockedError(429, 'Target page returned HTTP status 429');
      }

      // Wait a brief moment to ensure dynamic images begin loading
      await page.waitForTimeout(1000);

      console.log(`[Scraper] Attempt ${attempt}: Extracting page content...`);
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
        throw new TargetBlockedError(429, 'Target page returned HTTP status 429');
      }

      console.log(`[Scraper] Attempt ${attempt}: Successfully extracted ${cleaned.length} photos.`);
      return cleaned;
    } finally {
      console.log(`[Scraper] Attempt ${attempt}: Closing Camoufox browser.`);
      await browser.close();
    }
  } finally {
    browserSemaphore.release();
    console.log(`[Scraper] Attempt ${attempt}: Released browser queue for URL: ${url}`);
  }
}

/**
 * Scrapes photos from Zillow or Redfin URL using Camoufox with automatic retries and proxy session rotation.
 */
async function scrapePhotos(url: string): Promise<string[]> {
  const maxAttempts = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const options = getLaunchOptionsForAttempt(attempt);
    try {
      const photos = await scrapePhotosAttempt(url, attempt, options);
      recordScrapeResult(url, true, false);
      return photos;
    } catch (error) {
      if (error instanceof TargetBlockedError) {
        console.warn(`[Scraper] Attempt ${attempt}/${maxAttempts} blocked by target page: ${error.message}. Retrying with fresh proxy session...`);
        recordScrapeResult(url, false, true);
        lastError = error;
        // Wait a brief moment before retrying (exponential backoff)
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      } else {
        // Fatal browser or initialization error — throw immediately
        recordScrapeResult(url, false, false);
        throw error;
      }
    }
  }

  throw lastError || new Error('Scraping failed after max retries');
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

    if (error instanceof TargetBlockedError) {
      res.statusMessage = error.message;
      res.status(error.status).json({
        error: error.message,
        reason: 'target_blocked',
        status: error.status
      });
    } else {
      res.status(500).json({
        error: (error as Error).message,
        reason: 'resolver_error'
      });
    }
  }
});

// Health check with dynamic status and rolling statistics
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: deriveStatus(),
    uptime: process.uptime(),
    stats: getRollingStats(),
  });
});

app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`Stealth Scraper Server running on port ${PORT}`);
});
