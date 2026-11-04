import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connectedAt } from './context.js';
import { HubError } from './hub.js';
import { nodeFiles } from './state.js';
import { dirtyFiles, head, hubBase, pushChanges, reportCheckout } from './sync.js';
import { ensureDir, errorText, readJson, sha256, sleep, writeJson } from './util.js';
import { dirname } from 'node:path';
/**
 * The local connector for one checkout: reports the checkout (branch, HEAD, merge-base with the hub base, dirty files
 * with hashes) and pushes changed .ts/.tsx contents, on start, every 30 s and after file changes (fs.watch on
 * macOS/Windows, a 10 s `git status` poll on Linux). It never modifies the repository.
 */
const PERIOD_MS = 30_000;
const LINUX_POLL_MS = 10_000;
const DEBOUNCE_MS = 1_500;
export function readNodeState(repoRoot) {
    return readJson(nodeFiles(repoRoot).state, null);
}
export function isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === 'EPERM';
    }
}
export function nodePid(repoRoot) {
    const file = nodeFiles(repoRoot).pid;
    if (!existsSync(file))
        return null;
    const pid = Number(readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}
/** Stops a running connector for this checkout. Returns true when one was running. */
export async function stopNode(repoRoot) {
    const pid = nodePid(repoRoot);
    const files = nodeFiles(repoRoot);
    let stopped = false;
    if (pid && isAlive(pid)) {
        try {
            process.kill(pid, 'SIGTERM');
            stopped = true;
        }
        catch { /* already gone */ }
        for (let i = 0; i < 30 && isAlive(pid); i++)
            await sleep(100);
        if (isAlive(pid))
            try {
                process.kill(pid, 'SIGKILL');
            }
            catch { /* gone */ }
    }
    try {
        unlinkSync(files.pid);
    }
    catch { /* none */ }
    return stopped;
}
/** Starts the connector detached from this terminal (stdio ignored, unref'd); it writes its own pidfile and log. */
export async function startNodeDetached(repoRoot) {
    await stopNode(repoRoot);
    const entry = fileURLToPath(new URL('./main.js', import.meta.url));
    const child = spawn(process.execPath, [entry, 'node'], { cwd: repoRoot, detached: true, stdio: 'ignore', env: process.env, windowsHide: true });
    child.unref();
    const files = nodeFiles(repoRoot);
    ensureDir(dirname(files.pid));
    writeFileSync(files.pid, `${child.pid}\n`, { mode: 0o600 });
    return child.pid;
}
/** Fingerprint of the working tree as Hive sees it: HEAD + dirty paths with hashes. */
function fingerprint(root) {
    return sha256(JSON.stringify([head(root), dirtyFiles(root)]));
}
export async function runNode(options) {
    const ctx = connectedAt(options.cwd);
    const files = nodeFiles(ctx.repo.root);
    ensureDir(dirname(files.pid));
    const log = (line) => {
        const text = `${new Date().toISOString()} ${line}\n`;
        process.stderr.write(text);
        if (!options.once)
            try {
                appendFileSync(files.log, text, { mode: 0o600 });
                if (statSync(files.log).size > 1_000_000)
                    writeFileSync(files.log, text);
            }
            catch { /* best effort */ }
    };
    const state = { pid: process.pid, repoRoot: ctx.repo.root, startedAt: new Date().toISOString(), lastReportAt: null, lastError: null, dirty: null };
    const save = () => { try {
        writeJson(files.state, state, 0o600);
    }
    catch { /* best effort */ } };
    let lastPushed = null;
    let revoked = false;
    const cycle = async (force) => {
        try {
            const base = await hubBase(ctx.hub);
            const report = await reportCheckout(ctx.hub, ctx.repo, base, ctx.connection.machine || undefined);
            const print = fingerprint(ctx.repo.root);
            if (force || print !== lastPushed) {
                const pushed = await pushChanges(ctx.hub, ctx.repo.root, base);
                lastPushed = print;
                log(`reported ${report.dirty} dirty file(s); synced ${pushed.stored.length} source file(s)`);
            }
            state.lastReportAt = new Date().toISOString();
            state.lastError = null;
            state.dirty = report.dirty;
            save();
            return true;
        }
        catch (error) {
            state.lastError = errorText(error);
            save();
            log(`report failed: ${errorText(error)}`);
            if (error instanceof HubError && error.status === 401)
                revoked = true;
            return false;
        }
    };
    if (options.once)
        return (await cycle(true)) ? 0 : 1;
    writeFileSync(files.pid, `${process.pid}\n`, { mode: 0o600 });
    log(`connector started for ${ctx.repo.root} → ${ctx.hub.url}`);
    let running = false;
    let again = false;
    let timer = null;
    const run = async (force = false) => {
        if (running) {
            again = true;
            return;
        }
        running = true;
        await cycle(force);
        running = false;
        if (revoked) {
            log('credential rejected (revoked?); stopping');
            shutdown(0);
            return;
        }
        if (again) {
            again = false;
            void run();
        }
    };
    const schedule = () => { if (timer)
        clearTimeout(timer); timer = setTimeout(() => { void run(); }, DEBOUNCE_MS); };
    let watcher = null;
    let poll = null;
    if (process.platform === 'darwin' || process.platform === 'win32') {
        try {
            watcher = watch(ctx.repo.root, { recursive: true }, (_event, name) => {
                const file = String(name ?? '');
                if (/(^|[\\/])(node_modules|\.hive)([\\/]|$)/.test(file))
                    return;
                if (/(^|[\\/])\.git[\\/]/.test(file) && !/\.git[\\/](HEAD|index)$/.test(file))
                    return;
                schedule();
            });
        }
        catch (error) {
            log(`file watching unavailable (${errorText(error)}); polling instead`);
        }
    }
    if (!watcher) {
        let last = fingerprint(ctx.repo.root);
        poll = setInterval(() => { const now = fingerprint(ctx.repo.root); if (now !== last) {
            last = now;
            void run();
        } }, LINUX_POLL_MS);
    }
    const periodic = setInterval(() => { void run(); }, PERIOD_MS);
    const shutdown = (code) => {
        watcher?.close();
        if (poll)
            clearInterval(poll);
        clearInterval(periodic);
        if (timer)
            clearTimeout(timer);
        try {
            if (readFileSync(files.pid, 'utf8').trim() === String(process.pid))
                unlinkSync(files.pid);
        }
        catch { /* gone */ }
        log('connector stopped');
        process.exit(code);
    };
    process.on('SIGTERM', () => shutdown(0));
    process.on('SIGINT', () => shutdown(0));
    await run(true);
    return new Promise(() => { });
}
