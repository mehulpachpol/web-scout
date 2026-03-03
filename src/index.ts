import { FunctionDeclaration, GoogleGenAI } from '@google/genai';
import { exec } from 'child_process';
import { Browser, chromium, Page } from 'playwright';
import * as readline from 'readline';
import { promisify } from 'util';

const execAsync = promisify(exec);

const ai = new GoogleGenAI({ apiKey: "" });

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const askQuestion = (query: string): Promise<string> => {
    return new Promise((resolve) => rl.question(query, resolve));
};

function speakText(text: string) {
    const cleanText = text
        .replace(/[\u{1F600}-\u{1F6FF}|\u{2600}-\u{26FF}|\u{2700}-\u{27BF}]/gu, '')
        .replace(/[*_#`]/g, '')
        .replace(/"/g, "'");

    const platform = process.platform;

    if (platform === 'darwin') {
        exec(`say "${cleanText}"`);
    } else if (platform === 'win32') {
        exec(`powershell -Command "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${cleanText}')"`);
    } else if (platform === 'linux') {
        exec(`espeak "${cleanText}"`);
    }
}

// TOOL DECLARATIONS
const executeCommandTool: FunctionDeclaration = {
    name: 'execute_command',
    description: 'Executes a CLI command in the terminal. Use for local system tasks.',
    parametersJsonSchema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command']
    }
};

const navigateToUrlTool: FunctionDeclaration = {
    name: 'navigate_to_url',
    description: 'Navigates the current browser tab to a specific URL.',
    parametersJsonSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The full URL including https://' } },
        required: ['url']
    }
};

const getPageTextTool: FunctionDeclaration = {
    name: 'get_page_text',
    description: 'Extracts all visible text from the current webpage.',
    parametersJsonSchema: {
        type: 'object',
        properties: {},
    }
};

const searchWebTool: FunctionDeclaration = {
    name: 'search_web',
    description: 'Searches the web for a query and reads the results.',
    parametersJsonSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The exact text to search for' } },
        required: ['query']
    }
};

const clickElementTool: FunctionDeclaration = {
    name: 'click_element',
    description: 'Clicks a button or link on the page based on its visible text. Use this to follow links from search results or navigate menus.',
    parametersJsonSchema: {
        type: 'object',
        properties: {
            text: {
                type: 'string',
                description: 'The visible text of the element to click (e.g., "Next Page" or "Wikipedia")'
            }
        },
        required: ['text']
    }
};

// MAIN AGENT LOOP

async function main() {
    console.log("🤖 Agent initializing browser...");

    // Initialize Playwright Browser 
    const browser: Browser = await chromium.launch({
        headless: false,
        channel: 'chrome'
    });

    let activePage: Page = await browser.newPage();

    console.log("🌐 Browser ready! Type 'exit' to quit.\n");

    const chat = ai.chats.create({
        model: 'gemini-2.5-flash',
        config: {
            systemInstruction: "You are a powerful autonomous assistant. You can execute terminal commands AND visually browse the web. If asked to find information, you can use `search_google` or `Maps_to_url`, and then use `get_page_text` to read the contents.",
            tools: [{
                functionDeclarations: [executeCommandTool, navigateToUrlTool, getPageTextTool, searchWebTool, clickElementTool]
            }]
        }
    });

    while (true) {
        const userInput = await askQuestion('\n👤 You: ');

        if (userInput.trim().toLowerCase() === 'exit') {
            console.log('👋 Cleaning up and exiting...');
            await browser.close();
            rl.close();
            break;
        }
        if (!userInput.trim()) continue;

        try {
            process.stdout.write('🤖 Agent: ...thinking...');
            let response = await chat.sendMessage({ message: userInput });

            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0);

            while (response.functionCalls && response.functionCalls.length > 0) {
                const call: any = response.functionCalls[0];
                let toolResult = "";

                // CLI COMMAND
                if (call.name === 'execute_command') {
                    const command = call.args.command as string;
                    const confirm = await askQuestion(`\n⚠️  Run CLI: \x1b[33m${command}\x1b[0m Allow? [Y/n]: `);
                    if (confirm.toLowerCase() === 'n') {
                        toolResult = "User denied permission.";
                    } else {
                        try {
                            const { stdout, stderr } = await execAsync(command);
                            toolResult = stdout || stderr || "Success.";
                        } catch (error: any) {
                            toolResult = `Error: ${error.message}\nStderr: ${error.stderr}`;
                        }
                    }
                }

                // NAVIGATE URL
                else if (call.name === 'navigate_to_url') {
                    const url = call.args.url as string;
                    console.log(`🌐  Navigating to: \x1b[36m${url}\x1b[0m`);
                    try {
                        await activePage.goto(url, { waitUntil: 'domcontentloaded' });
                        toolResult = `Successfully navigated to ${url}. The page is loaded. Call get_page_text to read it.`;
                    } catch (error: any) {
                        toolResult = `Failed to navigate: ${error.message}`;
                    }
                }

                // READ PAGE TEXT
                else if (call.name === 'get_page_text') {
                    console.log(`📄  Reading page content...`);
                    try {
                        const text = await activePage.evaluate(() => document.body.innerText);
                        toolResult = text;
                    } catch (error: any) {
                        toolResult = `Failed to read page: ${error.message}`;
                    }
                }

                // SEARCH GOOGLE 
                else if (call.name === 'search_web') {
                    const query = call.args.query as string;
                    console.log(`🔍  Searching the web for: \x1b[36m${query}\x1b[0m`);
                    try {
                        await activePage.bringToFront();

                        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
                        await activePage.goto(searchUrl, { waitUntil: 'domcontentloaded' });

                        const text = await activePage.evaluate(() => document.body.innerText);
                        toolResult = `Search completed. Page text: ${text}`;
                    } catch (error: any) {
                        toolResult = `Failed to search: ${error.message}`;
                    }
                }

                // CLICK ELEMENT
                else if (call.name === 'click_element') {
                    const text = call.args.text as string;
                    console.log(`🖱️  Clicking element with text: \x1b[36m${text}\x1b[0m`);
                    try {
                        await activePage.bringToFront();

                        const element = activePage.getByText(text, { exact: false }).first();
                        await element.click();

                        await activePage.waitForLoadState('domcontentloaded');

                        toolResult = `Successfully clicked '${text}'. The page may have updated. Call get_page_text to read the new view.`;
                    } catch (error: any) {
                        toolResult = `Failed to click '${text}'. Error: ${error.message}. The text might not be visible or clickable. Try reading the page text again to find the exact wording.`;
                    }
                }

                if (toolResult.length > 20000) {
                    toolResult = toolResult.substring(0, 20000) + "\n...[CONTENT TRUNCATED]...";
                }

                process.stdout.write(`🤖 Agent: ...processing ${call.name} output...`);

                response = await chat.sendMessage({
                    message: [{
                        functionResponse: {
                            id: call.id,
                            name: call.name,
                            response: { result: toolResult }
                        }
                    }]
                });

                readline.clearLine(process.stdout, 0);
                readline.cursorTo(process.stdout, 0);
            }

            if (response.text) {
                console.log(`🤖 Agent: ${response.text}`);
                // speakText(response.text);
            }

        } catch (error) {
            console.error("\n❌ Error:", error);
        }
    }
}

main();