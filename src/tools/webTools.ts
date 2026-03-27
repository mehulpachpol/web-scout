import crypto from 'crypto';
import * as fs from 'fs/promises';
import OpenAI from 'openai';
import * as os from 'os';
import * as path from 'path';
import { Browser, chromium, Page } from 'playwright';

let browser: Browser | null = null;
let activePage: Page | null = null;
let currentAbortSignal: AbortSignal | undefined = undefined;
const DEBUG = process.env.SCOUT_DEBUG === '1' || process.argv.includes('--debug');
const debugLog = (...args: any[]) => { if (DEBUG) console.log(...args); };

function webScoutDir() {
    return path.join(os.homedir(), '.web-scout');
}

function cacheDir() {
    return path.join(webScoutDir(), 'cache', 'web');
}

function telemetryPath() {
    return path.join(webScoutDir(), 'telemetry', 'web.jsonl');
}

async function appendTelemetry(entry: any) {
    try {
        await fs.mkdir(path.dirname(telemetryPath()), { recursive: true });
        await fs.appendFile(telemetryPath(), `${JSON.stringify(entry)}\n`, 'utf-8');
    } catch {
    }
}

function sha1(input: string) {
    return crypto.createHash('sha1').update(input).digest('hex');
}

type CacheEntry<T> = { createdAt: string; expiresAt: string; value: T };

async function readCache<T>(key: string): Promise<T | null> {
    try {
        const p = path.join(cacheDir(), `${sha1(key)}.json`);
        const raw = await fs.readFile(p, 'utf-8');
        const parsed = JSON.parse(raw) as CacheEntry<T>;
        if (!parsed?.expiresAt) return null;
        const exp = new Date(parsed.expiresAt);
        if (Number.isNaN(exp.getTime()) || exp.getTime() < Date.now()) return null;
        return parsed.value ?? null;
    } catch {
        return null;
    }
}

async function writeCache<T>(key: string, value: T, ttlMs: number) {
    try {
        await fs.mkdir(cacheDir(), { recursive: true });
        const p = path.join(cacheDir(), `${sha1(key)}.json`);
        const entry: CacheEntry<T> = {
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + ttlMs).toISOString(),
            value
        };
        await fs.writeFile(p, JSON.stringify(entry), 'utf-8');
    } catch {
    }
}

function sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
}

