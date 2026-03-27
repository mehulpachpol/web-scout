import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export type MissedRunPolicy = 'skip' | 'catch_up_once' | 'catch_up_all';
export type Interval = 'hourly' | 'daily' | 'weekly' | 'monthly';

export type TaskSchedule =
    | { type: 'once'; executeAt: string }
    | { type: 'interval'; interval: Interval; anchorAt: string; timezone?: string | null }
    | { type: 'cron'; cron: string; timezone: string };

export type ScheduledTask = {
    id: number;
    prompt: string;
    enabled: boolean;
    schedule: TaskSchedule;
    missedRunPolicy: MissedRunPolicy;
    lastRunAt?: string | null;
    nextRunAt: string;
    createdAt: string;
    updatedAt: string;
};

function getSystemTimeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function toDate(value: unknown): Date | null {
    const d = new Date(String(value ?? ''));
    return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeInterval(value: unknown): Interval | null {
    if (!value) return null;
    const v = String(value).trim().toLowerCase();
    if (!v) return null;
    if (['hourly', 'hour', '1h', 'every hour', 'each hour'].includes(v)) return 'hourly';
    if (['daily', 'day', '1d', 'every day', 'each day'].includes(v)) return 'daily';
    if (['weekly', 'week', '1w', 'every week', 'each week'].includes(v)) return 'weekly';
    if (['monthly', 'month', '1m', 'every month', 'each month'].includes(v)) return 'monthly';
    return null;
}

function formatToParts(date: Date, timeZone: string) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        weekday: 'short'
    });
    const parts = fmt.formatToParts(date);
    const get = (type: string) => parts.find(p => p.type === type)?.value;
    const weekday = get('weekday') || 'Sun';
    const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
        year: Number(get('year')),
        month: Number(get('month')),
        day: Number(get('day')),
        hour: Number(get('hour')),
        minute: Number(get('minute')),
        weekday: weekdayMap[weekday] ?? 0
    };
}

function parseCronField(field: string, min: number, max: number, isDow = false): Set<number> | null {
    const f = field.trim();
    if (!f || f === '*') return null; // null means "any"

    const allowed = new Set<number>();
    const add = (n: number) => {
        if (isDow && n === 7) n = 0;
        if (n >= min && n <= max) allowed.add(n);
    };

    const handlePart = (part: string) => {
        const p = part.trim();
        if (!p) return;

        const [rangePart, stepPart] = p.split('/');
        const step = stepPart ? Math.max(1, Number(stepPart)) : 1;

        if (rangePart === '*') {
            for (let v = min; v <= max; v += step) add(v);
            return;
        }

        if (rangePart.includes('-')) {
            const [aStr, bStr] = rangePart.split('-');
            const a = Number(aStr);
            const b = Number(bStr);
            if (!Number.isFinite(a) || !Number.isFinite(b)) return;
            for (let v = a; v <= b; v += step) add(v);
            return;
        }

        const n = Number(rangePart);
        if (!Number.isFinite(n)) return;
        add(n);
    };

    for (const part of f.split(',')) handlePart(part);
    return allowed.size > 0 ? allowed : new Set<number>();
}

function parseCronExpression(expr: string) {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) throw new Error('Cron must have 5 fields: "m h dom mon dow"');
    const [minF, hourF, domF, monF, dowF] = parts;

    const minute = parseCronField(minF, 0, 59);
    const hour = parseCronField(hourF, 0, 23);
    const dom = parseCronField(domF, 1, 31);
    const mon = parseCronField(monF, 1, 12);
    const dow = parseCronField(dowF, 0, 7, true);

    const domAny = dom === null;
    const dowAny = dow === null;

    const matches = (candidate: { minute: number; hour: number; day: number; month: number; weekday: number }) => {
        const minuteOk = minute === null || minute.has(candidate.minute);
        const hourOk = hour === null || hour.has(candidate.hour);
        const monOk = mon === null || mon.has(candidate.month);

        const domOk = dom === null || dom.has(candidate.day);
        const dowOk = dow === null || dow.has(candidate.weekday);

        // Vixie cron semantics: if both DOM and DOW are restricted, match if either matches.
        const dayOk = (!domAny && !dowAny) ? (domOk || dowOk) : (domOk && dowOk);

        return minuteOk && hourOk && monOk && dayOk;
    };

    return { matches };
}

