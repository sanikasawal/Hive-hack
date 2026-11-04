import { readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { git, sha256 } from './util.js';
/** Mirrors src/remote/paths.ts: which laptop files the hub type-checks. */
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_DIRTY = 500;
const MAX_PUSH_FILES = 200;
const SOURCE = /\.(ts|tsx|mts|cts)$/;
const BLOCKED_SEGMENTS = new Set(['node_modules', '.git', '.hive']);
export function checkPath(path) {
    if (!path || path.length > 500)
        return 'path is empty or too long';
    if (path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:/.test(path) || path.includes('\\'))
        return `${path}: must be repository-relative with / separators`;
    const segments = path.split('/');
    if (segments.some(s => s === '..' || s === '.' || s === ''))
        return `${path}: must not contain empty, . or .. segments`;
    if (segments.some(s => BLOCKED_SEGMENTS.has(s)))
        return `${path}: node_modules, .git and .hive are not synced`;
    if (!SOURCE.test(path) || path.endsWith('.d.ts'))
        return `${path}: only .ts/.tsx source files are synced`;
    if (/(^|\/)\.env/.test(path))
        return `${path}: secrets are not synced`;
    return null;
}
export function readOrNull(path) {
    try {
        return readFileSync(path, 'utf8');
    }
    catch {
        return null;
    }
}
/** `git status --porcelain` entries (untracked files listed individually), each with the sha256 of its content (null when deleted). */
export function dirtyFiles(root) {
    const out = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']) ?? '';
    const parts = out.split('\0');
    const files = [];
    for (let i = 0; i < parts.length && files.length < MAX_DIRTY; i++) {
        const entry = parts[i];
        if (entry.length < 4)
            continue;
        const status = entry.slice(0, 2);
        const path = entry.slice(3);
        if (status[0] === 'R' || status[0] === 'C')
            i++; // the next field is the rename source
        if (!path || path.startsWith('/') || path.split('/').includes('..'))
            continue;
        let hash = null;
        try {
            const abs = resolve(root, path);
            if (statSync(abs).isFile())
                hash = sha256(readFileSync(abs));
        }
        catch {
            hash = null;
        }
        files.push({ path, sha256: hash, status: status.trim() || status });
    }
    return files;
}
/** Every syncable file that differs from the hub's base commit (committed, staged, unstaged or untracked), as in src/hooks/hook.ts. */
export function changedFiles(root, hubBase) {
    const base = hubBase && git(root, ['cat-file', '-e', `${hubBase}^{commit}`]) !== null ? hubBase : 'HEAD';
    const diff = git(root, ['diff', '--name-only', base]) ?? '';
    const untracked = git(root, ['ls-files', '--others', '--exclude-standard']) ?? '';
    return [...new Set([...diff.split('\n'), ...untracked.split('\n')].map(l => l.trim()).filter(Boolean))]
        .filter(p => checkPath(p) === null).slice(0, MAX_PUSH_FILES);
}
export function changedContents(root, hubBase) {
    return changedFiles(root, hubBase).map(path => ({ path, content: readOrNull(resolve(root, path)) }))
        .filter(f => f.content === null || Buffer.byteLength(f.content) <= MAX_FILE_BYTES);
}
export function head(root) { return git(root, ['rev-parse', 'HEAD'])?.trim() || null; }
export function branch(root) {
    const name = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim();
    return name && name !== 'HEAD' ? name : null;
}
export function mergeBase(root, hubBase) {
    if (!hubBase || git(root, ['cat-file', '-e', `${hubBase}^{commit}`]) === null)
        return null;
    return git(root, ['merge-base', 'HEAD', hubBase])?.trim() || null;
}
/** The hub's base commit (remote_status), or null when unknown or unreachable. */
export async function hubBase(hub) {
    try {
        return (await hub.command({ action: 'remote_status' })).baseCommit ?? null;
    }
    catch {
        return null;
    }
}
/** One checkout_report: repository, branch, HEAD, merge-base with the hub base, dirty files with hashes. */
export async function reportCheckout(hub, repo, base, machine = hostname()) {
    const dirty = dirtyFiles(repo.root);
    await hub.command({
        action: 'checkout_report',
        repo: { name: repo.name, identity: repo.identity, rootCommit: repo.rootCommit },
        branch: branch(repo.root), head: head(repo.root), baseCommit: mergeBase(repo.root, base), machine: machine.slice(0, 80), dirty,
    });
    return { dirty: dirty.length };
}
/** Full laptop sync: every changed .ts/.tsx file, replacing what the hub held for this member. */
export async function pushChanges(hub, root, base) {
    const files = changedContents(root, base);
    return hub.command({ action: 'remote_push', files, baseCommit: head(root), replace: true }, 60_000);
}
