import 'dotenv/config';
import OpenAI from 'openai';
import { generateRollingSummary } from '../memory/compactor';
import { executeSystemTool, systemToolDeclarations } from '../tools/systemTools';
import { executeWebTool, webToolDeclarations } from '../tools/webTools';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ALL_TOOLS = [...systemToolDeclarations, ...webToolDeclarations];

export async function runAgentTurn(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    callbacks: any
) {
    const systemToolNames = new Set(systemToolDeclarations.map(t => (t as any).function.name));

    try {
        const MAX_MESSAGES = 25;
        if (messages.length > MAX_MESSAGES) {
            callbacks.onStatusUpdate('Compacting old memory to save tokens...');
            let splitIndex = messages.length - 8;
            while (splitIndex < messages.length && messages[splitIndex].role !== 'user') {
                splitIndex++;
            }

            const messagesToCompact = messages.slice(1, splitIndex);
            const summary = await generateRollingSummary(messagesToCompact);

            messages.splice(1, messagesToCompact.length, {
                role: 'system',
                content: `[System Note - Rolling Summary of previous conversation]: ${summary}`
            });
        }

        callbacks.onStatusUpdate('Agent is thinking...');

        let response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: messages,
            tools: ALL_TOOLS,
        });

        let responseMessage = response.choices[0].message;

        messages.push(responseMessage as OpenAI.Chat.ChatCompletionMessageParam);

        while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {

            for (const toolCall of responseMessage.tool_calls) {
                const func = (toolCall as any).function;

                callbacks.onStatusUpdate(`Executing tool: ${func.name}...`);

                const args = JSON.parse(func.arguments);
                let executionResult = "";

                if (systemToolNames.has(func.name)) {
                    const callObj = { name: func.name, args: args };
                    const data = await executeSystemTool(callObj, async () => 'y');
                    executionResult = data.result;
                } else {
                    const data = await executeWebTool(func.name, args);
                    executionResult = data.result;
                }

                if (executionResult.length > 20000) {
                    executionResult = executionResult.substring(0, 20000) + "\n...[CONTENT TRUNCATED]...";
                }

                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: executionResult
                });
            }

            callbacks.onStatusUpdate(`Analyzing tool outputs...`);

            response = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages: messages,
                tools: ALL_TOOLS,
            });

            responseMessage = response.choices[0].message;
            messages.push(responseMessage as OpenAI.Chat.ChatCompletionMessageParam);
        }

        callbacks.onStatusUpdate('Idle');

        if (responseMessage.content) {
            callbacks.onAgentReply(responseMessage.content);
        }

    } catch (error: any) {
        callbacks.onError(error);
        callbacks.onStatusUpdate('Idle');
    }
}