import express, { Request, Response } from 'express';
import { Camoufox } from 'camoufox-js';

const app = express();
app.use(express.json());

const PORT = 9377;
const ACCESS_KEY = process.env.PHOTO_RESOLVER_TOKEN || process.env.CAMOFOX_ACCESS_KEY;

// Browser launch options
const LAUNCH_OPTIONS: Record<string, any> = {
  headless: true,
  firefoxUserPrefs: {
    'security.sandbox.content.level': 0,
    'security.sandbox.plugin.level': 0,
    'security.sandbox.level': 0,
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

    // Navigate to listing page (with 15s timeout)
    console.log(`[Scraper] Navigating to page...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Wait a brief moment to ensure dynamic images begin loading
    await page.waitForTimeout(1000);

    console.log(`[Scraper] Extracting page content...`);
    // Extract image elements and schema data
    const result = await page.evaluate(() => {
      // Find URLs in all standard image elements
      const imgs = Array.from(document.images).map((img: HTMLImageElement) => img.src);

      // Find URLs hidden inside JSON-LD scripts
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
        .map((s: Element) => {
          try {
            return JSON.parse(s.textContent || '');
          } catch {
            return null;
          }
        });

      return { imgs, scripts };
    });

    const photos: string[] = [];

    if (result) {
      // Recursively search nested schema JSON objects for Redfin or Zillow CDN links
      const searchForImages = (obj: any) => {
        if (!obj) return;
        if (typeof obj === 'string') {
          const isListingImage = 
            (obj.includes('cdn-redfin.com') || obj.includes('zillowstatic.com')) &&
            (obj.endsWith('.jpg') || obj.endsWith('.jpeg') || obj.endsWith('.png') || obj.includes('width=') || obj.includes('height='));
            
          if (isListingImage) {
            photos.push(obj);
          }
        } else if (Array.isArray(obj)) {
          obj.forEach(searchForImages);
        } else if (typeof obj === 'object') {
          Object.values(obj).forEach(searchForImages);
        }
      };

      if (result.scripts) {
        result.scripts.forEach(searchForImages);
      }

      if (result.imgs) {
        result.imgs.forEach((src: string) => {
          if (!src) return;
          if (src.includes('ssl.cdn-redfin.com') || src.includes('photos.zillowstatic.com')) {
            photos.push(src);
          }
        });
      }
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