function decodeHtmlEntities(input: string): string {
    return input
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(input: string): string {
    return input.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeDuckDuckGoHref(href: string): string {
    const withScheme = href.startsWith('//') ? `https:${href}` : href;

    try {
        const url = new URL(withScheme);
        const uddg = url.searchParams.get('uddg');
        if (uddg) return decodeURIComponent(uddg);
        return withScheme;
    } catch {
        return withScheme;
    }
}

function extractGoogleSearchQuery(urlString: string): string | null {
    try {
        const url = new URL(urlString);
        const host = url.hostname.toLowerCase();
        const isGoogle = host === 'google.com' || host.endsWith('.google.com');
        if (!isGoogle) return null;

        if (url.pathname !== '/search') return null;
        const q = url.searchParams.get('q');
        return q && q.trim() ? q.trim() : null;
    } catch {
        return null;
    }
}

type WebSearchResult = { title: string; url: string; snippet: string };

const backoffUntilByHost = new Map<string, number>();

function getHost(urlString: string): string | null {
    try {
        return new URL(urlString).hostname.toLowerCase();
    } catch {
        return null;
    }
}

function isBackedOff(urlString: string) {
    const host = getHost(urlString);
    if (!host) return false;
    const until = backoffUntilByHost.get(host) || 0;
    return until > Date.now();
}

function noteRateLimit(urlString: string, retryAfterSeconds?: number) {
    const host = getHost(urlString);
    if (!host) return;
    const ms = Math.max(30_000, (retryAfterSeconds ? retryAfterSeconds * 1000 : 90_000));
    backoffUntilByHost.set(host, Date.now() + ms);
}

async function duckDuckGoHtmlSearchResults(query: string, maxResults = 6): Promise<WebSearchResult[]> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const tryFetchOnce = async () => {
        if (isBackedOff(url)) {
            throw new Error('Rate-limited (backoff active).');
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        const started = Date.now();
        if (currentAbortSignal) currentAbortSignal.addEventListener('abort', () => controller.abort(), { once: true });
        try {
            const res = await fetch(url, {
                method: 'GET',
                headers: {
                    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'accept': 'text/html,application/xhtml+xml',
                    'accept-language': 'en-US,en;q=0.9',
                },
                signal: controller.signal
            });
            const html = await res.text();
            if (res.status === 429) {
                const ra = Number(res.headers.get('retry-after') || '');
                noteRateLimit(url, Number.isFinite(ra) ? ra : undefined);
                throw new Error(`HTTP 429`);
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await appendTelemetry({ ts: new Date().toISOString(), op: 'search', provider: 'ddg_html', query, status: res.status, ms: Date.now() - started });
            return html;
        } catch (e: any) {
            await appendTelemetry({ ts: new Date().toISOString(), op: 'search', provider: 'ddg_html', query, status: 'error', ms: Date.now() - started, error: e?.message || String(e) });
            throw e;
        } finally {
            clearTimeout(timeout);
        }
    };

    let html = '';
    let lastErr: any = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            html = await tryFetchOnce();
            break;
        } catch (e: any) {
            lastErr = e;
            await sleep(350 * attempt);
        }
    }
    if (!html) throw lastErr || new Error('Failed to fetch search results.');

    const titleRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    const titles: { title: string; href: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = titleRegex.exec(html)) && titles.length < maxResults) {
        const href = normalizeDuckDuckGoHref(decodeHtmlEntities(m[1]));
        const title = stripTags(decodeHtmlEntities(m[2]));
        if (!title) continue;
        titles.push({ title, href });
    }

    const snippets: string[] = [];
    while ((m = snippetRegex.exec(html)) && snippets.length < maxResults) {
        const snippet = stripTags(decodeHtmlEntities(m[1]));
        snippets.push(snippet);
    }

    const results: WebSearchResult[] = [];
    for (let i = 0; i < titles.length; i++) {
        results.push({
            title: titles[i].title,
            url: titles[i].href,
            snippet: snippets[i] || ''
        });
    }
    return results;
}

async function duckDuckGoLiteSearchResults(query: string, maxResults = 6): Promise<WebSearchResult[]> {
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    if (isBackedOff(url)) throw new Error('Rate-limited (backoff active).');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const started = Date.now();
    if (currentAbortSignal) currentAbortSignal.addEventListener('abort', () => controller.abort(), { once: true });
    try {
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'accept': 'text/html,application/xhtml+xml',
                'accept-language': 'en-US,en;q=0.9',
            },
            signal: controller.signal
        });
        const html = await res.text();
        if (res.status === 429) {
            const ra = Number(res.headers.get('retry-after') || '');
            noteRateLimit(url, Number.isFinite(ra) ? ra : undefined);
            throw new Error(`HTTP 429`);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const linkRegex = /<a[^>]*href=\"([^\"]+)\"[^>]*>([\s\S]*?)<\/a>/gi;
        const results: WebSearchResult[] = [];
        let m: RegExpExecArray | null;
        while ((m = linkRegex.exec(html)) && results.length < maxResults) {
            const href = normalizeDuckDuckGoHref(decodeHtmlEntities(m[1]));
            const title = stripTags(decodeHtmlEntities(m[2]));
            if (!title) continue;
            if (!/^https?:\/\//i.test(href)) continue;
            results.push({ title, url: href, snippet: '' });
        }

        await appendTelemetry({ ts: new Date().toISOString(), op: 'search', provider: 'ddg_lite', query, status: res.status, ms: Date.now() - started });
        return results.slice(0, maxResults);
    } catch (e: any) {
        await appendTelemetry({ ts: new Date().toISOString(), op: 'search', provider: 'ddg_lite', query, status: 'error', ms: Date.now() - started, error: e?.message || String(e) });
        throw e;
    } finally {
        clearTimeout(timeout);
    }
}

