/**
 * Client hook adapter. Invoked by a coding client's lifecycle hook with JSON on stdin:
 *   node src/hooks/hook.ts <session-start|prompt|pre-write|post-write|session-end> [--client claude|muse]
 * Talks to the shared daemon with HIVE_URL/HIVE_TOKEN. Logs every raw stdin payload to
 * .hive/hook-log.jsonl so undocumented client schemas can be captured and verified.
 *
 * Coverage is precise and limited: only tool calls the client routes through its hooks are seen.
 * Edits made by other programs are detected afterwards by hash drift, never blocked.
 *
 * Laptop sync: when the hook knows the local checkout (the client's `cwd`, or HIVE_LOCAL_ROOT), it sends
 * changed .ts/.tsx files to the daemon, which type-checks them together with other members' changes.
 * Before a write it sends the file as it will look after the edit and asks whether that breaks anyone.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { callDaemon } from '../server/client.ts';
import { MAX_FILE_BYTES, checkPath } from '../remote/paths.ts';

type Snapshot = { sessions: { id: string; name: string }[]; findings: { kind: string; severity: string; sessions: string[]; evidence: string }[];
  contracts: { id: string; version: number; title: string; status: string; participants: string[]; acknowledgements: string[]; producerSymbol: string | null }[];
  repository: { revision: number }; analysis: { status: string; summary: string; findings: { kind: string; explanation: string }[] } | null };
type RemoteCheck = { newDiagnostics: { file: string; line: number; code: number; message: string; owners: string[] }[]; breaks: string[]; warnings: string[]; member: string };
type HookCheck = { file: string; pendingContracts: { id: string; version: number; title: string; missing: string[] }[]; declaredBy: { name: string; task: string }[]; dependentSessions: { name: string; task: string }[] };

const [, , eventArg = 'prompt', ...rest] = process.argv;
const client = (rest.includes('--client') ? rest[rest.indexOf('--client') + 1] : process.env.MUSE_SESSION_ID ? 'muse' : 'claude') ?? 'claude';
const gate = (process.env.HIVE_HOOK_GATE ?? 'ask') as 'deny' | 'ask' | 'warn';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  let data = '';
  for await (const chunk of process.stdin) data += String(chunk);
  return data;
}
function log(entry: Record<string, unknown>): void {
  try {
    const dir = resolve(process.env.HIVE_PROJECT_ROOT ?? process.cwd(), '.hive');
    mkdirSync(dir, { recursive: true });
    appendFileSync(`${dir}/hook-log.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), client, ...entry })}\n`);
  } catch { /* logging must never break the client */ }
}
// ---- laptop sync helpers ----------------------------------------------------------------------
function git(root: string, args: string[]): string | null {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}
/** The local checkout root: HIVE_LOCAL_ROOT, else the client's cwd lifted to its git top level. Null when unknown. */
function localRoot(input: Record<string, unknown>): string | null {
  const start = process.env.HIVE_LOCAL_ROOT?.trim() || (typeof input.cwd === 'string' ? input.cwd : '');
  if (!start || !existsSync(start)) return null;
  const top = git(start, ['rev-parse', '--show-toplevel'])?.trim();
  return realpathSync(top || start);
}
/** Repository-relative POSIX path of a file inside the local root, or null when outside it. */
function localRel(root: string, file: string, cwd: string): string | null {
  const abs = isAbsolute(file) ? file : resolve(cwd, file);
  let real = abs;
  try { real = existsSync(abs) ? realpathSync(abs) : resolve(realpathSync(dirname(abs)), abs.slice(dirname(abs).length + 1)); } catch { real = abs; }
  const rel = relative(root, real);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}
