import * as fs from 'fs/promises';
import { Box, Static, Text } from 'ink';
import TextInput from 'ink-text-input';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
import OpenAI from 'openai';
import * as os from 'os';
import * as path from 'path';
import { useEffect, useRef, useState } from 'react';
import { runAgentTurn } from '../agent/agentRunner';

marked.setOptions({
    renderer: new TerminalRenderer({ width: 80, reflowText: true }) as any
});

type Message = { id: number; role: 'user' | 'agent' | 'system'; text: string };

async function appendToDailyLog(role: 'User' | 'Agent' | 'Agent (Scheduled)', text: string) {
    const date = new Date().toISOString().split('T')[0];
    const logDir = path.join(os.homedir(), '.web-scout', 'logs');
    const logPath = path.join(logDir, `${date}.md`);
    const time = new Date().toLocaleTimeString();
    const entry = `\n### [${time}] ${role}\n${text}\n`;
    try {
        await fs.mkdir(logDir, { recursive: true });
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
    const pendingQuestionResolveRef = useRef<((answer: string) => void) | null>(null);
    const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);

    const apiMessagesRef = useRef(apiMessages);
    const isProcessingRef = useRef(isProcessing);

    useEffect(() => {
        apiMessagesRef.current = apiMessages;
        isProcessingRef.current = isProcessing;
    }, [apiMessages, isProcessing]);

    useEffect(() => {
        const checkPendingTasks = async () => {
            if (isProcessingRef.current) return;

            const tasksFile = path.join(os.homedir(), '.web-scout', 'pending_tasks.json');

            try {
                const data = await fs.readFile(tasksFile, 'utf-8');
                const parsed = JSON.parse(data);
                const tasks = Array.isArray(parsed) ? parsed : [];
                const now = new Date();

                const toDate = (value: unknown): Date | null => {
                    const d = new Date(String(value ?? ''));
                    return Number.isNaN(d.getTime()) ? null : d;
                };

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

                const sortedTasks = tasks
                    .map((t: any) => ({ ...t, __time: toDate(t.executeAt) }))
                    .filter((t: any) => t.__time)
                    .sort((a: any, b: any) => a.__time.getTime() - b.__time.getTime());

                const dueTasks = sortedTasks.filter((t: any) => t.__time <= now);
                const futureTasks = sortedTasks.filter((t: any) => t.__time > now);

                if (dueTasks.length > 0) {
                    const stripMeta = (t: any) => {
                        const { __time, ...rest } = t;
                        return rest;
                    };

                    const taskToRun = stripMeta(dueTasks[0]);
                    let updatedTasks = [...futureTasks, ...dueTasks.slice(1)].map(stripMeta);

                    const interval = normalizeInterval(taskToRun.recurrenceInterval);
                    if (taskToRun.isRecurring && interval) {
                        const addIntervalOnce = (d: Date) => {
                            if (interval === 'hourly') d.setHours(d.getHours() + 1);
                            else if (interval === 'daily') d.setDate(d.getDate() + 1);
                            else if (interval === 'weekly') d.setDate(d.getDate() + 7);
                            else if (interval === 'monthly') d.setMonth(d.getMonth() + 1);
                        };

                        const nextTime = toDate(taskToRun.executeAt) || new Date(now);
                        addIntervalOnce(nextTime);

                        let guard = 0;
                        while (nextTime <= now && guard++ < 500) addIntervalOnce(nextTime);

                        updatedTasks.push({
                            ...taskToRun,
                            isRecurring: true,
                            recurrenceInterval: interval,
                            executeAt: nextTime.toISOString()
                        });
                        console.log(`\n🔁 Rescheduled recurring task for ${nextTime.toLocaleString()}`);
                    }

                    updatedTasks.sort((a: any, b: any) => new Date(a.executeAt).getTime() - new Date(b.executeAt).getTime());
                    await fs.writeFile(tasksFile, JSON.stringify(updatedTasks, null, 2), 'utf-8');

                    setIsProcessing(true);
                    setStatus('Executing scheduled task...');
                    setHistory(prev => [...prev, { id: Date.now(), role: 'system', text: `⏰ Scheduled Task Triggered: ${taskToRun.prompt}` }]);

                    const currentMessages = [
                        ...apiMessagesRef.current,
                        {
                            role: 'user',
                            content: `SYSTEM WAKEUP (Scheduled Task): ${taskToRun.prompt} \n\nCRITICAL INSTRUCTION: Since this is a background task, the user is not looking at the terminal. When you are finished, use the 'write_to_file' tool to save your final summary to a markdown file (e.g., in a 'reports' folder). Then, use the 'send_desktop_notification' tool to alert the user and pass the absolute path of that markdown file so it opens on their screen.`
                        } as OpenAI.Chat.ChatCompletionMessageParam
                    ];

                    await runAgentTurn(currentMessages, {
                        onStatusUpdate: (newStatus: string) => setStatus(newStatus),
                        onAgentReply: async (text: string) => {
                            setHistory(prev => [...prev, { id: Date.now(), role: 'agent', text }]);
                            await appendToDailyLog('Agent (Scheduled)', text);

                            setApiMessages([...currentMessages]);
                            setIsProcessing(false);
                            setStatus('Idle');
                        },
                        askQuestion: async () => 'n',
                        onError: (err: any) => {
                            setHistory(prev => [...prev, { id: Date.now(), role: 'system', text: `❌ Task Error: ${err.message}` }]);
                            setIsProcessing(false);
                            setStatus('Idle');
                        }
                    });
                }
            } catch (e) {
            }
        };

        const interval = setInterval(checkPendingTasks, 15000);
        return () => clearInterval(interval);
    }, []);

    const askQuestion = async (q: string) => {
        return await new Promise<string>((resolve) => {
            setPendingQuestion(q);
            setHistory(prev => [...prev, { id: Date.now(), role: 'system', text: q }]);
            pendingQuestionResolveRef.current = (answer: string) => {
                pendingQuestionResolveRef.current = null;
                setPendingQuestion(null);
                resolve(answer);
            };
        });
    };

    const handleSubmit = async (query: string) => {
        if (!query.trim()) return;

        if (pendingQuestionResolveRef.current) {
            const resolver = pendingQuestionResolveRef.current;
            setInput('');
            setHistory(prev => [...prev, { id: Date.now(), role: 'user', text: query }]);
            await appendToDailyLog('User', query);
            resolver(query);
            return;
        }

        if (isProcessing) return;

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

        // Named function so it can call itself if the agent needs to loop
        const handleAgentReply = async (text: string, messagesToUpdate: OpenAI.Chat.ChatCompletionMessageParam[]) => {
            const needsToContinue = text.includes('[CONTINUE]');
            const cleanText = text.replace('[CONTINUE]', '').trim();

            setHistory(prev => [...prev, { id: Date.now(), role: 'agent', text: cleanText }]);
            await appendToDailyLog('Agent', cleanText);

            setApiMessages([...messagesToUpdate]);

            if (needsToContinue) {
                setStatus('Agent is initiating the next phase...');

                const continueMessages = [
                    ...messagesToUpdate,
                    { role: 'assistant', content: text } as OpenAI.Chat.ChatCompletionMessageParam,
                    { role: 'user', content: 'SYSTEM: Proceed with the next step of the overarching goal.' } as OpenAI.Chat.ChatCompletionMessageParam
                ];

                setApiMessages(continueMessages);

                setTimeout(() => {
                    runAgentTurn(continueMessages, {
                        onStatusUpdate: (newStatus: string) => setStatus(newStatus),
                        onAgentReply: (newText: string) => handleAgentReply(newText, continueMessages),
                        onError: (err: any) => {
                            setHistory(prev => [...prev, { id: Date.now(), role: 'system', text: `❌ Error: ${err.message}` }]);
                            setIsProcessing(false);
                        }
                    });
                }, 1000);
            } else {
                setIsProcessing(false);
                setStatus('Idle');
            }
        };

        await runAgentTurn(currentApiMessages, {
            onStatusUpdate: (newStatus: string) => setStatus(newStatus),
            onAgentReply: (text: string) => handleAgentReply(text, currentApiMessages),
            askQuestion,
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
                    placeholder={pendingQuestion ? "Approval required (y/n)..." : isProcessing ? "Please wait..." : "Type a message..."}
                />
            </Box>
        </Box>
    );
};
