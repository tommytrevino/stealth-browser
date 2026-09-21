import express, { Request, Response } from 'express';
import { Camoufox } from 'camoufox-js';
import { request } from 'playwright-core';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 9377;
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

const BRIGHTDATA_API_KEY = process.env.BRIGHTDATA_API_KEY;
const BRIGHTDATA_ZONE = process.env.BRIGHTDATA_ZONE || 'web_unlocker1';

class TargetBlockedError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'TargetBlockedError';
  }
}

class CircuitOpenError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'CircuitOpenError';
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

interface TargetState {
  circuit: 'closed' | 'open' | 'half-open';
  lastStateChange: number;
  consecutiveBlocks: number;
  lastProbeAt: number | null;
}

// Global rolling history array (last 24 hours)
const scrapeHistory: ScrapeRecord[] = [];
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24-hour rolling window

const targetStates: Record<string, TargetState> = {
  redfin: { circuit: 'closed', lastStateChange: Date.now(), consecutiveBlocks: 0, lastProbeAt: null },
  zillow: { circuit: 'closed', lastStateChange: Date.now(), consecutiveBlocks: 0, lastProbeAt: null },
  realtor: { circuit: 'closed', lastStateChange: Date.now(), consecutiveBlocks: 0, lastProbeAt: null },
  homes: { circuit: 'closed', lastStateChange: Date.now(), consecutiveBlocks: 0, lastProbeAt: null },
  other: { circuit: 'closed', lastStateChange: Date.now(), consecutiveBlocks: 0, lastProbeAt: null },
};

const CIRCUIT_OPEN_DURATION_MS = 45 * 1000; // 45 seconds in Open state before testing Half-Open
const BLOCK_THRESHOLD = 5; // 5 consecutive real target blocks opens the circuit

function isTargetBlockResponse(error: any): boolean {
  if (error instanceof TargetBlockedError) {
    const msg = error.message.toLowerCase();
    // Exclude self-inflicted timeouts or queue wait errors from circuit breaker block count
    if (msg.includes('ceiling') || msg.includes('queue') || msg.includes('timed out')) {
      return false;
    }
    return true;
  }
  return false;
}

function getUrlTarget(url: string): string {
  const lowercase = url.toLowerCase();
  if (lowercase.includes('redfin.com')) return 'redfin';
  if (lowercase.includes('zillow.com')) return 'zillow';
  if (lowercase.includes('realtor.com')) return 'realtor';
  if (lowercase.includes('homes.com')) return 'homes';
  return 'other';
}

function updateCircuitOnSuccess(target: string) {
  const state = targetStates[target];
  state.consecutiveBlocks = 0;
  if (state.circuit !== 'closed') {
    console.log(`[Circuit Breaker] ${target} is recovered! Closing circuit.`);
    state.circuit = 'closed';
    state.lastStateChange = Date.now();
  }
}

function updateCircuitOnBlock(target: string) {
  const state = targetStates[target];
  state.consecutiveBlocks++;
  if (state.circuit === 'closed' && state.consecutiveBlocks >= BLOCK_THRESHOLD) {
    console.warn(`[Circuit Breaker] ${target} hit ${state.consecutiveBlocks} consecutive real blocks. Opening circuit.`);
    state.circuit = 'open';
    state.lastStateChange = Date.now();
  } else if (state.circuit === 'half-open') {
    console.warn(`[Circuit Breaker] ${target} probe failed in half-open state. Re-opening circuit.`);
    state.circuit = 'open';
    state.lastStateChange = Date.now();
  }
}

