import * as fs from 'fs/promises';
import { Box, Static, Text } from 'ink';
import TextInput from 'ink-text-input';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
import OpenAI from 'openai';
import * as os from 'os';
import * as path from 'path';
import { useState } from 'react';
import { runAgentTurn } from '../agent/agentRunner';

marked.setOptions({
    renderer: new TerminalRenderer({ width: 80, reflowText: true }) as any
});

type Message = { id: number; role: 'user' | 'agent' | 'system'; text: string };

async function appendToDailyLog(role: 'User' | 'Agent', text: string) {
    const date = new Date().toISOString().split('T')[0];
    const logPath = path.join(os.homedir(), '.web-scout', 'logs', `${date}.md`);
    const time = new Date().toLocaleTimeString();
    const entry = `\n### [${time}] ${role}\n${text}\n`;
    try {
        await fs.appendFile(logPath, entry, 'utf-8');
    } catch (error) {
    }
}

export const App = ({ initialMessages }: { initialMessages: OpenAI.Chat.ChatCompletionMessageParam[] }) => {
    const [apiMessages, setApiMessages] = useState<OpenAI.Chat.ChatCompletionMessageParam[]>(initialMessages);

    const [history, setHistory] = useState<Message[]>([
        { id: 0, role: 'system', text: '🤖 Web-Scout initialized. Type "exit" to quit.' }
    ]);
    const [input, setInput] = useState('');
    const [status, setStatus] = useState('Idle');
    const [isProcessing, setIsProcessing] = useState(false);

    const handleSubmit = async (query: string) => {
        if (!query.trim() || isProcessing) return;

        if (query.trim().toLowerCase() === 'exit') {
            process.exit(0);
        }

        const userMsg = query;
        setInput('');
        setIsProcessing(true);

        setHistory(prev => [...prev, { id: Date.now(), role: 'user', text: userMsg }]);

        await appendToDailyLog('User', userMsg);

        const currentApiMessages = [
            ...apiMessages,
            { role: 'user', content: userMsg } as OpenAI.Chat.ChatCompletionMessageParam
        ];

        await runAgentTurn(currentApiMessages, {
            onStatusUpdate: (newStatus: string) => setStatus(newStatus),
            onAgentReply: async (text: string) => {
                setHistory(prev => [...prev, { id: Date.now(), role: 'agent', text }]);
                await appendToDailyLog('Agent', text);
                setApiMessages([...currentApiMessages]);
                setIsProcessing(false);
            },
            onError: (err: any) => {
                setHistory(prev => [...prev, { id: Date.now(), role: 'system', text: `❌ Error: ${err.message}` }]);
                setIsProcessing(false);
            }
        });
    };

    return (
        <Box flexDirection="column" padding={1}>

            <Static items={history}>
                {(msg) => (
                    <Box key={msg.id} flexDirection="column" marginBottom={1}>
                        <Text bold color={msg.role === 'user' ? 'green' : msg.role === 'agent' ? 'cyan' : 'gray'}>
                            {msg.role === 'user' ? '👤 You:' : msg.role === 'agent' ? '🤖 Agent:' : '⚙️ System:'}
                        </Text>
                        <Text>
                            {msg.role === 'agent' ? (marked.parse(msg.text) as string).trim() : msg.text}
                        </Text>
                    </Box>
                )}
            </Static>

            {isProcessing && (
                <Box marginBottom={1}>
                    <Text color="yellow">🌀 {status}</Text>
                </Box>
            )}

            <Box>
                <Box marginRight={1}>
                    <Text color="green">❯</Text>
                </Box>
                <TextInput
                    value={input}
                    onChange={setInput}
                    onSubmit={handleSubmit}
                    placeholder={isProcessing ? "Please wait..." : "Type a message..."}
                />
            </Box>
        </Box>
    );
};