import express, { Request, Response } from 'express';
import { Camoufox } from 'camoufox-js';
import { request, type APIRequestContext, type Browser } from 'playwright-core';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 9377;
const ACCESS_KEY = process.env.PHOTO_RESOLVER_TOKEN || process.env.CAMOFOX_ACCESS_KEY;

// Browser launch options
const LAUNCH_OPTIONS: Record<string, any> = {
  headless: process.env.DISPLAY ? false : true,
  geoip: false,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  firefoxUserPrefs: {
    'security.sandbox.content.level': 0,
    'security.sandbox.plugin.level': 0,
    'security.sandbox.level': 0,
    'webgl.disabled': true,
    'layers.acceleration.disabled': true,
    'gfx.webrender.software': true,
    'browser.cache.disk.enable': false,
    'browser.cache.memory.enable': true,
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
const BRIGHTDATA_TARGETS = ['zillow', 'realtor', 'homes', 'redfin'];

// Sites whose /scrape asks Bright Data before the fast HTTP GET, e.g. BRIGHTDATA_FIRST=zillow,realtor
const BRIGHTDATA_FIRST = new Set(
  (process.env.BRIGHTDATA_FIRST || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
);
for (const site of BRIGHTDATA_FIRST) {
  if (!BRIGHTDATA_TARGETS.includes(site)) {
    console.warn(`[Scraper] BRIGHTDATA_FIRST names "${site}", which is not a Bright Data site (${BRIGHTDATA_TARGETS.join(', ')}). Ignored.`);
  }
}
if (BRIGHTDATA_FIRST.size > 0 && !BRIGHTDATA_API_KEY) {
  console.warn('[Scraper] BRIGHTDATA_FIRST is set but BRIGHTDATA_API_KEY is not, so it has no effect.');
}

function usesBrightData(target: string): boolean {
  return BRIGHTDATA_TARGETS.includes(target) && !!BRIGHTDATA_API_KEY;
}

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

class FetchTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchTimeoutError';
  }
}

// A page that passed the block checks but held no photos. It stays a TargetBlockedError so every
// existing check treats it as before; the trace is what tells it apart from a block.
class EmptyPageError extends TargetBlockedError {
  constructor(message: string) {
    super(429, message);
    this.name = 'EmptyPageError';
  }
}

// Bright Data answered with an HTTP error that isn't one of the block statuses
class UpstreamStatusError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'UpstreamStatusError';
  }
}

// Bright Data answered 200, but with its own refusal in place of the page
class BrightDataRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrightDataRefusalError';
  }
}

// Redfin answered /fetch with a body that isn't its JSON: no answer, rather than an empty one
class InvalidResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidResponseError';
  }
}

// The proxy refused to connect. Playwright reports a refused CONNECT as an HTTP 429 with an empty body (checked
// 2026-10-27), which would otherwise read as the site blocking us
class ProxyRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyRefusedError';
  }
}

function isProxyRefusal(status: number, body: string): boolean {
  return status === 429 && body.length === 0;
}

