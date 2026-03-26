import OpenAI from 'openai';
import { Browser, chromium, Page } from 'playwright';

let browser: Browser | null = null;
let activePage: Page | null = null;

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

async function duckDuckGoHtmlSearch(query: string, maxResults = 6): Promise<string> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const tryFetchOnce = async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
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
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return html;
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

    if (titles.length === 0) {
        const textFallback = stripTags(html).slice(0, 2500);
        return `No structured results found for "${query}". Raw page text (truncated):\n${textFallback}`;
    }

    const lines: string[] = [];
    lines.push(`Web search results for "${query}":`);
    for (let i = 0; i < titles.length; i++) {
        const t = titles[i];
        const s = snippets[i] || '';
        lines.push(`${i + 1}. ${t.title}`);
        lines.push(`   ${t.href}`);
        if (s) lines.push(`   ${s}`);
    }
    return lines.join('\n');
}

export const webToolDeclarations: OpenAI.Chat.ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'navigate_to_url',
            description: 'Navigates the browser to a specific URL.',
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
            description: 'Searches the web for a query.',
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
        console.log("\n🤖 Agent initializing browser on-demand...");
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
        console.log("🌐 Browser ready!\n");
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

export async function executeWebTool(name: string, args: any): Promise<{ result: string, base64Image?: string }> {
    let toolResult = "";
    let base64Image: string | undefined = undefined;

    try {
        if (name === 'search_web') {
            toolResult = await duckDuckGoHtmlSearch(args.query as string);
            return { result: toolResult };
        }

        const page = await ensureBrowser();

        switch (name) {
            case 'navigate_to_url':
                console.log(`🌐  Navigating to: \x1b[36m${args.url}\x1b[0m`);
                await page.goto(args.url as string, { waitUntil: 'domcontentloaded' });
                toolResult = `Mapped to ${args.url}. Call get_page_text to read it.`;
                break;
            case 'get_page_text':
                console.log(`📄  Reading page structure and converting to Markdown...`);

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
                console.log(`🖱️  Clicking text: \x1b[36m${args.text}\x1b[0m`);
                await page.getByText(args.text as string, { exact: false }).first().click();
                await page.waitForLoadState('domcontentloaded');
                toolResult = `Clicked '${args.text}'. Screen may have changed.`;
                break;
            case 'type_text':
                console.log(`⌨️  Typing into: \x1b[36m${args.selector}\x1b[0m`);
                await page.locator(args.selector as string).first().fill(args.text as string);
                toolResult = `Typed into '${args.selector}'.`;
                break;
            case 'press_key':
                console.log(`⌨️  Pressing key: \x1b[35m${args.key}\x1b[0m`);
                await page.keyboard.press(args.key as string);
                await page.waitForTimeout(1000);
                toolResult = `Pressed '${args.key}'.`;
                break;
            case 'take_screenshot':
                console.log(`📸  Taking screenshot...`);
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
    }

    return { result: toolResult, base64Image };
}
