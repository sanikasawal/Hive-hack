/**
 * One-time laptop setup, served by the daemon as /connect.mjs. Run it inside your project:
 *   curl -fsSL <hive>/connect.mjs -o hive-connect.mjs && node hive-connect.mjs <member token>
 * It checks the token, installs the Hive hook into .hive/, adds the hooks and HIVE_URL/HIVE_TOKEN to
 * .claude/settings.local.json (kept out of git via .git/info/exclude), and adds Hive as an MCP server
 * for this project with `claude mcp add`. It never edits tracked files.
 * It never writes MODEL_API_KEY: the model credential stays on the hub. (The laptop relay is an operator
 * fallback that reads the key from the environment at run time only.)
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HUB = (process.env.HIVE_URL || '__HIVE_URL__').replace(/\/+$/, '');
const token = (process.argv[2] || process.env.HIVE_TOKEN || '').trim();
const HOOK_EVENTS: { event: string; arg: string; matcher?: string; timeout: number }[] = [
  { event: 'SessionStart', arg: 'session-start', timeout: 30 },
  { event: 'UserPromptSubmit', arg: 'prompt', timeout: 30 },
  { event: 'PreToolUse', arg: 'pre-write', matcher: 'Edit|Write|MultiEdit', timeout: 30 },
  // Bash too: agents sometimes edit with shell redirection; the hook then re-syncs every changed file.
  { event: 'PostToolUse', arg: 'post-write', matcher: 'Edit|Write|MultiEdit|Bash', timeout: 60 },
];

function fail(message: string): never { console.error(`hive-connect: ${message}`); process.exit(1); }
function git(args: string[]): string | null {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}
type HookEntry = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] };

/**
 * Settings with Hive's hooks and env merged in; other hooks and settings are kept as they are. A MODEL_API_KEY that an
 * earlier Hive setup stored here is removed: the model credential belongs on the hub only.
 */
export function mergeSettings(existing: Record<string, unknown>, hub: string, secret: string): Record<string, unknown> {
  const settings = { ...existing };
  const env: Record<string, string> = { ...(existing.env as Record<string, string> | undefined ?? {}), HIVE_URL: hub, HIVE_TOKEN: secret };
  delete env.MODEL_API_KEY;
  settings.env = env;
  const hooks = { ...(existing.hooks as Record<string, HookEntry[]> | undefined ?? {}) };
  for (const { event, arg, matcher, timeout } of HOOK_EVENTS) {
    const kept = (hooks[event] ?? []).filter(entry => !entry.hooks?.some(h => h.command.includes('hive-hook.mjs')));
    const command = `node "$CLAUDE_PROJECT_DIR/.hive/hive-hook.mjs" ${arg} --client claude`;
    kept.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout }] });
    hooks[event] = kept;
  }
  settings.hooks = hooks;
  return settings;
}

async function main(): Promise<void> {
  if (!token) fail('pass your Hive member token: node hive-connect.mjs <token>');
  if (HUB.includes('__HIVE_URL__')) fail('set HIVE_URL to the Hive address');
  const me = await fetch(`${HUB}/me`, { headers: { Authorization: `Bearer ${token}` } }).catch(error => fail(`cannot reach ${HUB}: ${error instanceof Error ? error.message : error}`));
  if (me.status === 401) fail('Hive rejected this token. Ask your admin for a member token on the Members page.');
  if (!me.ok) fail(`Hive answered HTTP ${me.status}`);
  const who = await me.json() as { role: string; member: string; workspace: { name: string } };
  if (who.role === 'viewer') fail('this is a viewer (read-only) token; agents need a member token');

  const root = git(['rev-parse', '--show-toplevel']) ?? process.cwd();
  const hook = await fetch(`${HUB}/hook.mjs`);
  if (!hook.ok) fail(`could not download the hook (HTTP ${hook.status})`);
  mkdirSync(join(root, '.hive'), { recursive: true });
  writeFileSync(join(root, '.hive', 'hive-hook.mjs'), await hook.text());

  const settingsPath = join(root, '.claude', 'settings.local.json');
  mkdirSync(join(root, '.claude'), { recursive: true });
  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>; }
    catch { fail(`${settingsPath} is not valid JSON; fix or remove it and run again`); }
  }
  const hadModelKey = Boolean((existing.env as Record<string, unknown> | undefined)?.MODEL_API_KEY);
  writeFileSync(settingsPath, `${JSON.stringify(mergeSettings(existing, HUB, token), null, 2)}\n`);

  // Keep the token and hook out of commits without touching the tracked .gitignore.
  const exclude = git(['rev-parse', '--git-path', 'info/exclude']);
  if (exclude) {
    const path = resolve(exclude);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const missing = ['.hive/', '.claude/settings.local.json'].filter(line => !current.split('\n').includes(line));
    if (missing.length) { mkdirSync(join(path, '..'), { recursive: true }); appendFileSync(path, `${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`); }
  }

  const mcpArgs = ['mcp', 'add', '--scope', 'local', '--transport', 'http', 'hive', `${HUB}/mcp`, '--header', `Authorization: Bearer ${token}`];
  spawnSync('claude', ['mcp', 'remove', '--scope', 'local', 'hive'], { cwd: root, stdio: 'ignore' });
  const mcp = spawnSync('claude', mcpArgs, { cwd: root, encoding: 'utf8' });
  const mcpOk = mcp.status === 0;

  console.log(`Connected ${who.member} to Hive workspace "${who.workspace.name}" at ${HUB}.`);
  console.log(`- Hook installed: ${join(root, '.hive', 'hive-hook.mjs')}`);
  console.log(`- Claude Code hooks and HIVE_URL/HIVE_TOKEN: ${settingsPath} (not committed)`);
  console.log(mcpOk ? '- Hive MCP tools added for this project (claude mcp add).'
    : `- Could not run "claude mcp add" (${mcp.error ? 'claude not found' : mcp.stderr.trim().split('\n')[0]}). Run it yourself:\n  claude mcp add --scope local --transport http hive ${HUB}/mcp --header "Authorization: Bearer <token>"`);
  if (hadModelKey) console.log(`- Removed MODEL_API_KEY from ${settingsPath}: the model key stays on the Hive hub, not on laptops.`);
  console.log('Start (or restart) Claude Code in this folder. Your edits to .ts/.tsx files are now checked against your teammates\' work.');
}

if (process.argv[1] && /connect\.(mjs|ts)$/.test(process.argv[1]) && !process.env.HIVE_CONNECT_NO_MAIN) await main();
