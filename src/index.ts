import { FunctionDeclaration, GoogleGenAI } from '@google/genai';
import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Browser, chromium, Page } from 'playwright';
import * as readline from 'readline';
import { promisify } from 'util';
// CONFIGURATION
const TRUST_MODE = process.argv.includes('--trust-mode');

if (TRUST_MODE) {
    console.log("⚠️  WARNING: Trust Mode is ENABLED. The agent will execute CLI commands without asking for permission.\n");
}

const execAsync = promisify(exec);
let base64Image: string | null = null;
const ai = new GoogleGenAI({ apiKey: "AIzaSyCbWB0_L3WfWIAPMdquruyZHs117tp4NEM" });
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});
const now = new Date().toISOString();

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

// ==========================================
// TOOL DECLARATIONS
// ==========================================
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

const typeTextTool: FunctionDeclaration = {
    name: 'type_text',
    description: 'Types text into an input field (like a search bar or login form). Use standard CSS selectors to guess the field, such as "input[name=\'username\']", "input[type=\'password\']", or "input[type=\'email\']".',
    parametersJsonSchema: {
        type: 'object',
        properties: {
            selector: {
                type: 'string',
                description: 'The CSS selector of the input field to type into.'
            },
            text: {
                type: 'string',
                description: 'The actual text to type.'
            }
        },
        required: ['selector', 'text']
    }
};

const pressKeyTool: FunctionDeclaration = {
    name: 'press_key',
    description: 'Presses a physical keyboard key. Extremely useful for pressing "Enter" after typing in a search bar, pressing "Escape" to close annoying popups, or "PageDown" to scroll.',
    parametersJsonSchema: {
        type: 'object',
        properties: {
            key: { type: 'string', description: 'The key to press (e.g., "Enter", "Escape", "Tab", "PageDown")' }
        },
        required: ['key']
    }
};

const writeToFileTool: FunctionDeclaration = {
    name: 'write_to_file',
    description: 'Writes text or code directly to a file. ALWAYS use this instead of CLI "echo" or "out-file" commands when writing multi-line content or code.',
    parametersJsonSchema: {
        type: 'object',
        properties: {
            filepath: { type: 'string', description: 'The absolute or relative path to the file (e.g., "index.html" or "src/app.js").' },
            content: { type: 'string', description: 'The full string content to write into the file.' }
        },
        required: ['filepath', 'content']
    }
};

const getProjectTreeTool: FunctionDeclaration = {
    name: 'get_project_tree',
    description: 'Returns a visual tree of the files and directories in the project. Automatically ignores node_modules and .git. Use this to understand the project structure and find files.',
    parametersJsonSchema: {
        type: 'object',
        properties: {
            dir_path: { type: 'string', description: 'The directory path to map out (default is ".")' }
        }
    }
};

const readFileTool: FunctionDeclaration = {
    name: 'read_file',
    description: 'Reads the exact contents of a file from the local disk. ALWAYS use this to read the current code before attempting to modify or overwrite it.',
    parametersJsonSchema: {
        type: 'object',
        properties: {
            filepath: { type: 'string', description: 'The path to the file to read (e.g., "src/environments/environment.ts")' }
        },
        required: ['filepath']
    }
};

const takeScreenshotTool: FunctionDeclaration = {
    name: 'take_screenshot',
    description: 'Takes a screenshot of the current browser tab. Use this when you cannot find an element via text, need to understand the visual layout, or encounter a complex UI/icon.',
    parametersJsonSchema: {
        type: 'object',
        properties: {}
    }
};

const storeMemoryTool: FunctionDeclaration = {
    name: 'store_memory',
    description: 'Saves an important fact, preference, or context about the user or project to long-term memory. Use this proactively when the user reveals how they like things done, their environment setup, or personal details.',
    parametersJsonSchema: {
        type: 'object',
        properties: {
            fact: { type: 'string', description: 'A clear, concise statement of the fact to remember (e.g., "User prefers yarn over npm" or "Default project path is D:/projects")' }
        },
        required: ['fact']
    }
};