async function duckDuckGoBrowserSearchResults(query: string, maxResults = 6): Promise<WebSearchResult[]> {
    const started = Date.now();
    try {
        const page = await ensureBrowser();
        await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1200);

        const results = await page.evaluate((max) => {
            const items = Array.from(document.querySelectorAll('a[data-testid="result-title-a"], a.result__a')) as HTMLAnchorElement[];
            const out: { title: string; url: string; snippet: string }[] = [];
            for (const a of items) {
                const title = (a.textContent || '').trim();
                const url = a.href;
                if (!title || !url) continue;
                if (out.some(x => x.url === url)) continue;
                out.push({ title, url, snippet: '' });
                if (out.length >= max) break;
            }
            return out;
        }, maxResults);

        await appendTelemetry({ ts: new Date().toISOString(), op: 'search', provider: 'ddg_browser', query, status: 'ok', ms: Date.now() - started });
        return results;
    } catch (e: any) {
        await appendTelemetry({ ts: new Date().toISOString(), op: 'search', provider: 'ddg_browser', query, status: 'error', ms: Date.now() - started, error: e?.message || String(e) });
        throw e;
    }
}

async function searchWebResults(query: string, maxResults = 6): Promise<WebSearchResult[]> {
    const q = String(query || '').trim();
    const key = `search:v1:${q}:${maxResults}`;
    const cached = await readCache<WebSearchResult[]>(key);
    if (cached && Array.isArray(cached) && cached.length > 0) {
        await appendTelemetry({ ts: new Date().toISOString(), op: 'search', provider: 'cache', query: q, status: 'hit' });
        return cached.slice(0, maxResults);
    }

    const providers = [
        async () => await duckDuckGoHtmlSearchResults(q, maxResults),
        async () => await duckDuckGoLiteSearchResults(q, maxResults),
        async () => await duckDuckGoBrowserSearchResults(q, maxResults)
    ];

    let lastErr: any = null;
    for (const p of providers) {
        try {
            const res = await p();
            if (res && res.length > 0) {
                await writeCache(key, res, 6 * 60 * 60 * 1000);
                return res.slice(0, maxResults);
            }
        } catch (e: any) {
            lastErr = e;
        }
    }

    throw lastErr || new Error('Search failed.');
}

async function duckDuckGoHtmlSearch(query: string, maxResults = 6): Promise<string> {
    const results = await searchWebResults(query, maxResults);

    if (results.length === 0) {
        return `No structured results found for "${query}".`;
    }

    const lines: string[] = [];
    lines.push(`Web search results for "${query}":`);
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        lines.push(`${i + 1}. ${r.title}`);
        lines.push(`   ${r.url}`);
        if (r.snippet) lines.push(`   ${r.snippet}`);
    }
    return lines.join('\n');
}

function htmlToPlainText(html: string): string {
    const noScript = html
        .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');

    const withBreaks = noScript
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|section|article|header|footer|main|li|h[1-6]|tr)>/gi, '\n')
        .replace(/<(p|div|section|article|header|footer|main|ul|ol|li|h[1-6]|table|tr|td)[^>]*>/gi, '\n');

    return stripTags(decodeHtmlEntities(withBreaks))
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

