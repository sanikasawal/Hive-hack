/**
 * Live two-agent acceptance (opt-in; NOT part of npm test; a real run SPENDS THE USER'S CLAUDE USAGE).
 *
 *   node --disable-warning=ExperimentalWarning scripts/acceptance-live.ts [--dry-run] [--timeout-min 15] [--keep]
 *
 * Same setup as tests/acceptance-two-users.test.ts: one hub (spawned daemon, temp file DB, HIVE_PROJECT_ROOT = a temp
 * clone of ../hive-playground or HIVE_PLAYGROUND), two users with separate config dirs and separate clones, each
 * connected with the real CLI (cli/dist) and paired through that user's browser token. Then two real `claude -p`
 * sessions (the `claude` binary on PATH) run in the two clones with `--mcp-config <clone>/.mcp.json`
 * (the file connect generated) and the clone's .claude/settings.local.json hooks, one README task each
 * (pricing agent, invoice agent), told to register and check hive_context.
 *
 * Claude keeps the real HOME (its login lives there); the Hive side is isolated with XDG_CONFIG_HOME (per user) and
 * HIVE_CONNECT_NO_KEYCHAIN=1, which the stdio bridge and the hooks inherit. Your global Claude settings, plugins and
 * CLAUDE.md still apply to these sessions.
 *
 * Output: a redacted trace (tool calls, Hive findings delivered through tool results and hooks, final diff summary,
 * final hub findings) at acceptance/trace-<timestamp>.json and a table on stdout. No token, absolute temp path or
 * prompt-hook payload body is written. --dry-run does everything except starting Claude: it validates the hub,
 * pairing, credentials, generated config, and the bridge (spawned exactly as .mcp.json says, with the env Claude
 * would pass), then prints the claude command lines it would run.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const log = (text = '') => process.stderr.write(`${text}\n`);
const HIVE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(HIVE_ROOT, 'cli', 'dist', 'main.js');
const DAEMON = join(HIVE_ROOT, 'src', 'server', 'daemon.ts');
const PLAYGROUND = resolve(process.env.HIVE_PLAYGROUND ?? join(HIVE_ROOT, '..', 'hive-playground'));
const PLAYGROUND_REMOTE = 'https://github.com/sanikasawal/hive-playground.git';
const UNIT_KEY = 'src/pricing.ts#getPrice:unit';

interface Options { dryRun: boolean; timeoutMin: number; keep: boolean }
function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false, timeoutMin: 15, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--timeout-min') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0 || value > 120) throw new Error('--timeout-min needs a number of minutes (1-120)');
      options.timeoutMin = value;
    } else if (arg === '--help' || arg === '-h') {
      log('Usage: node scripts/acceptance-live.ts [--dry-run] [--timeout-min 15] [--keep]'); process.exit(0);
    } else throw new Error(`Unknown argument ${arg}`);
  }
  return options;
}

async function unusedPort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No free port');
  await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
  return address.port;
}
const temp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
function clonePlayground(prefix: string): string {
  const dir = temp(prefix);
  git(dir, 'clone', '-q', PLAYGROUND, 'hive-playground');
  const repo = join(dir, 'hive-playground');
  git(repo, 'remote', 'set-url', 'origin', PLAYGROUND_REMOTE);
  return repo;
}
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') env[key] = value;
  for (const name of ['PORT', 'HIVE_HOST', 'HIVE_URL', 'HIVE_TOKEN', 'HIVE_DB', 'HIVE_PUBLIC_URL', 'HIVE_REPO_URL', 'HIVE_CONNECT_COMMAND', 'MUSE_SESSION_ID',
    'MODEL_API_KEY', 'NODE_TEST_CONTEXT', 'CLAUDE_PROJECT_DIR']) delete env[name];
  return env;
}

/** Every secret and machine path seen in this run is replaced before anything is written or printed. */
class Redactor {
  private readonly secrets: string[] = [];
  private readonly paths: [string, string][] = [];
  secret(value: string): void { if (value) this.secrets.push(value); }
  path(value: string, label: string): void { this.paths.push([value, label]); this.paths.sort((a, b) => b[0].length - a[0].length); }
  text(value: string): string {
    let out = value;
    for (const secret of this.secrets) out = out.split(secret).join('[redacted]');
    for (const [path, label] of this.paths) out = out.split(path).join(label);
    return out.replace(/hive_(adm|mem|view)_[0-9A-Za-z_-]+/g, 'hive_$1_[redacted]').replace(/(Bearer\s+)\S+/gi, '$1[redacted]');
  }
  value<T>(value: T): T { return JSON.parse(this.text(JSON.stringify(value))) as T; }
}