function checkCircuit(target: string): 'closed' | 'open' | 'half-open' {
  const state = targetStates[target];
  if (state.circuit === 'open') {
    const elapsed = Date.now() - state.lastStateChange;
    if (elapsed >= CIRCUIT_OPEN_DURATION_MS) {
      console.log(`[Circuit Breaker] ${target} open duration expired. Moving to half-open to probe.`);
      state.circuit = 'half-open';
      state.lastStateChange = Date.now();
      state.lastProbeAt = Date.now();
    }
  }
  return state.circuit;
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
    homes: { attempts: 0, successes: 0, blocks: 0 },
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

// Guarantee maximum 3 browser instances at once, and cap Redfin concurrency at 1 with pacing
const browserSemaphore = new Semaphore(3);
const redfinSemaphore = new Semaphore(1);

let lastRedfinLaunchTime = 0;
const REDFIN_MIN_LAUNCH_INTERVAL_MS = 2500; // 2.5s launch interval pacing for Redfin only

async function paceRedfinRequest(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRedfinLaunchTime;
  if (elapsed < REDFIN_MIN_LAUNCH_INTERVAL_MS) {
    const delay = REDFIN_MIN_LAUNCH_INTERVAL_MS - elapsed;
    console.log(`[Scraper] Pacing Redfin request: waiting ${delay}ms to maintain ${REDFIN_MIN_LAUNCH_INTERVAL_MS / 1000}s launch interval...`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  lastRedfinLaunchTime = Date.now();
}

function findPhotosDeep(obj: any): any[] {
  if (!obj || typeof obj !== 'object') return [];
  
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findPhotosDeep(item);
      if (found.length > 0) return found;
    }
  } else {
    if (typeof obj.href === 'string' && obj.href.includes('rdcpix.com')) {
      return [obj];
    }
    for (const key of Object.keys(obj)) {
      if (key === 'photos' && Array.isArray(obj[key])) {
        const first = obj[key][0];
        if (first && (first.href || first.url)) {
          return obj[key];
        }
      }
      const found = findPhotosDeep(obj[key]);
      if (found.length > 0) return found;
    }
  }
  return [];
}

function extractRealtorPhotos(html: string): string[] {
  const allMatches = html.match(/https:\/\/[a-z0-9-.]+\.rdcpix\.com\/[^\s"'>\\,;`]+/g) || [];
  const uniqueMatches = Array.from(new Set(allMatches));

  let subjectKeys: string[] = [];
  try {
    const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (nextMatch) {
      const parsed = JSON.parse(nextMatch[1]);
      const details = parsed?.props?.pageProps?.initialReduxState?.propertyDetails;
      let rawPhotos: any[] = [];
      if (details) {
        if (Array.isArray(details.photos)) {
          rawPhotos = details.photos;
        } else if (Array.isArray(details.augmented_gallery)) {
          const allPhotos = details.augmented_gallery.find((g: any) => g.key === 'all_photos');
          if (allPhotos && Array.isArray(allPhotos.photos)) {
            rawPhotos = allPhotos.photos;
          }
        }
      }

      if (rawPhotos.length === 0) {
        rawPhotos = findPhotosDeep(parsed);
      }

      for (const p of rawPhotos) {
        const href = p?.href || p?.url;
        if (typeof href === 'string' && href.includes('rdcpix.com')) {
          const keyMatch = href.match(/\/([a-f0-9]{32})/i);
          if (keyMatch) {
            subjectKeys.push(keyMatch[1]);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[Scraper] Failed to parse __NEXT_DATA__ for Realtor:', (err as Error).message);
  }

  if (subjectKeys.length === 0) {
    console.warn('[Scraper] Could not isolate Realtor subject property keys. Discarding to prevent wrong gallery.');
    return [];
  }

  // Filter unique matches to only keep URLs that contain one of the subject keys
  const subjectUrls = uniqueMatches.filter((url) => {
    return subjectKeys.some((key) => url.toLowerCase().includes(key.toLowerCase()));
  });

  // Group by unique photo index to select the best resolution
  const photoGroups: Record<string, string[]> = {};
  for (const url of subjectUrls) {
    const baseMatch = url.match(/\/([a-f0-9]{32}l-m\d+)/i);
    if (baseMatch) {
      const baseKey = baseMatch[1];
      if (!photoGroups[baseKey]) {
        photoGroups[baseKey] = [];
      }
      photoGroups[baseKey].push(url);
    }
  }

  const bestUrls: string[] = [];
  for (const baseKey of Object.keys(photoGroups)) {
    const urls = photoGroups[baseKey];
    
    // Choose the best resolution url in order of preference
    const best = 
      urls.find(u => u.includes('rd-w1280_h960.webp')) ||
      urls.find(u => u.includes('rd-w960_h720.webp')) ||
      urls.find(u => u.includes('od-w640_h480.jpg')) ||
      urls.find(u => u.includes('rd-w480_h360.webp')) ||
      urls[0]; // fallback
      
    // Automatically rewrite the URL to the high-resolution rd-w1280_h960.webp format
    let formattedBest = best;
    if (!best.includes('rd-w1280_h960.webp')) {
      formattedBest = best.replace(/([a-f0-9]{32}l-m\d+)(?:[^\/]*)$/i, '$1rd-w1280_h960.webp');
    }
    bestUrls.push(formattedBest);
  }

  return bestUrls;
}

function extractPhotosFromHtml(html: string): string[] {
  // Normalize escaped slashes (\/) in JSON strings to standard slashes (/) first
  const normalizedHtml = html.replace(/\\\//g, '/');
  
  const redfinMatches = normalizedHtml.match(/https:\/\/ssl\.cdn-redfin\.com\/photo\/[^\s"'>\\,;`]+/g) || [];
  const zillowMatches = normalizedHtml.match(/https:\/\/photos\.zillowstatic\.com\/fp\/[^\s"'>\\,;`]+/g) || [];
  const homesMatches = normalizedHtml.match(/https:\/\/[a-z0-9-.]*homes\.com\/[^\s"'>\\,;`]+/g) || [];
  
  let realtorMatches: string[] = [];
  if (normalizedHtml.includes('rdcpix.com')) {
    realtorMatches = extractRealtorPhotos(normalizedHtml);
  }

  const photos = [...redfinMatches, ...zillowMatches, ...homesMatches, ...realtorMatches];

  // Clean, de-duplicate, and filter out tracking pixels
  return Array.from(new Set(photos)).filter(
    (p) => !p.includes('pixel') && !p.includes('tracking')
  );
}

function isCaptchaOrBlockPage(html: string): boolean {
  const lowercase = html.toLowerCase();
  return (
    lowercase.includes('px-captcha') ||
    lowercase.includes('g-recaptcha') ||
    lowercase.includes('h-captcha') ||
    lowercase.includes('sec-cpt') ||
    lowercase.includes('captcha-container') ||
    lowercase.includes('pardon our interruption') ||
    lowercase.includes('robot or human') ||
    lowercase.includes('verify you are human') ||
    lowercase.includes('access denied') ||
    lowercase.includes('unusual traffic') ||
    lowercase.includes('405 method not allowed') ||
    lowercase.includes('405 forbidden')
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
      const randomId = `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
      options.proxy.username = `${cleanUsername}-session-${randomId}`;
      console.log(`[Scraper] Attempt ${attempt}: Rotating proxy session username to ${options.proxy.username}`);
    }
  }
  return options;
}

export interface SaleHistoryEntry {
  date: string;
  event: string;
  price: number | null;
  source: string | null;
}

export interface ScrapeResult {
  photos: string[];
  daysOnMarket: number | null;
  listPrice: number | null;
  saleHistory: SaleHistoryEntry[];
}

function extractRedfinMetadata(html: string): {
  daysOnMarket: number | null;
  listPrice: number | null;
  saleHistory: SaleHistoryEntry[];
} {
  let daysOnMarket: number | null = null;
  let listPrice: number | null = null;
  const saleHistory: SaleHistoryEntry[] = [];

  try {
    // 1. Days On Market
    const domMatch1 = html.match(/Days\s+On\s+Market:\s*(\d+)/i);
    if (domMatch1) {
      daysOnMarket = parseInt(domMatch1[1], 10);
    } else {
      const domMatch2 = html.match(/"amenityName":"Days On Market".*?"amenityValues":\["(\d+)"\]/i);
      if (domMatch2) {
        daysOnMarket = parseInt(domMatch2[1], 10);
      } else {
        const domMatch3 = html.match(/<li[^>]*>\s*Days On Market\s*:\s*(\d+)\s*<\/li>/i);
        if (domMatch3) {
          daysOnMarket = parseInt(domMatch3[1], 10);
        }
      }
    }

    // 2. Sale History
    const tableIdx = html.indexOf('PropertyHistoryEventTable');
    if (tableIdx !== -1) {
      const tableHtml = html.substring(tableIdx, tableIdx + 30000);
      const rowRegex = /<div class="BasicTable__row([^"]*)"[^>]*>([\s\S]*?)<\/div>(?=<div class="BasicTable__row|<div class="ExpandablePreview|$)/g;
      let currentSource: string | null = null;
      let match: RegExpExecArray | null;

      while ((match = rowRegex.exec(tableHtml)) !== null) {
        const rowClasses = match[1];
        const rowContent = match[2];

        if (rowClasses.includes('mlsAttr')) {
          const subtextMatch = rowContent.match(/<div class="subtext">([\s\S]*?)<\/div>/i);
          if (subtextMatch) {
            currentSource = subtextMatch[1].replace(/<[^>]+>/g, '').trim() || null;
          }
        } else if (!rowClasses.includes('BasicTable__headerRow')) {
          const dateMatch = rowContent.match(/<div class="BasicTable__col date">([\s\S]*?)<\/div>/i);
          const eventMatch = rowContent.match(/<div class="BasicTable__col event">([\s\S]*?)<\/div>/i);
          const priceMatch = rowContent.match(/<div class="BasicTable__col price">([\s\S]*?)<\/div>/i);

          if (dateMatch && eventMatch) {
            const date = dateMatch[1].replace(/<[^>]+>/g, '').trim();
            const eventText = eventMatch[1].replace(/<[^>]+>/g, '').trim();

            let price: number | null = null;
            if (priceMatch) {
              let priceCell = priceMatch[1].replace(/<p class="subtext">[\s\S]*?<\/p>/gi, '');
              priceCell = priceCell.replace(/<[^>]+>/g, '').trim();
              const digits = priceCell.replace(/[^0-9]/g, '');
              if (digits.length > 0) {
                price = parseInt(digits, 10);
              }
            }

            if (date && eventText) {
              saleHistory.push({
                date,
                event: eventText,
                price,
                source: currentSource
              });
            }
          }
        }
      }
    }

    // 3. List Price (price on the most recent row whose event is "Listed")
    const listedEntry = saleHistory.find(e => e.event.toLowerCase() === 'listed' && e.price !== null);
    if (listedEntry) {
      listPrice = listedEntry.price;
    }
  } catch (err) {
    console.warn('[Scraper] Failed to extract Redfin metadata:', (err as Error).message);
  }

  return {
    daysOnMarket,
    listPrice,
    saleHistory
  };
}

async function scrapeWithBrightData(url: string): Promise<ScrapeResult> {
  if (!BRIGHTDATA_API_KEY) {
    throw new Error('BRIGHTDATA_API_KEY is not defined');
  }

  const target = getUrlTarget(url);
  const timeoutMs = target === 'realtor' ? 20000 : 25000;

  console.log(`[Scraper] Querying Bright Data Web Unlocker for URL: ${url} (Timeout: ${timeoutMs / 1000}s)`);
  const response = await fetch('https://api.brightdata.com/request', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${BRIGHTDATA_API_KEY}`
    },
    body: JSON.stringify({
      zone: BRIGHTDATA_ZONE,
      url: url,
      format: 'raw',
      country: 'us'
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[Scraper] Bright Data API returned status ${response.status}: ${errorText}`);
    
    if (response.status === 403 || response.status === 405 || response.status === 429 || response.status === 503) {
      throw new TargetBlockedError(response.status, `Target page returned HTTP status ${response.status}`);
    }
    throw new Error(`Bright Data API request failed with status ${response.status}`);
  }

  const html = await response.text();
  
  if (isCaptchaOrBlockPage(html)) {
    throw new TargetBlockedError(429, 'Target page returned HTTP status 429');
  }

  const photos = extractPhotosFromHtml(html);
  if (photos.length === 0) {
    throw new TargetBlockedError(429, 'Target page returned block page or no content');
  }

  console.log(`[Scraper] Bright Data Web Unlocker successful. Extracted ${photos.length} photos.`);
  const metadata = target === 'redfin' ? extractRedfinMetadata(html) : { daysOnMarket: null, listPrice: null, saleHistory: [] };
  return {
    photos,
    ...metadata
  };
}

async function scrapePhotosAttempt(url: string, attempt: number, options: Record<string, any>): Promise<ScrapeResult> {
  const target = getUrlTarget(url);

  // Route Zillow, Realtor, Homes.com, and Redfin through Bright Data Web Unlocker if configured
  if ((target === 'zillow' || target === 'realtor' || target === 'homes' || target === 'redfin') && BRIGHTDATA_API_KEY) {
    try {
      return await scrapeWithBrightData(url);
    } catch (error) {
      console.warn(`[Scraper] Bright Data Web Unlocker failed for ${url}: ${(error as Error).message}.`);
      if (error instanceof TargetBlockedError) throw error;
    }
  }

  // Layer 1: Try standalone HTTP GET request first
  try {
    console.log(`[Scraper] Attempt ${attempt}: Standalone HTTP GET for URL: ${url}`);
    const requestContext = await request.newContext({
      proxy: options.proxy,
      extraHTTPHeaders: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    const response = await requestContext.get(url, { timeout: 6000 });
    const status = response.status();
    console.log(`[Scraper] Attempt ${attempt}: Standalone HTTP GET response status: ${status}`);

    if (status === 405 || status === 403 || status === 429 || status === 503) {
      await requestContext.dispose();
      throw new TargetBlockedError(status, `Target page returned HTTP status ${status}`);
    }

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
          const metadata = target === 'redfin' ? extractRedfinMetadata(html) : { daysOnMarket: null, listPrice: null, saleHistory: [] };
          return {
            photos,
            ...metadata
          };
        }
      }
    } else {
      await requestContext.dispose();
    }
  } catch (err) {
    if (err instanceof TargetBlockedError) throw err;
    console.warn(`[Scraper] Attempt ${attempt}: Standalone HTTP GET failed: ${(err as Error).message}`);
  }

  // Layer 2: Launch browser & try browser-context request
  console.log(`[Scraper] Attempt ${attempt}: Entering browser queue for URL: ${url}`);
  await browserSemaphore.acquire();

  try {
    console.log(`[Scraper] Attempt ${attempt}: Launching Camoufox browser for URL: ${url}`);
    const browser = await Camoufox(options);

    try {
      try {
        console.log(`[Scraper] Attempt ${attempt}: Attempting browser-context HTTP GET...`);
        const context = await browser.newContext();
        
        const response = await context.request.get(url, { timeout: 8000 });
        const status = response.status();
        console.log(`[Scraper] Attempt ${attempt}: Browser-context HTTP GET response status: ${status}`);

        if (status === 405 || status === 403 || status === 429 || status === 503) {
          await context.close();
          throw new TargetBlockedError(status, `Target page returned HTTP status ${status}`);
        }

        if (status === 200) {
          const html = await response.text();
          
          if (isCaptchaOrBlockPage(html)) {
            await context.close();
            throw new TargetBlockedError(429, 'Target page returned HTTP status 429');
          }

          const photos = extractPhotosFromHtml(html);
          await context.close();

          if (photos.length > 0) {
            console.log(`[Scraper] Attempt ${attempt}: Browser-context HTTP GET successful. Extracted ${photos.length} photos.`);
            const metadata = target === 'redfin' ? extractRedfinMetadata(html) : { daysOnMarket: null, listPrice: null, saleHistory: [] };
            return {
              photos,
              ...metadata
            };
          }
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

      // Navigate to listing page (with 12s timeout)
      console.log(`[Scraper] Attempt ${attempt}: Navigating to page...`);
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
      const status = response?.status() ?? 0;
      if (status === 405 || status === 403 || status === 429 || status === 503 || status >= 400) {
        throw new TargetBlockedError(status >= 400 ? status : 429, `Target page returned HTTP status ${status}`);
      }

      const html = await page.content();
      if (isCaptchaOrBlockPage(html)) {
        throw new TargetBlockedError(429, 'Target page returned HTTP status 429');
      }

      // Wait safely for navigation/rendering to settle
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(500);

      console.log(`[Scraper] Attempt ${attempt}: Extracting page content...`);
      let result: { scriptTexts: string[]; imgs: string[] } | null = null;
      try {
        result = await page.evaluate(() => {
          const scriptTexts = Array.from(document.querySelectorAll('script'))
            .map((s) => s.textContent || '');
          const imgs = Array.from(document.images).map((img: HTMLImageElement) => img.src);
          return { scriptTexts, imgs };
        });
      } catch (evalErr) {
        console.warn(`[Scraper] Attempt ${attempt}: page.evaluate failed (${(evalErr as Error).message}). Extracting directly from html string.`);
      }

      const photos: string[] = [];

      if (result) {
        const fullText = result.scriptTexts.join('\n').replace(/\\\//g, '/');
        
        const redfinMatches = fullText.match(/https:\/\/ssl\.cdn-redfin\.com\/photo\/[^\s"'>\\,;`]+/g) || [];
        const zillowMatches = fullText.match(/https:\/\/photos\.zillowstatic\.com\/fp\/[^\s"'>\\,;`]+/g) || [];
        const realtorMatches = fullText.match(/https:\/\/[a-z0-9-.]+\.rdcpix\.com\/[^\s"'>\\,;`]+/g) || [];

        photos.push(...redfinMatches, ...zillowMatches, ...realtorMatches);

        result.imgs.forEach((src: string) => {
          if (!src) return;
          if (src.includes('ssl.cdn-redfin.com') || src.includes('photos.zillowstatic.com') || src.includes('rdcpix.com')) {
            photos.push(src);
          }
        });
      }

      // Fallback: also run extractPhotosFromHtml on raw html string
      const htmlPhotos = extractPhotosFromHtml(html);
      photos.push(...htmlPhotos);

      // Clean, de-duplicate, and filter out tracking pixels
      const cleaned = Array.from(new Set(photos)).filter(
        p => !p.includes('pixel') && !p.includes('tracking')
      );

      if (cleaned.length === 0) {
        throw new TargetBlockedError(429, 'Target page returned block page or no content');
      }

      console.log(`[Scraper] Attempt ${attempt}: Successfully extracted ${cleaned.length} photos.`);
      const metadata = target === 'redfin' ? extractRedfinMetadata(html) : { daysOnMarket: null, listPrice: null, saleHistory: [] };
      return {
        photos: cleaned,
        ...metadata
      };
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
 * Integrates an internal Circuit Breaker to prevent consecutive dead target latency from blocking requests.
 */
function isBlockOrTimeoutError(error: any): boolean {
  if (error instanceof TargetBlockedError) return true;
  const msg = error?.message?.toLowerCase() || '';
  return (
    error?.name === 'TimeoutError' ||
    error?.name === 'AbortError' ||
    msg.includes('timeout') ||
    msg.includes('abort') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('socket hang up')
  );
}

async function executeScrapeWithRetries(url: string, target: string): Promise<ScrapeResult> {
  const circuit = checkCircuit(target);

  if (circuit === 'open') {
    console.log(`[Circuit Breaker] Skipping request for ${url} (Circuit is OPEN).`);
    recordScrapeResult(url, false, true);
    throw new CircuitOpenError(429, `Target page returned HTTP status 429 [Circuit is OPEN]`);
  }

  // Redfin allowed 1 retry (max 2 attempts); BrightData allowed 1 attempt; others 3 attempts
  const isBrightData = (target === 'zillow' || target === 'realtor' || target === 'homes' || target === 'redfin') && BRIGHTDATA_API_KEY;
  const maxAttempts = (circuit === 'half-open' || isBrightData) ? 1 : (target === 'redfin' ? 2 : 3);
  let lastError: Error | null = null;
  let hasRealBlock = false;
  const renderStartTime = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (Date.now() - renderStartTime > 20000) {
      throw new TargetBlockedError(429, 'Request timed out rendering target (20s ceiling exceeded)');
    }

    const options = getLaunchOptionsForAttempt(attempt);
    try {
      const result = await scrapePhotosAttempt(url, attempt, options);
      recordScrapeResult(url, true, false);
      updateCircuitOnSuccess(target);
      return result;
    } catch (error) {
      if (isBlockOrTimeoutError(error)) {
        console.warn(`[Scraper] Attempt ${attempt}/${maxAttempts} blocked or timed out for ${target}: ${(error as Error).message}`);
        const isRealBlock = isTargetBlockResponse(error);
        if (isRealBlock) hasRealBlock = true;

        recordScrapeResult(url, false, isRealBlock);
        lastError = error instanceof TargetBlockedError ? error : new TargetBlockedError(408, (error as Error).message);
        
        if (attempt < maxAttempts) {
          const backoffMs = target === 'redfin'
            ? Math.floor(2000 + Math.random() * 2000)
            : attempt * 500;
          console.log(`[Scraper] Retrying ${url} in ${backoffMs}ms (attempt ${attempt + 1}/${maxAttempts})...`);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      } else {
        recordScrapeResult(url, false, false);
        throw error;
      }
    }
  }

  if (hasRealBlock) {
    updateCircuitOnBlock(target);
  }
  throw lastError || new TargetBlockedError(429, 'Target page returned block page or no content after retries');
}

async function scrapePhotos(url: string): Promise<ScrapeResult> {
  const target = getUrlTarget(url);
  const startTime = Date.now();

  if (target === 'redfin') {
    await redfinSemaphore.acquire();
    await paceRedfinRequest();
  }

  try {
    return await executeScrapeWithRetries(url, target);
  } finally {
    if (target === 'redfin') {
      redfinSemaphore.release();
    }
  }
}

async function scrapePhotosWithTimeout(url: string): Promise<ScrapeResult> {
  const QUEUE_WAIT_TIMEOUT_MS = 90000; // 90s budget for queue wait + pacing
  let timerId: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      reject(new TargetBlockedError(429, 'Request timed out waiting in queue (90s budget exceeded)'));
    }, QUEUE_WAIT_TIMEOUT_MS);
  });

  try {
    return await Promise.race([scrapePhotos(url), timeoutPromise]);
  } finally {
    clearTimeout(timerId!);
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
    const result = await scrapePhotosWithTimeout(url);
    res.json(result);
  } catch (error) {
    console.error(`[Scraper] Scrape failed for ${url}:`, error);

    if (error instanceof CircuitOpenError) {
      res.statusMessage = error.message;
      res.status(429).json({
        error: error.message,
        reason: 'circuit_open',
        status: 429
      });
    } else if (error instanceof TargetBlockedError) {
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

// Health check with dynamic status, rolling statistics, and circuit state
app.get('/health', (_req: Request, res: Response) => {
  const rolling = getRollingStats();
  
  // Format stats with current circuit state and lastProbeAt timestamp
  const formattedStats = Object.keys(rolling).reduce((acc, key) => {
    acc[key] = {
      ...rolling[key],
      circuit: targetStates[key].circuit,
      lastProbeAt: targetStates[key].lastProbeAt,
    };
    return acc;
  }, {} as Record<string, any>);

  res.json({
    status: deriveStatus(),
    uptime: process.uptime(),
    stats: formattedStats,
  });
});

app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`Stealth Scraper Server running on port ${PORT}`);
});
