import * as os from 'os';
import * as path from 'path';

const BANNED_COMMANDS = [
    'rm -rf /',
    'rm -rf *',
    'mkfs',
    'dd if=',
    'chmod 777',
    'chown -R',
    '> /dev/sda'
];

export function validateCommand(command: string): { allowed: boolean, reason?: string } {
    const lowerCmd = command.toLowerCase().trim();

    for (const banned of BANNED_COMMANDS) {
        if (lowerCmd.includes(banned)) {
            return {
                allowed: false,
                reason: `CRITICAL SAFETY TRIGGER: Command contains banned pattern '${banned}'`
            };
        }
    }
    return { allowed: true };
}

export function validatePath(targetPath: string): { allowed: boolean, reason?: string } {
    const absoluteTarget = path.resolve(targetPath);
    const absoluteCwd = process.cwd();
    const absoluteMemoryDir = path.resolve(os.homedir(), '.web-scout');
    if (absoluteTarget.startsWith(absoluteCwd)) {
        return { allowed: true };
    }

    if (absoluteTarget.startsWith(absoluteMemoryDir)) {
        return { allowed: true };
    }

    return {
        allowed: false,
        reason: `SHIELD BLOCKED: Path '${targetPath}' is outside the allowed project workspace. The agent cannot read/write here.`
    };
}