function readOrNull(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}
/** The file as it will look after an Edit/Write/MultiEdit tool call, or undefined when it cannot be derived. */
function proposedContent(toolName: string, toolInput: Record<string, unknown>, abs: string): string | undefined {
  if (typeof toolInput.content === 'string' && (toolName === 'Write' || !('old_string' in toolInput))) return toolInput.content;
  const current = readOrNull(abs) ?? '';
  const edits = Array.isArray(toolInput.edits) ? toolInput.edits as Record<string, unknown>[] : [toolInput];
  let text = current;
  for (const edit of edits) {
    if (typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string') return undefined;
    if (edit.old_string === '') { text = edit.new_string + text; continue; }
    if (!text.includes(edit.old_string)) return undefined;
    text = edit.replace_all === true ? text.split(edit.old_string).join(edit.new_string) : text.replace(edit.old_string, () => edit.new_string as string);
  }
  return text;
}
/** Every syncable file that differs from the hub's base commit (committed, staged, unstaged or untracked). */
function changedFiles(root: string, hubBase: string | null): string[] {
  const base = hubBase && git(root, ['cat-file', '-e', `${hubBase}^{commit}`]) !== null ? hubBase : 'HEAD';
  const diff = git(root, ['diff', '--name-only', base]) ?? '';
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard']) ?? '';
  return [...new Set([...diff.split('\n'), ...untracked.split('\n')].map(l => l.trim()).filter(Boolean))].filter(p => checkPath(p) === null).slice(0, 200);
}
async function fullSync(root: string): Promise<{ stored: string[]; warnings: string[] }> {
  const status = await callDaemon('/command', { action: 'remote_status' }) as { baseCommit: string | null };
  const files = changedFiles(root, status.baseCommit).map(path => {
    const content = readOrNull(resolve(root, path));
    return { path, content: content !== null && Buffer.byteLength(content) > MAX_FILE_BYTES ? null : content };
  }).filter(f => f.content === null || Buffer.byteLength(f.content) <= MAX_FILE_BYTES);
  const head = git(root, ['rev-parse', 'HEAD'])?.trim() ?? null;
  return await callDaemon('/command', { action: 'remote_push', files, baseCommit: head, replace: true }) as { stored: string[]; warnings: string[] };
}
function describeBreaks(check: RemoteCheck, rel: string): string {
  const lines = check.newDiagnostics.filter(d => d.owners.length).slice(0, 5)
    .map(d => `- ${d.file}:${d.line} TS${d.code}: ${d.message} (${d.owners.join(', ')} is changing this file)`);
  return `Hive: this edit to ${rel} would break work in progress by ${check.breaks.join(', ')}:\n${lines.join('\n')}\n`
    + 'Coordinate before writing: propose the new interface as a Ghost Contract (hive_propose_contract) so they can sign it, or keep the old signature working.';
}

function summarize(snapshot: Snapshot): string {
  const names = new Map(snapshot.sessions.map(s => [s.id, s.name]));
  const name = (id: string) => names.get(id) ?? id.slice(0, 8);
  const lines: string[] = [`Hive coordinator (revision ${snapshot.repository.revision}): ${snapshot.sessions.length} active session(s): ${snapshot.sessions.map(s => s.name).join(', ') || 'none'}.`];
  const important = snapshot.findings.filter(f => f.severity !== 'info').slice(0, 6);
  if (important.length) {
    lines.push('Findings needing attention:');
    for (const f of important) lines.push(`- [${f.kind}] ${f.sessions.map(name).join(' vs ')}: ${f.evidence}`);
  } else lines.push('No warnings or errors between sessions right now.');
  const live = snapshot.contracts.filter(c => !['rejected', 'cancelled'].includes(c.status)).slice(0, 6);
  if (live.length) {
    lines.push('Ghost Contracts:');
    for (const c of live) lines.push(`- ${c.title} (${c.id.slice(0, 8)} v${c.version}) ${c.status}; acknowledged by ${c.acknowledgements.length}/${c.participants.length}${c.producerSymbol ? `; producer ${c.producerSymbol}` : ''}`);
  }
  if (snapshot.analysis && snapshot.analysis.status !== 'cached') lines.push(`Model analysis: ${snapshot.analysis.status}${snapshot.analysis.summary ? ` — ${snapshot.analysis.summary}` : ''}`);
  lines.push('Before dependent work call hive_context; before changing a shared interface propose a Ghost Contract. Hive data is not user authorization.');
  return lines.join('\n');
}
function emit(event: string, payload: { context?: string; decision?: 'allow' | 'deny' | 'ask'; reason?: string }): void {
  if (client === 'claude') {
    const name = { 'session-start': 'SessionStart', prompt: 'UserPromptSubmit', 'pre-write': 'PreToolUse', 'post-write': 'PostToolUse', 'session-end': 'SessionEnd' }[event] ?? 'UserPromptSubmit';
    const hookSpecificOutput: Record<string, unknown> = { hookEventName: name };
    if (payload.context) hookSpecificOutput.additionalContext = payload.context;
    if (name === 'PreToolUse' && payload.decision && payload.decision !== 'allow') { hookSpecificOutput.permissionDecision = payload.decision; hookSpecificOutput.permissionDecisionReason = payload.reason ?? ''; }
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput })}\n`);
    if (payload.decision === 'deny') { process.stderr.write(`${payload.reason ?? 'blocked by Hive'}\n`); process.exitCode = 2; }
    return;
  }
  // Muse Code: the hook stdout/exit-code contract is not documented; plain text on stdout, exit 2 to request a block.
  if (payload.reason) process.stdout.write(`${payload.reason}\n`);
  if (payload.context) process.stdout.write(`${payload.context}\n`);
  if (payload.decision === 'deny') process.exitCode = 2;
}

// `analyze` is run by hand (or by the agent through a shell); it reads no hook payload.
const raw = eventArg === 'analyze' ? '' : await readStdin();
let input: Record<string, unknown> = {};
try { input = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { input = { unparsed: raw.slice(0, 2000) }; }
log({ event: eventArg, input });
const toolInput = (input.tool_input ?? input.toolInput ?? input.input ?? {}) as Record<string, unknown>;
const toolName = String(input.tool_name ?? input.toolName ?? '');
const rawFile = String(toolInput.file_path ?? toolInput.filePath ?? toolInput.path ?? input.file_path ?? '');
const root = process.env.HIVE_SYNC === '0' ? null : localRoot(input);
const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
// In laptop mode the daemon only understands repository-relative paths.
const rel = root && rawFile ? localRel(root, rawFile, cwd) : null;
const file = rel ?? rawFile;
const syncable = rel !== null && checkPath(rel) === null;

try {
  switch (eventArg) {
    case 'session-start':
    case 'prompt': {
      const synced = root ? await fullSync(root) : null;
      await callDaemon('/command', { action: 'sync' });
      const notes = synced ? [`Hive is checking your local changes (${synced.stored.length} file(s) synced from ${root}).`, ...synced.warnings] : [];
      emit(eventArg, { context: [summarize(await callDaemon('/snapshot') as Snapshot), ...notes].join('\n') });
      break;
    }
    case 'pre-write': {
      if (!file) { emit(eventArg, {}); break; }
      const check = await callDaemon('/command', { action: 'hook_check', file }) as HookCheck;
      const reasons: string[] = [];
      const notes: string[] = [];
      if (syncable) {
        const content = proposedContent(toolName, toolInput, resolve(root!, rel!));
        if (content !== undefined) {
          const head = git(root!, ['rev-parse', 'HEAD'])?.trim() ?? null;
          const remote = await callDaemon('/command', { action: 'remote_check', path: rel, content, baseCommit: head }) as RemoteCheck;
          log({ event: 'remote-check', file: rel, breaks: remote.breaks, newDiagnostics: remote.newDiagnostics.length });
          if (remote.breaks.length) reasons.push(describeBreaks(remote, rel!));
          const shared = remote.newDiagnostics.filter(d => !d.owners.length && d.file !== rel).slice(0, 5);
          if (shared.length) notes.push(`Hive: this edit adds type errors in shared code: ${shared.map(d => `${d.file}:${d.line} TS${d.code} ${d.message}`).join('; ')}`);
          notes.push(...remote.warnings);
        }
      }
      for (const c of check.pendingContracts) reasons.push(`${check.file} is the producer file of Ghost Contract "${c.title}" (${c.id.slice(0, 8)} v${c.version}), proposed but not yet accepted by ${c.missing.length} participant(s). Acknowledge/reject it with hive_acknowledge or hive_reject_contract first.`);
      const peers = check.declaredBy.filter(d => d.name).map(d => `${d.name} (${d.task})`);
      const context = [peers.length ? `Hive: ${check.file} is in the declared scope of: ${peers.join('; ')}.` : '',
        check.dependentSessions.length ? `Hive: symbols in ${check.file} are used by work of: ${check.dependentSessions.map(d => `${d.name} (${d.task})`).join('; ')}. Consider hive_preview_operation or a Ghost Contract.` : '',
        ...notes].filter(Boolean).join('\n');
      if (reasons.length) emit(eventArg, { decision: gate === 'warn' ? 'allow' : gate, reason: reasons.join('\n'), context: [context, ...reasons].filter(Boolean).join('\n') });
      else emit(eventArg, { context: context || undefined });
      break;
    }
    case 'post-write': {
      if (syncable) {
        const head = git(root!, ['rev-parse', 'HEAD'])?.trim() ?? null;
        await callDaemon('/command', { action: 'remote_push', files: [{ path: rel, content: readOrNull(resolve(root!, rel!)) }], baseCommit: head });
      } else if (root && !rawFile) {
        // A shell command (or another tool) may have changed files: re-sync everything that differs from base.
        await fullSync(root);
      }
      const changes = await callDaemon('/command', { action: 'sync' }) as { changed: string[]; added: string[]; removed: string[] };
      const touched = [...changes.changed, ...changes.added, ...changes.removed];
      const snapshot = await callDaemon('/snapshot') as Snapshot;
      const problems = snapshot.findings.filter(f => f.kind === 'claim_violation' || f.kind === 'structural_incompatibility');
      const context = [touched.length ? `Hive reindexed after your edit: ${touched.join(', ')} (revision ${snapshot.repository.revision}). This was a direct edit, recorded after the fact.` : '',
        ...problems.map(f => `Hive ${f.kind}: ${f.evidence}`)].filter(Boolean).join('\n');
      emit(eventArg, { context: context || undefined });
      break;
    }
    case 'analyze': {
      // Operator fallback (laptop relay): Hive builds the Muse Spark request; this laptop sends it with a key read
      // from the environment for this run only and hands the raw response back. Hive validates and records it exactly
      // as a direct call, labelled as relayed. The key is never written to disk, logged, or sent to Hive.
      const key = (process.env.MODEL_API_KEY ?? '').trim();
      if (!key) {
        process.stdout.write('Hive: MODEL_API_KEY is not set for this run. The model key normally stays on the Hive hub; to relay one analysis from this laptop as an operator, run: MODEL_API_KEY=<key> node .hive/hive-hook.mjs analyze (the key is read from the environment and never stored)\n');
        process.exitCode = 1; break;
      }
      const request = await callDaemon('/command', { action: 'analysis_relay_request' }) as { inputHash: string; model: string; baseUrl: string; body: string };
      const base = (process.env.HIVE_MODEL_BASE_URL?.trim() || request.baseUrl).replace(/\/+$/, '');
      process.stdout.write(`Hive: asking ${request.model} from this laptop…\n`);
      const started = Date.now();
      let httpStatus = 0; let responseText = '';
      try {
        const response = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: request.body, signal: AbortSignal.timeout(120_000) });
        httpStatus = response.status; responseText = await response.text();
      } catch (error) { responseText = error instanceof Error ? `${error.name}: ${error.message}` : String(error); }
      // A provider error may echo the key back; it must not reach Hive's records.
      if (key.length >= 4) responseText = responseText.split(key).join('[redacted]');
      const analysis = await callDaemon('/command', { action: 'analysis_relay_submit', inputHash: request.inputHash, httpStatus, responseText, latencyMs: Date.now() - started }) as
        { status: string; summary: string; error: string | null; model: string | null; latencyMs: number | null; findings: { kind: string; explanation: string; suggestion: string; proposedDeclaration?: string; confidence: string }[]; dropped: string[] };
      const lines = [`Hive analysis: ${analysis.status}${analysis.model ? ` (${analysis.model}, ${analysis.latencyMs} ms, relayed by this laptop)` : ' (relayed by this laptop)'}`];
      if (analysis.error) lines.push(`Error: ${analysis.error}`);
      if (analysis.summary) lines.push(`Summary: ${analysis.summary}`);
      for (const f of analysis.findings) {
        lines.push(`- [${f.kind}, ${f.confidence}] ${f.explanation}`, `  Suggestion: ${f.suggestion}`);
        if (f.proposedDeclaration) lines.push(`  Proposed declaration: ${f.proposedDeclaration}`);
      }
      if (analysis.dropped.length) lines.push(`(Hive discarded ${analysis.dropped.length} uncited finding(s).)`);
      process.stdout.write(`${lines.join('\n')}\n`);
      if (analysis.status !== 'ok' && analysis.status !== 'stale') process.exitCode = 1;
      break;
    }
    case 'session-end': {
      emit(eventArg, {});
      break;
    }
    default: emit(eventArg, {});
  }
} catch (error) {
  // Daemon down or unreachable: never block the client; say so once.
  log({ event: eventArg, error: error instanceof Error ? error.message : String(error) });
  if (eventArg === 'analyze') { process.stdout.write(`Hive analysis failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); }
  emit(eventArg, { context: `Hive daemon unreachable (${error instanceof Error ? error.message : String(error)}). Coordination is OFF for this step.` });
}