async function fetchUrlText(url: string, maxChars = 12000): Promise<string> {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return `Unsupported URL scheme: ${u}`;

    const key = `fetch:v2:${u}:${maxChars}`;
    const cached = await readCache<string>(key);
    if (cached) {
        await appendTelemetry({ ts: new Date().toISOString(), op: 'fetch', provider: 'cache', url: u, status: 'hit' });
        return cached;
    }

    const tryHttpFetch = async (): Promise<string> => {
        if (isBackedOff(u)) throw new Error('Rate-limited (backoff active).');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 25000);
        const started = Date.now();
        if (currentAbortSignal) currentAbortSignal.addEventListener('abort', () => controller.abort(), { once: true });
        try {
            const res = await fetch(u, {
                method: 'GET',
                redirect: 'follow',
                headers: {
                    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'accept': 'text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.8',
                    'accept-language': 'en-US,en;q=0.9',
                },
                signal: controller.signal
            });

            if (res.status === 429) {
                const ra = Number(res.headers.get('retry-after') || '');
                noteRateLimit(u, Number.isFinite(ra) ? ra : undefined);
                throw new Error('HTTP 429');
            }

            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }

            const contentType = res.headers.get('content-type') || '';
            const raw = await res.text();

            const text = /text\/html|application\/xhtml\+xml/i.test(contentType)
                ? htmlToPlainText(raw)
                : raw.replace(/\r\n/g, '\n').trim();

            const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}\n...[TRUNCATED]...` : text;
            const out = `URL: ${u}\nStatus: ${res.status}\nContent-Type: ${contentType || 'unknown'}\n\n${clipped}`;
            await appendTelemetry({ ts: new Date().toISOString(), op: 'fetch', provider: 'http', url: u, status: res.status, ms: Date.now() - started });
            return out;
        } catch (e: any) {
            await appendTelemetry({ ts: new Date().toISOString(), op: 'fetch', provider: 'http', url: u, status: 'error', ms: Date.now() - started, error: e?.message || String(e) });
            throw e;
        } finally {
            clearTimeout(timeout);
        }
    };

    let httpOut: string | null = null;
    let lastErr: any = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            httpOut = await tryHttpFetch();
            break;
        } catch (e: any) {
            lastErr = e;
            await sleep(300 * attempt);
        }
    }

    if (httpOut) {
        await writeCache(key, httpOut, 12 * 60 * 60 * 1000);
        return httpOut;
    }

    // Fallback: render in browser and extract visible text (handles bot-blocked sites).
    const started = Date.now();
    try {
        const page = await ensureBrowser();
        await page.goto(u, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1200);
        const text = await page.evaluate(() => (document.body?.innerText || '').replace(/\r\n/g, '\n'));
        const cleaned = String(text || '').trim();
        const clipped = cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}\n...[TRUNCATED]...` : cleaned;
        const out = `URL: ${u}\nStatus: browser\nContent-Type: rendered\n\n${clipped}`;
        await appendTelemetry({ ts: new Date().toISOString(), op: 'fetch', provider: 'browser', url: u, status: 'ok', ms: Date.now() - started, error: lastErr?.message || undefined });
        await writeCache(key, out, 12 * 60 * 60 * 1000);
        return out;
    } catch (e: any) {
        await appendTelemetry({ ts: new Date().toISOString(), op: 'fetch', provider: 'browser', url: u, status: 'error', ms: Date.now() - started, error: e?.message || String(e), prior: lastErr?.message || String(lastErr || '') });
        return `Failed to fetch URL: ${u}\nError: ${e?.message || String(e)}`;
    }
}

async function researchWeb(query: string, maxSources = 3, maxCharsPerSource = 6000): Promise<string> {
    const key = `research:v1:${String(query || '').trim()}:${maxSources}:${maxCharsPerSource}`;
    const cached = await readCache<string>(key);
    if (cached) {
        await appendTelemetry({ ts: new Date().toISOString(), op: 'research', provider: 'cache', query, status: 'hit' });
        return cached;
    }

    const results = await searchWebResults(query, Math.max(3, maxSources));
    const selected = results.slice(0, maxSources);

    const lines: string[] = [];
    lines.push(`Research bundle for "${query}"`);
    lines.push('');
    lines.push('Sources:');
    for (let i = 0; i < selected.length; i++) {
        const r = selected[i];
        lines.push(`${i + 1}. ${r.title}`);
        lines.push(`   ${r.url}`);
        if (r.snippet) lines.push(`   ${r.snippet}`);
    }

    if (selected.length === 0) return lines.join('\n');

    lines.push('');
    lines.push('Extracts (truncated):');
    for (let i = 0; i < selected.length; i++) {
        const r = selected[i];
        try {
            const text = await fetchUrlText(r.url, maxCharsPerSource);
            lines.push('');
            lines.push(`[${i + 1}] ${r.url}`);
            lines.push(text);
        } catch (e: any) {
            lines.push('');
            lines.push(`[${i + 1}] ${r.url}`);
            lines.push(`Failed to fetch source: ${e?.message || String(e)}`);
        }
    }

    const out = lines.join('\n');
    await writeCache(key, out, 3 * 60 * 60 * 1000);
    return out;
}

