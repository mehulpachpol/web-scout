import { FunctionDeclaration } from '@google/genai';
import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { performHybridSearch } from '../memory/retrieval';

const execAsync = promisify(exec);
const TRUST_MODE = process.argv.includes('--trust-mode');

export const systemToolDeclarations: FunctionDeclaration[] = [
    {
        name: 'execute_command',
        description: 'Executes a CLI command in the terminal. Use for local system tasks.',
        parametersJsonSchema: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command']
        }
    },
    {
        name: 'write_to_file',
        description: 'Writes text or code directly to a file. ALWAYS use this instead of CLI "echo" or "out-file" commands when writing multi-line content or code.',
        parametersJsonSchema: {
            type: 'object',
            properties: {
                filepath: { type: 'string', description: 'The absolute or relative path to the file' },
                content: { type: 'string', description: 'The full string content to write into the file.' }
            },
            required: ['filepath', 'content']
        }
    },
    {
        name: 'read_file',
        description: 'Reads the exact contents of a file from the local disk.',
        parametersJsonSchema: {
            type: 'object',
            properties: { filepath: { type: 'string' } },
            required: ['filepath']
        }
    },
    {
        name: 'get_project_tree',
        description: 'Returns a visual tree of the files and directories in the project. Automatically ignores node_modules and .git.',
        parametersJsonSchema: {
            type: 'object',
            properties: { dir_path: { type: 'string', description: 'Directory path to map out (default is ".")' } }
        }
    },
    {
        name: 'store_memory',
        description: 'Saves an important fact, preference, or context about the user or project to long-term memory.',
        parametersJsonSchema: {
            type: 'object',
            properties: { fact: { type: 'string' } },
            required: ['fact']
        }
    },
    {
        name: 'memory_search',
        description: 'Performs a semantic vector search across all past conversations, logs, and long-term memory. Use this to find past facts, preferences, code snippets, or context.',
        parametersJsonSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'A natural language query describing what you are trying to remember.' }
            },
            required: ['query']
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

    try {
        switch (call.name) {
            case 'execute_command':
                const command = call.args.command as string;
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
                console.log(`💾  Writing content to: \x1b[32m${writePath}\x1b[0m`);
                await fs.mkdir(path.dirname(writePath), { recursive: true });
                await fs.writeFile(writePath, call.args.content as string, 'utf-8');
                toolResult = `Successfully wrote to ${writePath}`;
                break;

            case 'read_file':
                console.log(`📖  Reading file: \x1b[36m${call.args.filepath}\x1b[0m`);
                toolResult = await fs.readFile(call.args.filepath as string, 'utf-8');
                break;

            case 'get_project_tree':
                const dirPath = (call.args.dir_path as string) || '.';
                console.log(`🌳  Mapping project tree for: \x1b[36m${dirPath}\x1b[0m`);
                toolResult = `Project structure (Max depth 3):\n${await generateTree(dirPath)}`;
                break;

            case 'store_memory':
                console.log(`🧠  Storing memory: \x1b[35m${call.args.fact}\x1b[0m`);
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

            default:
                toolResult = `Tool ${call.name} not found in systemTools.`;
        }
    } catch (error: any) {
        toolResult = `Error executing ${call.name}: ${error.message}`;
    }

    return { result: toolResult };
}