// Seen 2026-10-24 for every Redfin /stingray/ URL, on a zone without KYC: "Residential Failed (bad_endpoint): Requested
// site is not available for immediate residential (no KYC) access mode in accordance with robots.txt. ..."
function brightDataRefusal(body: string): BrightDataRefusalError | null {
  const text = body.trimStart();
  if (!text.startsWith('Residential Failed (')) return null;
  return new BrightDataRefusalError(`Bright Data refused the URL: ${text.split('\n')[0].slice(0, 160)}`);
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

// redfin is /scrape's listing pages and redfin_fetch is /fetch's searches: each has its own circuit, so failing
// page loads can't shut off searches
const targetStates: Record<string, TargetState> = {
  redfin: { circuit: 'closed', lastStateChange: Date.now(), consecutiveBlocks: 0, lastProbeAt: null },
  redfin_fetch: { circuit: 'closed', lastStateChange: Date.now(), consecutiveBlocks: 0, lastProbeAt: null },
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

function recordScrapeResult(url: string, success: boolean, blocked: boolean, target = getUrlTarget(url)) {
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
    redfin_fetch: { attempts: 0, successes: 0, blocks: 0 },
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

type StepResult = 'ok' | 'blocked' | 'empty' | 'http_error' | 'timeout' | 'error';

interface TraceStep {
  layer: string;
  attempt: number; // 0 for steps outside the retry loop, such as the Redfin queue
  result: StepResult;
  ms: number;
  status?: number;
  detail?: string;
  tokenAgeMs?: number; // age of the Redfin WAF token sent with the request, when one was
  lane?: number; // the Redfin lane (fixed proxy IP and its token) the step went through
}

type StepExtra = Pick<TraceStep, 'status' | 'detail' | 'tokenAgeMs' | 'lane'>;

const BLOCK_STATUSES = new Set([403, 405, 429, 503]);

// One request's path through the layers, logged as a single JSON line when its response is sent
class RequestTrace {
  readonly steps: TraceStep[] = [];
  readonly notes: string[] = [];
  readonly startedAt = Date.now();
  reason = 'ok';
  error: string | null = null;
  photos: number | null = null;

  constructor(readonly endpoint: '/scrape' | '/fetch', readonly url: string, readonly site: string) {}

  record(layer: string, attempt: number, result: StepResult, startedAt: number, extra: StepExtra = {}) {
    const step: TraceStep = { layer, attempt, result, ms: Date.now() - startedAt, ...extra };
    this.steps.push(step);
    recordLayerStep(this.endpoint, this.site, step);
  }

  recordError(layer: string, attempt: number, err: unknown, startedAt: number, extra: StepExtra = {}) {
    const { result, status } = classifyError(err);
    this.record(layer, attempt, result, startedAt, { status, detail: errorDetail(err), ...extra });
  }

  log(status: number) {
    console.log(JSON.stringify({
      msg: 'request_trace',
      endpoint: this.endpoint,
      site: this.site,
      url: this.url,
      status,
      reason: this.reason,
      error: this.error,
      photos: this.photos,
      totalMs: Date.now() - this.startedAt,
      notes: this.notes,
      steps: this.steps,
    }));
  }
}

function classifyError(err: unknown): { result: StepResult; status?: number } {
  if (err instanceof EmptyPageError) return { result: 'empty' };
  if (err instanceof TargetBlockedError) {
    return { result: BLOCK_STATUSES.has(err.status) ? 'blocked' : 'http_error', status: err.status };
  }
  if (err instanceof UpstreamStatusError) return { result: 'http_error', status: err.status };
  const e = err as { name?: string; message?: string } | null;
  const msg = e?.message?.toLowerCase() || '';
  if (e?.name === 'TimeoutError' || msg.includes('timeout') || msg.includes('timed out')) return { result: 'timeout' };
  return { result: 'error' };
}

function errorDetail(err: unknown): string {
  return toStatusMessage(String((err as Error | null)?.message ?? err)).slice(0, 200);
}

interface LayerStepRecord {
  at: number;
  endpoint: string;
  site: string;
  layer: string;
  result: StepResult;
  ms: number;
}

// The most recent layer steps, for the per-layer numbers on /health. Bounded so memory stays flat
// under load; the request_trace log lines are the complete record.
const LAYER_STEP_LIMIT = 10000;
const layerSteps: LayerStepRecord[] = [];
let nextLayerStep = 0;

function recordLayerStep(endpoint: string, site: string, step: TraceStep) {
  const record: LayerStepRecord = { at: Date.now(), endpoint, site, layer: step.layer, result: step.result, ms: step.ms };
  if (layerSteps.length < LAYER_STEP_LIMIT) {
    layerSteps.push(record);
  } else {
    layerSteps[nextLayerStep] = record;
  }
  nextLayerStep = (nextLayerStep + 1) % LAYER_STEP_LIMIT;
}

// Nearest-rank percentile of an ascending array
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

function getLayerStats() {
  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  const groups = new Map<string, LayerStepRecord[]>();
  let since: number | null = null;
  let steps = 0;
  for (const record of layerSteps) {
    if (record.at < cutoff) continue;
    steps++;
    if (since === null || record.at < since) since = record.at;
    const key = `${record.endpoint}|${record.site}|${record.layer}`;
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }

  const byEndpoint: Record<string, Record<string, Record<string, any>>> = {};
  for (const [key, records] of groups) {
    const [endpoint, site, layer] = key.split('|');
    const counts: Record<StepResult, number> = { ok: 0, blocked: 0, empty: 0, http_error: 0, timeout: 0, error: 0 };
    for (const record of records) counts[record.result]++;
    const ms = records.map((r) => r.ms).sort((a, b) => a - b);
    byEndpoint[endpoint] ??= {};
    byEndpoint[endpoint][site] ??= {};
    byEndpoint[endpoint][site][layer] = {
      attempts: records.length,
      ...counts,
      okRate: Math.round((counts.ok / records.length) * 1000) / 1000,
      p50Ms: percentile(ms, 0.5),
      p95Ms: percentile(ms, 0.95),
    };
  }

  return {
    window: `last 24h, at most ${LAYER_STEP_LIMIT} steps`,
    since,
    steps,
    brightDataFirst: Array.from(BRIGHTDATA_FIRST).filter((site) => BRIGHTDATA_TARGETS.includes(site)),
    byEndpoint,
  };
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

// Guarantee maximum 3 browser instances at once, and allow 2 concurrent Redfin requests of each kind with light pacing.
// /fetch's searches and /scrape's listing pages queue separately: a failing page load holds its slot for 25-70s
// (2026-10-27: searches waited 41-51s behind them and missed arv-ai's 45s deadline).
type RedfinQueue = 'fetch' | 'scrape';
const browserSemaphore = new Semaphore(3);
// Lane token refreshes run one at a time: several browsers loading redfin.com at once through the proxy got
// NS_ERROR_PROXY_TOO_MANY_REQUESTS from Webshare (2026-10-27)
const laneRefreshSemaphore = new Semaphore(1);
const redfinSemaphores: Record<RedfinQueue, Semaphore> = { fetch: new Semaphore(2), scrape: new Semaphore(2) };

const lastRedfinLaunchTime: Record<RedfinQueue, number> = { fetch: 0, scrape: 0 };
const REDFIN_MIN_LAUNCH_INTERVAL_MS = 1000; // 1.0s launch interval pacing for each Redfin queue

async function paceRedfinRequest(queue: RedfinQueue): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRedfinLaunchTime[queue];
  if (elapsed < REDFIN_MIN_LAUNCH_INTERVAL_MS) {
    const delay = REDFIN_MIN_LAUNCH_INTERVAL_MS - elapsed;
    console.log(`[Scraper] Pacing Redfin ${queue} request: waiting ${delay}ms to maintain ${REDFIN_MIN_LAUNCH_INTERVAL_MS / 1000}s launch interval...`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  lastRedfinLaunchTime[queue] = Date.now();
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
    lowercase.includes('405 forbidden') ||
    lowercase.includes('request blocked')
  );
}

function getLaunchOptionsForAttempt(attempt: number): Record<string, any> {
  const options = JSON.parse(JSON.stringify(LAUNCH_OPTIONS));
  if (options.proxy && options.proxy.username) {
    const baseUsername = options.proxy.username;
    // Strip any existing session/id/zone suffixes to get the clean base username
    const cleanUsername = baseUsername.replace(/(-session-|-id-|-zone-|-sessionid-).*/i, '');
    
    // Generate a unique session ID per request attempt for residential/datacenter proxy IP rotation
    const randomId = `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
    if (options.proxy.server.includes('smartproxy') || options.proxy.server.includes('gate.')) {
      options.proxy.username = `${cleanUsername}-session-${randomId}`;
    } else if (options.proxy.server.includes('brightdata') || options.proxy.server.includes('luminati')) {
      options.proxy.username = `${cleanUsername}-session-${randomId}`;
    } else if (options.proxy.server.includes('webshare')) {
      // For Webshare rotating proxy endpoints or standard proxy credentials
      options.proxy.username = cleanUsername;
    } else {
      options.proxy.username = `${cleanUsername}-session-${randomId}`;
    }
    console.log(`[Scraper] Attempt ${attempt}: Using proxy session username ${options.proxy.username}`);
  }
  return options;
}

type ProxySettings = { server: string; username?: string; password?: string };

// Launch options sending everything through one given proxy (a Redfin lane's), or none
function launchOptionsWithProxy(proxy: ProxySettings | undefined): Record<string, any> {
  const options = JSON.parse(JSON.stringify(LAUNCH_OPTIONS));
  if (proxy) options.proxy = { ...proxy };
  else delete options.proxy;
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
    const domRegexes = [
      /"daysOnMarket"\s*:\s*(\d+)/i,
      /"timeOnRedfin"\s*:\s*\{\s*"value"\s*:\s*(\d+)/i,
      /"timeOnMarket"\s*:\s*(\d+)/i,
      /Days\s+On\s+Market:\s*(\d+)/i,
      /Days\s+on\s+Redfin:\s*(\d+)/i,
      /"amenityName"\s*:\s*"Days\s+On\s+Market".*?"amenityValues"\s*:\s*\["(\d+)"\]/i,
      /"label"\s*:\s*"Days\s+on\s+Redfin".*?"value"\s*:\s*"(\d+)/i,
      />\s*(\d+)\s*<\/span>\s*<span[^>]*>\s*Days\s+on\s+(?:Market|Redfin)\s*<\/span>/i,
      /<span[^>]*>\s*Days\s+on\s+(?:Market|Redfin)\s*<\/span>\s*<span[^>]*>\s*(\d+)\s*<\/span>/i,
      /(\d+)\s+days?\s+on\s+(?:Redfin|market)/i,
      /<li[^>]*>\s*Days On Market\s*:\s*(\d+)\s*<\/li>/i,
    ];

    for (const rx of domRegexes) {
      const match = html.match(rx);
      if (match && match[1]) {
        const val = parseInt(match[1], 10);
        if (!isNaN(val)) {
          daysOnMarket = val;
          break;
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
    } else {
      const priceMatch1 = html.match(/data-rf-test-name="stat-price"[^>]*>[\s\S]*?\$([\d,]+)/i);
      if (priceMatch1) {
        listPrice = parseInt(priceMatch1[1].replace(/,/g, ''), 10);
      } else {
        const priceMatch2 = html.match(/"price"\s*:\s*(\d+)/i);
        if (priceMatch2) {
          listPrice = parseInt(priceMatch2[1], 10);
        }
      }
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

async function scrapeWithBrightData(url: string, attempt: number, trace: RequestTrace): Promise<ScrapeResult> {
  if (!BRIGHTDATA_API_KEY) {
    throw new Error('BRIGHTDATA_API_KEY is not defined');
  }

  const target = getUrlTarget(url);
  const timeoutMs = target === 'realtor' ? 20000 : 25000;
  const startedAt = Date.now();

  try {
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
      throw new UpstreamStatusError(response.status, `Bright Data API request failed with status ${response.status}`);
    }

    const html = await response.text();

    const refusal = brightDataRefusal(html);
    if (refusal) throw refusal;

    if (isCaptchaOrBlockPage(html)) {
      throw new TargetBlockedError(429, 'Target page returned HTTP status 429');
    }

    const photos = extractPhotosFromHtml(html);
    if (photos.length === 0) {
      throw new EmptyPageError('Target page returned block page or no content');
    }

    console.log(`[Scraper] Bright Data Web Unlocker successful. Extracted ${photos.length} photos.`);
    const metadata = target === 'redfin' ? extractRedfinMetadata(html) : { daysOnMarket: null, listPrice: null, saleHistory: [] };
    trace.record('brightdata', attempt, 'ok', startedAt);
    return {
      photos,
      ...metadata
    };
  } catch (err) {
    trace.recordError('brightdata', attempt, err, startedAt);
    throw err;
  }
}

// Layer 1: Fast standalone HTTP GET via the proxy (~900ms); a Redfin page goes through its lane, with the lane's
// token. Null when it produced no photos.
async function scrapeWithFastGet(
  url: string,
  attempt: number,
  options: Record<string, any>,
  trace: RequestTrace,
  lane?: RedfinLane
): Promise<ScrapeResult | null> {
  const target = getUrlTarget(url);

  if (lane) {
    // Without a token Redfin answers a listing page with a challenge or a CAPTCHA (2026-10-27), so wait for the lane's
    // refresh; when it can't get one, the page goes to the next layer without being sent
    if (!lane.hasToken()) await waitForCookieRefresh(lane, trace, attempt);
    else if (lane.needsRefreshSoon()) lane.refreshInBackground();
    if (!lane.hasToken()) return null;
  }

  const startedAt = Date.now();
  const tokenAgeMs = lane?.tokenAgeMs() ?? undefined;
  const laneId = lane?.id;
  let outcome: LaneOutcome = 'error';
  const sentToken = lane?.begin();

  try {
    console.log(`[Scraper] Attempt ${attempt}: Layer 1 fast HTTP GET for URL: ${url}${lane ? ` (Redfin lane ${lane.id})` : ''}`);
    const cookieHeader = lane?.cookieHeader();
    const extraHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      'Referer': target === 'redfin' ? 'https://www.redfin.com/' : (target === 'zillow' ? 'https://www.zillow.com/' : 'https://www.google.com/')
    };
    if (cookieHeader) {
      extraHeaders['Cookie'] = cookieHeader;
    }

    const requestContext = await request.newContext({
      proxy: options.proxy,
      extraHTTPHeaders: extraHeaders
    });

    try {
      const response = await requestContext.get(url, { timeout: 6000 });
      const status = response.status();
      console.log(`[Scraper] Attempt ${attempt}: Layer 1 HTTP response status: ${status}`);
      lane?.absorbSetCookie(response.headers()['set-cookie']);

      if (status === 200) {
        const html = await response.text();

        if (!isCaptchaOrBlockPage(html)) {
          const photos = extractPhotosFromHtml(html);
          if (photos.length > 0) {
            console.log(`[Scraper] Attempt ${attempt}: Layer 1 successful in fast path. Extracted ${photos.length} photos.`);
            const metadata = target === 'redfin' ? extractRedfinMetadata(html) : { daysOnMarket: null, listPrice: null, saleHistory: [] };
            trace.record('fast', attempt, 'ok', startedAt, { status, tokenAgeMs, lane: laneId });
            outcome = 'ok';
            return {
              photos,
              ...metadata
            };
          }
          trace.record('fast', attempt, 'empty', startedAt, { status, tokenAgeMs, lane: laneId });
        } else {
          console.log(`[Scraper] Attempt ${attempt}: Layer 1 hit captcha/block page.`);
          trace.record('fast', attempt, 'blocked', startedAt, { status, detail: 'block page', tokenAgeMs, lane: laneId });
          outcome = 'blocked';
        }
      } else if (isProxyRefusal(status, await response.text())) {
        console.warn(`[Scraper] Attempt ${attempt}: Layer 1 connection refused by the proxy (HTTP 429, empty body).`);
        trace.record('fast', attempt, 'http_error', startedAt, { status, detail: 'proxy refused', tokenAgeMs, lane: laneId });
      } else {
        console.warn(`[Scraper] Attempt ${attempt}: Layer 1 returned HTTP status ${status}.`);
        trace.record('fast', attempt, BLOCK_STATUSES.has(status) ? 'blocked' : 'http_error', startedAt, { status, tokenAgeMs, lane: laneId });
        // 202 is AWS WAF's challenge: Redfin didn't accept the token either
        if (BLOCK_STATUSES.has(status) || status === 202) outcome = 'blocked';
      }
    } finally {
      // Disposed on every path, a timeout included, so contexts don't pile up for the life of the process
      await requestContext.dispose().catch(() => {});
    }
  } catch (err: any) {
    console.warn(`[Scraper] Attempt ${attempt}: Layer 1 failed (${err.message}).`);
    trace.recordError('fast', attempt, err, startedAt, { tokenAgeMs, lane: laneId });
  } finally {
    lane?.end(outcome, sentToken, 'scrape');
  }
  return null;
}

// Layer 2: Bright Data Web Unlocker. Its block ends the attempt without the browser; its other failures don't.
async function tryBrightData(
  url: string,
  attempt: number,
  trace: RequestTrace
): Promise<{ result: ScrapeResult | null; block: TargetBlockedError | null }> {
  try {
    console.log(`[Scraper] Attempt ${attempt}: Trying Layer 2 (Bright Data Web Unlocker) for ${url}`);
    return { result: await scrapeWithBrightData(url, attempt, trace), block: null };
  } catch (error) {
    console.warn(`[Scraper] Bright Data Web Unlocker failed for ${url}: ${(error as Error).message}.`);
    return { result: null, block: error instanceof TargetBlockedError ? error : null };
  }
}

// A Redfin page's attempt runs every layer that leaves from our IPs (fast GET, browser) through its lane's proxy
async function scrapePhotosAttempt(
  url: string,
  attempt: number,
  options: Record<string, any>,
  trace: RequestTrace,
  lane?: RedfinLane
): Promise<ScrapeResult> {
  const target = getUrlTarget(url);
  let brightDataBlock: TargetBlockedError | null = null;

  // Fast GET then Bright Data by default; BRIGHTDATA_FIRST swaps the two for the sites it names
  if (usesBrightData(target) && BRIGHTDATA_FIRST.has(target)) {
    const brightData = await tryBrightData(url, attempt, trace);
    if (brightData.result) return brightData.result;
    brightDataBlock = brightData.block;
    const fast = await scrapeWithFastGet(url, attempt, options, trace, lane);
    if (fast) return fast;
  } else {
    const fast = await scrapeWithFastGet(url, attempt, options, trace, lane);
    if (fast) return fast;
    if (usesBrightData(target)) {
      const brightData = await tryBrightData(url, attempt, trace);
      if (brightData.result) return brightData.result;
      brightDataBlock = brightData.block;
    }
  }

  // A block from Bright Data ends the attempt: the browser only runs when Bright Data failed some other way
  if (brightDataBlock) throw brightDataBlock;

  // Layer 3: Launch browser & try browser-context request
  console.log(`[Scraper] Attempt ${attempt}: Entering browser queue for URL: ${url}`);
  const queueStart = Date.now();
  await browserSemaphore.acquire();
  trace.record('browser_queue', attempt, 'ok', queueStart);

  try {
    console.log(`[Scraper] Attempt ${attempt}: Launching Camoufox browser for URL: ${url}${lane ? ` (Redfin lane ${lane.id})` : ''}`);
    const launchStart = Date.now();
    const browser = await Camoufox(options).catch((err) => {
      trace.recordError('browser_launch', attempt, err, launchStart, { lane: lane?.id });
      throw err;
    });
    trace.record('browser_launch', attempt, 'ok', launchStart, { lane: lane?.id });

    try {
      const requestStart = Date.now();
      try {
        console.log(`[Scraper] Attempt ${attempt}: Attempting browser-context HTTP GET...`);
        const context = await browser.newContext();
        
        const response = await context.request.get(url, { timeout: 4000 });
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
            trace.record('browser_request', attempt, 'ok', requestStart, { status });
            return {
              photos,
              ...metadata
            };
          }
          trace.record('browser_request', attempt, 'empty', requestStart, { status });
        } else {
          await context.close();
          trace.record('browser_request', attempt, 'http_error', requestStart, { status });
        }
      } catch (err) {
        trace.recordError('browser_request', attempt, err, requestStart);
        if (err instanceof TargetBlockedError) throw err;
        console.warn(`[Scraper] Attempt ${attempt}: Browser-context HTTP GET failed or blocked: ${(err as Error).message}`);
      }

      // Full browser page loading and rendering
      const renderStart = Date.now();
      try {
        const rendered = await renderListingPage(browser, url, attempt);
        trace.record('browser_render', attempt, 'ok', renderStart);
        return rendered;
      } catch (err) {
        trace.recordError('browser_render', attempt, err, renderStart);
        throw err;
      }
    } finally {
      console.log(`[Scraper] Attempt ${attempt}: Closing Camoufox browser.`);
      await browser.close();
    }
  } finally {
    browserSemaphore.release();
    console.log(`[Scraper] Attempt ${attempt}: Released browser queue for URL: ${url}`);
  }
}

// Loads the listing in a browser tab and reads photos from its scripts, images and HTML
async function renderListingPage(
  browser: Browser,
  url: string,
  attempt: number
): Promise<ScrapeResult> {
  const target = getUrlTarget(url);
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

  // Navigate to listing page (with 7s timeout)
  console.log(`[Scraper] Attempt ${attempt}: Navigating to page...`);
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 7000 });
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
    throw new EmptyPageError('Target page returned block page or no content');
  }

  console.log(`[Scraper] Attempt ${attempt}: Successfully extracted ${cleaned.length} photos.`);
  const metadata = target === 'redfin' ? extractRedfinMetadata(html) : { daysOnMarket: null, listPrice: null, saleHistory: [] };
  return {
    photos: cleaned,
    ...metadata
  };
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

async function executeScrapeWithRetries(url: string, target: string, trace: RequestTrace): Promise<ScrapeResult> {
  const circuit = checkCircuit(target);

  if (circuit === 'open') {
    console.log(`[Circuit Breaker] Skipping request for ${url} (Circuit is OPEN).`);
    recordScrapeResult(url, false, true);
    throw new CircuitOpenError(429, `Target page returned HTTP status 429 [Circuit is OPEN]`);
  }

  // Redfin allowed 1 retry (max 2 attempts); BrightData allowed 1 attempt; others 3 attempts
  const maxAttempts = (circuit === 'half-open' || usesBrightData(target)) ? 1 : (target === 'redfin' ? 2 : 3);
  let lastError: Error | null = null;
  let hasRealBlock = false;
  let lane: RedfinLane | undefined;
  const renderStartTime = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (Date.now() - renderStartTime > 20000) {
      throw new TargetBlockedError(429, 'Request timed out rendering target (20s ceiling exceeded)');
    }

    // A Redfin retry moves to another lane: a blocked lane is refreshing its token in the background
    lane = target === 'redfin' ? pickRedfinLane(lane) : undefined;
    const options = lane ? launchOptionsWithProxy(lane.proxy) : getLaunchOptionsForAttempt(attempt);
    try {
      const result = await scrapePhotosAttempt(url, attempt, options, trace, lane);
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

async function scrapePhotos(url: string, trace: RequestTrace): Promise<ScrapeResult> {
  const target = getUrlTarget(url);
  const startTime = Date.now();

  if (target === 'redfin') {
    await redfinSemaphores.scrape.acquire();
    await paceRedfinRequest('scrape');
    trace.record('redfin_queue', 0, 'ok', startTime);
  }

  try {
    return await executeScrapeWithRetries(url, target, trace);
  } finally {
    if (target === 'redfin') {
      redfinSemaphores.scrape.release();
    }
  }
}

async function scrapePhotosWithTimeout(url: string, trace: RequestTrace): Promise<ScrapeResult> {
  const QUEUE_WAIT_TIMEOUT_MS = 90000; // 90s budget for queue wait + pacing
  let timerId: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      reject(new TargetBlockedError(429, 'Request timed out waiting in queue (90s budget exceeded)'));
    }, QUEUE_WAIT_TIMEOUT_MS);
  });

  try {
    return await Promise.race([scrapePhotos(url, trace), timeoutPromise]);
  } finally {
    clearTimeout(timerId!);
  }
}

// Node throws on a status message containing newlines or non-ASCII (Playwright error
// messages contain both), which crashes the process, so only the first line is used
function toStatusMessage(message: string): string {
  return message.split('\n')[0].replace(/[^\x20-\x7e]/g, '').trim();
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
  if (typeof url !== 'string') {
    return res.status(400).json({ error: 'Parameter "url" must be a string.' });
  }

  const trace = new RequestTrace('/scrape', url, getUrlTarget(url));
  try {
    const result = await scrapePhotosWithTimeout(url, trace);
    trace.photos = result.photos.length;
    res.json(result);
  } catch (error) {
    console.error(`[Scraper] Scrape failed for ${url}:`, error);
    trace.error = errorDetail(error);

    if (error instanceof CircuitOpenError) {
      trace.reason = 'circuit_open';
      res.statusMessage = error.message;
      res.status(429).json({
        error: error.message,
        reason: 'circuit_open',
        status: 429
      });
    } else if (error instanceof TargetBlockedError) {
      trace.reason = 'target_blocked';
      res.statusMessage = toStatusMessage(error.message);
      res.status(error.status).json({
        error: error.message,
        reason: 'target_blocked',
        status: error.status
      });
    } else {
      trace.reason = 'resolver_error';
      res.status(500).json({
        error: (error as Error).message,
        reason: 'resolver_error'
      });
    }
  } finally {
    trace.log(res.statusCode);
  }
});

function isAllowedFetchUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.hostname !== 'www.redfin.com') return false;
    const path = parsed.pathname;
    if (path === '/stingray/api/gis' || path === '/stingray/do/location-autocomplete') return true;
    if (/^\/zipcode\/\d{5}\/?$/.test(path)) return true;
    return false;
  } catch {
    return false;
  }
}

interface FetchResult {
  status: number;
  data: any;
}

const COOKIE_REFRESH_AHEAD_MS = 15 * 60 * 1000; // past this age, a request starts a background refresh
const COOKIE_TOKEN_WAIT_MS = 10 * 1000; // how long a refresh waits for aws-waf-token once the page has loaded
const COOKIE_REFRESH_BACKOFF_BASE_MS = 30 * 1000; // doubles with each failure, up to the max
const COOKIE_REFRESH_BACKOFF_MAX_MS = 5 * 60 * 1000;
const FRESH_TOKEN_BLOCK_MS = 60 * 1000; // a token blocked this soon after it arrived counts as a failed refresh

type LaneOutcome = 'ok' | 'blocked' | 'error';

// One Redfin lane: a fixed proxy IP, and the session cookies (above all the AWS WAF token) obtained through it.
// Redfin's firewall cancels a token it sees from more than a couple of IPs within 5 minutes (AWS WAF Bot Control,
// TGT_TokenReuseIp), so a lane's token is only ever sent through the lane's own proxy. Measured 2026-10-27: one token
// shared over Webshare's rotating IPs was blocked after 2-3 uses, even from the IP it came from; a token kept on one
// fixed IP got through 9 of 9 (6 searches, 3 listing pages).
// All session state lives here, so sharing it across replicas (e.g. Redis) changes only this class.
class RedfinLane {
  private cookies = new Map<string, string>();
  private tokenReceivedAt: number | null = null;
  private refreshing: Promise<Error | null> | null = null;
  // Refreshes in a row that didn't produce a working token; reset when a request gets through
  private failures = 0;
  private nextRefreshAt = 0;
  // For choosing a lane, and for /health
  inFlight = 0;
  lastPickedAt = 0;
  private tokenUses = 0;
  private counts: Record<LaneOutcome, number> = { ok: 0, blocked: 0, error: 0 };
  private lastBlockAt: number | null = null;

  constructor(readonly id: number, readonly proxy: ProxySettings | undefined) {}

  cookieHeader(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  hasToken(): boolean {
    return this.cookies.has('aws-waf-token');
  }

  tokenAgeMs(): number | null {
    return this.hasToken() && this.tokenReceivedAt !== null ? Date.now() - this.tokenReceivedAt : null;
  }

  // No token, or old enough that the next request should start a background refresh
  needsRefreshSoon(): boolean {
    const age = this.tokenAgeMs();
    return age === null || age > COOKIE_REFRESH_AHEAD_MS;
  }

  isRefreshing(): boolean {
    return this.refreshing !== null;
  }

  // No token, and refreshing is backing off after failures: a request here would go without one
  coolingDown(): boolean {
    return !this.hasToken() && Date.now() < this.nextRefreshAt;
  }

  // A request is going out through this lane; returns the token it carries, for end()
  begin(): string | undefined {
    this.inFlight++;
    const token = this.cookies.get('aws-waf-token');
    if (token !== undefined) this.tokenUses++;
    return token;
  }

  // How it went. A block cancels the token the request carried and starts getting a new one through the same IP; a
  // token that already replaced it, while the request was out, is kept. A listing page blocked on a token younger than
  // FRESH_TOKEN_BLOCK_MS keeps it: that says more about the page than the token, and cancelling would put the lane into
  // backoff, taking it from /fetch. Only a search blocked on a fresh token backs the lane off.
  end(outcome: LaneOutcome, sentToken: string | undefined, queue: RedfinQueue): void {
    this.inFlight--;
    this.counts[outcome]++;
    if (outcome === 'ok') this.markWorked();
    if (outcome !== 'blocked') return;
    this.lastBlockAt = Date.now();
    if (sentToken === undefined || this.cookies.get('aws-waf-token') !== sentToken) return;
    const age = this.tokenAgeMs();
    if (queue === 'scrape' && age !== null && age < FRESH_TOKEN_BLOCK_MS) return;
    this.invalidateToken();
    this.refreshInBackground();
  }

  // A request got through to Redfin, so refreshing is working again
  markWorked(): void {
    this.failures = 0;
    this.nextRefreshAt = 0;
  }

  // After a block. A token blocked within FRESH_TOKEN_BLOCK_MS of arriving means refreshing isn't helping,
  // so it backs off rather than launching a browser after every block.
  invalidateToken(): void {
    const age = this.tokenAgeMs();
    this.cookies.delete('aws-waf-token');
    this.tokenReceivedAt = null;
    this.tokenUses = 0;
    if (age !== null && age < FRESH_TOKEN_BLOCK_MS) this.recordFailure();
  }

  // Cookies from a browser context on this lane's IP; returns whether an aws-waf-token was among them
  absorb(cookies: { name: string; value: string; domain: string }[]): boolean {
    let receivedToken = false;
    for (const cookie of cookies) {
      if (cookie.domain.includes('redfin.com')) {
        this.cookies.set(cookie.name, cookie.value);
        if (cookie.name === 'aws-waf-token') receivedToken = true;
      }
    }
    if (receivedToken) this.tokenReceived();
    return receivedToken;
  }

  absorbSetCookie(setCookieHeader?: string): void {
    if (!setCookieHeader) return;
    const lines = setCookieHeader.split(/\r?\n|, (?=[a-zA-Z0-9_-]+=)/);
    for (const line of lines) {
      const parts = line.split(';')[0]?.trim();
      if (parts && parts.includes('=')) {
        const [name, ...val] = parts.split('=');
        if (name && val) {
          this.cookies.set(name.trim(), val.join('=').trim());
          if (name.trim() === 'aws-waf-token') this.tokenReceived();
        }
      }
    }
  }

  // One refresh at a time; while backing off it resolves at once with the reason instead of launching a browser.
  // Resolves to null when the refresh received an aws-waf-token.
  refresh(): Promise<Error | null> {
    if (this.refreshing) return this.refreshing;
    const waitMs = this.nextRefreshAt - Date.now();
    if (waitMs > 0) {
      return Promise.resolve(new Error(`Redfin lane ${this.id} cookie refresh backing off for ${Math.ceil(waitMs / 1000)}s after ${this.failures} failure(s)`));
    }

    const startedAt = Date.now();
    this.refreshing = this.loadHomepage().then((failure) => {
      if (failure) this.recordFailure();
      this.refreshing = null;
      const result = failure ? classifyError(failure).result : 'ok';
      const ms = Date.now() - startedAt;
      recordLayerStep('lanes', 'redfin', { layer: 'cookie_refresh', attempt: 0, result, ms, lane: this.id });
      console.log(JSON.stringify({
        msg: 'cookie_refresh',
        lane: this.id,
        result,
        ms,
        error: failure ? errorDetail(failure) : null,
        failures: this.failures,
        backoffSec: Math.max(0, Math.ceil((this.nextRefreshAt - Date.now()) / 1000)),
      }));
      return failure;
    });
    return this.refreshing;
  }

  refreshInBackground(): void {
    if (this.refreshing || Date.now() < this.nextRefreshAt) return;
    void this.refresh();
  }

  status() {
    const age = this.tokenAgeMs();
    return {
      lane: this.id,
      hasToken: this.hasToken(),
      tokenAgeSec: age === null ? null : Math.round(age / 1000),
      tokenUses: this.tokenUses,
      refreshing: this.refreshing !== null,
      failures: this.failures,
      backoffSec: Math.max(0, Math.ceil((this.nextRefreshAt - Date.now()) / 1000)),
      inFlight: this.inFlight,
      ok: this.counts.ok,
      blocked: this.counts.blocked,
      errors: this.counts.error,
      lastBlockSecAgo: this.lastBlockAt === null ? null : Math.round((Date.now() - this.lastBlockAt) / 1000),
    };
  }

  private tokenReceived(): void {
    this.tokenReceivedAt = Date.now();
    this.tokenUses = 0;
  }

  private recordFailure(): void {
    this.failures++;
    this.nextRefreshAt = Date.now() + Math.min(COOKIE_REFRESH_BACKOFF_MAX_MS, COOKIE_REFRESH_BACKOFF_BASE_MS * 2 ** (this.failures - 1));
  }

  private async loadHomepage(): Promise<Error | null> {
    let browser: Browser | undefined;
    await laneRefreshSemaphore.acquire();
    await browserSemaphore.acquire();
    try {
      console.log(`[Fetcher] Warming Redfin lane ${this.id} session and WAF tokens via Camoufox...`);
      const launched: Browser = await Camoufox(launchOptionsWithProxy(this.proxy));
      browser = launched;
      const context = await launched.newContext();
      const page = await context.newPage();
      const response = await page.goto('https://www.redfin.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
      // An IP Redfin has flagged gets a CAPTCHA (405) even on the homepage. A token still appears there, but it opens
      // nothing: 6 of 6 searches 403 and 3 of 3 pages 405 with it (2026-10-27). 202 is the silent challenge, which the
      // page solves itself.
      const status = response?.status() ?? 0;
      if (status === 403 || status === 405 || status === 429) {
        return new Error(`Redfin answered its homepage with HTTP ${status}${status === 405 ? ' (CAPTCHA)' : ''} on this IP`);
      }

      // The token is set by a script shortly after the page loads, so wait for the cookie itself
      // rather than for the network to go idle
      const hasToken = (cookies: { name: string; domain: string }[]) =>
        cookies.some((c) => c.name === 'aws-waf-token' && c.domain.includes('redfin.com'));
      const deadline = Date.now() + COOKIE_TOKEN_WAIT_MS;
      let cookies = await context.cookies();
      while (!hasToken(cookies) && Date.now() < deadline) {
        await page.waitForTimeout(250);
        cookies = await context.cookies();
      }

      const receivedToken = this.absorb(cookies);
      console.log(`[Fetcher] Warmed Redfin lane ${this.id} cookies (${this.cookies.size} cookies cached, aws-waf-token received: ${receivedToken})`);
      return receivedToken ? null : new Error(`No aws-waf-token cookie within ${COOKIE_TOKEN_WAIT_MS / 1000}s of the page loading`);
    } catch (err) {
      console.error(`[Fetcher] Error warming Redfin lane ${this.id} cookies:`, err);
      return err instanceof Error ? err : new Error(String(err));
    } finally {
      if (browser) await browser.close().catch(() => {});
      browserSemaphore.release();
      laneRefreshSemaphore.release();
    }
  }
}

// Webshare gives a fixed IP when the username ends in a number instead of "rotate". The plan has 6: -us-1 to -us-6
// answered and -us-7 and up didn't (2026-10-27). REDFIN_PROXY_LANES overrides the count.
const REDFIN_LANES_DEFAULT = 6;

function redfinLaneProxies(): (ProxySettings | undefined)[] {
  const proxy = LAUNCH_OPTIONS.proxy as ProxySettings | undefined;
  if (!proxy) return [undefined];
  const username = proxy.username ?? '';
  if (!proxy.server.includes('webshare') || !/-rotate$/i.test(username)) {
    console.warn('[Redfin] PROXY_URL is not a Webshare "-rotate" username, so Redfin runs on one lane through the proxy as configured. If that proxy changes IPs, Redfin will cancel the lane\'s token.');
    return [{ ...proxy }];
  }
  let count = REDFIN_LANES_DEFAULT;
  const configured = process.env.REDFIN_PROXY_LANES;
  if (configured !== undefined) {
    const n = Number(configured);
    if (Number.isInteger(n) && n >= 1 && n <= 100) count = n;
    else console.warn(`[Redfin] REDFIN_PROXY_LANES="${configured}" is not a whole number from 1 to 100. Using ${REDFIN_LANES_DEFAULT}.`);
  }
  return Array.from({ length: count }, (_, i) => ({ ...proxy, username: username.replace(/rotate$/i, String(i + 1)) }));
}

const redfinLanes = redfinLaneProxies().map((proxy, i) => new RedfinLane(i + 1, proxy));
console.log(`[Redfin] ${redfinLanes.length} lane(s): ${redfinLanes.map((l) => l.proxy?.username ?? 'no proxy').join(', ')}`);
// Every lane gets its token at startup, one at a time, so a flagged IP is found (and backed off) before a request waits
// on it: on 2026-10-27, 3 of the 6 IPs got a CAPTCHA on the homepage, and the first searches waited 28s finding that out
for (const lane of redfinLanes) lane.refreshInBackground();

// The lane for the next Redfin request: one with a token if any has, the least busy and then the longest unused, so
// traffic spreads over every IP. A lane cooling down after failed refreshes is skipped while another can serve.
// exclude is the lane a retry is leaving.
function pickRedfinLane(exclude?: RedfinLane): RedfinLane {
  const others = redfinLanes.filter((l) => l !== exclude);
  const pool = others.length > 0 ? others : redfinLanes;
  const usable = pool.filter((l) => !l.coolingDown());
  const candidates = usable.length > 0 ? usable : pool;
  const withToken = candidates.filter((l) => l.hasToken());
  // While some lanes have no token, warm the longest-unused one in the background, one at a time, so every IP comes
  // into use
  if (withToken.length > 0 && !redfinLanes.some((l) => l.isRefreshing())) {
    const cold = candidates.filter((l) => !l.hasToken() && !l.isRefreshing()).sort((a, b) => a.lastPickedAt - b.lastPickedAt)[0];
    cold?.refreshInBackground();
  }
  // With no token anywhere, a request joins a refresh already running rather than starting another
  const refreshing = candidates.filter((l) => l.isRefreshing());
  const choices = withToken.length > 0 ? withToken : refreshing.length > 0 ? refreshing : candidates;
  const lane = choices.sort((a, b) => a.inFlight - b.inFlight || a.lastPickedAt - b.lastPickedAt)[0];
  lane.lastPickedAt = Date.now();
  return lane;
}

// A request waiting on its lane's refresh, with no token or after a block; the refresh itself is logged as cookie_refresh
async function waitForCookieRefresh(lane: RedfinLane, trace: RequestTrace, attempt: number): Promise<void> {
  const startedAt = Date.now();
  const failure = await lane.refresh();
  if (failure) trace.recordError('cookie_wait', attempt, failure, startedAt, { lane: lane.id });
  else trace.record('cookie_wait', attempt, 'ok', startedAt, { lane: lane.id });
}

// A /zipcode/ page, after the browser failed. Not used for /stingray/: Bright Data refuses those (see brightDataRefusal).
async function fetchZipcodeWithBrightData(url: string, trace: RequestTrace, attempt: number): Promise<FetchResult> {
  if (!BRIGHTDATA_API_KEY) {
    throw new Error('BRIGHTDATA_API_KEY is not defined');
  }

  const timeoutMs = 25000;
  const startedAt = Date.now();
  try {
    console.log(`[Fetcher] Querying Bright Data Web Unlocker for URL: ${url}`);
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
      console.error(`[Fetcher] Bright Data API returned status ${response.status}: ${errorText}`);
      if (response.status === 403 || response.status === 405 || response.status === 429 || response.status === 503) {
        throw new TargetBlockedError(response.status, `Target page returned HTTP status ${response.status}`);
      }
      throw new UpstreamStatusError(response.status, `Bright Data API request failed with status ${response.status}`);
    }

    const text = await response.text();
    const refusal = brightDataRefusal(text);
    if (refusal) throw refusal;
    if (isCaptchaOrBlockPage(text)) {
      throw new TargetBlockedError(429, 'Target page returned block page');
    }

    const match = text.match(/\/stingray\/api\/gis\?[^"'\s<>]+/);
    let region_id: string | null = null;
    let region_type: string | null = null;
    let market: string | null = null;
    if (match) {
      try {
        const u = new URL('https://www.redfin.com' + match[0].replace(/&amp;/g, '&'));
        region_id = u.searchParams.get('region_id');
        region_type = u.searchParams.get('region_type');
        market = u.searchParams.get('market');
      } catch (e) {}
    }
    if (!region_id) {
      throw new Error('Redfin region id not found on zipcode page');
    }
    const titleMatch = text.match(/<title>([^<]+)<\/title>/i);
    recordScrapeResult(url, true, false, 'redfin_fetch');
    updateCircuitOnSuccess('redfin_fetch');
    trace.record('brightdata', attempt, 'ok', startedAt);
    return {
      status: 200,
      data: {
        region_id,
        region_type: region_type || '2',
        market,
        title: titleMatch ? titleMatch[1] : 'Redfin Zipcode',
        url: url
      }
    };
  } catch (err) {
    trace.recordError('brightdata', attempt, err, startedAt);
    throw err;
  }
}

async function renderZipcodePage(url: string, trace: RequestTrace): Promise<FetchResult> {
  let browser;
  const startedAt = Date.now();
  // Through a lane, so the cookies the page sets are kept by the lane whose IP they came from
  const lane = pickRedfinLane();
  try {
    const options = launchOptionsWithProxy(lane.proxy);
    browser = await Camoufox(options);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    lane.absorb(await context.cookies());

    const extracted = await page.evaluate(() => {
      const state = (window as any).__reactServerState;
      const cache = state?.InitialContext?.['ReactServerAgent.cache']?.dataCache || {};
      const gisKey = Object.keys(cache).find(k => k.includes('gis'));
      let region_id: string | null = null;
      let region_type: string | null = null;
      let market: string | null = null;
      if (gisKey) {
        try {
          const u = new URL('https://www.redfin.com' + gisKey);
          region_id = u.searchParams.get('region_id');
          region_type = u.searchParams.get('region_type');
          market = u.searchParams.get('market');
        } catch (e) {}
      }
      return {
        region_id,
        region_type: region_type || '2',
        market,
        title: document.title,
        url: window.location.href
      };
    });

    if (!extracted.region_id) {
      throw new Error('Redfin region id not found on zipcode page');
    }

    recordScrapeResult(url, true, false, 'redfin_fetch');
    updateCircuitOnSuccess('redfin_fetch');
    trace.record('browser', 1, 'ok', startedAt, { lane: lane.id });
    return {
      status: 200,
      data: extracted
    };
  } catch (err: any) {
    trace.recordError('browser', 1, err, startedAt, { lane: lane.id });
    if (browser) {
      await browser.close().catch(() => {});
      browser = undefined;
    }
    if (BRIGHTDATA_API_KEY) {
      console.warn(`[Fetcher] Camoufox failed for ${url} (${err.message}). Escalating to Bright Data Web Unlocker...`);
      return await fetchZipcodeWithBrightData(url, trace, 1);
    }
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// The /fetch request to Redfin, through the lane's proxy with the lane's cookies
async function fetchRedfinDirect(
  url: string,
  lane: RedfinLane,
  trace: RequestTrace,
  attempt: number
): Promise<
  | { kind: 'ok'; result: FetchResult }
  | { kind: 'blocked'; status: number; finalUrl: string }
  | { kind: 'refused'; err: ProxyRefusedError }
  | { kind: 'error'; err: unknown }
> {
  const FETCH_TIMEOUT_MS = 15000;
  const tokenAgeMs = lane.tokenAgeMs() ?? undefined;
  const startedAt = Date.now();
  let outcome: LaneOutcome = 'error';
  const sentToken = lane.begin();

  console.log(`[Fetcher] Executing proxied fetch on Redfin lane ${lane.id} for URL: ${url}`);
  let requestContext: APIRequestContext | undefined;
  try {
    const cookieHeader = lane.cookieHeader();
    const extraHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer': 'https://www.redfin.com/'
    };
    if (cookieHeader) {
      extraHeaders['Cookie'] = cookieHeader;
    }

    requestContext = await request.newContext({
      proxy: lane.proxy,
      extraHTTPHeaders: extraHeaders
    });

    const response = await requestContext.get(url, { timeout: FETCH_TIMEOUT_MS });
    const status = response.status();
    const finalUrl = response.url();
    lane.absorbSetCookie(response.headers()['set-cookie']);
    const text = await response.text();

    if (isProxyRefusal(status, text)) {
      const err = new ProxyRefusedError('The proxy refused the connection (HTTP 429, empty body)');
      trace.recordError('fast', attempt, err, startedAt, { status, detail: 'proxy refused', tokenAgeMs, lane: lane.id });
      return { kind: 'refused', err };
    }

    // 202 and 405 are AWS WAF's challenge and CAPTCHA: Redfin didn't accept the token
    const blockedBy = finalUrl.includes('ratelimited.redfin.com') ? 'ratelimited redirect' : isCaptchaOrBlockPage(text) ? 'block page' : undefined;
    if (BLOCK_STATUSES.has(status) || status === 202 || blockedBy) {
      trace.record('fast', attempt, 'blocked', startedAt, { status, detail: blockedBy, tokenAgeMs, lane: lane.id });
      outcome = 'blocked';
      return { kind: 'blocked', status, finalUrl };
    }

    let data: unknown;
    try {
      data = JSON.parse(text.trim().replace(/^\{\}&&/, ''));
    } catch {
      const err = new InvalidResponseError(`Redfin answered HTTP ${status} with a body that isn't JSON`);
      trace.recordError('fast', attempt, err, startedAt, { status, tokenAgeMs, lane: lane.id });
      return { kind: 'error', err };
    }

    const ok = status >= 200 && status < 300;
    trace.record('fast', attempt, ok ? 'ok' : 'http_error', startedAt, { status, tokenAgeMs, lane: lane.id });
    if (ok) outcome = 'ok';
    return { kind: 'ok', result: { status, data } };
  } catch (err) {
    trace.recordError('fast', attempt, err, startedAt, { tokenAgeMs, lane: lane.id });
    return { kind: 'error', err };
  } finally {
    lane.end(outcome, sentToken, 'fetch');
    await requestContext?.dispose().catch(() => {});
  }
}

// Redfin directly, never Bright Data: it refuses every /stingray/ URL (see brightDataRefusal). A block moves the retry to
// another lane at once, while the blocked lane gets a new token through its own IP in the background.
async function fetchRedfinLayers(url: string, trace: RequestTrace): Promise<FetchResult> {
  let lane = pickRedfinLane();
  let lastBlock: { status: number; finalUrl: string } | null = null;
  let lastRefusal: ProxyRefusedError | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 2) lane = pickRedfinLane(lane);
    if (!lane.hasToken()) {
      await waitForCookieRefresh(lane, trace, attempt);
    } else if (lane.needsRefreshSoon()) {
      // An old token is used as it is, since one past 20 minutes still got through 8 of 10 times in production
      // (2026-10-23/24); the refresh runs alongside, and a block still moves the retry to another lane
      lane.refreshInBackground();
    }
    // Without a token Redfin refuses every /stingray/ URL (403, 2026-10-27), so nothing is sent
    if (!lane.hasToken()) continue;

    const direct = await fetchRedfinDirect(url, lane, trace, attempt);
    if (direct.kind === 'ok') {
      recordScrapeResult(url, true, false, 'redfin_fetch');
      updateCircuitOnSuccess('redfin_fetch');
      return direct.result;
    }
    if (direct.kind === 'error') {
      throw direct.err;
    }
    if (direct.kind === 'refused') {
      // Not Redfin: the lane keeps its token, and the retry goes to another IP
      lastRefusal = direct.err;
      console.warn(`[Fetcher] The proxy refused Redfin lane ${lane.id}${attempt === 1 ? ', retrying on another lane' : ''}`);
      continue;
    }
    lastBlock = direct;
    console.warn(`[Fetcher] Redfin lane ${lane.id} blocked with status ${direct.status}${attempt === 1 ? ', retrying on another lane' : ''}`);
  }

  if (lastBlock === null) {
    // Redfin refused nothing, so the circuit is left alone
    if (lastRefusal) throw lastRefusal;
    throw new TargetBlockedError(503, 'No Redfin token: every lane is refreshing or backing off');
  }
  console.warn(`[Fetcher] Target blocked with status ${lastBlock.status}, url: ${lastBlock.finalUrl}`);
  recordScrapeResult(url, false, true, 'redfin_fetch');
  updateCircuitOnBlock('redfin_fetch');
  throw new TargetBlockedError(429, `Target page returned HTTP status ${lastBlock.status}`);
}

// Errors leave /fetch as a block, an open circuit, a timeout, an invalid response, or as they are
function toFetchError(err: any, url: string): unknown {
  if (err instanceof TargetBlockedError || err instanceof CircuitOpenError || err instanceof FetchTimeoutError || err instanceof InvalidResponseError || err instanceof ProxyRefusedError) {
    return err;
  }
  const msg = err?.message?.toLowerCase() || '';
  if (err?.name === 'TimeoutError' || msg.includes('timeout') || msg.includes('timed out')) {
    console.warn(`[Fetcher] Request timed out for URL: ${url}`);
    return new FetchTimeoutError('Request timed out');
  }
  return err;
}

async function executeFetchRequest(url: string, trace: RequestTrace): Promise<FetchResult> {
  const parsed = new URL(url);
  if (parsed.pathname.startsWith('/zipcode/')) {
    return await renderZipcodePage(url, trace);
  }

  try {
    return await fetchRedfinLayers(url, trace);
  } catch (err) {
    throw toFetchError(err, url);
  }
}

async function fetchRedfinWithQueue(url: string, trace: RequestTrace): Promise<FetchResult> {
  const circuit = checkCircuit('redfin_fetch');
  if (circuit === 'open') {
    console.log(`[Circuit Breaker] Skipping fetch for ${url} (Circuit is OPEN).`);
    recordScrapeResult(url, false, true, 'redfin_fetch');
    throw new CircuitOpenError(429, `Target page returned HTTP status 429 [Circuit is OPEN]`);
  }

  const QUEUE_WAIT_TIMEOUT_MS = 90000;
  let timerId: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      reject(new TargetBlockedError(429, 'Request timed out waiting in queue (90s budget exceeded)'));
    }, QUEUE_WAIT_TIMEOUT_MS);
  });

  const worker = async () => {
    const queueStart = Date.now();
    await redfinSemaphores.fetch.acquire();
    try {
      await paceRedfinRequest('fetch');
      trace.record('redfin_queue', 0, 'ok', queueStart);
      return await executeFetchRequest(url, trace);
    } finally {
      redfinSemaphores.fetch.release();
    }
  };

  try {
    return await Promise.race([worker(), timeoutPromise]);
  } finally {
    clearTimeout(timerId!);
  }
}

