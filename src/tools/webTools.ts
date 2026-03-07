import { FunctionDeclaration } from '@google/genai';
import { Browser, chromium, Page } from 'playwright';

let browser: Browser | null = null;
let activePage: Page | null = null;

export const webToolDeclarations: FunctionDeclaration[] = [
    { name: 'navigate_to_url', description: 'Navigates the browser to a specific URL.', parametersJsonSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    { name: 'get_page_text', description: 'Extracts the current webpage as structured Markdown. Links will appear as [Text](url) and buttons as [BUTTON: Text]. Use this to understand page hierarchy and find exact URLs to navigate to.', parametersJsonSchema: { type: 'object', properties: {} } },
    { name: 'search_web', description: 'Searches the web for a query.', parametersJsonSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'click_element', description: 'Clicks a button or link based on its visible text.', parametersJsonSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'type_text', description: 'Types text into an input field using CSS selectors.', parametersJsonSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' } }, required: ['selector', 'text'] } },
    { name: 'press_key', description: 'Presses a keyboard key (e.g., "Enter", "Escape").', parametersJsonSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
    { name: 'take_screenshot', description: 'Takes a screenshot of the current browser tab.', parametersJsonSchema: { type: 'object', properties: {} } }
];

async function ensureBrowser(): Promise<Page> {
    if (!browser) {
        console.log("\n🤖 Agent initializing browser on-demand...");
        browser = await chromium.launch({ headless: false, channel: 'chrome' });
        activePage = await browser.newPage();
        console.log("🌐 Browser ready!\n");
    } else if (activePage) {
        activePage = activePage.context().pages().at(-1) || activePage;
    }
    if (activePage) await activePage.bringToFront();
    return activePage!;
}

export async function closeBrowser() {
    if (browser) await browser.close();
}

export async function executeWebTool(call: any): Promise<{ result: string, base64Image?: string }> {
    let toolResult = "";
    let base64Image: string | undefined = undefined;

    try {
        const page = await ensureBrowser();

        switch (call.name) {
            case 'navigate_to_url':
                console.log(`🌐  Navigating to: \x1b[36m${call.args.url}\x1b[0m`);
                await page.goto(call.args.url as string, { waitUntil: 'domcontentloaded' });
                toolResult = `Mapsd to ${call.args.url}. Call get_page_text to read it.`;
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
            case 'search_web':
                console.log(`🔍  Searching web for: \x1b[36m${call.args.query}\x1b[0m`);
                await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(call.args.query as string)}`, { waitUntil: 'domcontentloaded' });
                toolResult = `Search completed. Text: ${await page.evaluate(() => document.body.innerText)}`;
                break;
            case 'click_element':
                console.log(`🖱️  Clicking text: \x1b[36m${call.args.text}\x1b[0m`);
                await page.getByText(call.args.text as string, { exact: false }).first().click();
                await page.waitForLoadState('domcontentloaded');
                toolResult = `Clicked '${call.args.text}'. Screen may have changed.`;
                break;
            case 'type_text':
                console.log(`⌨️  Typing into: \x1b[36m${call.args.selector}\x1b[0m`);
                await page.locator(call.args.selector as string).first().fill(call.args.text as string);
                toolResult = `Typed into '${call.args.selector}'.`;
                break;
            case 'press_key':
                console.log(`⌨️  Pressing key: \x1b[35m${call.args.key}\x1b[0m`);
                await page.keyboard.press(call.args.key as string);
                await page.waitForTimeout(1000);
                toolResult = `Pressed '${call.args.key}'.`;
                break;
            case 'take_screenshot':
                console.log(`📸  Taking screenshot...`);
                const buffer = await page.screenshot({ type: 'jpeg', quality: 80 });
                base64Image = buffer.toString('base64');
                toolResult = `Screenshot taken. Check inlineData.`;
                break;
            default:
                toolResult = `Tool ${call.name} not found in webTools.`;
        }
    } catch (error: any) {
        toolResult = `Failed to execute ${call.name}: ${error.message}`;
    }

    return { result: toolResult, base64Image };
}