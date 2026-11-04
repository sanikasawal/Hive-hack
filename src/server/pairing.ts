import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Store } from '../store/sqlite.ts';
import { repoRecord, type RepoDescriptor, type RepoRecord } from './checkouts.ts';
import type { TokenRecord, TokenService } from './tokens.ts';

/**
 * Device pairing for `hive-connect connect` (spec section 1.4-1.5, 2).
 * - pair_start (unauthenticated): returns a pairing id, a short user code for the browser and a poll secret
 *   for the CLI. Only the sha256 of the poll secret is stored.
 * - pair_approve / pair_deny: a signed-in member (or admin) decides in the dashboard.
 * - pair_poll (unauthenticated, needs the poll secret): after approval the first poll mints the connector
 *   token and returns its value exactly once; every later poll answers `consumed`. The token value is never
 *   stored, so a restart between approve and poll simply mints it on the next poll.
 */

export const PAIRING_TTL_MS = 10 * 60_000;
/** No 0/O/1/I: easy to read aloud and type. 32 symbols, so `byte % 32` is unbiased. */
export const USER_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const USER_CODE_LENGTH = 8;
const POLL_INTERVAL_S = 2;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export type PairingStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';

/** Refusal for too many pairing requests. The daemon answers it with HTTP 429. */
export class RateLimitError extends Error {
  readonly status = 429;
  constructor(message: string) { super(message); this.name = 'RateLimitError'; }
}

export interface PairStartInput { repo: RepoDescriptor; machine: string; client?: string | null }
export interface PairStartResult { pairingId: string; userCode: string; pollSecret: string; verifyUrl: string; expiresAt: number; interval: number }
export interface PairingInfo { pairingId: string; userCode: string; status: PairingStatus; repo: RepoRecord; machine: string; client: string | null; createdAt: number; expiresAt: number; member: string | null }
export type PollResult =
  | { status: 'pending'; expiresAt: number; interval: number }
  | { status: 'approved'; token: string; tokenId: string; member: string; label: string; repo: RepoRecord }
  | { status: 'denied' | 'expired' | 'consumed' };

type PairingRow = { id: string; user_code: string; poll_secret_hash: string; repo_json: string; machine: string; client: string | null;
  status: 'pending' | 'approved' | 'denied' | 'consumed'; token_id: string | null; created_at: number; expires_at: number; approved_by: string | null; approver: string | null; requester: string };

export interface PairingOptions {
  store: Store;
  tokens: TokenService;
  clock?: () => number;
  ttlMs?: number;
  /** Pending (undecided, unexpired) pairings allowed per requester IP. Default 5. */
  maxPendingPerIp?: number;
  /** Pairings started in any rolling hour across all requesters. Default 60. */
  maxPerHour?: number;
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function randomFrom(alphabet: string, length: number): string {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** Upper-cases and drops separators so `abcd-efgh` and `ABCD EFGH` both match `ABCDEFGH`. */
export function normalizeUserCode(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, '');
}

function cleanMachine(value: string): string {
  const trimmed = value.trim().replace(/[\0-\x1f\x7f]/g, '');
  if (!trimmed || trimmed.length > 80) throw new Error('machine must be 1-80 characters');
  return trimmed;
}

/** `<member> · <machine> · <repo>` within the 80-character label limit. */
export function connectorLabel(member: string, machine: string, repo: string): string {
  const label = `${member} · ${machine} · ${repo}`;
  if (label.length <= 80) return label;
  const budget = Math.max(8, Math.floor((80 - member.length - 6) / 2));
  const cut = (value: string) => value.length > budget ? `${value.slice(0, budget - 1)}…` : value;
  return `${member} · ${cut(machine)} · ${cut(repo)}`.slice(0, 80);
}

export class PairingService {
  private readonly store: Store;
  private readonly tokens: TokenService;
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private readonly maxPendingPerIp: number;
  private readonly maxPerHour: number;

  constructor(options: PairingOptions) {
    this.store = options.store;
    this.tokens = options.tokens;
    this.clock = options.clock ?? Date.now;
    this.ttlMs = options.ttlMs ?? PAIRING_TTL_MS;
    this.maxPendingPerIp = options.maxPendingPerIp ?? 5;
    this.maxPerHour = options.maxPerHour ?? 60;
  }