export const webToolDeclarations: OpenAI.Chat.ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'navigate_to_url',
            description: 'Navigates the browser to a specific URL. Do NOT use this for Google/Bing search result pages; use search_web for searching.',
            parameters: {
                type: 'object',
                properties: { url: { type: 'string' } },
                required: ['url'],
                additionalProperties: false
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_page_text',
            description: 'Extracts the current webpage as structured Markdown. Links will appear as [Text](url) and buttons as [BUTTON: Text]. Use this to understand page hierarchy and find exact URLs to navigate to.',
            parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_web',
            description: 'Searches the web for a query (reliable, no CAPTCHA). Use this instead of navigating to Google/Bing search pages.',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query'],
                additionalProperties: false
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'fetch_url_text',
            description: 'Fetches a URL and extracts readable text (no browser). Use this to read articles for research and then write a final summary/comparison.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string' },
                    max_chars: { type: 'number', description: 'Optional cap for returned text.' }
                },
                required: ['url'],
                additionalProperties: false
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'research_web',
            description: 'Performs web research: search + fetch top sources + return extracted text. Use this for comparisons/reviews so you can produce a final write-up (not just links).',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string' },
                    max_sources: { type: 'number', description: 'How many sources to fetch (default 3).' },
                    max_chars_per_source: { type: 'number', description: 'Per-source text cap (default 6000).' }
                },
                required: ['query'],
                additionalProperties: false
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'click_element',
            description: 'Clicks a button or link based on its visible text.',
            parameters: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
                additionalProperties: false
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'type_text',
            description: 'Types text into an input field using CSS selectors.',
            parameters: {
                type: 'object',
                properties: { selector: { type: 'string' }, text: { type: 'string' } },
                required: ['selector', 'text'],
                additionalProperties: false
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'press_key',
            description: 'Presses a keyboard key (e.g., "Enter", "Escape").',
            parameters: {
                type: 'object',
                properties: { key: { type: 'string' } },
                required: ['key'],
                additionalProperties: false
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'take_screenshot',
            description: 'Takes a screenshot of the current browser tab.',
            parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false
            }
        }
    }
];

async function ensureBrowser(): Promise<Page> {
    if (!browser) {
        debugLog("\n🤖 Agent initializing browser on-demand...");
        const headless = process.env.WEBTOOLS_HEADLESS !== 'false';
        const channel = process.env.WEBTOOLS_CHANNEL || 'chrome';

        try {
            browser = await chromium.launch({ headless, channel });
        } catch {
            browser = await chromium.launch({ headless });
        }

        activePage = await browser.newPage({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        });
        activePage.setDefaultTimeout(30000);
        activePage.setDefaultNavigationTimeout(45000);
        debugLog("🌐 Browser ready!\n");
    } else if (activePage) {
        activePage = activePage.context().pages().at(-1) || activePage;
    }
    if (activePage) await activePage.bringToFront();
    return activePage!;
}

export async function closeBrowser() {
    if (browser) await browser.close();
    browser = null;
    activePage = null;
}

