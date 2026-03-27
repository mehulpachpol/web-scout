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
    const askQuestion = typeof callbacks?.askQuestion === 'function' ? callbacks.askQuestion : async () => 'y';
    const abortSignal: AbortSignal | undefined = callbacks?.abortSignal;
    const executionOptions = callbacks?.executionOptions || {};
    const requestOptions = abortSignal ? ({ signal: abortSignal } as any) : undefined;
    const throwIfAborted = () => {
        if (abortSignal?.aborted) {
            throw new Error('Aborted by user.');
        }
    };
    const looksLikeLinkDump = (text: string) => {
        const urls = text.match(/https?:\/\/\S+/g) || [];
        const nonUrl = text.replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
        const nonUrlWords = nonUrl ? nonUrl.split(' ').length : 0;
        const hasSourcesSection = /(^|\n)\s*(sources|references)\s*:/i.test(text);
        const isMostlyLinks = urls.length >= 3 && nonUrlWords < 120;
        const isSourcesOnly = hasSourcesSection && urls.length >= 2 && nonUrlWords < 180;
        return isMostlyLinks || isSourcesOnly;
    };

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

        throwIfAborted();
        let response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: messages,
            tools: ALL_TOOLS,
        }, requestOptions);

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
                    throwIfAborted();
                    const data = await executeSystemTool(callObj, askQuestion, executionOptions);
                    executionResult = data.result;
                } else {
                    throwIfAborted();
                    const data = await executeWebTool(func.name, args, abortSignal);
                    executionResult = data.result;
                }

                if (executionResult.length > 20000) {
                    executionResult = executionResult.substring(0, 20000) + "\n...[CONTENT TRUNCATED]...";
                }

                if (typeof callbacks?.onToolOutput === 'function') {
                    try {
                        callbacks.onToolOutput(func.name, args, executionResult);
                    } catch {
                    }
                }

                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: executionResult
                });
            }

            callbacks.onStatusUpdate(`Analyzing tool outputs...`);

            throwIfAborted();
            response = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages: messages,
                tools: ALL_TOOLS,
            }, requestOptions);

            responseMessage = response.choices[0].message;
            messages.push(responseMessage as OpenAI.Chat.ChatCompletionMessageParam);
        }

        if (responseMessage.content) {
            let finalContent = responseMessage.content;

            // If the model returns "just links" for a research question, do one extra
            // internal pass to force a complete write-up using the gathered tool outputs.
            if (looksLikeLinkDump(finalContent)) {
                callbacks.onStatusUpdate('Finalizing answer...');
                throwIfAborted();
                const finalize = await openai.chat.completions.create({
                    model: 'gpt-4o',
                    messages: [
                        ...messages,
                        {
                            role: 'system',
                            content:
                                 'FINALIZATION: Rewrite the answer as a complete, user-facing write-up. Do NOT output only links. Use the tool outputs above as sources, include a clear comparison/summary and a conclusion. Keep it concise and actionable.'
                                 + ' If sources are available, cite them inline as [1], [2], etc and include a short Sources list at the end.'
                         }
                    ]
                }, requestOptions);

                const rewritten = finalize.choices[0].message.content;
                if (rewritten && rewritten.trim()) {
                    finalContent = rewritten;
                    responseMessage.content = rewritten;
                }
            }

            callbacks.onAgentReply(finalContent);
        }

        callbacks.onStatusUpdate('Idle');

    } catch (error: any) {
        callbacks.onError(error);
        callbacks.onStatusUpdate('Idle');
    }
}