interface User { name: string; role: string; task: string; home: string; repo: string; env: Record<string, string>; browserToken: string }

function runCli(args: string[], user: User, onStdout?: (text: string) => void): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: user.repo, env: user.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', chunk => { stdout += String(chunk); onStdout?.(stdout); });
    child.stderr!.on('data', chunk => { stderr += String(chunk); });
    child.on('error', fail);
    child.on('close', code => done({ code, stdout, stderr }));
  });
}

/** The two README tasks that collide on getPrice's unit. */
function readmeTasks(readme: string): { pricing: string; invoice: string } {
  const grab = (label: string) => {
    const match = new RegExp(`\\*\\*${label}:\\*\\*\\s*"([\\s\\S]*?)"`).exec(readme);
    if (!match) throw new Error(`hive-playground README has no "${label}" task`);
    return match[1]!.replace(/\s+/g, ' ').trim();
  };
  return { pricing: grab('Pricing agent'), invoice: grab('Invoice agent') };
}

function promptFor(user: User): string {
  return [`You are the ${user.role} on a team whose coding agents are coordinated by Hive (MCP server "hive").`,
    `Your task: ${user.task}`,
    `Before editing: call hive_register with name "${user.role}" (no workspace argument), then hive_set_intent with your task, the files you will touch,`,
    `canonical symbols (e.g. src/pricing.ts#getPrice:function) and your assumptions, including key ${UNIT_KEY} with the unit you assume.`,
    'Then call hive_context and read the findings. If Hive reports a conflict with a teammate, adapt your plan (update your intent) or propose a',
    'Ghost Contract before changing a shared interface. Call hive_context again before you finish. Do not call hive_finish.',
    'Edit code only with the Edit or Write tools. Run npm test before you finish. End with a three-line summary.'].join('\n');
}

const ALLOWED_TOOLS = ['mcp__hive__*', 'Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep', 'Bash(npm test)', 'Bash(npm run typecheck)', 'Bash(git diff:*)', 'Bash(git status:*)'];
function claudeArgs(user: User): string[] {
  return ['-p', promptFor(user), '--mcp-config', join(user.repo, '.mcp.json'), '--strict-mcp-config', '--output-format', 'stream-json', '--verbose',
    '--include-hook-events', '--permission-mode', 'acceptEdits', '--allowedTools', ALLOWED_TOOLS.join(',')];
}
/** The env Claude runs with: real HOME (its login), this user's Hive config dir, file credential store. */
function claudeEnv(user: User): Record<string, string> {
  return { ...baseEnv(), XDG_CONFIG_HOME: join(user.home, '.config'), HIVE_CONNECT_NO_KEYCHAIN: '1' };
}

interface AgentTrace {
  agent: string; member: string; exitCode: number | null; timedOut: boolean; turns: number | null; costUsd: number | null;
  toolCalls: { name: string; input: string }[];
  findingsDelivered: { via: string; kinds: string[] }[];
  finalText: string; diffStat: string; status: string[];
}

const FINDING_KINDS = /\b(assumption_mismatch|dependent_write|symbol_overlap|file_overlap|structural_incompatibility|claim_violation|direct_edit)\b/g;
const kindsIn = (text: string) => [...new Set(text.match(FINDING_KINDS) ?? [])].sort();