const searchMemoryTool: FunctionDeclaration = {
    name: 'search_memory',
    description: 'Searches the long-term memory file for specific keywords or concepts. Call this if you need to recall past preferences, API keys, or user details.',
    parametersJsonSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'The keyword or short phrase to search for in the memory file. Leave empty to retrieve all memories.' }
        }
    }
};

// MAIN AGENT LOOP
async function main() {
    console.log("🤖 Agent initialized. Type 'exit' to quit.\n");

    let browser: Browser | null = null;
    let activePage: Page | null = null;

    async function ensureBrowser(): Promise<Page> {
        if (!browser) {
            console.log("\n🤖 Agent initializing browser on-demand...");
            browser = await chromium.launch({
                headless: false,
                channel: 'chrome'
            });
            activePage = await browser.newPage();
            console.log("🌐 Browser ready!\n");
        } else if (activePage) {
            // ALWAYS focus on the most recently opened tab
            activePage = activePage.context().pages().at(-1) || activePage;
        }

        if (activePage) {
            await activePage.bringToFront();
        }
        return activePage!;
    }

    // Helper to generate a clean project tree
    async function generateTree(dir: string, depth = 0, maxDepth = 3): Promise<string> {
        if (depth > maxDepth) return '';
        let result = '';
        try {
            const items = await fs.readdir(dir, { withFileTypes: true });
            for (const item of items) {
                // Ignore massive junk folders
                if (['node_modules', '.git', 'dist', 'build', '.next'].includes(item.name)) continue;

                const prefix = '  '.repeat(depth) + '|- ';
                result += `${prefix}${item.name}\n`;

                if (item.isDirectory()) {
                    result += await generateTree(path.join(dir, item.name), depth + 1, maxDepth);
                }
            }
        } catch (e) {
            return `Error reading directory: ${dir}`;
        }
        return result;
    }

    // Helper to automatically log the running conversation
    async function logConversation(role: 'User' | 'Agent', text: string) {
        if (!text) return;
        try {
            const logDir = path.join(os.homedir(), '.web-scout', 'logs');
            await fs.mkdir(logDir, { recursive: true });

            const date = new Date().toISOString().split('T')[0];
            const logFile = path.join(logDir, `${date}.md`);
            const timestamp = new Date().toLocaleTimeString();

            await fs.appendFile(logFile, `**[${timestamp}] ${role}:**\n${text}\n\n`, 'utf-8');
        } catch (e) {
            // Fail silently so it doesn't crash the agent
        }
    }

    let todaysContext = "";
    try {
        const date = new Date().toISOString().split('T')[0];
        const logFile = path.join(os.homedir(), '.web-scout', 'logs', `${date}.md`);
        todaysContext = await fs.readFile(logFile, 'utf-8');
    } catch (e) {
        todaysContext = "No prior conversation today.";
    }

    let coreMemory = "";
    try {
        const memoryFile = path.join(os.homedir(), '.web-scout', 'MEMORY.md');
        coreMemory = await fs.readFile(memoryFile, 'utf-8');
    } catch (e) {
        coreMemory = "No core memories established yet.";
    }

    const chat = ai.chats.create({
        model: 'gemini-2.5-flash',
        config: {
            systemInstruction: `You are Web-Scout, a highly intelligent, autonomous AI agent with access to the user's local terminal and a visual web browser. 

            YOUR CORE DIRECTIVE: Require zero hand-holding. Anticipate obstacles and solve them silently. When a task is fully accomplished, start your final text response with "✅ TASK COMPLETE:" followed by a concise summary.
            System context: The current date and time is ${now}. Use this as the reference point for interpreting relative time expressions like "now", "today", "yesterday", or "tomorrow".
            Depending on the user's request, adopt the following strategies:

            ### 1. WEB BROWSING & E-COMMERCE TASKS
            - **Popups are inevitable:** When you navigate to sites like Flipkart, Amazon, or news sites, expect aggressive login or location popups. Proactively use the \`press_key\` tool with the "Escape" key to dismiss them before trying to click or type anything else.
            - **Searching:** Locate search bars using \`type_text\` (guess standard selectors like input[type="text"], input[name="q"], or input[placeholder*="Search"]). Press "Enter" via \`press_key\` to submit.
            - **Product Selection:** Read the search results, evaluate prices and ratings based on the user's constraints, and use \`click_element\` to select the best match. 
            - **Goal Completion:** If the user asks to buy or purchase, your goal is to get the item into the shopping cart. You do not need to process the final payment.
            - **Visual Interfaces:** If reading the page text isn't enough to understand the layout, or if you need to find an icon (like a cart or magnifying glass), use \`take_screenshot\` to physically look at the screen.

            ### 2. LOCAL CLI & SYSTEM TASKS
            - **Safety First:** You are running on the user's actual machine. Do not run destructive commands (like \`rm -rf /\`). 
            - **Environment Awareness:** Always check the operating system and current directory (\`pwd\`, \`ls\` or \`dir\`) before creating or modifying files.
            - **Chaining:** Use operators like \`&&\` to chain simple commands together to save time (e.g., \`mkdir test_dir && cd test_dir && touch index.js\`).

            ### 3. CODING & DEVELOPMENT TASKS
            - **Writing Files:** NEVER use \`echo\` or terminal redirection to write code. ALWAYS use the \`write_to_file\` tool to safely save multi-line code or text to the disk.
            - **Context Gathering:** Before writing code, use \`execute_command\` to read existing files (\`cat filename\`) or view the project structure.
            - **Iterative Testing:** If you write a script for the user, attempt to run it. If it throws an error, read the stderr, fix the code, and try again before telling the user you are done.

            ### 4. LONG-TERM MEMORY
            - You have access to a persistent \`MEMORY.md\` file.
            - **Proactive Storage:** If the user tells you a preference, an API key, or a fact about their environment, call \`store_memory\` immediately to save it for future sessions.
            - **Retrieval:** If you are unsure about the user's environment or past preferences, use \`search_memory\` before asking them.

            ### CORE MEMORY (Persistent Facts):
            These are the facts you have learned about the user over time. You DO NOT need to search for these, you already know them:
            ${coreMemory}

            ### RECENT CONTEXT (Earlier Today):
            Here is the log of what you and the user discussed earlier today. Use this to maintain conversation flow if the user references past tasks or general conversations :
            ${todaysContext}
            ### ERROR HANDLING (SELF-HEALING)
            If a tool fails (e.g., Playwright cannot find a CSS selector, or a CLI command throws an error), DO NOT apologize immediately to the user. Instead, read the error message, deduce what went wrong, and call the tool again with a different parameter.`,
            tools: [{
                functionDeclarations: [executeCommandTool, navigateToUrlTool, getPageTextTool, searchWebTool, clickElementTool, typeTextTool, pressKeyTool, writeToFileTool, getProjectTreeTool, readFileTool, takeScreenshotTool, storeMemoryTool, searchMemoryTool]
            }]
        }
    });

    while (true) {
        const userInput = await askQuestion('\n👤 You: ');

        if (userInput.trim().toLowerCase() === 'exit') {
            console.log('👋 Cleaning up and exiting...');
            if (browser) await (browser as Browser).close();
            rl.close();
            break;
        }
        if (!userInput.trim()) continue;
        await logConversation('User', userInput);

        try {
            process.stdout.write('🤖 Agent: ...thinking...');
            let response = await chat.sendMessage({ message: userInput });

            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0);

            while (response.functionCalls && response.functionCalls.length > 0) {
                const call: any = response.functionCalls[0];
                let toolResult = "";

                //CLI COMMAND 
                if (call.name === 'execute_command') {
                    const command = call.args.command as string;
                    let runCommand = false;

                    if (TRUST_MODE) {
                        console.log(`⚠️  Trust Mode ON: Automatically running CLI: \x1b[33m${command}\x1b[0m`);
                        runCommand = true;
                    } else {
                        const confirm = await askQuestion(`\n⚠️  Run CLI: \x1b[33m${command}\x1b[0m Allow? [Y/n]: `);
                        if (confirm.toLowerCase() !== 'n') {
                            runCommand = true;
                        } else {
                            toolResult = "User denied permission.";
                        }
                    }

                    if (runCommand) {
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
                    const page = await ensureBrowser();
                    const url = call.args.url as string;
                    console.log(`🌐  Navigating to: \x1b[36m${url}\x1b[0m`);
                    try {
                        await page.goto(url, { waitUntil: 'domcontentloaded' });
                        toolResult = `Successfully navigated to ${url}. The page is loaded. Call get_page_text to read it.`;
                    } catch (error: any) {
                        toolResult = `Failed to navigate: ${error.message}`;
                    }
                }

                // READ PAGE TEXT
                else if (call.name === 'get_page_text') {
                    const page = await ensureBrowser();
                    console.log(`📄  Reading page content...`);
                    try {
                        const text = await page.evaluate(() => document.body.innerText);
                        toolResult = text;
                    } catch (error: any) {
                        toolResult = `Failed to read page: ${error.message}`;
                    }
                }

                // SEARCH WEB 
                else if (call.name === 'search_web') {
                    const page = await ensureBrowser();
                    const query = call.args.query as string;
                    console.log(`🔍  Searching the web for: \x1b[36m${query}\x1b[0m`);
                    try {
                        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
                        await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });

                        const text = await page.evaluate(() => document.body.innerText);
                        toolResult = `Search completed. Page text: ${text}`;
                    } catch (error: any) {
                        toolResult = `Failed to search: ${error.message}`;
                    }
                }

                //  CLICK ELEMENT
                else if (call.name === 'click_element') {
                    const page = await ensureBrowser();
                    const text = call.args.text as string;
                    console.log(`🖱️  Clicking element with text: \x1b[36m${text}\x1b[0m`);
                    try {
                        const element = page.getByText(text, { exact: false }).first();
                        await element.click();

                        await page.waitForLoadState('domcontentloaded');

                        toolResult = `Successfully clicked '${text}'. The page may have updated. Call get_page_text to read the new view.`;
                    } catch (error: any) {
                        toolResult = `Failed to click '${text}'. Error: ${error.message}. The text might not be visible or clickable. Try reading the page text again to find the exact wording.`;
                    }
                }

                // TYPE TEXT
                else if (call.name === 'type_text') {
                    const page = await ensureBrowser();
                    const selector = call.args.selector as string;
                    const textToType = call.args.text as string;

                    const displayName = selector.toLowerCase().includes('password') ? '********' : textToType;
                    console.log(`⌨️  Typing \x1b[33m${displayName}\x1b[0m into: \x1b[36m${selector}\x1b[0m`);

                    try {
                        const element = page.locator(selector).first();
                        await element.fill(textToType);

                        toolResult = `Successfully typed into '${selector}'. You may need to call click_element to submit the form.`;
                    } catch (error: any) {
                        toolResult = `Failed to type into '${selector}'. Error: ${error.message}. Try guessing a different CSS selector like input[type="text"], input[name="email"], input[name="username"], or input[name="password"].`;
                    }
                }

                // PRESS KEY
                else if (call.name === 'press_key') {
                    const page = await ensureBrowser();
                    const key = call.args.key as string;
                    console.log(`⌨️  Pressing key: \x1b[35m${key}\x1b[0m`);
                    try {
                        await page.keyboard.press(key);
                        await page.waitForTimeout(1000);
                        toolResult = `Successfully pressed '${key}'. The screen may have changed.`;
                    } catch (error: any) {
                        toolResult = `Failed to press key: ${error.message}`;
                    }
                }

                // WRITE TO FILE 
                else if (call.name === 'write_to_file') {
                    const filepath = call.args.filepath as string;
                    const content = call.args.content as string;
                    console.log(`💾  Writing content to: \x1b[32m${filepath}\x1b[0m`);
                    try {
                        // Automatically create the directory if it doesn't exist
                        const dir = path.dirname(filepath);
                        await fs.mkdir(dir, { recursive: true });

                        // Write the file
                        await fs.writeFile(filepath, content, 'utf-8');
                        toolResult = `Successfully wrote ${content.length} characters to ${filepath}`;
                    } catch (error: any) {
                        toolResult = `Failed to write file: ${error.message}`;
                    }
                }

                // READ FILE
                else if (call.name === 'read_file') {
                    const filepath = call.args.filepath as string;
                    console.log(`📖  Reading file: \x1b[36m${filepath}\x1b[0m`);
                    try {
                        const content = await fs.readFile(filepath, 'utf-8');
                        toolResult = content;
                    } catch (error: any) {
                        toolResult = `Failed to read file: ${error.message}`;
                    }
                }

                // GET PROJECT TREE
                else if (call.name === 'get_project_tree') {
                    const dirPath = (call.args.dir_path as string) || '.';
                    console.log(`🌳  Mapping project tree for: \x1b[36m${dirPath}\x1b[0m`);
                    try {
                        const tree = await generateTree(dirPath);
                        toolResult = `Project structure (Max depth 3):\n${tree}`;
                    } catch (error: any) {
                        toolResult = `Failed to get tree: ${error.message}`;
                    }
                }

                // TAKE SCREENSHOT (Vision)
                else if (call.name === 'take_screenshot') {
                    const page = await ensureBrowser();
                    console.log(`📸  Taking a visual screenshot...`);
                    try {
                        // We use JPEG to save bandwidth and token limits
                        const screenshotBuffer = await page.screenshot({ type: 'jpeg', quality: 80 });
                        base64Image = screenshotBuffer.toString('base64');
                        toolResult = `Screenshot taken successfully. Look at the attached image to understand the visual layout.`;
                    } catch (error: any) {
                        toolResult = `Failed to take screenshot: ${error.message}`;
                    }
                }

                //  STORE MEMORY
                else if (call.name === 'store_memory') {
                    const fact = call.args.fact as string;
                    console.log(`🧠  Storing memory: \x1b[35m${fact}\x1b[0m`);
                    try {
                        const memoryDir = path.join(os.homedir(), '.web-scout');
                        const memoryFile = path.join(memoryDir, 'MEMORY.md');

                        await fs.mkdir(memoryDir, { recursive: true });

                        // Append the fact with a timestamp
                        const date = new Date().toISOString().split('T')[0];
                        const logEntry = `- [${date}] ${fact}\n`;

                        await fs.appendFile(memoryFile, logEntry, 'utf-8');
                        toolResult = `Successfully stored memory.`;
                    } catch (error: any) {
                        toolResult = `Failed to store memory: ${error.message}`;
                    }
                }

                // SEARCH MEMORY
                else if (call.name === 'search_memory') {
                    const query = (call.args.query as string || '').toLowerCase();
                    console.log(`🔎  Searching memory for: \x1b[35m${query || 'ALL'}\x1b[0m`);
                    try {
                        const memoryFile = path.join(os.homedir(), '.web-scout', 'MEMORY.md');

                        // Check if memory file exists
                        try {
                            await fs.access(memoryFile);
                        } catch {
                            toolResult = "Memory file is empty. No memories found.";
                            continue;
                        }

                        const content = await fs.readFile(memoryFile, 'utf-8');

                        if (!query) {
                            toolResult = content || "Memory file is empty.";
                        } else {
                            // Basic keyword search (simulating BM25)
                            const lines = content.split('\n');
                            const matches = lines.filter(line => line.toLowerCase().includes(query));
                            toolResult = matches.length > 0
                                ? `Found ${matches.length} matches:\n${matches.join('\n')}`
                                : `No memories found matching '${query}'.`;
                        }
                    } catch (error: any) {
                        toolResult = `Failed to search memory: ${error.message}`;
                    }
                }

                if (toolResult.length > 20000) {
                    toolResult = toolResult.substring(0, 20000) + "\n...[CONTENT TRUNCATED]...";
                }

                process.stdout.write(`🤖 Agent: ...processing ${call.name} output...`);

                const messageParts: any[] = [{
                    functionResponse: {
                        id: call.id,
                        name: call.name,
                        response: { result: toolResult }
                    }
                }];

                if (base64Image) {
                    messageParts.push({
                        inlineData: {
                            mimeType: "image/jpeg",
                            data: base64Image
                        }
                    });
                }

                response = await chat.sendMessage({ message: messageParts });

                readline.clearLine(process.stdout, 0);
                readline.cursorTo(process.stdout, 0);
            }

            if (response.text) {
                console.log(`🤖 Agent: ${response.text}`);
                // speakText(response.text);
                await logConversation('Agent', response.text);
            }

        } catch (error) {
            console.error("\n❌ Error:", error);
        }
    }
}

main();