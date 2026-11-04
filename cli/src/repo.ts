import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { UserError, git } from './util.js';

export interface RepoInfo {
  root: string;
  name: string;
  /** Raw origin URL (may carry credentials): shown to the user only with credentials stripped, never sent. */
  remote: string | null;
  /** Normalized host/owner/repo, or null without a usable origin. */
  identity: string | null;
  rootCommit: string | null;
}

/**
 * Normalizes a git remote to `host/owner/repo`: no scheme, user info, password, port or `.git`; lower-case host;
 * path case kept (the hub does the same: src/server/checkouts.ts normalizeRepoIdentity). Local paths → null.
 */
export function normalizeRepoIdentity(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw || raw.length > 500 || /[\s\0]/.test(raw) || /(^|[/:\\])\.\.([/\\]|$)/.test(raw)) return null;
  let host: string;
  let path: string;
  const scp = /^(?:[^@/:]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(raw);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url: URL;
    try { url = new URL(raw); } catch { return null; }
    if (url.protocol === 'file:') return null;
    host = url.hostname;
    path = decodeURIComponent(url.pathname);
  } else if (scp && !/^[A-Za-z]$/.test(scp[1]!)) {
    host = scp[1]!;
    path = scp[2]!;
  } else if (/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}\/[^/]/.test(raw)) {
    const slash = raw.indexOf('/');
    host = raw.slice(0, slash);
    path = raw.slice(slash + 1);
  } else {
    return null;
  }
  host = host.toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+$/.test(host) || (!host.includes('.') && host !== 'localhost')) return null;
  const segments = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  if (!segments.length || segments.some(s => s === '.' || s === '..' || /[@:\\?#]/.test(s))) return null;
  return `${host}/${segments.join('/')}`;
}

export function stripUrlCredentials(value: string): string {
  return value.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1');
}

/** Git top level of `cwd`, or null outside a repository. */
export function repoRootOf(cwd: string): string | null {
  const top = git(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  if (!top) return null;
  try { return realpathSync(top); } catch { return top; }
}

export function detectRepo(cwd: string = process.cwd()): RepoInfo {
  const root = repoRootOf(cwd);
  if (!root) throw new UserError(`${cwd} is not inside a git repository. Run hive-connect from your project's folder.`);
  const remote = git(root, ['remote', 'get-url', 'origin'])?.trim() || null;
  const rootCommit = git(root, ['rev-list', '--max-parents=0', 'HEAD'])?.split('\n')[0]?.trim() || null;
  return { root, name: basename(root), remote, identity: normalizeRepoIdentity(remote), rootCommit };
}

/** Stable key for a repository: the identity, else the root commit, else the folder. */
export function repoKey(repo: Pick<RepoInfo, 'identity' | 'rootCommit' | 'root'>): string {
  return repo.identity ?? (repo.rootCommit ? `root:${repo.rootCommit}` : `path:${repo.root}`);
}
