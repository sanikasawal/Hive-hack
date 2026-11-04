import type { Store } from '../store/sqlite.ts';

/**
 * Checkout reports: what each connector (or member token) last said about its local clone. One row per
 * token. Only the normalized repository identity is kept, never a remote URL (which may carry credentials),
 * and dirty files are relative paths with the sha256 of their content.
 */

export const MAX_DIRTY_ENTRIES = 500;
const HEX = /^[0-9a-f]+$/i;

/** Repository as the client describes it. remoteUrl is only read to derive `identity`; it is never stored. */
export interface RepoDescriptor { name: string; identity?: string | null; remoteUrl?: string | null; rootCommit?: string | null }
/** Repository as stored and shown. */
export interface RepoRecord { name: string; identity: string | null; rootCommit: string | null }
export interface DirtyFile { path: string; sha256: string | null; status?: string }
export interface CheckoutInput {
  repo: RepoDescriptor;
  branch?: string | null;
  head?: string | null;
  baseCommit?: string | null;
  machine?: string | null;
  dirty: DirtyFile[];
}
export interface Checkout {
  tokenId: string;
  member: string;
  machine: string | null;
  repo: RepoRecord;
  branch: string | null;
  head: string | null;
  baseCommit: string | null;
  dirty: DirtyFile[];
  reportedAt: number;
}

type CheckoutRow = { token_id: string; member: string; machine: string | null; repo_json: string; branch: string | null; head: string | null;
  base_commit: string | null; dirty_json: string; reported_at: number };

/**
 * Normalizes a git remote to `host/owner/repo` (lower-case host, no scheme, user, password, port or `.git`).
 * `git@github.com:a/b.git`, `https://github.com/a/b`, `https://x:tok@github.com/a/b.git/` and
 * `ssh://git@github.com:22/a/b.git` all become `github.com/a/b`. Local paths and garbage return null.
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
    // Already an identity: host/owner/repo.
    const slash = raw.indexOf('/');
    host = raw.slice(0, slash);
    path = raw.slice(slash + 1);
  } else {
    return null;
  }
  host = host.toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.') && host !== 'localhost') return null;
  const segments = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  if (!segments.length || segments.some(s => s === '.' || s === '..' || /[@:\\?#]/.test(s))) return null;
  return `${host}/${segments.join('/')}`;
}

/** Strips `user:password@` from URLs anywhere in a string (for anything echoed back to a client). */
export function stripUrlCredentials(value: string): string {
  return value.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1');
}

/** A relative, normalized repository path: no absolute paths, drive letters, home shortcuts, `..` or NUL. */
export function isRelativeRepoPath(value: string): boolean {
  if (!value || value.length > 1000 || value.includes('\0')) return false;
  if (value.startsWith('/') || value.startsWith('\\') || value.startsWith('~') || /^[A-Za-z]:/.test(value)) return false;
  return !value.split(/[\\/]/).some(segment => segment === '..');
}

function shortText(value: string | null | undefined, field: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = stripUrlCredentials(value.trim());
  if (!trimmed) return null;
  if (trimmed.length > max) throw new Error(`${field} must be at most ${max} characters`);
  return trimmed;
}
function commit(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value.length < 7 || value.length > 64 || !HEX.test(value)) throw new Error(`${field} must be a hex commit id`);
  return value.toLowerCase();
}

/** Repository descriptor to the stored record. Derives identity from remoteUrl (preferred) or identity. */
export function repoRecord(repo: RepoDescriptor): RepoRecord {
  const name = shortText(repo.name, 'repo.name', 120);
  if (!name) throw new Error('repo.name is required');
  if (name.includes('/') && !isRelativeRepoPath(name)) throw new Error('repo.name must not be a path');
  return { name, identity: normalizeRepoIdentity(repo.remoteUrl) ?? normalizeRepoIdentity(repo.identity), rootCommit: commit(repo.rootCommit, 'repo.rootCommit') };
}

