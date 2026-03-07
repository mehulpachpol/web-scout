import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { executeSystemTool, systemToolDeclarations } from '../tools/systemTools';
import { closeBrowser, executeWebTool, webToolDeclarations } from '../tools/webTools';

async function logConversation(role: 'User' | 'Agent', text: string) {
    if (!text) return;
    try {
        const logDir = path.join(os.homedir(), '.web-scout', 'logs');
        await fs.mkdir(logDir, { recursive: true });
        const date = new Date().toISOString().split('T')[0];
        const logFile = path.join(logDir, `${date}.md`);
        await fs.appendFile(logFile, `**[${new Date().toLocaleTimeString()}] ${role}:**\n${text}\n\n`, 'utf-8');
    } catch (e) { }
}

function pruneChatHistory(chat: any) {
    if (!chat.history || chat.history.length === 0) return;
    const SAFE_WINDOW = 4;
    const historyLength = chat.history.length;
    if (historyLength <= SAFE_WINDOW) return;

    let prunedCount = 0;
    for (let i = 0; i < historyLength - SAFE_WINDOW; i++) {
        const message = chat.history[i];
        if (message.parts) {
            for (const part of message.parts) {
                if (part.functionResponse && part.functionResponse.response && typeof part.functionResponse.response.result === 'string') {
                    const content = part.functionResponse.response.result;
                    if (content.length > 1500 && !content.includes('[✂️ OLD TOOL RESULT PRUNED]')) {
                        const firstPart = content.substring(0, 500);
                        const lastPart = content.substring(content.length - 500);
                        part.functionResponse.response.result = `${firstPart}\n\n...[✂️ OLD TOOL RESULT PRUNED TO SAVE MEMORY]...\n\n${lastPart}`;
                        prunedCount++;
                    }
                }
                if (part.inlineData && part.inlineData.data && !part.inlineData.data.startsWith('[IMAGE')) {
                    part.inlineData = {
                        mimeType: "text/plain",
                        data: Buffer.from("[IMAGE CLEARED FROM HISTORY TO SAVE TOKENS]").toString('base64')
                    };
                    prunedCount++;
                }
            }
        }
    }
}

async function checkAndFlushMemory(chat: any) {
    if (!chat.history) return;

    const COMPACTION_THRESHOLD = 30;
    const RETAIN_COUNT = 10;

    if (chat.history.length > COMPACTION_THRESHOLD) {
        console.log(`\n\x1b[90m[System: Context threshold reached. Running Pre-Compaction Flush...]\x1b[0m`);

        try {
            let response = await chat.sendMessage({
                message: "SYSTEM ALERT: Session nearing compaction. Review the conversation above. Use the 'store_memory' tool to permanently save any new durable facts, user preferences, project paths, or critical decisions. If there is nothing important to save, simply reply with the exact text 'NO_REPLY'."
            });

            while (response.functionCalls && response.functionCalls.length > 0) {
                const call: any = response.functionCalls[0];
                let toolResult = "";

                if (call.name === 'store_memory') {
                    const dummyAsk = async () => 'Y';
                    const executionData = await executeSystemTool(call, dummyAsk);
                    toolResult = executionData.result;
                    console.log(`\x1b[90m[System: Agent saved a memory: ${call.args.fact}]\x1b[0m`);
                } else {
                    toolResult = "SYSTEM ERROR: Only store_memory is permitted during flush.";
                }

                response = await chat.sendMessage({
                    message: [{
                        functionResponse: {
                            id: call.id,
                            name: call.name,
                            response: { result: toolResult }
                        }
                    }]
                });
            }

            const elementsToRemove = chat.history.length - RETAIN_COUNT;
            chat.history.splice(0, elementsToRemove);

            console.log(`\x1b[90m[System: Memory flush complete. Old context cleared. Resume normal operations.]\x1b[0m\n`);

        } catch (error) {
            console.error("\x1b[90m[System: Memory flush failed silently.]\x1b[0m", error);
        }
    }
}

export async function runReactLoop(chat: any, rl: readline.Interface) {
    const askQuestion = (query: string): Promise<string> => new Promise((resolve) => rl.question(query, resolve));

    const systemToolNames = new Set(systemToolDeclarations.map(t => t.name));
    const webToolNames = new Set(webToolDeclarations.map(t => t.name));

    console.log("🤖 Agent initialized. Type 'exit' to quit.\n");

    while (true) {
        await checkAndFlushMemory(chat);
        pruneChatHistory(chat);

        const userInput = await askQuestion('\n👤 You: ');

        if (userInput.trim().toLowerCase() === 'exit') {
            console.log('👋 Cleaning up and exiting...');
            await closeBrowser();
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
                let executionData: { result: string, base64Image?: string } = { result: "" };

                if (systemToolNames.has(call.name)) {
                    executionData = await executeSystemTool(call, askQuestion);
                } else if (webToolNames.has(call.name)) {
                    executionData = await executeWebTool(call);
                } else {
                    executionData.result = `Unknown tool: ${call.name}`;
                }

                if (executionData.result.length > 20000) {
                    executionData.result = executionData.result.substring(0, 20000) + "\n...[CONTENT TRUNCATED]...";
                }

                process.stdout.write(`🤖 Agent: ...processing ${call.name} output...`);

                const messageParts: any[] = [{
                    functionResponse: {
                        id: call.id,
                        name: call.name,
                        response: { result: executionData.result }
                    }
                }];

                if (executionData.base64Image) {
                    messageParts.push({
                        inlineData: { mimeType: "image/jpeg", data: executionData.base64Image }
                    });
                }

                response = await chat.sendMessage({ message: messageParts });

                readline.clearLine(process.stdout, 0);
                readline.cursorTo(process.stdout, 0);
            }

            if (response.text) {
                if (!response.text.includes('NO_REPLY')) {
                    console.log(`🤖 Agent: ${response.text}`);
                    await logConversation('Agent', response.text);
                }
            }

        } catch (error) {
            console.error("\n❌ Error:", error);
        }
    }
}