export async function executeWebTool(name: string, args: any, abortSignal?: AbortSignal): Promise<{ result: string, base64Image?: string }> {
    let toolResult = "";
    let base64Image: string | undefined = undefined;

    try {
        currentAbortSignal = abortSignal;
        if (abortSignal?.aborted) throw new Error('Aborted by user.');
        if (name === 'navigate_to_url') {
            const url = String(args?.url ?? '');
            const googleQuery = extractGoogleSearchQuery(url);
            if (googleQuery) {
                toolResult = await duckDuckGoHtmlSearch(googleQuery);
                toolResult += `\n\nNote: Google Search pages frequently block automation. Prefer calling search_web directly, then navigate_to_url to a specific result URL.`;
                return { result: toolResult };
            }
        }

        if (name === 'search_web') {
            toolResult = await duckDuckGoHtmlSearch(args.query as string);
            return { result: toolResult };
        }

        if (name === 'fetch_url_text') {
            const maxChars = typeof args.max_chars === 'number' ? args.max_chars : 12000;
            toolResult = await fetchUrlText(String(args.url), maxChars);
            return { result: toolResult };
        }

        if (name === 'research_web') {
            const maxSources = typeof args.max_sources === 'number' ? args.max_sources : 3;
            const maxCharsPerSource = typeof args.max_chars_per_source === 'number' ? args.max_chars_per_source : 6000;
            toolResult = await researchWeb(String(args.query), maxSources, maxCharsPerSource);
            return { result: toolResult };
        }

        const page = await ensureBrowser();

        switch (name) {
            case 'navigate_to_url':
                debugLog(`🌐  Navigating to: \x1b[36m${args.url}\x1b[0m`);
                await page.goto(args.url as string, { waitUntil: 'domcontentloaded' });
                toolResult = `Mapped to ${args.url}. Call get_page_text to read it.`;
                break;
            case 'get_page_text':
                debugLog(`📄  Reading page structure and converting to Markdown...`);

                toolResult = await page.evaluate(() => {
                    function domToMarkdown(node: any): string {
                        if (node.nodeType === 3) {
                            return (node.textContent || '').replace(/\s+/g, ' ');
                        }
                        if (node.nodeType !== 1) return '';

                        const tag = (node.tagName || '').toLowerCase();

                        if (['script', 'style', 'noscript', 'svg', 'img', 'iframe', 'canvas', 'video'].includes(tag)) return '';

                        if (tag !== 'body' && node.offsetParent === null) {
                            try {
                                if (window.getComputedStyle(node).position !== 'fixed') return '';
                            } catch (e) { return ''; }
                        }

                        let md = '';
                        if (node.childNodes) {
                            for (let child of Array.from(node.childNodes)) {
                                md += domToMarkdown(child);
                            }
                        }
                        md = md.trim();
                        if (!md) return '';

                        if (tag === 'a') {
                            const href = node.href;
                            if (href && !href.startsWith('javascript:')) {
                                return ` [${md}](${href}) `;
                            }
                            return ` [${md}] `;
                        } else if (tag === 'button') {
                            return ` [BUTTON: ${md}] `;
                        } else if (/^h[1-6]$/.test(tag)) {
                            const level = parseInt(tag.charAt(1));
                            return `\n\n${'#'.repeat(level)} ${md}\n\n`;
                        } else if (['p', 'div', 'section', 'article', 'ul', 'ol'].includes(tag)) {
                            return `\n${md}\n`;
                        } else if (tag === 'li') {
                            return `\n* ${md}`;
                        }

                        return md;
                    }

                    try {
                        return domToMarkdown(document.body).replace(/\n{3,}/g, '\n\n').trim();
                    } catch (error: any) {
                        console.error("Markdown parser failed, falling back to innerText", error);
                        return document.body.innerText;
                    }
                });
                break;
            case 'click_element':
                debugLog(`🖱️  Clicking text: \x1b[36m${args.text}\x1b[0m`);
                await page.getByText(args.text as string, { exact: false }).first().click();
                await page.waitForLoadState('domcontentloaded');
                toolResult = `Clicked '${args.text}'. Screen may have changed.`;
                break;
            case 'type_text':
                debugLog(`⌨️  Typing into: \x1b[36m${args.selector}\x1b[0m`);
                await page.locator(args.selector as string).first().fill(args.text as string);
                toolResult = `Typed into '${args.selector}'.`;
                break;
            case 'press_key':
                debugLog(`⌨️  Pressing key: \x1b[35m${args.key}\x1b[0m`);
                await page.keyboard.press(args.key as string);
                await page.waitForTimeout(1000);
                toolResult = `Pressed '${args.key}'.`;
                break;
            case 'take_screenshot':
                debugLog(`📸  Taking screenshot...`);
                const buffer = await page.screenshot({ type: 'jpeg', quality: 80 });
                base64Image = buffer.toString('base64');
                toolResult = `Screenshot taken. Check inlineData.`;
                break;
            default:
                toolResult = `Tool ${name} not found in webTools.`;
        }
    } catch (error: any) {
        if (browser && /Target closed|has been closed|browser has disconnected|Navigation failed|net::/i.test(String(error?.message || ''))) {
            try {
                await closeBrowser();
            } catch { }
        }
        toolResult = `Failed to execute ${name}: ${error.message}`;
    } finally {
        currentAbortSignal = undefined;
    }

    return { result: toolResult, base64Image };
}
