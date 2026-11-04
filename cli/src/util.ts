import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** A problem the user can fix (bad flag, not a git repository, hub refused): exit code 2. */
export class UserError extends Error {
  constructor(message: string) { super(message); this.name = 'UserError'; }
}

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Diagnostics always go to stderr; stdout belongs to the MCP bridge and hook output contracts. */
export function warn(message: string): void { process.stderr.write(`${message}\n`); }

export function homeDir(): string { return process.env.HOME || homedir(); }

/** $XDG_CONFIG_HOME/hive, default ~/.config/hive. */
export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homeDir(), '.config');
  return join(base, 'hive');
}

export function ensureDir(path: string, mode = 0o700): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode });
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) return fallback;
  try { return JSON.parse(text) as T; } catch {
    throw new UserError(`${path} is not valid JSON; fix or remove it and run again`);
  }
}

/** Atomic JSON write (temp file + rename), 2-space indent, trailing newline. Returns true when the bytes changed. */
export function writeJson(path: string, value: unknown, mode?: number): boolean {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, 'utf8') === text) {
    if (mode !== undefined) chmodSync(path, mode);
    return false;
  }
  ensureDir(dirname(path), 0o755);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, mode !== undefined ? { mode } : {});
  if (mode !== undefined) chmodSync(temp, mode);
  renameSync(temp, path);
  return true;
}

export function git(cwd: string, args: string[], maxBuffer = 32 * 1024 * 1024): string | null {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 15_000, maxBuffer, windowsHide: true });
  return result.status === 0 ? result.stdout : null;
}

export function onPath(command: string): boolean {
  const probe = process.platform === 'win32' ? spawnSync('where', [command], { stdio: 'ignore', windowsHide: true })
    : spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
  return probe.status === 0;
}

export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Quotes one argument for a POSIX shell (Claude Code runs hook commands through sh). */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  if (process.platform === 'win32') return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