/** Validates a report; throws with a reason. Kept independent of the zod schema so the service is safe on its own. */
export function validateCheckout(input: CheckoutInput): Omit<Checkout, 'tokenId' | 'member' | 'reportedAt'> {
  if (!Array.isArray(input.dirty)) throw new Error('dirty must be a list');
  if (input.dirty.length > MAX_DIRTY_ENTRIES) throw new Error(`At most ${MAX_DIRTY_ENTRIES} dirty files per report`);
  const seen = new Set<string>();
  const dirty: DirtyFile[] = [];
  for (const entry of input.dirty) {
    const path = String(entry?.path ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!isRelativeRepoPath(path)) throw new Error(`Dirty path must be relative to the repository root: ${JSON.stringify(String(entry?.path ?? '').slice(0, 80))}`);
    if (entry.sha256 !== null && (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.sha256))) throw new Error(`Dirty file ${path} needs a sha256 (or null when deleted)`);
    if (seen.has(path)) continue;
    seen.add(path);
    dirty.push({ path, sha256: entry.sha256 === null ? null : entry.sha256.toLowerCase(), ...(entry.status ? { status: String(entry.status).slice(0, 20) } : {}) });
  }
  return { repo: repoRecord(input.repo), machine: shortText(input.machine, 'machine', 80), branch: shortText(input.branch, 'branch', 200),
    head: commit(input.head, 'head'), baseCommit: commit(input.baseCommit, 'baseCommit'), dirty };
}

function rowToCheckout(row: CheckoutRow): Checkout {
  return { tokenId: row.token_id, member: row.member, machine: row.machine, repo: JSON.parse(row.repo_json) as RepoRecord, branch: row.branch, head: row.head,
    baseCommit: row.base_commit, dirty: JSON.parse(row.dirty_json) as DirtyFile[], reportedAt: Number(row.reported_at) };
}

export class CheckoutService {
  private readonly store: Store;
  private readonly clock: () => number;

  constructor(store: Store, clock: () => number = Date.now) {
    this.store = store;
    this.clock = clock;
  }

  /**
   * Stores the latest report for a token (replacing the previous one). `boundIdentity` is the repository a
   * connector credential was paired for: a report from a different repository is refused.
   */
  report(owner: { tokenId: string | null; member: string; boundIdentity?: string | null; machine?: string | null }, input: CheckoutInput): Checkout {
    if (!owner.tokenId) throw new Error('checkout_report needs a member or connector token (the operator token has no checkout)');
    const clean = validateCheckout(input);
    if (owner.boundIdentity && clean.repo.identity && clean.repo.identity !== owner.boundIdentity)
      throw new Error(`This credential is bound to ${owner.boundIdentity}, not ${clean.repo.identity}`);
    const machine = owner.machine ?? clean.machine;
    const now = this.clock();
    this.store.run(`INSERT INTO checkouts(token_id, member, machine, repo_json, branch, head, base_commit, dirty_json, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token_id) DO UPDATE SET member = excluded.member, machine = excluded.machine, repo_json = excluded.repo_json, branch = excluded.branch,
      head = excluded.head, base_commit = excluded.base_commit, dirty_json = excluded.dirty_json, reported_at = excluded.reported_at`,
    owner.tokenId, owner.member, machine, JSON.stringify(clean.repo), clean.branch, clean.head, clean.baseCommit, JSON.stringify(clean.dirty), now);
    return this.get(owner.tokenId)!;
  }

  get(tokenId: string): Checkout | undefined {
    const row = this.store.get<CheckoutRow>('SELECT * FROM checkouts WHERE token_id = ?', tokenId);
    return row ? rowToCheckout(row) : undefined;
  }

  list(): Checkout[] {
    return this.store.all<CheckoutRow>('SELECT * FROM checkouts ORDER BY reported_at, rowid').map(rowToCheckout);
  }

  clear(tokenId: string): boolean {
    return Number(this.store.run('DELETE FROM checkouts WHERE token_id = ?', tokenId).changes) > 0;
  }
}
