import { exec } from 'child_process';
import * as fs from 'fs/promises';
import OpenAI from 'openai';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { performHybridSearch } from '../memory/retrieval';
import { ingestDocument } from '../ingest/pipeline';
import { validateCommand, validatePath } from '../security/shield';
import { addRule, appendAudit, decideForCommand, decideForPath, decideForTool } from '../security/permissions';
import { computeNextRunAt, readTasks, scheduleSummary, writeTasks } from '../scheduler/tasks';

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
                    },
                    cron_expression: {
                        type: 'string',
                        description: 'Optional cron expression (5 fields: "m h dom mon dow"). If provided, this overrides recurrence_interval.'
                    },
                    timezone: {
                        type: 'string',
                        description: 'Optional IANA timezone (e.g., "Asia/Calcutta"). Used for cron schedules.'
                    },
                    missed_run_policy: {
                        type: 'string',
                        enum: ['skip', 'catch_up_once', 'catch_up_all'],
                        description: 'What to do if runs were missed while the app was closed.'
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
            name: 'ingest_document',
            description: 'Ingests a local document (PDF/DOCX/HTML/TXT/MD) into the memory database with embeddings for later Q&A (with page-number citations for PDFs).',
            parameters: {
                type: 'object',
                properties: {
                    filepath: { type: 'string', description: 'Absolute or relative path to the document file.' },
                    title: { type: 'string', description: 'Optional display title for citations.' },
                    source_url: { type: 'string', description: 'Optional source URL if this file came from the web.' },
                    source_type: { type: 'string', description: 'Optional override: pdf|docx|html|markdown|text.' }
                },
                required: ['filepath'],
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

export async function executeSystemTool(call: any, askQuestion: (q: string) => Promise<string>, executionOptions?: { dryRun?: boolean }): Promise<{ result: string }> {
    let toolResult = "";
    const isYes = (input: string) => input.trim().toLowerCase().startsWith('y');
    const choice = (input: string) => input.trim().toLowerCase().slice(0, 1);
    const dryRun = Boolean(executionOptions?.dryRun);

    const audit = async (entry: { tool: string; target?: string; decision: 'allow' | 'deny'; ruleId?: string; reason: string; argsSummary?: any }) => {
        await appendAudit({
            ts: new Date().toISOString(),
            tool: entry.tool,
            target: entry.target,
            decision: entry.decision,
            ruleId: entry.ruleId,
            reason: entry.reason,
            argsSummary: entry.argsSummary
        });
    };

    const promptPathPermission = async (toolName: string, targetPath: string, reason: string) => {
        const absTarget = path.resolve(targetPath);
        const dirPattern = path.join(path.dirname(absTarget), '**');
        const answer = TRUST_MODE ? 'y' : await askQuestion(
            `${reason}\n` +
            `Allow this operation?\n` +
            `  y = allow once\n` +
            `  a = always allow folder (${dirPattern})\n` +
            `  t = always allow tool (${toolName})\n` +
            `  n = deny once\n` +
            `  d = always deny folder (${dirPattern})\n` +
            `  x = always deny tool (${toolName})\n` +
            `Choice [y/a/t/n/d/x] (default n): `
        );
        const c = choice(answer);
        if (c === 'y') return { allowed: true as const };
        if (c === 'a') {
            const rule = await addRule({ effect: 'allow', scope: 'path', pattern: dirPattern, tools: [toolName] });
            return { allowed: true as const, ruleId: rule.id };
        }
        if (c === 't') {
            const rule = await addRule({ effect: 'allow', scope: 'tool', pattern: toolName });
            return { allowed: true as const, ruleId: rule.id };
        }
        if (c === 'd') {
            const rule = await addRule({ effect: 'deny', scope: 'path', pattern: dirPattern, tools: [toolName] });
            return { allowed: false as const, ruleId: rule.id };
        }
        if (c === 'x') {
            const rule = await addRule({ effect: 'deny', scope: 'tool', pattern: toolName });
            return { allowed: false as const, ruleId: rule.id };
        }
        return { allowed: false as const };
    };

    const promptCommandPermission = async (toolName: string, command: string) => {
        const tokens = command.trim().split(/\s+/).filter(Boolean);
        const prefix = tokens.slice(0, Math.min(tokens.length, 2)).join(' ').toLowerCase();
        const answer = TRUST_MODE ? 'y' : await askQuestion(
            `Allow running this command?\n` +
            `  y = allow once\n` +
            `  a = always allow prefix ("${prefix}")\n` +
            `  t = always allow tool (${toolName})\n` +
            `  n = deny once\n` +
            `  d = always deny prefix ("${prefix}")\n` +
            `  x = always deny tool (${toolName})\n` +
            `Choice [y/a/t/n/d/x] (default n): `
        );
        const c = choice(answer);
        if (c === 'y') return { allowed: true as const };
        if (c === 'a') {
            const rule = await addRule({ effect: 'allow', scope: 'command', pattern: prefix, tools: [toolName] });
            return { allowed: true as const, ruleId: rule.id };
        }
        if (c === 't') {
            const rule = await addRule({ effect: 'allow', scope: 'tool', pattern: toolName });
            return { allowed: true as const, ruleId: rule.id };
        }
        if (c === 'd') {
            const rule = await addRule({ effect: 'deny', scope: 'command', pattern: prefix, tools: [toolName] });
            return { allowed: false as const, ruleId: rule.id };
        }
        if (c === 'x') {
            const rule = await addRule({ effect: 'deny', scope: 'tool', pattern: toolName });
            return { allowed: false as const, ruleId: rule.id };
        }
        return { allowed: false as const };
    };

    try {
        switch (call.name) {
            case 'execute_command':
                const command = call.args.command as string;

                const cmdCheck = validateCommand(command);
                if (!cmdCheck.allowed) {
                    console.log(`\x1b[31m🛡️  SHIELD INTERCEPTED: \x1b[0m${cmdCheck.reason}`);
                    await audit({ tool: 'execute_command', target: command, decision: 'deny', reason: cmdCheck.reason || 'Blocked by Shield.' });
                    return { result: cmdCheck.reason || "Blocked by Shield." };
                }

                const toolDecision = await decideForTool('execute_command');
                if (toolDecision.effect === 'deny') {
                    await audit({ tool: 'execute_command', target: command, decision: 'deny', ruleId: toolDecision.ruleId, reason: toolDecision.reason });
                    return { result: `Blocked by permissions rule. ${toolDecision.reason}` };
                }

                const cmdDecision = await decideForCommand('execute_command', command);
                if (cmdDecision.effect === 'deny') {
                    await audit({ tool: 'execute_command', target: command, decision: 'deny', ruleId: cmdDecision.ruleId, reason: cmdDecision.reason });
                    return { result: `Blocked by permissions rule. ${cmdDecision.reason}` };
                }

                let runCommand = false;
                let cmdRuleId: string | undefined = undefined;

                if (cmdDecision.effect === 'allow') {
                    runCommand = true;
                    cmdRuleId = cmdDecision.ruleId;
                } else if (toolDecision.effect === 'allow') {
                    runCommand = true;
                    cmdRuleId = toolDecision.ruleId;
                } else if (TRUST_MODE) {
                    console.log(`⚠️  Trust Mode ON: Automatically running CLI: \x1b[33m${command}\x1b[0m`);
                    runCommand = true;
                } else {
                    const confirm = await promptCommandPermission('execute_command', command);
                    if (!confirm.allowed) {
                        toolResult = "User denied permission.";
                        await audit({ tool: 'execute_command', target: command, decision: 'deny', ruleId: (confirm as any).ruleId, reason: 'User denied.' });
                        break;
                    }
                    runCommand = true;
                    cmdRuleId = (confirm as any).ruleId;
                }

                if (runCommand) {
                    if (dryRun) {
                        toolResult = `DRY RUN: would run CLI command:\n${command}`;
                        await audit({
                            tool: 'execute_command',
                            target: command,
                            decision: 'allow',
                            ruleId: cmdRuleId,
                            reason: 'Dry-run (not executed).',
                            argsSummary: { dryRun: true }
                        });
                    } else {
                        const { stdout, stderr } = await execAsync(command);
                        toolResult = stdout || stderr || "Success.";
                        await audit({
                            tool: 'execute_command',
                            target: command,
                            decision: 'allow',
                            ruleId: cmdRuleId,
                            reason: cmdRuleId ? 'Allowed by rule.' : (cmdDecision.effect === 'allow' ? cmdDecision.reason : 'User allowed.'),
                            argsSummary: { stdoutBytes: (stdout || '').length, stderrBytes: (stderr || '').length }
                        });
                    }
                }
                break;

            case 'write_to_file':
                const writePath = call.args.filepath as string;
                const writeCheck = validatePath(writePath);
                {
                    const td = await decideForTool('write_to_file');
                    if (td.effect === 'deny') {
                        await audit({ tool: 'write_to_file', target: writePath, decision: 'deny', ruleId: td.ruleId, reason: td.reason });
                        toolResult = `Blocked by permissions rule. ${td.reason}`;
                        break;
                    }
                }
                let allowWrite = writeCheck.allowed;
                if (!allowWrite) {
                    console.log(`\x1b[31m🛡️  SHIELD INTERCEPTED: \x1b[0m${writeCheck.reason}`);
                    const decision = await decideForPath('write_to_file', writePath);
                    if (decision.effect === 'deny') {
                        await audit({ tool: 'write_to_file', target: writePath, decision: 'deny', ruleId: decision.ruleId, reason: decision.reason });
                        toolResult = `Blocked by permissions rule. ${decision.reason}`;
                        break;
                    }

                    if (decision.effect === 'allow') {
                        allowWrite = true;
                        await audit({ tool: 'write_to_file', target: writePath, decision: 'allow', ruleId: decision.ruleId, reason: decision.reason });
                    } else {
                        const td = await decideForTool('write_to_file');
                        if (td.effect === 'deny') {
                            await audit({ tool: 'write_to_file', target: writePath, decision: 'deny', ruleId: td.ruleId, reason: td.reason });
                            toolResult = `Blocked by permissions rule. ${td.reason}`;
                            break;
                        }

                        if (td.effect === 'allow') {
                            allowWrite = true;
                            await audit({ tool: 'write_to_file', target: writePath, decision: 'allow', ruleId: td.ruleId, reason: td.reason });
                        } else {
                            const confirm = await promptPathPermission('write_to_file', writePath, writeCheck.reason || 'Blocked by Shield.');
                            if (!confirm.allowed) {
                                await audit({ tool: 'write_to_file', target: writePath, decision: 'deny', ruleId: (confirm as any).ruleId, reason: 'User denied.' });
                                toolResult = writeCheck.reason || "Blocked by Shield.";
                                break;
                            }
                            allowWrite = true;
                            await audit({ tool: 'write_to_file', target: writePath, decision: 'allow', ruleId: (confirm as any).ruleId, reason: (confirm as any).ruleId ? 'Persisted allow rule created.' : 'User allowed.' });
                        }
                    }
                }
                const content = String(call.args.content ?? '');
                if (dryRun) {
                    toolResult = `DRY RUN: would write ${Buffer.byteLength(content, 'utf8')} bytes to ${writePath}`;
                } else {
                    console.log(`💾  Writing content to: \x1b[32m${writePath}\x1b[0m`);
                    await fs.mkdir(path.dirname(writePath), { recursive: true });
                    await fs.writeFile(writePath, content, 'utf-8');
                    toolResult = `Successfully wrote to ${writePath}`;
                }
                break;

            case 'read_file':
                const readPath = call.args.filepath as string;
                {
                    const td = await decideForTool('read_file');
                    if (td.effect === 'deny') {
                        await audit({ tool: 'read_file', target: readPath, decision: 'deny', ruleId: td.ruleId, reason: td.reason });
                        toolResult = `Blocked by permissions rule. ${td.reason}`;
                        break;
                    }
                }
                console.log(`📖  Reading file: \x1b[36m${call.args.filepath}\x1b[0m`);
                const readCheck = validatePath(readPath);
                let allowRead = readCheck.allowed;
                if (!allowRead) {
                    console.log(`\x1b[31mðŸ›¡ï¸  SHIELD INTERCEPTED: \x1b[0m${readCheck.reason}`);
                    const decision = await decideForPath('read_file', readPath);
                    if (decision.effect === 'deny') {
                        await audit({ tool: 'read_file', target: readPath, decision: 'deny', ruleId: decision.ruleId, reason: decision.reason });
                        toolResult = `Blocked by permissions rule. ${decision.reason}`;
                        break;
                    }

                    if (decision.effect === 'allow') {
                        allowRead = true;
                        await audit({ tool: 'read_file', target: readPath, decision: 'allow', ruleId: decision.ruleId, reason: decision.reason });
                    } else {
                        const td = await decideForTool('read_file');
                        if (td.effect === 'deny') {
                            await audit({ tool: 'read_file', target: readPath, decision: 'deny', ruleId: td.ruleId, reason: td.reason });
                            toolResult = `Blocked by permissions rule. ${td.reason}`;
                            break;
                        }

                        if (td.effect === 'allow') {
                            allowRead = true;
                            await audit({ tool: 'read_file', target: readPath, decision: 'allow', ruleId: td.ruleId, reason: td.reason });
                        } else {
                            const confirm = await promptPathPermission('read_file', readPath, readCheck.reason || 'Blocked by Shield.');
                            if (!confirm.allowed) {
                                await audit({ tool: 'read_file', target: readPath, decision: 'deny', ruleId: (confirm as any).ruleId, reason: 'User denied.' });
                                toolResult = readCheck.reason || "Blocked by Shield.";
                                break;
                            }
                            allowRead = true;
                            await audit({ tool: 'read_file', target: readPath, decision: 'allow', ruleId: (confirm as any).ruleId, reason: (confirm as any).ruleId ? 'Persisted allow rule created.' : 'User allowed.' });
                        }
                    }
                }
                toolResult = await fs.readFile(readPath, 'utf-8');
                break;

            case 'get_project_tree':
                const dirPath = (call.args.dir_path as string) || '.';
                {
                    const td = await decideForTool('get_project_tree');
                    if (td.effect === 'deny') {
                        await audit({ tool: 'get_project_tree', target: dirPath, decision: 'deny', ruleId: td.ruleId, reason: td.reason });
                        toolResult = `Blocked by permissions rule. ${td.reason}`;
                        break;
                    }
                }
                const treeCheck = validatePath(dirPath);
                if (!treeCheck.allowed) {
                    console.log(`\x1b[31mðŸ›¡ï¸  SHIELD INTERCEPTED: \x1b[0m${treeCheck.reason}`);
                    const decision = await decideForPath('get_project_tree', dirPath);
                    if (decision.effect === 'deny') {
                        await audit({ tool: 'get_project_tree', target: dirPath, decision: 'deny', ruleId: decision.ruleId, reason: decision.reason });
                        toolResult = `Blocked by permissions rule. ${decision.reason}`;
                        break;
                    }

                    if (decision.effect === 'allow') {
                        await audit({ tool: 'get_project_tree', target: dirPath, decision: 'allow', ruleId: decision.ruleId, reason: decision.reason });
                    } else {
                        const td = await decideForTool('get_project_tree');
                        if (td.effect === 'deny') {
                            await audit({ tool: 'get_project_tree', target: dirPath, decision: 'deny', ruleId: td.ruleId, reason: td.reason });
                            toolResult = `Blocked by permissions rule. ${td.reason}`;
                            break;
                        }

                        if (td.effect === 'allow') {
                            await audit({ tool: 'get_project_tree', target: dirPath, decision: 'allow', ruleId: td.ruleId, reason: td.reason });
                        } else {
                            const confirm = await promptPathPermission('get_project_tree', dirPath, treeCheck.reason || 'Blocked by Shield.');
                            if (!confirm.allowed) {
                                await audit({ tool: 'get_project_tree', target: dirPath, decision: 'deny', ruleId: (confirm as any).ruleId, reason: 'User denied.' });
                                toolResult = treeCheck.reason || "Blocked by Shield.";
                                break;
                            }
                            await audit({ tool: 'get_project_tree', target: dirPath, decision: 'allow', ruleId: (confirm as any).ruleId, reason: (confirm as any).ruleId ? 'Persisted allow rule created.' : 'User allowed.' });
                        }
                    }
                }
                console.log(`🌳  Mapping project tree for: \x1b[36m${dirPath}\x1b[0m`);
                toolResult = `Project structure (Max depth 3):\n${await generateTree(dirPath)}`;
                break;

            case 'store_memory':
                const memDir = path.join(os.homedir(), '.web-scout');
                if (dryRun) {
                    toolResult = `DRY RUN: would append to MEMORY.md: ${String(call.args.fact || '').slice(0, 2000)}`;
                } else {
                    await fs.mkdir(memDir, { recursive: true });
                    const date = new Date().toISOString().split('T')[0];
                    await fs.appendFile(path.join(memDir, 'MEMORY.md'), `- [${date}] ${call.args.fact}\n`, 'utf-8');
                    toolResult = "Successfully stored memory.";
                }
                break;

            case 'memory_search':
                const searchQuery = call.args.query as string;
                toolResult = await performHybridSearch(searchQuery);
                break;

            case 'send_desktop_notification':
                const notifier = (await import('node-notifier')).default;
                const { title, message, open_file_path } = call.args;
                if (dryRun) {
                    toolResult = `DRY RUN: would send desktop notification: ${String(title || 'Web-Scout Agent')} — ${String(message || '')}`;
                    break;
                }

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
                const tasks = await readTasks(tasksFile);

                const executeAtRaw = String(call.args.execute_at);
                const executeAtDate = new Date(executeAtRaw);
                if (Number.isNaN(executeAtDate.getTime())) {
                    toolResult = `Invalid execute_at timestamp '${executeAtRaw}'. Please pass an ISO 8601 date/time (e.g. 2026-03-25T14:30:00.000Z).`;
                    break;
                }

                const normalizeInterval = (value: unknown): 'hourly' | 'daily' | 'weekly' | 'monthly' | null => {
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

                const nowIso = new Date().toISOString();
                const cronExpression = call.args.cron_expression ? String(call.args.cron_expression).trim() : '';
                const timezone = call.args.timezone ? String(call.args.timezone).trim() : (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
                const missedRunPolicy = (['skip', 'catch_up_once', 'catch_up_all'].includes(String(call.args.missed_run_policy || '')))
                    ? (String(call.args.missed_run_policy) as any)
                    : 'catch_up_once';

                const schedule = cronExpression
                    ? ({ type: 'cron', cron: cronExpression, timezone } as const)
                    : isRecurring && recurrenceInterval
                        ? ({ type: 'interval', interval: recurrenceInterval, anchorAt: executeAtDate.toISOString(), timezone: null } as const)
                        : ({ type: 'once', executeAt: executeAtDate.toISOString() } as const);

                const newTask = {
                    id: Date.now(),
                    prompt: String(call.args.task_prompt || ''),
                    enabled: true,
                    schedule,
                    missedRunPolicy,
                    lastRunAt: null,
                    nextRunAt: executeAtDate.toISOString(),
                    createdAt: nowIso,
                    updatedAt: nowIso
                };

                if (dryRun) {
                    toolResult = `DRY RUN: would schedule task: ${scheduleSummary(newTask as any)} (next: ${(newTask as any).nextRunAt})`;
                    break;
                }

                tasks.push(newTask as any);
                await writeTasks(tasks as any, tasksFile);
                toolResult = `✅ Task scheduled: ${scheduleSummary(newTask as any)} (next: ${(newTask as any).nextRunAt})`;
                break;

            case 'ingest_document': {
                const docPath = String(call.args.filepath || '');
                const title = call.args.title ? String(call.args.title) : undefined;
                const sourceUrl = call.args.source_url ? String(call.args.source_url) : undefined;
                const sourceType = call.args.source_type ? String(call.args.source_type) : undefined;

                const toolDecision = await decideForTool('ingest_document');
                if (toolDecision.effect === 'deny') {
                    await audit({ tool: 'ingest_document', target: docPath, decision: 'deny', ruleId: toolDecision.ruleId, reason: toolDecision.reason });
                    toolResult = `Blocked by permissions rule. ${toolDecision.reason}`;
                    break;
                }

                const docCheck = validatePath(docPath);
                let allowIngest = docCheck.allowed;
                if (!allowIngest) {
                    const decision = await decideForPath('ingest_document', docPath);
                    if (decision.effect === 'deny') {
                        await audit({ tool: 'ingest_document', target: docPath, decision: 'deny', ruleId: decision.ruleId, reason: decision.reason });
                        toolResult = `Blocked by permissions rule. ${decision.reason}`;
                        break;
                    }

                    if (decision.effect === 'allow') {
                        allowIngest = true;
                        await audit({ tool: 'ingest_document', target: docPath, decision: 'allow', ruleId: decision.ruleId, reason: decision.reason });
                    } else if (toolDecision.effect === 'allow') {
                        allowIngest = true;
                        await audit({ tool: 'ingest_document', target: docPath, decision: 'allow', ruleId: toolDecision.ruleId, reason: toolDecision.reason });
                    } else {
                        const confirm = await promptPathPermission('ingest_document', docPath, docCheck.reason || 'Blocked by Shield.');
                        if (!confirm.allowed) {
                            await audit({ tool: 'ingest_document', target: docPath, decision: 'deny', ruleId: (confirm as any).ruleId, reason: 'User denied.' });
                            toolResult = docCheck.reason || "Blocked by Shield.";
                            break;
                        }
                        allowIngest = true;
                        await audit({ tool: 'ingest_document', target: docPath, decision: 'allow', ruleId: (confirm as any).ruleId, reason: (confirm as any).ruleId ? 'Persisted allow rule created.' : 'User allowed.' });
                    }
                }

                if (!allowIngest) {
                    toolResult = docCheck.reason || "Blocked by Shield.";
                    break;
                }

                if (dryRun) {
                    toolResult = `DRY RUN: would ingest document into memory: ${docPath}`;
                    break;
                }

                const r = await ingestDocument(docPath, { title, url: sourceUrl, sourceType });
                toolResult = r.skipped
                    ? `✅ Document already up-to-date in memory: ${r.title} (${r.sourceType})`
                    : `✅ Ingested document into memory: ${r.title} (${r.sourceType}) — ${r.chunks} chunks indexed.`;
                break;
            }

            case 'read_pdf':
                const pdfPath = call.args.filepath as string;
                {
                    const td = await decideForTool('read_pdf');
                    if (td.effect === 'deny') {
                        await audit({ tool: 'read_pdf', target: pdfPath, decision: 'deny', ruleId: td.ruleId, reason: td.reason });
                        toolResult = `Blocked by permissions rule. ${td.reason}`;
                        break;
                    }
                }
                const pdfCheck = validatePath(pdfPath);
                if (!pdfCheck.allowed) {
                    console.log(`\x1b[31mðŸ›¡ï¸  SHIELD INTERCEPTED: \x1b[0m${pdfCheck.reason}`);
                    const decision = await decideForPath('read_pdf', pdfPath);
                    if (decision.effect === 'deny') {
                        await audit({ tool: 'read_pdf', target: pdfPath, decision: 'deny', ruleId: decision.ruleId, reason: decision.reason });
                        toolResult = `Blocked by permissions rule. ${decision.reason}`;
                        break;
                    }

                    if (decision.effect === 'allow') {
                        await audit({ tool: 'read_pdf', target: pdfPath, decision: 'allow', ruleId: decision.ruleId, reason: decision.reason });
                    } else {
                        const td = await decideForTool('read_pdf');
                        if (td.effect === 'deny') {
                            await audit({ tool: 'read_pdf', target: pdfPath, decision: 'deny', ruleId: td.ruleId, reason: td.reason });
                            toolResult = `Blocked by permissions rule. ${td.reason}`;
                            break;
                        }

                        if (td.effect === 'allow') {
                            await audit({ tool: 'read_pdf', target: pdfPath, decision: 'allow', ruleId: td.ruleId, reason: td.reason });
                        } else {
                            const confirm = await promptPathPermission('read_pdf', pdfPath, pdfCheck.reason || 'Blocked by Shield.');
                            if (!confirm.allowed) {
                                await audit({ tool: 'read_pdf', target: pdfPath, decision: 'deny', ruleId: (confirm as any).ruleId, reason: 'User denied.' });
                                toolResult = pdfCheck.reason || "Blocked by Shield.";
                                break;
                            }
                            await audit({ tool: 'read_pdf', target: pdfPath, decision: 'allow', ruleId: (confirm as any).ruleId, reason: (confirm as any).ruleId ? 'Persisted allow rule created.' : 'User allowed.' });
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
                const pdfParseMod = (await import('pdf-parse')) as any;
                const pdfParse = pdfParseMod?.default || pdfParseMod;
                const pdfData = await pdfParse(pdfBuffer);
                const extracted = String(pdfData?.text || '').trim();
                toolResult = `PDF Contents of ${path.basename(pdfPath)}:\n\n${extracted || '[No text extracted from PDF]'}\n`;
                break;

            default:
                toolResult = `Tool ${call.name} not found in systemTools.`;
        }
    } catch (error: any) {
        toolResult = `Error executing ${call.name}: ${error.message}`;
    }

    return { result: toolResult };
}