function runClaude(user: User, redact: Redactor, timeoutMs: number): Promise<AgentTrace> {
  const trace: AgentTrace = { agent: user.role, member: user.name, exitCode: null, timedOut: false, turns: null, costUsd: null, toolCalls: [], findingsDelivered: [], finalText: '', diffStat: '', status: [] };
  const toolNames = new Map<string, string>();
  return new Promise((done, fail) => {
    const child = spawn('claude', claudeArgs(user), { cwd: user.repo, env: claudeEnv(user), stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { trace.timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    let buffer = '';
    const handle = (line: string) => {
      let event: any;
      try { event = JSON.parse(line); } catch { return; }
      const content: any[] = Array.isArray(event?.message?.content) ? event.message.content : [];
      if (event.type === 'assistant') for (const block of content) if (block.type === 'tool_use') {
        toolNames.set(block.id, block.name);
        trace.toolCalls.push({ name: block.name, input: redact.text(JSON.stringify(block.input ?? {})).slice(0, 300) });
      }
      if (event.type === 'user') for (const block of content) if (block.type === 'tool_result') {
        const name = toolNames.get(block.tool_use_id) ?? '?';
        const kinds = name.startsWith('mcp__hive__') ? kindsIn(JSON.stringify(block.content ?? '')) : [];
        if (kinds.length) trace.findingsDelivered.push({ via: name, kinds });
      }
      if (event.type === 'system' && /hook/i.test(String(event.subtype ?? ''))) {
        const kinds = kindsIn(JSON.stringify(event));
        if (kinds.length) trace.findingsDelivered.push({ via: `hook:${String(event.hook_event_name ?? event.hook_name ?? event.subtype)}`, kinds });
      }
      if (event.type === 'result') {
        trace.turns = typeof event.num_turns === 'number' ? event.num_turns : null;
        trace.costUsd = typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null;
        trace.finalText = redact.text(String(event.result ?? '')).slice(0, 1500);
      }
    };
    child.stdout!.on('data', chunk => {
      buffer += String(chunk);
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) { handle(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
    });
    child.stderr!.on('data', chunk => log(`[${user.role}] ${redact.text(String(chunk)).trimEnd()}`));
    child.on('error', error => { clearTimeout(timer); fail(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (buffer.trim()) handle(buffer);
      trace.exitCode = code;
      trace.diffStat = redact.text(git(user.repo, 'diff', '--stat'));
      trace.status = git(user.repo, 'status', '--porcelain').split('\n').filter(Boolean);
      done(trace);
    });
  });
}

/** Dry-run wiring check: spawn the bridge exactly as .mcp.json says, with Claude's env, and list Hive's tools. */
async function checkBridge(user: User): Promise<number> {
  const config = JSON.parse(readFileSync(join(user.repo, '.mcp.json'), 'utf8')) as { mcpServers: { hive: { command: string; args: string[] } } };
  const { command, args } = config.mcpServers.hive;
  const client = new Client({ name: `acceptance-live-dry-${user.name}`, version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command, args, cwd: user.repo, env: claudeEnv(user), stderr: 'ignore' }));
  try { return (await client.listTools()).tools.filter(t => t.name.startsWith('hive_')).length; } finally { await client.close(); }
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map(r => r[i]!.length)));
  return rows.map(r => r.map((cell, i) => cell.padEnd(widths[i]!)).join('  ')).join('\n');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(CLI)) throw new Error('cli/dist/main.js is missing: npm run build:cli');
  if (!existsSync(join(PLAYGROUND, '.git'))) throw new Error(`hive-playground clone not found at ${PLAYGROUND} (set HIVE_PLAYGROUND)`);
  const claudeVersion = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  const claudeFound = claudeVersion.status === 0;
  if (!claudeFound && !options.dryRun) throw new Error('`claude` is not on PATH; install Claude Code or use --dry-run');

  const redact = new Redactor();
  const adminToken = `acc-${randomBytes(24).toString('base64url')}`;
  redact.secret(adminToken);
  const port = await unusedPort();
  const url = `http://127.0.0.1:${port}`;
  const hubRepo = clonePlayground('hive-live-hub-');
  const dataDir = temp('hive-live-data-');
  redact.path(join(hubRepo, '..'), '<hub>');
  redact.path(dataDir, '<hub-data>');
  const tasks = readmeTasks(readFileSync(join(hubRepo, 'README.md'), 'utf8'));
  const cleanup: string[] = [join(hubRepo, '..'), dataDir];
  const users: User[] = [];
  const started = new Date();

  const daemon: ChildProcess = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', DAEMON], {
    env: { ...baseEnv(), HIVE_TOKEN: adminToken, HIVE_PORT: String(port), HIVE_PROJECT_ROOT: hubRepo, HIVE_DATA_DIR: dataDir }, stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    await new Promise<void>((done, fail) => {
      let text = '';
      daemon.stderr!.on('data', chunk => { text += String(chunk); if (text.includes('Hive daemon listening')) done(); });
      daemon.once('exit', code => fail(new Error(`daemon exited ${code}: ${redact.text(text)}`)));
    });
    log(`hub: ${url} (temp clone of hive-playground, file DB)`);
    const call = async (token: string | null, path: string, body?: unknown): Promise<any> => {
      const response = await fetch(`${url}${path}`, { method: body ? 'POST' : 'GET', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      const json = await response.json();
      if (!response.ok) throw new Error(`${path} ${response.status}: ${redact.text(JSON.stringify(json))}`);
      return json;
    };

    for (const [name, role, task] of [['ana', 'pricing agent', tasks.pricing], ['ben', 'invoice agent', tasks.invoice]] as const) {
      const invite = await call(adminToken, '/command', { action: 'token_create', label: `${name} browser`, member: name, role: 'member' }) as { token: string };
      redact.secret(invite.token);
      const home = temp(`hive-live-home-${name}-`);
      const repo = clonePlayground(`hive-live-${name}-`);
      redact.path(join(repo, '..'), `<${name}-clone>`);
      redact.path(home, `<${name}-home>`);
      cleanup.push(home, join(repo, '..'));
      const env = { ...baseEnv(), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), HIVE_CONNECT_NO_KEYCHAIN: '1', HIVE_CONNECT_POLL_MS: '200' };
      const user: User = { name, role, task, home, repo, env, browserToken: invite.token };
      users.push(user);

      let approval: Promise<unknown> | null = null;
      const out = await runCli(['connect', '--hub', url, '--no-browser', '--yes', '--client', 'claude'], user, text => {
        const match = /Code: (\w{4})-(\w{4})/.exec(text);
        if (match && !approval) approval = call(user.browserToken, '/command', { action: 'pair_approve', userCode: match[1]! + match[2]! });
      });
      if (out.code !== 0) throw new Error(`connect for ${name} failed (${out.code}): ${redact.text(out.stderr + out.stdout)}`);
      await approval;
      const stored = Object.values(JSON.parse(readFileSync(join(home, '.config', 'hive', 'credentials.json'), 'utf8')) as Record<string, string>);
      for (const token of stored) redact.secret(token);
      log(`${name}: connected (${role}); credential in the fallback file store`);
    }

    const trace: Record<string, unknown> = { startedAt: started.toISOString(), dryRun: options.dryRun, hub: url, claude: claudeFound ? claudeVersion.stdout.trim() : null,
      tasks: users.map(u => ({ agent: u.role, member: u.name, task: u.task })), allowedTools: ALLOWED_TOOLS };
    let rows: string[][];
    if (options.dryRun) {
      const checks = [];
      for (const user of users) {
        const tools = await checkBridge(user);
        const command = ['claude', ...claudeArgs(user).map(a => a.includes(' ') || a.includes('\n') ? JSON.stringify(a) : a)].join(' ');
        checks.push({ agent: user.role, member: user.name, bridgeTools: tools, wouldRun: redact.text(command).slice(0, 400) });
        log(`${user.name}: bridge OK (${tools} hive_* tools). Would run in <${user.name}-clone>: ${redact.text(command).slice(0, 160)}…`);
      }
      trace.dryRunChecks = checks;
      rows = [['agent', 'member', 'bridge tools', 'claude'], ...checks.map(c => [c.agent, c.member, String(c.bridgeTools), claudeFound ? 'on PATH (not started)' : 'NOT on PATH'])];
    } else {
      log(`starting two claude -p sessions (timeout ${options.timeoutMin} min each); this spends Claude usage`);
      const agents = await Promise.all(users.map(user => runClaude(user, redact, options.timeoutMin * 60_000)));
      trace.agents = agents;
      const snapshot = await call(adminToken, '/snapshot?fresh=1') as { findings: { kind: string; severity: string }[]; contracts: { title: string; status: string; version: number }[] };
      trace.hubAtEnd = { findings: snapshot.findings.map(f => `${f.kind}/${f.severity}`), contracts: redact.value(snapshot.contracts.map(c => ({ title: c.title, status: c.status, version: c.version }))) };
      rows = [['agent', 'exit', 'turns', 'tool calls', 'hive calls', 'findings delivered', 'files changed'],
        ...agents.map(a => [a.agent, a.timedOut ? 'timeout' : String(a.exitCode), String(a.turns ?? '?'), String(a.toolCalls.length),
          String(a.toolCalls.filter(t => t.name.startsWith('mcp__hive__')).length), [...new Set(a.findingsDelivered.flatMap(f => f.kinds))].join(',') || '-', String(a.status.length)])];
    }
    trace.finishedAt = new Date().toISOString();
    mkdirSync(join(HIVE_ROOT, 'acceptance'), { recursive: true });
    const file = join(HIVE_ROOT, 'acceptance', `trace-${started.toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, `${JSON.stringify(redact.value(trace), null, 2)}\n`);
    console.log(table(rows));
    console.log(`\ntrace: ${file.slice(HIVE_ROOT.length)}`);
  } finally {
    for (const user of users) await runCli(['disconnect'], user).catch(() => null);
    daemon.kill('SIGTERM');
    if (daemon.exitCode === null) await once(daemon, 'exit');
    if (options.keep) log(`kept temp dirs (--keep): ${cleanup.length}`);
    else for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(error => { log(`acceptance-live: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
