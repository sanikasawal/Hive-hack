// Pure logic for the sign-in and Connect screens: client config snippets built from the real endpoints,
// invite links, token paste clean-up and the "waiting for the first agent" progress.
// No imports at all, so the backend test suite runs this file directly under Node (strip-only).

export type ConnectClientId = 'claude-code' | 'muse-code' | 'mcp';

export interface ConnectClient {
  id: ConnectClientId;
  name: string;
  /** Label above the snippet, e.g. "Terminal". */
  snippetLabel: string;
  snippetLanguage: 'bash' | 'json' | 'text';
  /** Shown under the snippet when the format is not confirmed against the client itself. */
  caveat: string | null;
}

export const CONNECT_CLIENTS: readonly ConnectClient[] = [
  { id: 'claude-code', name: 'Claude Code', snippetLabel: 'Terminal', snippetLanguage: 'bash', caveat: null },
  { id: 'muse-code', name: 'Muse Code', snippetLabel: 'MCP servers', snippetLanguage: 'json',
    caveat: 'Format taken from the Meta docs. Verify it on your install.' },
  { id: 'mcp', name: 'Other MCP client', snippetLabel: 'URL and header', snippetLanguage: 'text', caveat: null },
];

export const clientById = (id: ConnectClientId): ConnectClient => CONNECT_CLIENTS.find(c => c.id === id) ?? CONNECT_CLIENTS[0]!;

/** One sentence the Connect flow shows next to the config, as the design spec requires. */
export const REMOTE_SCOPE_NOTE = 'Hive type-checks the TypeScript files your agent edits on your machine together with your teammates\' uncommitted changes. Only changed .ts and .tsx files are sent to Hive, never secrets or node_modules.';

/** Placeholder used when the person already holds their token (members cannot create new ones). */
export const TOKEN_PLACEHOLDER = '<your Hive token>';

/** Base of the service: no trailing slash. */
export function serviceBase(cloudLink: string): string {
  return cloudLink.trim().replace(/\/+$/, '');
}

/** The Streamable HTTP MCP endpoint the daemon serves (POST/GET/DELETE /mcp). */
export function mcpUrl(cloudLink: string): string {
  return `${serviceBase(cloudLink)}/mcp`;
}

/** POSIX single-quote quoting: safe for any string, including quotes and spaces. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The exact text a person pastes to connect a client. URL and token are filled in. */
export function configSnippet(client: ConnectClientId, cloudLink: string, token: string): string {
  const url = mcpUrl(cloudLink);
  const header = `Authorization: Bearer ${token}`;
  if (client === 'claude-code') {
    // One-time setup served by Hive: installs the hook, the MCP server and the token for this project only.
    return `curl -fsSL ${shellQuote(`${serviceBase(cloudLink)}/connect.mjs`)} -o hive-connect.mjs && node hive-connect.mjs ${shellQuote(token)} && rm hive-connect.mjs`;
  }
  if (client === 'muse-code') {
    const block = { mcp_servers: { hive: { transport: 'streamable_http', url, headers: { Authorization: `Bearer ${token}` } } } };
    return JSON.stringify(block, null, 2);
  }
  return `URL: ${url}\n${header}`;
}

/**
 * Browser invite link. The token rides after the #, which browsers never send to a server.
 * `basePath` is where the app is served (Vite BASE_URL, "/ui/").
 */
export function inviteLink(cloudLink: string, basePath: string, token: string): string {
  const base = `/${basePath.replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '');
  return `${serviceBase(cloudLink)}${base}/join#token=${encodeURIComponent(token)}`;
}

/**
 * Cleans what people actually paste into the sign-in field: surrounding whitespace and quotes,
 * an "Authorization:" header name and a "Bearer" prefix. The token itself is never altered.
 */