function addIntervalOnce(d: Date, interval: Interval) {
    if (interval === 'hourly') d.setHours(d.getHours() + 1);
    else if (interval === 'daily') d.setDate(d.getDate() + 1);
    else if (interval === 'weekly') d.setDate(d.getDate() + 7);
    else if (interval === 'monthly') d.setMonth(d.getMonth() + 1);
}

export function computeNextRunAt(task: ScheduledTask, from: Date): string | null {
    if (!task.enabled) return null;

    if (task.schedule.type === 'once') {
        const d = toDate(task.schedule.executeAt);
        if (!d) return null;
        return d.toISOString();
    }

    if (task.schedule.type === 'interval') {
        const anchor = toDate(task.schedule.anchorAt) || from;
        const next = new Date(anchor);
        addIntervalOnce(next, task.schedule.interval);

        let guard = 0;
        while (next <= from && guard++ < 5000) addIntervalOnce(next, task.schedule.interval);
        return next.toISOString();
    }

    const tz = task.schedule.timezone || getSystemTimeZone();
    const cron = parseCronExpression(task.schedule.cron);

    const start = new Date(from);
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() + 1);

    const limit = new Date(start);
    limit.setDate(limit.getDate() + 366);

    const cursor = new Date(start);
    while (cursor <= limit) {
        const parts = formatToParts(cursor, tz);
        if (cron.matches({
            minute: parts.minute,
            hour: parts.hour,
            day: parts.day,
            month: parts.month,
            weekday: parts.weekday
        })) {
            return cursor.toISOString();
        }
        cursor.setMinutes(cursor.getMinutes() + 1);
    }

    return null;
}

function isScheduledTask(value: any): value is ScheduledTask {
    return value && typeof value === 'object' && typeof value.nextRunAt === 'string' && value.schedule && typeof value.schedule.type === 'string';
}

function migrateLegacyTask(raw: any): ScheduledTask | null {
    if (!raw || typeof raw !== 'object') return null;
    const executeAt = toDate(raw.executeAt);
    if (!executeAt) return null;

    const now = new Date().toISOString();
    const interval = raw.isRecurring ? normalizeInterval(raw.recurrenceInterval) : null;
    const schedule: TaskSchedule = interval
        ? { type: 'interval', interval, anchorAt: executeAt.toISOString(), timezone: getSystemTimeZone() }
        : { type: 'once', executeAt: executeAt.toISOString() };

    return {
        id: typeof raw.id === 'number' ? raw.id : Date.now(),
        prompt: String(raw.prompt || ''),
        enabled: true,
        schedule,
        missedRunPolicy: 'catch_up_once',
        lastRunAt: null,
        nextRunAt: executeAt.toISOString(),
        createdAt: now,
        updatedAt: now
    };
}

export function tasksFilePath() {
    return path.join(os.homedir(), '.web-scout', 'pending_tasks.json');
}

export async function readTasks(filePath = tasksFilePath()): Promise<ScheduledTask[]> {
    try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        const arr = Array.isArray(parsed) ? parsed : [];

        const tasks: ScheduledTask[] = [];
        for (const item of arr) {
            if (isScheduledTask(item)) {
                tasks.push(item);
            } else {
                const migrated = migrateLegacyTask(item);
                if (migrated) tasks.push(migrated);
            }
        }

        return sortTasks(tasks);
    } catch {
        return [];
    }
}

export function sortTasks(tasks: ScheduledTask[]) {
    return [...tasks].sort((a, b) => new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime());
}

export async function writeTasks(tasks: ScheduledTask[], filePath = tasksFilePath()) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(sortTasks(tasks), null, 2), 'utf-8');
    await fs.rename(tmp, filePath);
}

export function scheduleSummary(task: ScheduledTask) {
    if (task.schedule.type === 'once') return `once @ ${task.schedule.executeAt}`;
    if (task.schedule.type === 'interval') return `${task.schedule.interval} (anchor ${task.schedule.anchorAt})`;
    return `cron "${task.schedule.cron}" (${task.schedule.timezone})`;
}

