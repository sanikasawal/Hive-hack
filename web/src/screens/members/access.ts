// Members and tokens as the Members screen shows them, derived from live daemon data. Pure functions,
// type-only imports and relative paths, so the backend test suite runs this file under Node directly.
//
// What the daemon gives each role (src/server/daemon.ts, src/server/auth.ts):
// - admin: token_list (metadata only: never values or hashes) and member_list, plus /snapshot sessions.
// - member: member_list without tokens and /snapshot sessions. token_* are admin only, so a member
//   knows only the token they signed in with (its id from /me).
// - viewer: /api/view only. No token data at all.
// The operator signs in with HIVE_TOKEN (tokenId null). That bootstrap token has no row and is never shown.
import type { Me, Role, TokenRecord } from '../../api/types.ts';

export const OPERATOR = 'operator';
/** A token used within this window counts as its member being active right now. */
export const ACTIVE_WINDOW_MS = 5 * 60_000;
/** Same bounds the daemon enforces for labels (src/server/schemas.ts). */
export const LABEL_MAX = 80;

const ROLE_PREFIX: Record<Role, string> = { admin: 'adm', member: 'mem', viewer: 'view' };
const ROLE_RANK: Record<Role, number> = { admin: 0, member: 1, viewer: 2 };
const TOKEN_PATTERN = /^hive_(adm|mem|view)_([0-9A-Za-z]{32})$/;

export interface SessionLike {
  id: string;
  name: string;
  client: string | null;
  member?: string | null;
  tokenId?: string | null;
}

export interface AgentRef { id: string; name: string; client: string | null }

export interface TokenView {
  id: string;
  label: string;
  role: Role;
  /** Safe display prefix, e.g. "hive_mem_7Qk2abCd". Empty when unknown. */
  prefix: string;
  createdAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  /** Agents registered with this token that the daemon currently reports. */
  agents: AgentRef[];
  /** The token this browser is signed in with. */
  current: boolean;
  /** False when only the id is known (a member looking at their own token). */
  detailsKnown: boolean;
}

export type MemberStatus = 'active' | 'idle' | 'no-access';

export interface MemberRow {
  /** Member name; the daemon keys members by name. */
  id: string;
  name: string;
  role: Role;
  isMe: boolean;
  /** Signed in with the bootstrap admin token (HIVE_TOKEN), which is never listed. */
  bootstrap: boolean;
  /** Active tokens newest first, then revoked tokens most recently revoked first. */
  tokens: TokenView[];
  activeTokenCount: number;
  agents: AgentRef[];
  lastActiveAt: number | null;
  /** Earliest token creation, or null when unknown. */
  joinedAt: number | null;
  status: MemberStatus;
}

/** 'all': every member (admin). 'own': only the signed-in member. 'none': viewers and signed-out. */
export type AccessScope = 'all' | 'own' | 'none';

export interface AccessInput {
  me: Pick<Me, 'role' | 'member' | 'tokenId'> | null;
  /** token_list (admin). Ignored for other roles. */
  tokens: TokenRecord[];
  /** /snapshot sessions; each carries the member and token id that registered it. */
  sessions: SessionLike[];
  /** Member names from member_list (people with agents but possibly no listed token). */
  memberNames?: string[];
  /** The stored sign-in token, used only to show a member their own prefix. Never the operator's. */
  signedInToken?: string | null;
  /** The signed-in member's Hive Connect credentials (member_list connectors): their agents count as the member's own. */
  connectorTokenIds?: string[];
  now: number;
}

export interface Access {
  scope: AccessScope;
  rows: MemberRow[];
  activeTokens: number;
}

/** "hive_mem_" plus the stored 8-character prefix. Mock data already carries the full display prefix. */
export function displayPrefix(role: Role, prefix: string): string {
  if (!prefix) return '';
  return prefix.startsWith('hive_') ? prefix : `hive_${ROLE_PREFIX[role]}_${prefix}`;
}

/** The same 8-character prefix the daemon stores, from a full member token. Null for anything else. */
export function prefixFromSecret(secret: string | null | undefined): string | null {
  const match = TOKEN_PATTERN.exec((secret ?? '').trim());
  return match ? `hive_${match[1]}_${match[2]!.slice(0, 8)}` : null;
}

/** "pricing agent" from "Sanika · pricing agent". */
export function agentName(sessionName: string, member: string | null | undefined): string {
  return member && sessionName.startsWith(`${member} · `) ? sessionName.slice(member.length + 3) : sessionName;
}

const toAgent = (session: SessionLike): AgentRef => ({ id: session.id, name: agentName(session.name, session.member), client: session.client });

function statusOf(activeCount: number, lastActiveAt: number | null, now: number): MemberStatus {
  if (activeCount === 0) return 'no-access';
  return lastActiveAt !== null && now - lastActiveAt < ACTIVE_WINDOW_MS ? 'active' : 'idle';
}

function sortTokens(tokens: TokenView[]): TokenView[] {
  const active = tokens.filter(t => t.revokedAt === null).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const revoked = tokens.filter(t => t.revokedAt !== null).sort((a, b) => (b.revokedAt ?? 0) - (a.revokedAt ?? 0));
  return [...active, ...revoked];
}

