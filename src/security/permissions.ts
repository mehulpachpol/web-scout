import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import crypto from 'crypto';

export type PermissionEffect = 'allow' | 'deny';
export type PermissionScope = 'path' | 'tool' | 'command';

export type PermissionRule = {
    id: string;
    createdAt: string;
    effect: PermissionEffect;
    scope: PermissionScope;
    pattern: string;
    tools?: string[];
    expiresAt?: string | null;
    note?: string;
};

export type PermissionDecision =
    | { effect: PermissionEffect; ruleId: string; reason: string }
    | { effect: 'none'; reason: string };

type AuditEntry = {
    ts: string;
    tool: string;
    target?: string;
    decision: PermissionEffect;
    ruleId?: string;
    reason: string;
    argsSummary?: any;
};

function webScoutDir() {
    return path.join(os.homedir(), '.web-scout');
}

function permissionsPath() {
    return path.join(webScoutDir(), 'permissions.json');
}

function auditPath() {
    return path.join(webScoutDir(), 'audit.jsonl');
}

function normalizeForMatch(p: string) {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isExpired(rule: PermissionRule, now = new Date()) {
    if (!rule.expiresAt) return false;
    const d = new Date(rule.expiresAt);
    if (Number.isNaN(d.getTime())) return false;
    return d <= now;
}

function globToRegex(glob: string) {
    // Very small glob implementation:
    // - "**" => matches any chars including separators
    // - "*"  => matches within a path segment
    // Works for Windows + POSIX separators.
    const esc = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const normalized = glob.replace(/\//g, path.sep);
    let re = esc(normalized);
    re = re.replace(/\\\*\\\*/g, '.*');
    re = re.replace(/\\\*/g, `[^${esc(path.sep)}]*`);
    return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : undefined);
}

function ruleMatchesPath(rule: PermissionRule, absoluteTarget: string) {
    const target = normalizeForMatch(absoluteTarget);
    const pattern = normalizeForMatch(rule.pattern);

    // Fast path: prefix rule for patterns ending with ** (folder allow/deny)
    if (pattern.endsWith(`${path.sep}**`) || pattern.endsWith(`**`)) {
        const prefix = pattern.endsWith(`**`) ? pattern.slice(0, -2) : pattern.slice(0, -3);
        return target.startsWith(prefix);
    }

    if (pattern.includes('*')) {
        return globToRegex(pattern).test(target);
    }

    return target === pattern;
}

function ruleMatchesCommand(rule: PermissionRule, command: string) {
    const cmd = command.trim().toLowerCase();
    const pat = String(rule.pattern || '').trim().toLowerCase();
    if (!pat) return false;
    return cmd.startsWith(pat);
}

function ruleMatchesTool(rule: PermissionRule, toolName: string) {
    const pat = String(rule.pattern || '').trim();
    if (!pat) return false;
    if (pat === '*') return true;
    if (pat.includes('*')) return globToRegex(pat).test(toolName);
    return toolName === pat;
}

function ruleAppliesToTool(rule: PermissionRule, toolName: string) {
    if (!rule.tools || rule.tools.length === 0) return true;
    return rule.tools.includes(toolName);
}

async function loadRules(): Promise<PermissionRule[]> {
    try {
        const raw = await fs.readFile(permissionsPath(), 'utf-8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

async function saveRules(rules: PermissionRule[]) {
    await fs.mkdir(webScoutDir(), { recursive: true });
    await fs.writeFile(permissionsPath(), JSON.stringify(rules, null, 2), 'utf-8');
}

export async function listRules(): Promise<PermissionRule[]> {
    return await loadRules();
}

export async function removeRule(id: string): Promise<boolean> {
    const rules = await loadRules();
    const next = rules.filter(r => r.id !== id);
    if (next.length === rules.length) return false;
    await saveRules(next);
    return true;
}

export async function addRule(rule: Omit<PermissionRule, 'id' | 'createdAt'>): Promise<PermissionRule> {
    const rules = await loadRules();
    const createdAt = new Date().toISOString();
    const id = `perm_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const full: PermissionRule = { id, createdAt, ...rule };
    rules.push(full);
    await saveRules(rules);
    return full;
}

export async function decideForPath(toolName: string, absoluteTarget: string): Promise<PermissionDecision> {
    const rules = (await loadRules()).filter(r => r.scope === 'path' && !isExpired(r) && ruleAppliesToTool(r, toolName));
    if (rules.length === 0) return { effect: 'none', reason: 'No path rules configured.' };

    const matches = rules.filter(r => ruleMatchesPath(r, absoluteTarget));
    if (matches.length === 0) return { effect: 'none', reason: 'No matching path rules.' };

    // Prefer the most specific (longest pattern). Deny wins on tie.
    matches.sort((a, b) => (b.pattern.length - a.pattern.length) || (a.effect === 'deny' ? -1 : 1));
    const winner = matches[0];
    return {
        effect: winner.effect,
        ruleId: winner.id,
        reason: `Matched ${winner.effect} path rule '${winner.pattern}'.`
    };
}

export async function decideForTool(toolName: string): Promise<PermissionDecision> {
    const rules = (await loadRules()).filter(r => r.scope === 'tool' && !isExpired(r));
    if (rules.length === 0) return { effect: 'none', reason: 'No tool rules configured.' };

    const matches = rules.filter(r => ruleMatchesTool(r, toolName));
    if (matches.length === 0) return { effect: 'none', reason: 'No matching tool rules.' };

    matches.sort((a, b) => (b.pattern.length - a.pattern.length) || (a.effect === 'deny' ? -1 : 1));
    const winner = matches[0];
    return {
        effect: winner.effect,
        ruleId: winner.id,
        reason: `Matched ${winner.effect} tool rule '${winner.pattern}'.`
    };
}

export async function decideForCommand(toolName: string, command: string): Promise<PermissionDecision> {
    const rules = (await loadRules()).filter(r => r.scope === 'command' && !isExpired(r) && ruleAppliesToTool(r, toolName));
    if (rules.length === 0) return { effect: 'none', reason: 'No command rules configured.' };

    const matches = rules.filter(r => ruleMatchesCommand(r, command));
    if (matches.length === 0) return { effect: 'none', reason: 'No matching command rules.' };

    matches.sort((a, b) => (b.pattern.length - a.pattern.length) || (a.effect === 'deny' ? -1 : 1));
    const winner = matches[0];
    return {
        effect: winner.effect,
        ruleId: winner.id,
        reason: `Matched ${winner.effect} command rule '${winner.pattern}'.`
    };
}

export async function appendAudit(entry: AuditEntry) {
    try {
        await fs.mkdir(webScoutDir(), { recursive: true });
        await fs.appendFile(auditPath(), `${JSON.stringify(entry)}\n`, 'utf-8');
    } catch {
        // best-effort
    }
}