// Proxied JSON fetch API endpoint for Redfin search data
app.post('/fetch', async (req: Request, res: Response) => {
  // Simple Authorization header check
  if (ACCESS_KEY) {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${ACCESS_KEY}`) {
      console.warn(`[Fetcher] Unauthorized access attempt blocked.`);
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const { url } = req.body;
  if (!url || typeof url !== 'string' || !isAllowedFetchUrl(url)) {
    return res.status(400).json({ error: 'url not allowed', reason: 'not_allowed' });
  }

  const trace = new RequestTrace('/fetch', url, 'redfin');
  try {
    const result = await fetchRedfinWithQueue(url, trace);
    return res.status(200).json({ status: 200, data: result.data });
  } catch (error) {
    console.error(`[Fetcher] Fetch failed for ${url}:`, error);
    trace.error = errorDetail(error);

    if (error instanceof CircuitOpenError) {
      trace.reason = 'circuit_open';
      res.statusMessage = error.message;
      res.status(429).json({
        error: error.message,
        reason: 'circuit_open',
        status: 429
      });
    } else if (error instanceof TargetBlockedError) {
      trace.reason = 'target_blocked';
      res.statusMessage = toStatusMessage(error.message);
      res.status(error.status || 429).json({
        error: error.message,
        reason: 'target_blocked',
        status: error.status || 429
      });
    } else if (error instanceof FetchTimeoutError) {
      trace.reason = 'timeout';
      res.status(504).json({
        reason: 'timeout'
      });
    } else if (error instanceof ProxyRefusedError) {
      trace.reason = 'proxy_refused';
      res.status(503).json({
        error: error.message,
        reason: 'proxy_refused',
        status: 503
      });
    } else if (error instanceof InvalidResponseError) {
      trace.reason = 'invalid_response';
      res.status(502).json({
        error: error.message,
        reason: 'invalid_response',
        status: 502
      });
    } else {
      trace.reason = 'resolver_error';
      res.status(500).json({
        error: (error as Error).message,
        reason: 'resolver_error'
      });
    }
  } finally {
    trace.log(res.statusCode);
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
    redfinLanes: redfinLanes.map((lane) => lane.status()),
    layers: getLayerStats(),
  });
});

app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`Stealth Scraper Server running on port ${PORT}`);
});
