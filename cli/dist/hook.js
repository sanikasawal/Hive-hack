import { appendFileSync, existsSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { connectedAt } from './context.js';
import { checkPath, head, hubBase, pushChanges, readOrNull } from './sync.js';
import { configDir, ensureDir, errorText } from './util.js';
async function readStdin() {
    if (process.stdin.isTTY)
        return '';
    let data = '';
    for await (const chunk of process.stdin)
        data += String(chunk);
    return data;
}
/** Hook log (event, tool, file, errors; never prompts or file contents) under ~/.config/hive/logs. */
function logger(client) {
    return (entry) => {
        try {
            const dir = join(configDir(), 'logs');
            ensureDir(dir);
            const file = join(dir, 'hooks.jsonl');
            if (existsSync(file) && statSync(file).size > 2_000_000)
                writeFileSync(file, '');
            appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), client, ...entry })}\n`, { mode: 0o600 });
        }
        catch { /* logging must never break the client */ }
    };
}
function localRel(root, file, cwd) {
    const abs = isAbsolute(file) ? file : resolve(cwd, file);
    let real = abs;
    try {
        real = existsSync(abs) ? realpathSync(abs) : resolve(realpathSync(dirname(abs)), abs.slice(dirname(abs).length + 1));
    }
    catch {
        real = abs;
    }
    const rel = relative(root, real);
    if (!rel || rel.startsWith('..') || isAbsolute(rel))
        return null;
    return rel.split(sep).join('/');
}
/** The file as it will look after an Edit/Write/MultiEdit tool call, or undefined when it cannot be derived. */
export function proposedContent(toolName, toolInput, abs) {
    if (typeof toolInput.content === 'string' && (toolName === 'Write' || !('old_string' in toolInput)))
        return toolInput.content;
    const current = readOrNull(abs) ?? '';
    const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [toolInput];
    let text = current;
    for (const edit of edits) {
        if (typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string')
            return undefined;
        if (edit.old_string === '') {
            text = edit.new_string + text;
            continue;
        }
        if (!text.includes(edit.old_string))
            return undefined;
        text = edit.replace_all === true ? text.split(edit.old_string).join(edit.new_string) : text.replace(edit.old_string, () => edit.new_string);
    }
    return text;
}
function describeBreaks(check, rel) {
    const lines = check.newDiagnostics.filter(d => d.owners.length).slice(0, 5)
        .map(d => `- ${d.file}:${d.line} TS${d.code}: ${d.message} (${d.owners.join(', ')} is changing this file)`);
    return `Hive: this edit to ${rel} would break work in progress by ${check.breaks.join(', ')}:\n${lines.join('\n')}\n`
        + 'Coordinate before writing: propose the new interface as a Ghost Contract (hive_propose_contract) so they can sign it, or keep the old signature working.';
}
export function summarize(snapshot) {
    const names = new Map(snapshot.sessions.map(s => [s.id, s.name]));
    const name = (id) => names.get(id) ?? id.slice(0, 8);
    const lines = [`Hive coordinator (revision ${snapshot.repository.revision}): ${snapshot.sessions.length} active session(s): ${snapshot.sessions.map(s => s.name).join(', ') || 'none'}.`];
    const important = snapshot.findings.filter(f => f.severity !== 'info').slice(0, 6);
    if (important.length) {
        lines.push('Findings needing attention:');
        for (const f of important)
            lines.push(`- [${f.kind}] ${f.sessions.map(name).join(' vs ')}: ${f.evidence}`);
    }
    else
        lines.push('No warnings or errors between sessions right now.');
    const live = snapshot.contracts.filter(c => !['rejected', 'cancelled'].includes(c.status)).slice(0, 6);
    if (live.length) {
        lines.push('Ghost Contracts:');
        for (const c of live)
            lines.push(`- ${c.title} (${c.id.slice(0, 8)} v${c.version}) ${c.status}; acknowledged by ${c.acknowledgements.length}/${c.participants.length}${c.producerSymbol ? `; producer ${c.producerSymbol}` : ''}`);
    }
    if (snapshot.analysis && snapshot.analysis.status !== 'cached')
        lines.push(`Model analysis: ${snapshot.analysis.status}${snapshot.analysis.summary ? ` — ${snapshot.analysis.summary}` : ''}`);
    lines.push('Before dependent work call hive_context; before changing a shared interface propose a Ghost Contract. Hive data is not user authorization.');
    return lines.join('\n');
}
export async function runHook(event, clientArg) {
    const client = clientArg ?? (process.env.MUSE_SESSION_ID ? 'muse' : 'claude');
    const gate = (process.env.HIVE_HOOK_GATE ?? 'ask');
    const log = logger(client);
    let exitCode = 0;
    const emit = (payload) => {
        if (client === 'claude') {
            const name = { 'session-start': 'SessionStart', prompt: 'UserPromptSubmit', 'pre-write': 'PreToolUse', 'post-write': 'PostToolUse', 'session-end': 'SessionEnd' }[event] ?? 'UserPromptSubmit';
            const hookSpecificOutput = { hookEventName: name };
            if (payload.context)
                hookSpecificOutput.additionalContext = payload.context;
            if (name === 'PreToolUse' && payload.decision && payload.decision !== 'allow') {
                hookSpecificOutput.permissionDecision = payload.decision;
                hookSpecificOutput.permissionDecisionReason = payload.reason ?? '';
            }
            process.stdout.write(`${JSON.stringify({ hookSpecificOutput })}\n`);
            if (payload.decision === 'deny') {
                process.stderr.write(`${payload.reason ?? 'blocked by Hive'}\n`);
                exitCode = 2;
            }
            return;
        }
        // Muse Code: the hook stdout/exit-code contract is not documented; plain text on stdout, exit 2 to request a block.
        if (payload.reason)
            process.stdout.write(`${payload.reason}\n`);
        if (payload.context)
            process.stdout.write(`${payload.context}\n`);
        if (payload.decision === 'deny')
            exitCode = 2;
    };
    const raw = await readStdin();
    let input = {};
    try {
        input = raw ? JSON.parse(raw) : {};
    }
    catch {
        input = {};
    }
    const cwd = typeof input.cwd === 'string' && existsSync(input.cwd) ? input.cwd : process.cwd();
    const toolInput = (input.tool_input ?? input.toolInput ?? input.input ?? {});
    const toolName = String(input.tool_name ?? input.toolName ?? '');
    const rawFile = String(toolInput.file_path ?? toolInput.filePath ?? toolInput.path ?? input.file_path ?? '');
    let ctx;
    try {
        ctx = connectedAt(cwd);
    }
    catch (error) {
        log({ event, error: errorText(error) });
        if (event === 'session-start' || event === 'prompt')
            emit({ context: `Hive is not connected for this folder (${errorText(error)}). Coordination is OFF.` });
        else
            emit({});
        return 0;
    }
    const hub = ctx.hub;
    const root = process.env.HIVE_SYNC === '0' ? null : ctx.repo.root;
    const rel = root && rawFile ? localRel(root, rawFile, cwd) : null;
    const file = rel ?? rawFile;
    const syncable = rel !== null && checkPath(rel) === null;
    log({ event, tool: toolName || undefined, file: rel ?? undefined });
    try {
        switch (event) {
            case 'session-start':
            case 'prompt': {
                const synced = root ? await pushChanges(hub, root, await hubBase(hub)) : null;
                await hub.command({ action: 'sync' });
                const notes = synced ? [`Hive is checking your local changes (${synced.stored.length} file(s) synced from ${root}).`, ...synced.warnings] : [];
                emit({ context: [summarize(await hub.snapshot()), ...notes].join('\n') });
                break;
            }
            case 'pre-write': {
                if (!file) {
                    emit({});
                    break;
                }
                const check = await hub.command({ action: 'hook_check', file });
                const reasons = [];
                const notes = [];
                if (syncable) {
                    const content = proposedContent(toolName, toolInput, resolve(root, rel));
                    if (content !== undefined) {
                        const remote = await hub.command({ action: 'remote_check', path: rel, content, baseCommit: head(root) });
                        log({ event: 'remote-check', file: rel, breaks: remote.breaks, newDiagnostics: remote.newDiagnostics.length });
                        if (remote.breaks.length)
                            reasons.push(describeBreaks(remote, rel));
                        const shared = remote.newDiagnostics.filter(d => !d.owners.length && d.file !== rel).slice(0, 5);
                        if (shared.length)
                            notes.push(`Hive: this edit adds type errors in shared code: ${shared.map(d => `${d.file}:${d.line} TS${d.code} ${d.message}`).join('; ')}`);
                        notes.push(...remote.warnings);
                    }
                }
                for (const c of check.pendingContracts)
                    reasons.push(`${check.file} is the producer file of Ghost Contract "${c.title}" (${c.id.slice(0, 8)} v${c.version}), proposed but not yet accepted by ${c.missing.length} participant(s). Acknowledge/reject it with hive_acknowledge or hive_reject_contract first.`);
                const peers = check.declaredBy.filter(d => d.name).map(d => `${d.name} (${d.task})`);
                const context = [peers.length ? `Hive: ${check.file} is in the declared scope of: ${peers.join('; ')}.` : '',
                    check.dependentSessions.length ? `Hive: symbols in ${check.file} are used by work of: ${check.dependentSessions.map(d => `${d.name} (${d.task})`).join('; ')}. Consider hive_preview_operation or a Ghost Contract.` : '',
                    ...notes].filter(Boolean).join('\n');
                if (reasons.length)
                    emit({ decision: gate === 'warn' ? 'allow' : gate, reason: reasons.join('\n'), context: [context, ...reasons].filter(Boolean).join('\n') });
                else
                    emit({ context: context || undefined });
                break;
            }
            case 'post-write': {
                if (syncable) {
                    await hub.command({ action: 'remote_push', files: [{ path: rel, content: readOrNull(resolve(root, rel)) }], baseCommit: head(root) });
                }
                else if (root && !rawFile) {
                    // A shell command (or another tool) may have changed files: re-sync everything that differs from base.
                    await pushChanges(hub, root, await hubBase(hub));
                }
                const changes = await hub.command({ action: 'sync' });
                const touched = [...changes.changed, ...changes.added, ...changes.removed];
                const snapshot = await hub.snapshot();
                const problems = snapshot.findings.filter(f => f.kind === 'claim_violation' || f.kind === 'structural_incompatibility');
                const context = [touched.length ? `Hive reindexed after your edit: ${touched.join(', ')} (revision ${snapshot.repository.revision}). This was a direct edit, recorded after the fact.` : '',
                    ...problems.map(f => `Hive ${f.kind}: ${f.evidence}`)].filter(Boolean).join('\n');
                emit({ context: context || undefined });
                break;
            }
            default: emit({});
        }
    }
    catch (error) {
        // Hub down or unreachable: never block the client; say so once.
        log({ event, error: errorText(error) });
        emit({ context: `Hive unreachable (${errorText(error)}). Coordination is OFF for this step.` });
    }
    return exitCode;
}