export function normalizePastedToken(input: string): string {
  let value = input.trim();
  value = value.replace(/^authorization\s*:\s*/i, '');
  value = value.replace(/^bearer\s+/i, '');
  value = value.replace(/^["'`]+|["'`]+$/g, '');
  return value.trim();
}

export interface SessionLike { id: string; tokenId?: string | null; status?: string }
export interface TokenRecordLike { id: string; lastUsedAt: number | null; revokedAt: number | null }

export interface InviteProgressInput {
  /** Token being followed: a token created in step 2, or the signed-in member's own token. */
  tokenId: string | null;
  /** Session ids already registered with this token when waiting started; they do not count. */
  baselineSessionIds: readonly string[];
  sessions: readonly SessionLike[];
  /** Admin only: the token's metadata (never its value). Null when the caller cannot list tokens. */
  record: TokenRecordLike | null;
  /** True when the token was created in this flow (then any use of it is the new client). */
  newToken: boolean;
  /** Extra session ids attributed to the token by other means (prototype data). */
  extraSessionIds?: readonly string[];
}

export interface InviteProgress {
  /** New sessions registered with the token, oldest first as the snapshot lists them. */
  sessionIds: string[];
  /** The token has been presented by some client (new tokens only; own tokens are used by this page). */
  clientSeenAt: number | null;
  registered: boolean;
  revoked: boolean;
}

export function inviteProgress(input: InviteProgressInput): InviteProgress {
  const baseline = new Set(input.baselineSessionIds);
  const ids: string[] = [];
  if (input.tokenId !== null) {
    for (const session of input.sessions) {
      if (session.tokenId === input.tokenId && !baseline.has(session.id) && !ids.includes(session.id)) ids.push(session.id);
    }
  }
  for (const id of input.extraSessionIds ?? []) if (!baseline.has(id) && !ids.includes(id)) ids.push(id);
  const clientSeenAt = input.newToken && input.record ? input.record.lastUsedAt : null;
  return { sessionIds: ids, clientSeenAt, registered: ids.length > 0, revoked: Boolean(input.record?.revokedAt) };
}

// ---- Hive Connect (spec 2026-11-03, section 1) -------------------------------------------------------

/** The one command a teammate runs inside their repository. Prefer /me.connect.cliCommand when the hub sends it. */
export function connectCommand(hubUrl: string): string {
  return `npx hive-connect connect --hub ${serviceBase(hubUrl)}`;
}

/** Per-client notes under the command: what `hive-connect connect` configures and what to do afterwards. */
export const CLIENT_NOTES: Readonly<Record<ConnectClientId, { name: string; note: string }>> = {
  'claude-code': { name: 'Claude Code', note: 'The command adds Hive hooks to .claude/settings.local.json and the Hive MCP server to .mcp.json in this repository. Neither file holds a token: the credential stays in your OS keychain. Start or restart Claude Code in that folder afterwards.' },
  'muse-code': { name: 'Muse Code', note: 'The command adds a "hive" entry to ~/.config/muse/settings.json (after a backup) and hooks to .muse/hooks.json in the repository. The hooks format is a best guess; check it on your install.' },
  mcp: { name: 'Other MCP client', note: 'The command prints the stdio server to add (hive-connect mcp, which reads the credential from your keychain) and the HTTP alternative with a placeholder header.' },
};

/**
 * Token from what a person pastes on the approval page: a full invite link (token after "#token="),
 * or a bare token (cleaned like the sign-in field). Empty string when nothing usable is there.
 */
export function tokenFromInvite(input: string): string {
  const value = input.trim();
  const hash = value.indexOf('#');
  if (hash >= 0) {
    const fragment = value.slice(hash + 1);
    for (const part of fragment.split('&')) {
      const [key, raw] = part.split('=');
      if (key === 'token' && raw) {
        try { return normalizePastedToken(decodeURIComponent(raw)); } catch { return normalizePastedToken(raw); }
      }
    }
    return '';
  }
  return normalizePastedToken(value);
}

/** Internal app paths an invite link may continue to after signing in (`#token=…&next=/pair/CODE`). */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next) return null;
  return /^\/[A-Za-z0-9/_-]{0,120}$/.test(next) && !next.startsWith('//') ? next : null;
}

export interface ConnectorLike {
  tokenId: string;
  member: string;
  machine: string | null;
  repoName: string | null;
  branch: string | null;
  headShort: string | null;
  dirtyCount: number;
  reportedAt: number | null;
  createdAt: number;
}
export interface ConnectSessionLike { id: string; member?: string | null; tokenId?: string | null; connector?: unknown }

export interface ConnectProgressInput {
  /** Whose connection to follow; null follows anyone the caller can see. */
  member: string | null;
  /** Connectors and sessions that existed when waiting started; they do not count. */
  baselineConnectorIds: readonly string[];
  baselineSessionIds: readonly string[];
  connectors: readonly ConnectorLike[];
  sessions: readonly ConnectSessionLike[];
}

export interface ConnectProgress {
  /** The connector this flow follows: a new pairing, or the credential a new connected session used (reconnect). */
  connector: ConnectorLike | null;
  /** The connector sent its first checkout report (repository, branch, HEAD, local changes). */
  reported: boolean;
  /** First new session registered through a connector credential. */
  sessionId: string | null;
  /** 0 nothing yet, 1 approved, 2 repository reported, 3 agent registered. */
  done: 0 | 1 | 2 | 3;
}

/** Progress of "run one command": approval creates a connector, the node reports the checkout, the agent registers. */
export function connectProgress(input: ConnectProgressInput): ConnectProgress {
  const forMember = <T extends { member?: string | null }>(item: T) => input.member === null || item.member === input.member;
  const baseConnectors = new Set(input.baselineConnectorIds);
  const baseSessions = new Set(input.baselineSessionIds);
  const visible = input.connectors.filter(forMember);
  const connectorIds = new Set(visible.map(c => c.tokenId));
  const fresh = visible.filter(c => !baseConnectors.has(c.tokenId)).sort((a, b) => b.createdAt - a.createdAt);
  // A new session counts when it came through a connector credential: one of the listed connectors, or carrying checkout info.
  const sessions = input.sessions.filter(s => !baseSessions.has(s.id) && forMember(s)
    && ((s.tokenId != null && connectorIds.has(s.tokenId)) || s.connector != null));
  const connector = fresh[0] ?? visible.find(c => sessions.some(s => s.tokenId === c.tokenId)) ?? null;
  const session = (connector && sessions.find(s => s.tokenId === connector.tokenId)) ?? sessions[0] ?? null;
  const reported = Boolean(connector && connector.reportedAt !== null);
  const sessionId = session?.id ?? null;
  const done = sessionId ? 3 : reported ? 2 : connector ? 1 : 0;
  return { connector, reported, sessionId, done };
}