function sortRows(rows: MemberRow[]): MemberRow[] {
  return rows.sort((a, b) => Number(b.isMe) - Number(a.isMe) || ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.name.localeCompare(b.name));
}

function adminRows(input: AccessInput, me: NonNullable<AccessInput['me']>): MemberRow[] {
  const byMember = new Map<string, TokenRecord[]>();
  const add = (name: string) => { if (!byMember.has(name)) byMember.set(name, []); return byMember.get(name)!; };
  for (const token of input.tokens) add(token.member).push(token);
  for (const name of input.memberNames ?? []) add(name);
  for (const session of input.sessions) if (session.member) add(session.member);
  if (me.tokenId === null) add(me.member);

  const connectorIds = new Set(input.tokens.filter(t => t.kind === 'connector').map(t => t.id));
  const rows: MemberRow[] = [];
  for (const [name, records] of byMember) {
    const tokens = sortTokens(records.map(record => ({
      id: record.id, label: record.label, role: record.role, prefix: displayPrefix(record.role, record.prefix),
      createdAt: record.createdAt, lastUsedAt: record.lastUsedAt, revokedAt: record.revokedAt,
      agents: input.sessions.filter(s => s.tokenId === record.id).map(toAgent),
      current: record.id === me.tokenId, detailsKnown: true,
    })));
    // Hive Connect credentials are listed as connected machines, not as tokens; their agents still count.
    const listed = tokens.filter(t => !connectorIds.has(t.id));
    const active = listed.filter(t => t.revokedAt === null);
    const isMe = name === me.member;
    const bootstrap = isMe && me.tokenId === null;
    // Operator sessions have no token row; they still belong to the operator.
    const untokened = input.sessions.filter(s => s.member === name && !s.tokenId).map(toAgent);
    const agents = [...tokens.flatMap(t => t.agents), ...untokened];
    const used = tokens.map(t => t.lastUsedAt).filter((v): v is number => v !== null);
    const lastActiveAt = bootstrap ? input.now : used.length ? Math.max(...used) : null;
    const newest = active[0] ?? tokens[0];
    const role: Role = bootstrap ? 'admin' : newest?.role ?? (name === OPERATOR ? 'admin' : isMe ? me.role : 'member');
    rows.push({
      id: name, name, role, isMe, bootstrap, tokens: listed, activeTokenCount: active.length, agents, lastActiveAt,
      joinedAt: records.length ? Math.min(...records.map(r => r.createdAt)) : null,
      status: bootstrap ? 'active' : statusOf(active.length, lastActiveAt, input.now),
    });
  }
  return sortRows(rows);
}

function ownRow(input: AccessInput, me: NonNullable<AccessInput['me']>): MemberRow {
  const connectors = new Set(input.connectorTokenIds ?? []);
  const own = (s: SessionLike) => (me.tokenId ? s.tokenId === me.tokenId : s.member === me.member && !s.tokenId);
  const viaConnector = input.sessions.filter(s => s.tokenId != null && connectors.has(s.tokenId)).map(toAgent);
  const mine = input.sessions.filter(own).map(toAgent);
  const tokens: TokenView[] = me.tokenId ? [{
    id: me.tokenId, label: 'The token you signed in with', role: me.role,
    prefix: prefixFromSecret(input.signedInToken) ?? '', createdAt: null, lastUsedAt: input.now, revokedAt: null,
    agents: mine, current: true, detailsKnown: false,
  }] : [];
  return { id: me.member, name: me.member, role: me.role, isMe: true, bootstrap: me.tokenId === null, tokens,
    activeTokenCount: tokens.length, agents: [...mine, ...viaConnector], lastActiveAt: input.now, joinedAt: null, status: 'active' };
}

/** Rows for the Members screen, scoped to what the signed-in role may see. */
export function buildAccess(input: AccessInput): Access {
  const me = input.me;
  if (!me || me.role === 'viewer') return { scope: 'none', rows: [], activeTokens: 0 };
  if (me.role === 'admin') {
    const rows = adminRows(input, me);
    return { scope: 'all', rows, activeTokens: input.tokens.filter(t => t.revokedAt === null && t.kind !== 'connector').length };
  }
  const row = ownRow(input, me);
  return { scope: 'own', rows: [row], activeTokens: row.activeTokenCount };
}

/** Only admins may rename or revoke tokens (token_* commands are admin only on the daemon). */
export const canManageTokens = (role: Role | null | undefined): boolean => role === 'admin';

/** Label check matching the daemon: 1 to 80 characters after trimming. */
export function validateLabel(next: string): string | null {
  const value = next.trim();
  if (!value) return 'Give the token a label.';
  if (value.length > LABEL_MAX) return `Keep the label to ${LABEL_MAX} characters or fewer.`;
  return null;
}

/** "1 agent", "3 agents". */
export const countAgents = (n: number) => `${n} ${n === 1 ? 'agent' : 'agents'}`;
