import { createHash, timingSafeEqual } from 'node:crypto';
import type { Command } from './schemas.ts';
import type { Role, TokenKind, TokenService } from './tokens.ts';

/**
 * Who is calling. The operator (HIVE_TOKEN) is admin with no token row (kind absent). A connector is a
 * member-role token from pairing: it acts as its member on its own sessions.
 */
export interface Auth { role: Role; member: string; tokenId: string | null; kind?: TokenKind; repoIdentity?: string | null; machine?: string | null }

export class AuthError extends Error {
  readonly status: 401 | 403;
  constructor(status: 401 | 403, message: string) { super(message); this.name = 'AuthError'; this.status = status; }
}

export const OPERATOR_MEMBER = 'operator';
/** Routes a viewer may call. Everything else is refused with 403 for viewers. */
const VIEWER_ROUTES = new Set(['/api/view', '/me', '/events', '/healthz']);
const ADMIN_ACTIONS = new Set(['token_create', 'token_list', 'token_rename', 'token_revoke', 'model_diagnose']);
/** The only commands POST /command accepts without a bearer token (rate-limited in src/server/pairing.ts). */
const PUBLIC_ACTIONS = new Set(['pair_start', 'pair_poll']);
/** Browser-side pairing decisions: a member or admin signed in to the dashboard, never a connector credential. */
const NOT_FOR_CONNECTORS = new Set(['pair_approve', 'pair_deny', 'pair_info']);

export function isPublicAction(action: unknown): boolean { return typeof action === 'string' && PUBLIC_ACTIONS.has(action); }

function digest(value: string): Buffer { return createHash('sha256').update(value, 'utf8').digest(); }

/** Constant-time comparison (both sides hashed to equal length first). */
export function safeEqual(a: string, b: string): boolean { return timingSafeEqual(digest(a), digest(b)); }

export function bearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(\S+)\s*$/.exec(value);
  return match ? match[1]! : null;
}

/** Resolves a request's Authorization header to an Auth, or throws 401. */
export function resolveAuth(header: string | string[] | undefined, options: { adminToken: string; tokens: TokenService }): Auth {
  const presented = bearer(header);
  if (!presented) throw new AuthError(401, 'Unauthorized');
  if (safeEqual(presented, options.adminToken)) return { role: 'admin', member: OPERATOR_MEMBER, tokenId: null };
  const record = options.tokens.resolve(presented);
  if (!record) throw new AuthError(401, 'Unauthorized');
  return { role: record.role, member: record.member, tokenId: record.id, kind: record.kind,
    ...(record.kind === 'connector' ? { repoIdentity: record.repoIdentity, machine: record.machine } : {}) };
}

/** Route-level gate: viewers may only GET the viewer-safe routes. */
export function authorizeRoute(auth: Auth, method: string, pathname: string): void {
  if (auth.role !== 'viewer') return;
  if (method === 'GET' && VIEWER_ROUTES.has(pathname)) return;
  throw new AuthError(403, 'Forbidden: viewer tokens are read-only');
}

/**
 * Command-level gate. Admins may do anything. Members may run session commands only on
 * sessions registered with their own token. Viewers may run no command.
 */
export function authorizeCommand(auth: Auth, command: Command, sessionOwner: (sessionId: string) => { tokenId?: string | null } | undefined): void {
  if (auth.role === 'admin') return;
  if (auth.role === 'viewer') throw new AuthError(403, 'Forbidden: viewer tokens are read-only');
  if (ADMIN_ACTIONS.has(command.action)) throw new AuthError(403, 'Forbidden: admin token required');
  if (PUBLIC_ACTIONS.has(command.action)) return;
  if (auth.kind === 'connector' && NOT_FOR_CONNECTORS.has(command.action)) throw new AuthError(403, 'Forbidden: approve pairings from the dashboard, not with a connector credential');
  if (command.action === 'pair_approve' && command.member && command.member !== auth.member) throw new AuthError(403, 'Forbidden: only an admin may approve a pairing for another member');
  if ('sessionId' in command && command.sessionId) {
    const owner = sessionOwner(command.sessionId);
    // An unknown session falls through so the coordinator reports it as unknown/expired.
    if (owner && (owner.tokenId ?? null) !== auth.tokenId) throw new AuthError(403, 'Forbidden: session belongs to another member');
  }
}