  /** Starts a pairing. `ip` is only stored as a sha256 for the per-address limit; `hub` builds verifyUrl. */
  start(input: PairStartInput, context: { ip: string; hub: string }): PairStartResult {
    const repo = repoRecord(input.repo);
    const machine = cleanMachine(input.machine);
    const client = input.client ? input.client.trim().slice(0, 40) || null : null;
    const requester = sha256(`pairing-ip:${context.ip || 'unknown'}`);
    return this.store.transaction(() => {
      const now = this.clock();
      const recent = Number(this.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM pairings WHERE created_at > ?', now - 3_600_000)!.n);
      if (recent >= this.maxPerHour) throw new RateLimitError('Too many pairing requests on this hub; try again later');
      const pending = Number(this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM pairings WHERE requester = ? AND status = 'pending' AND expires_at > ?", requester, now)!.n);
      if (pending >= this.maxPendingPerIp) throw new RateLimitError('Too many pending pairings from this address; approve, deny or wait for them to expire');
      const id = randomUUID();
      const pollSecret = randomFrom(BASE62, 32);
      const expiresAt = now + this.ttlMs;
      let userCode = '';
      for (let attempt = 0; attempt < 10 && !userCode; attempt++) {
        const candidate = randomFrom(USER_CODE_ALPHABET, USER_CODE_LENGTH);
        if (!this.store.get('SELECT 1 AS one FROM pairings WHERE user_code = ?', candidate)) userCode = candidate;
      }
      if (!userCode) throw new Error('Could not allocate a pairing code');
      this.store.run(`INSERT INTO pairings(id, user_code, poll_secret_hash, repo_json, machine, client, status, created_at, expires_at, requester)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`, id, userCode, sha256(pollSecret), JSON.stringify(repo), machine, client, now, expiresAt, requester);
      return { pairingId: id, userCode, pollSecret, verifyUrl: `${context.hub.replace(/\/+$/, '')}/ui/pair/${userCode}`, expiresAt, interval: POLL_INTERVAL_S };
    });
  }

  /** What the approval page shows. Any member may look a code up; the code itself is the capability to approve. */
  info(userCode: string): PairingInfo {
    const row = this.byCode(userCode);
    return { pairingId: row.id, userCode: row.user_code, status: this.status(row), repo: JSON.parse(row.repo_json) as RepoRecord, machine: row.machine, client: row.client,
      createdAt: Number(row.created_at), expiresAt: Number(row.expires_at), member: row.approved_by };
  }

  /** Approves a pending pairing for `member` (the approver's own member; an admin may name another). */
  approve(userCode: string, approver: { member: string; tokenId: string | null }): PairingInfo & { label: string } {
    return this.store.transaction(() => {
      const row = this.byCode(userCode);
      const status = this.status(row);
      if (status !== 'pending') throw new Error(`Pairing is ${status}`);
      this.store.run("UPDATE pairings SET status = 'approved', approved_by = ?, approver = ? WHERE id = ?", approver.member, approver.tokenId ?? approver.member, row.id);
      const info = this.info(row.user_code);
      return { ...info, label: connectorLabel(approver.member, info.machine, info.repo.name) };
    });
  }

  deny(userCode: string): PairingInfo {
    return this.store.transaction(() => {
      const row = this.byCode(userCode);
      const status = this.status(row);
      if (status !== 'pending') throw new Error(`Pairing is ${status}`);
      this.store.run("UPDATE pairings SET status = 'denied' WHERE id = ?", row.id);
      return this.info(row.user_code);
    });
  }

  /**
   * CLI poll. Wrong secret and unknown id give the same error. After approval the first poll creates the
   * connector token and returns it; the pairing is then `consumed` and never returns a token again.
   */
  poll(pairingId: string, pollSecret: string): PollResult {
    return this.store.transaction(() => {
      const row = this.store.get<PairingRow>('SELECT * FROM pairings WHERE id = ?', pairingId);
      const presented = Buffer.from(sha256(pollSecret), 'hex');
      const stored = Buffer.from(row?.poll_secret_hash ?? sha256(`absent:${pairingId}`), 'hex');
      if (!row || !timingSafeEqual(presented, stored)) throw new Error('Unknown pairing or wrong poll secret');
      const status = this.status(row);
      if (status === 'pending') return { status, expiresAt: Number(row.expires_at), interval: POLL_INTERVAL_S };
      if (status !== 'approved') return { status };
      const repo = JSON.parse(row.repo_json) as RepoRecord;
      const member = row.approved_by!;
      const label = connectorLabel(member, row.machine, repo.name);
      const created = this.tokens.create({ label, member, role: 'member', kind: 'connector', repoIdentity: repo.identity, machine: row.machine,
        createdBy: row.approver ?? member });
      this.store.run("UPDATE pairings SET status = 'consumed', token_id = ? WHERE id = ?", created.record.id, row.id);
      return { status: 'approved', token: created.token, tokenId: created.record.id, member, label, repo };
    });
  }

  /** Connector token minted by a pairing (for tests and the Members screen). */
  token(pairingId: string): TokenRecord | undefined {
    const row = this.store.get<{ token_id: string | null }>('SELECT token_id FROM pairings WHERE id = ?', pairingId);
    return row?.token_id ? this.tokens.get(row.token_id) : undefined;
  }

  private byCode(userCode: string): PairingRow {
    const row = this.store.get<PairingRow>('SELECT * FROM pairings WHERE user_code = ?', normalizeUserCode(userCode));
    if (!row) throw new Error('Unknown pairing code');
    return row;
  }

  /** Pending and approved pairings expire at expires_at; decided ones keep their status. */
  private status(row: PairingRow): PairingStatus {
    if ((row.status === 'pending' || row.status === 'approved') && Number(row.expires_at) <= this.clock()) return 'expired';
    return row.status;
  }
}
