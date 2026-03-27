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
import { computeNextRunAt, readTasks, scheduleSummary, writeTasks, type ScheduledTask } from '../scheduler/tasks';

marked.setOptions({
    renderer: new TerminalRenderer({
        width: Math.max(60, (process.stdout.columns || 80) - 16),
        reflowText: false
    }) as any
});

type Message = { id: number; role: 'user' | 'agent' | 'system' | 'tool'; text: string };

function indentMultiline(prefix: string, text: string) {
    const pad = ' '.repeat(prefix.length);
    return text
        .split('\n')
        .map((line, i) => (i === 0 ? `${prefix}${line}` : `${pad}${line}`))
        .join('\n');
}

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
        { id: 0, role: 'agent', text: '🤖 Web-Scout initialized. Type "exit" to quit.' }
    ]);
    const [input, setInput] = useState('');
    const [status, setStatus] = useState('Idle');
    const [isProcessing, setIsProcessing] = useState(false);
    const [showTrace, setShowTrace] = useState(false);
    const [dryRun, setDryRun] = useState(false);
    const pendingQuestionResolveRef = useRef<((answer: string) => void) | null>(null);
    const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);

    const apiMessagesRef = useRef(apiMessages);
    const isProcessingRef = useRef(isProcessing);
    const abortControllerRef = useRef<AbortController | null>(null);
    const showTraceRef = useRef(showTrace);
    const dryRunRef = useRef(dryRun);

    useEffect(() => {
        apiMessagesRef.current = apiMessages;
        isProcessingRef.current = isProcessing;
        showTraceRef.current = showTrace;
        dryRunRef.current = dryRun;
    }, [apiMessages, isProcessing, showTrace, dryRun]);

    useEffect(() => {
        const checkPendingTasks = async () => {
            if (isProcessingRef.current) return;

            const tasksFile = path.join(os.homedir(), '.web-scout', 'pending_tasks.json');

            try {
                const tasks = await readTasks(tasksFile);
                const now = new Date();

                const nowIso = now.toISOString();
                const dueTasks = tasks.filter(t => t.enabled && new Date(t.nextRunAt) <= now);

                if (dueTasks.length > 0) {
                    const taskToRun = dueTasks[0] as ScheduledTask;
                    let updatedTasks = tasks.filter(t => t.id !== taskToRun.id);
                    const latenessMs = now.getTime() - new Date(taskToRun.nextRunAt).getTime();
                    const wasMissed = latenessMs > 2 * 60 * 1000;
                    const willSkipExecution = wasMissed && taskToRun.missedRunPolicy === 'skip';

                    // Scheduler v2: compute next run based on task.schedule
                    if (taskToRun.schedule.type !== 'once') {
                        const from = taskToRun.missedRunPolicy === 'catch_up_all'
                            ? new Date(taskToRun.nextRunAt)
                            : now;

                        const next = computeNextRunAt(taskToRun, from);
                        if (next) {
                            updatedTasks.push({
                                ...taskToRun,
                                lastRunAt: willSkipExecution ? (taskToRun.lastRunAt ?? null) : nowIso,
                                nextRunAt: next,
                                updatedAt: nowIso
                            });
                        } else {
                            updatedTasks.push({
                                ...taskToRun,
                                enabled: false,
                                lastRunAt: willSkipExecution ? (taskToRun.lastRunAt ?? null) : nowIso,
                                updatedAt: nowIso
                            });
                        }
                    }

                    await writeTasks(updatedTasks, tasksFile);

                    // Missed-run policy: if this run was missed (app asleep/closed), optionally skip execution.
                    if (willSkipExecution) {
                        return;
                    }

                    setIsProcessing(true);
                    setStatus('Executing scheduled task...');
                    setHistory(prev => [...prev, { id: Date.now(), role: 'agent', text: `⏰ Scheduled Task Triggered: ${taskToRun.prompt}` }]);

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
                        onToolOutput,
                        askQuestion: async () => 'n',
                        onError: (err: any) => {
                            setHistory(prev => [...prev, { id: Date.now(), role: 'agent', text: `❌ Task Error: ${err.message}` }]);
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

    const onToolOutput = (name: string, args: any, result: string) => {
        if (!showTraceRef.current) return;
        const argText = (() => {
            try { return JSON.stringify(args ?? {}, null, 2); } catch { return String(args ?? ''); }
        })();
        const trimmed = String(result || '').trim();
        const body = trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}\n...[TRUNCATED]...` : trimmed;
        setHistory(prev => [...prev, { id: Date.now(), role: 'tool', text: `🧰 ${name}\nArgs:\n${argText}\n\nResult:\n${body}` }]);
    };

    const askQuestion = async (q: string) => {
        return await new Promise<string>((resolve) => {
            setPendingQuestion(q);
            setHistory(prev => [...prev, { id: Date.now(), role: 'agent', text: q }]);
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

        // Local UI commands (no LLM needed)
        const trimmed = query.trim();

        if (trimmed === '/stop') {
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
                abortControllerRef.current = null;
                setHistory(prev => [...prev, { id: Date.now(), role: 'agent', text: 'Stopped current run.' }]);
            } else {
                setHistory(prev => [...prev, { id: Date.now(), role: 'agent', text: 'Nothing to stop.' }]);
            }
            setInput('');
            setIsProcessing(false);
            setStatus('Idle');
            return;
        }

        if (isProcessing) return;

        if (trimmed.startsWith('/trace')) {
            const v = trimmed.split(/\s+/)[1]?.toLowerCase();
            const next = v === 'on' ? true : v === 'off' ? false : !showTraceRef.current;
            setShowTrace(next);
            setHistory(prev => [...prev, { id: Date.now(), role: 'agent', text: `Trace ${next ? 'enabled' : 'disabled'}.` }]);
            setInput('');
            return;
        }

        if (trimmed.startsWith('/dryrun')) {
            const v = trimmed.split(/\s+/)[1]?.toLowerCase();
            const next = v === 'on' ? true : v === 'off' ? false : !dryRunRef.current;
            setDryRun(next);
            setHistory(prev => [...prev, { id: Date.now(), role: 'agent', text: `Dry-run ${next ? 'enabled' : 'disabled'}.` }]);
            setInput('');
            return;
        }
        if (trimmed.startsWith('/tasks')) {
            const tasksFile = path.join(os.homedir(), '.web-scout', 'pending_tasks.json');
            const parts = trimmed.split(/\s+/).filter(Boolean);
            const sub = (parts[1] || 'list').toLowerCase();
            const nowIso = new Date().toISOString();

            const tasks = await readTasks(tasksFile);
            const renderList = (items: ScheduledTask[]) => {
                if (items.length === 0) return 'No scheduled tasks.';
                const lines: string[] = [];
                lines.push('### Tasks');
                lines.push('');
                lines.push('| id | enabled | nextRunAt | schedule |');
                lines.push('|---:|:-------:|:---------|:---------|');
                for (const t of items) {
                    lines.push(`| ${t.id} | ${t.enabled ? 'yes' : 'no'} | ${t.nextRunAt} | ${scheduleSummary(t)} |`);
                }
                return lines.join('\n');
            };

            const idArg = parts[2] ? Number(parts[2]) : NaN;

            if (sub === 'list' || sub === 'ls') {
                setHistory(prev => [...prev, { id: Date.now(), role: 'agent', text: renderList(tasks) }]);
                return;
            }

            if (sub === 'disable' && Number.isFinite(idArg)) {
                const updated = tasks.map(t => (t.id === idArg ? { ...t, enabled: false, updatedAt: nowIso } : t));
                await writeTasks(updated, tasksFile);
                setHistory(prev => [...prev, { id: Date.now(), role: 'agent', text: `Disabled task ${idArg}.` }]);
                return;
            }

            if (sub === 'enable' && Number.isFinite(idArg)) {
                const updated = tasks.map(t => {
                    if (t.id !== idArg) return t;
                    const next = t.schedule.type === 'once'
                        ? t.nextRunAt
                        : (computeNextRunAt(t, new Date()) || t.nextRunAt);
                    return { ...t, enabled: true, nextRunAt: next, updatedAt: nowIso };
                });
                await writeTasks(updated, tasksFile);
                setHistory(prev => [...prev, { id: Date.now(), role: 'agent', text: `Enabled task ${idArg}.` }]);
                return;
            }

            if ((sub === 'delete' || sub === 'rm') && Number.isFinite(idArg)) {
                const updated = tasks.filter(t => t.id !== idArg);
                await writeTasks(updated, tasksFile);
                setHistory(prev => [...prev, { id: Date.now(), role: 'agent', text: `Deleted task ${idArg}.` }]);
                return;
            }

            if (sub === 'show' && Number.isFinite(idArg)) {
                const t = tasks.find(x => x.id === idArg);
                setHistory(prev => [...prev, { id: Date.now(), role: 'agent', text: t ? '```json\n' + JSON.stringify(t, null, 2) + '\n```' : `Task ${idArg} not found.` }]);
                return;
            }

            if ((sub === 'update' || sub === 'edit') && Number.isFinite(idArg)) {
                const m = trimmed.match(/^\/tasks\s+(update|edit)\s+\d+\s+([\s\S]+)$/i);
                const jsonText = m?.[2]?.trim() || '';
                if (!jsonText) {
                    setHistory(prev => [...prev, { id: Date.now(), role: 'agent', text: `Usage: /tasks update ${idArg} {\"prompt\":\"...\",\"missedRunPolicy\":\"catch_up_once\",\"schedule\":{...}}` }]);
                    return;
                }

                let patch: any;
                try {
                    patch = JSON.parse(jsonText);
                } catch (e: any) {
                    setHistory(prev => [...prev, { id: Date.now(), role: 'agent', text: `Invalid JSON: ${e?.message || String(e)}` }]);
                    return;
                }

                const updated = tasks.map(t => {
                    if (t.id !== idArg) return t;
                    const nextTask: ScheduledTask = { ...t, ...patch, updatedAt: nowIso } as any;

                    if (patch?.schedule) {
                        const s = patch.schedule as any;
                        if (s.type === 'once') {
                            const d = new Date(String(s.executeAt || ''));
                            if (!Number.isNaN(d.getTime())) {
                                nextTask.nextRunAt = d.toISOString();
                            }
                        } else {
                            const next = computeNextRunAt(nextTask, new Date());
                            if (next) nextTask.nextRunAt = next;
                        }
                    }

                    if (patch?.enabled === true && nextTask.schedule.type !== 'once') {
                        const next = computeNextRunAt(nextTask, new Date());
                        if (next) nextTask.nextRunAt = next;
                    }

                    return nextTask;
                });

                await writeTasks(updated, tasksFile);
                setHistory(prev => [...prev, { id: Date.now(), role: 'agent', text: `Updated task ${idArg}. Use /tasks show ${idArg} to review.` }]);
                return;
            }

            setHistory(prev => [...prev, { id: Date.now(), role: 'agent', text: `Unknown /tasks command. Try: /tasks list | /tasks show <id> | /tasks disable <id> | /tasks enable <id> | /tasks delete <id> | /tasks update <id> <json>` }]);
            return;
        }

        if (query.trim().toLowerCase() === 'exit') {
            process.exit(0);
        }

        const userMsg = query;
        setInput('');
        setIsProcessing(true);
        abortControllerRef.current = new AbortController();

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
                        onToolOutput,
                        askQuestion,
                        abortSignal: abortControllerRef.current?.signal,
                        executionOptions: { dryRun: dryRunRef.current },
                        onError: (err: any) => {
                            setHistory(prev => [...prev, { id: Date.now(), role: 'agent', text: `❌ Error: ${err.message}` }]);
                            setIsProcessing(false);
                            abortControllerRef.current = null;
                        }
                    });
                }, 1000);
            } else {
                setIsProcessing(false);
                abortControllerRef.current = null;
                setStatus('Idle');
            }
        };

        await runAgentTurn(currentApiMessages, {
            onStatusUpdate: (newStatus: string) => setStatus(newStatus),
            onAgentReply: (text: string) => handleAgentReply(text, currentApiMessages),
            onToolOutput,
            askQuestion,
            abortSignal: abortControllerRef.current?.signal,
            executionOptions: { dryRun: dryRunRef.current },
            onError: (err: any) => {
                setHistory(prev => [...prev, { id: Date.now(), role: 'agent', text: `❌ Error: ${err.message}` }]);
                setIsProcessing(false);
                abortControllerRef.current = null;
            }
        });
    };

    return (
        <Box flexDirection="column" padding={1}>

            <Static items={history.filter(m => m.role !== 'system' && (showTrace || m.role !== 'tool'))}>
                {(msg) => (
                    <Box key={msg.id} flexDirection="column" marginBottom={1}>
                        <Text wrap="wrap">
                            <Text bold color={msg.role === 'user' ? 'green' : msg.role === 'agent' ? 'cyan' : msg.role === 'tool' ? 'yellow' : 'gray'}>
                                {msg.role === 'user' ? '👤 You:' : msg.role === 'agent' ? '🤖 Agent:' : msg.role === 'tool' ? '🧰 Tool:' : '⚙️ System:'}
                            </Text>
                            {' '}
                            {msg.role === 'agent' || msg.role === 'tool'
                                ? String(marked.parse(msg.text))
                                    .replace(/[ \t]+\n/g, '\n')
                                    .replace(/\n{3,}/g, '\n\n')
                                    .trimEnd()
                                : msg.text}
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
