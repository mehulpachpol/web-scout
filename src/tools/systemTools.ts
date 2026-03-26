import { exec } from 'child_process';
import * as fs from 'fs/promises';
import OpenAI from 'openai';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { performHybridSearch } from '../memory/retrieval';
import { validateCommand, validatePath } from '../security/shield';

const execAsync = promisify(exec);
const TRUST_MODE = process.argv.includes('--trust-mode');

export const systemToolDeclarations: OpenAI.Chat.ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'execute_command',
            description: 'Executes a CLI command in the terminal. Use for local system tasks.',
            parameters: {
                type: 'object',
                properties: { command: { type: 'string' } },
                required: ['command'],
                additionalProperties: false
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'write_to_file',
            description: 'Writes text or code directly to a file. ALWAYS use this instead of CLI "echo" or "out-file" commands when writing multi-line content or code.',
            parameters: {
                type: 'object',
                properties: {
                    filepath: { type: 'string', description: 'The absolute or relative path to the file' },
                    content: { type: 'string', description: 'The full string content to write into the file.' }
                },
                required: ['filepath', 'content'],
                additionalProperties: false
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Reads the exact contents of a file from the local disk.',
            parameters: {
                type: 'object',
                properties: { filepath: { type: 'string' } },
                required: ['filepath'],
                additionalProperties: false
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_project_tree',
            description: 'Returns a visual tree of the files and directories in the project. Automatically ignores node_modules and .git.',
            parameters: {
                type: 'object',
                properties: { dir_path: { type: 'string', description: 'Directory path to map out (default is ".")' } },
                additionalProperties: false
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'store_memory',
            description: 'Saves an important fact, preference, or context about the user or project to long-term memory.',
            parameters: {
                type: 'object',
                properties: { fact: { type: 'string' } },
                required: ['fact'],
                additionalProperties: false
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'memory_search',
            description: 'Performs a semantic vector search across all past conversations, logs, and long-term memory. Use this to find past facts, preferences, code snippets, or context.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'A natural language query describing what you are trying to remember.' }
                },
                required: ['query'],
                additionalProperties: false
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'send_desktop_notification',
            description: 'Sends a native OS desktop notification to the user. Use this to alert the user when a scheduled background task is complete.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'The title of the notification.' },
                    message: { type: 'string', description: 'A short summary of what was completed.' },
                    open_file_path: { type: 'string', description: 'Optional. The absolute path to a file (like a .md report) to automatically open on the user\'s screen.' }
                },
                required: ['title', 'message'],
                additionalProperties: false
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'schedule_task',
            description: 'Schedules a specific task to be executed autonomously at a future date and time. Can be a one-time task or recurring.',
            parameters: {
                type: 'object',
                properties: {
                    execute_at: {
                        type: 'string',
                        description: 'The exact ISO 8601 timestamp for when to run the task. Calculate this based on the current system time.'
                    },
                    task_prompt: {
                        type: 'string',
                        description: 'The exact instruction you need to execute when the time arrives.'
                    },
                    is_recurring: {
                        type: 'boolean',
                        description: 'Set to true if the user wants this task to repeat.'
                    },
                    recurrence_interval: {
                        type: 'string',
                        enum: ['hourly', 'daily', 'weekly', 'monthly'],
                        description: 'If recurring, specify the interval (hourly, daily, weekly, monthly). Leave blank if not recurring.'
                    }
                },
                required: ['execute_at', 'task_prompt'],
                additionalProperties: false
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_pdf',
            description: 'Reads and extracts text from a PDF document on the local disk.',
            parameters: {
                type: 'object',
                properties: { filepath: { type: 'string', description: 'Absolute or relative path to the .pdf file' } },
                required: ['filepath'],
                additionalProperties: false
            }
        }
    }
];

async function generateTree(dir: string, depth = 0, maxDepth = 3): Promise<string> {
    if (depth > maxDepth) return '';
    let result = '';
    try {
        const items = await fs.readdir(dir, { withFileTypes: true });
        for (const item of items) {
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

export async function executeSystemTool(call: any, askQuestion: (q: string) => Promise<string>): Promise<{ result: string }> {
    let toolResult = "";
    const isYes = (input: string) => input.trim().toLowerCase().startsWith('y');

    try {
        switch (call.name) {
            case 'execute_command':
                const command = call.args.command as string;

                const cmdCheck = validateCommand(command);
                if (!cmdCheck.allowed) {
                    console.log(`\x1b[31m🛡️  SHIELD INTERCEPTED: \x1b[0m${cmdCheck.reason}`);
                    return { result: cmdCheck.reason || "Blocked by Shield." };
                }

                let runCommand = false;

                if (TRUST_MODE) {
                    console.log(`⚠️  Trust Mode ON: Automatically running CLI: \x1b[33m${command}\x1b[0m`);
                    runCommand = true;
                } else {
                    const confirm = await askQuestion(`\n⚠️  Run CLI: \x1b[33m${command}\x1b[0m Allow? [Y/n]: `);
                    if (confirm.toLowerCase() !== 'n') runCommand = true;
                    else toolResult = "User denied permission.";
                }

                if (runCommand) {
                    const { stdout, stderr } = await execAsync(command);
                    toolResult = stdout || stderr || "Success.";
                }
                break;

            case 'write_to_file':
                const writePath = call.args.filepath as string;
                const writeCheck = validatePath(writePath);
                let allowWrite = writeCheck.allowed;
                if (!allowWrite) {
                    console.log(`\x1b[31m🛡️  SHIELD INTERCEPTED: \x1b[0m${writeCheck.reason}`);
                    if (TRUST_MODE) {
                        allowWrite = true;
                    } else {
                        const confirm = await askQuestion(`${writeCheck.reason}\nAllow write to '${writePath}'? [y/N]: `);
                        if (!isYes(confirm)) {
                            toolResult = writeCheck.reason || "Blocked by Shield.";
                            break;
                        }
                        allowWrite = true;
                    }
                }
                console.log(`💾  Writing content to: \x1b[32m${writePath}\x1b[0m`);
                await fs.mkdir(path.dirname(writePath), { recursive: true });
                await fs.writeFile(writePath, call.args.content as string, 'utf-8');
                toolResult = `Successfully wrote to ${writePath}`;
                break;

            case 'read_file':
                const readPath = call.args.filepath as string;
                console.log(`📖  Reading file: \x1b[36m${call.args.filepath}\x1b[0m`);
                const readCheck = validatePath(readPath);
                let allowRead = readCheck.allowed;
                if (!allowRead) {
                    console.log(`\x1b[31mðŸ›¡ï¸  SHIELD INTERCEPTED: \x1b[0m${readCheck.reason}`);
                    if (TRUST_MODE) {
                        allowRead = true;
                    } else {
                        const confirm = await askQuestion(`${readCheck.reason}\nAllow read from '${readPath}'? [y/N]: `);
                        if (!isYes(confirm)) {
                            toolResult = readCheck.reason || "Blocked by Shield.";
                            break;
                        }
                        allowRead = true;
                    }
                }
                toolResult = await fs.readFile(readPath, 'utf-8');
                break;

            case 'get_project_tree':
                const dirPath = (call.args.dir_path as string) || '.';
                const treeCheck = validatePath(dirPath);
                if (!treeCheck.allowed) {
                    console.log(`\x1b[31mðŸ›¡ï¸  SHIELD INTERCEPTED: \x1b[0m${treeCheck.reason}`);
                    if (!TRUST_MODE) {
                        const confirm = await askQuestion(`${treeCheck.reason}\nAllow reading directory tree '${dirPath}'? [y/N]: `);
                        if (!isYes(confirm)) {
                            toolResult = treeCheck.reason || "Blocked by Shield.";
                            break;
                        }
                    }
                }
                console.log(`🌳  Mapping project tree for: \x1b[36m${dirPath}\x1b[0m`);
                toolResult = `Project structure (Max depth 3):\n${await generateTree(dirPath)}`;
                break;

            case 'store_memory':
                const memDir = path.join(os.homedir(), '.web-scout');
                await fs.mkdir(memDir, { recursive: true });
                const date = new Date().toISOString().split('T')[0];
                await fs.appendFile(path.join(memDir, 'MEMORY.md'), `- [${date}] ${call.args.fact}\n`, 'utf-8');
                toolResult = "Successfully stored memory.";
                break;

            case 'memory_search':
                const searchQuery = call.args.query as string;
                toolResult = await performHybridSearch(searchQuery);
                break;

            case 'send_desktop_notification':
                const notifier = (await import('node-notifier')).default;
                const { title, message, open_file_path } = call.args;

                if (!(global as any).__notifierClickAttached) {
                    notifier.on('click', async (notifierObject, options) => {
                        const filePath = (options as any).target_file;
                        if (filePath) {
                            const openModule = (await import('open')).default;
                            console.log(`\n📂 User clicked notification. Opening: \x1b[36m${filePath}\x1b[0m\n❯ `);
                            await openModule(filePath);
                        }
                    });
                    (global as any).__notifierClickAttached = true;
                }

                notifier.notify({
                    title: title || 'Web-Scout Agent',
                    message: message,
                    sound: true,
                    wait: true,
                    target_file: open_file_path
                } as any);

                toolResult = `Notification sent to user successfully.`;
                break;

            case 'schedule_task':
                const tasksFile = path.join(os.homedir(), '.web-scout', 'pending_tasks.json');
                await fs.mkdir(path.dirname(tasksFile), { recursive: true });
                let tasks: any[] = [];

                // Read existing queue
                try {
                    const data = await fs.readFile(tasksFile, 'utf-8');
                    const parsed = JSON.parse(data);
                    tasks = Array.isArray(parsed) ? parsed : [];
                } catch (e) { }

                const executeAtRaw = String(call.args.execute_at);
                const executeAtDate = new Date(executeAtRaw);
                if (Number.isNaN(executeAtDate.getTime())) {
                    toolResult = `Invalid execute_at timestamp '${executeAtRaw}'. Please pass an ISO 8601 date/time (e.g. 2026-03-25T14:30:00.000Z).`;
                    break;
                }

                const normalizeInterval = (value: unknown): string | null => {
                    if (!value) return null;
                    const v = String(value).trim().toLowerCase();
                    if (!v) return null;
                    if (['hourly', 'hour', '1h', 'every hour', 'each hour'].includes(v)) return 'hourly';
                    if (['daily', 'day', '1d', 'every day', 'each day'].includes(v)) return 'daily';
                    if (['weekly', 'week', '1w', 'every week', 'each week'].includes(v)) return 'weekly';
                    if (['monthly', 'month', '1m', 'every month', 'each month'].includes(v)) return 'monthly';
                    return null;
                };

                const recurrenceInterval = normalizeInterval(call.args.recurrence_interval);
                const isRecurring = Boolean(call.args.is_recurring) || Boolean(recurrenceInterval);

                // Add the new task
                tasks.push({
                    id: Date.now(),
                    executeAt: executeAtDate.toISOString(),
                    prompt: call.args.task_prompt,
                    isRecurring,
                    recurrenceInterval: isRecurring ? recurrenceInterval : null
                });

                // Save the queue
                tasks.sort((a: any, b: any) => new Date(a.executeAt).getTime() - new Date(b.executeAt).getTime());
                await fs.writeFile(tasksFile, JSON.stringify(tasks, null, 2), 'utf-8');
                toolResult = `✅ Task successfully scheduled for ${executeAtDate.toISOString()}.`;
                break;

            case 'read_pdf':
                const pdfPath = call.args.filepath as string;
                const pdfCheck = validatePath(pdfPath);
                if (!pdfCheck.allowed) {
                    console.log(`\x1b[31mðŸ›¡ï¸  SHIELD INTERCEPTED: \x1b[0m${pdfCheck.reason}`);
                    if (!TRUST_MODE) {
                        const confirm = await askQuestion(`${pdfCheck.reason}\nAllow read from PDF '${pdfPath}'? [y/N]: `);
                        if (!isYes(confirm)) {
                            toolResult = pdfCheck.reason || "Blocked by Shield.";
                            break;
                        }
                    }
                }
                console.log(`📄  Reading PDF: \x1b[36m${pdfPath}\x1b[0m`);

                // const pdfCheck = validatePath(pdfPath);
                // if (!pdfCheck.allowed) {
                //     console.log(`\x1b[31m🛡️  SHIELD INTERCEPTED: \x1b[0m${pdfCheck.reason}`);
                //     return { result: pdfCheck.reason || "Blocked by Shield." };
                // }
                const pdfBuffer = await fs.readFile(pdfPath);
                const { PDFParse } = await import('pdf-parse');
                const parser = new PDFParse({ data: pdfBuffer as any });
                const pdfData = await parser.getText();

                toolResult = `PDF Contents of ${path.basename(pdfPath)}:\n\n${pdfData.text}`;
                break;

            default:
                toolResult = `Tool ${call.name} not found in systemTools.`;
        }
    } catch (error: any) {
        toolResult = `Error executing ${call.name}: ${error.message}`;
    }

    return { result: toolResult };
}
