import 'dotenv/config';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function generateRollingSummary(oldMessages: OpenAI.Chat.ChatCompletionMessageParam[]): Promise<string> {
    const transcript = oldMessages.map(msg => {
        const role = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Agent' : 'System Tool';
        const text = typeof msg.content === 'string' ? msg.content : '[Complex Tool Data]';
        return `${role}: ${text}`;
    }).join('\n\n');

    const prompt = `
    You are a core memory compactor for an autonomous AI agent.
    Below is a transcript of the oldest messages in the current conversation.
    Condense this into a dense, 3-4 sentence "Rolling Summary" that captures the exact context, 
    decisions made, and active tasks. Omit pleasantries. Retain technical facts, file paths, and code architecture details.
    
    TRANSCRIPT:
    ${transcript}
    `;

    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }]
        });
        return response.choices[0].message.content || "Summary generation failed.";
    } catch (error) {
        console.error("Compaction failed:", error);
        return "Previous context retained.";
    }
}