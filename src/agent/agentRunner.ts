import { executeSystemTool, systemToolDeclarations } from '../tools/systemTools';
import { executeWebTool, webToolDeclarations } from '../tools/webTools';

export async function runAgentTurn(
    chat: any,
    userInput: string,
    callbacks: {
        onStatusUpdate: (status: string) => void,
        onAgentReply: (text: string) => void,
        onError: (err: any) => void
    }
) {
    const systemToolNames = new Set(systemToolDeclarations.map(t => t.name));
    const webToolNames = new Set(webToolDeclarations.map(t => t.name));

    try {
        callbacks.onStatusUpdate('Agent is thinking...');
        let response = await chat.sendMessage({ message: userInput });

        while (response.functionCalls && response.functionCalls.length > 0) {
            const call: any = response.functionCalls[0];
            let executionData: { result: string, base64Image?: string } = { result: "" };

            callbacks.onStatusUpdate(`Executing tool: ${call.name}...`);

            // Note: For the Ink UI, we temporarily bypass the interactive Y/n prompt 
            // by passing a dummy function that always returns 'y'. We will build a native Ink confirmation modal later!
            const dummyAsk = async () => 'y';

            if (systemToolNames.has(call.name)) {
                executionData = await executeSystemTool(call, dummyAsk);
            } else if (webToolNames.has(call.name)) {
                executionData = await executeWebTool(call);
            } else {
                executionData.result = `Unknown tool: ${call.name}`;
            }

            if (executionData.result.length > 20000) {
                executionData.result = executionData.result.substring(0, 20000) + "\n...[CONTENT TRUNCATED]...";
            }

            const messageParts: any[] = [{
                functionResponse: {
                    id: call.id,
                    name: call.name,
                    response: { result: executionData.result }
                }
            }];

            if (executionData.base64Image) {
                messageParts.push({ inlineData: { mimeType: "image/jpeg", data: executionData.base64Image } });
            }

            callbacks.onStatusUpdate(`Analyzing ${call.name} output...`);
            response = await chat.sendMessage({ message: messageParts });
        }

        callbacks.onStatusUpdate('Idle');

        if (response.text && !response.text.includes('NO_REPLY')) {
            callbacks.onAgentReply(response.text);
        }

    } catch (error) {
        callbacks.onError(error);
        callbacks.onStatusUpdate('Idle');
    }
}