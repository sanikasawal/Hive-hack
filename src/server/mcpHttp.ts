import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Auth } from './auth.ts';
import { registerHiveTools, type HiveTools, type ToolBackend } from './tools.ts';

/**
 * MCP over Streamable HTTP at /mcp (stateful). The caller (daemon) authenticates the request first; viewers never
 * reach this handler. One MCP session = one Hive session: hive_register binds them, every request to the MCP
 * session heartbeats the bound Hive session, an open GET stream keeps it alive, and DELETE finishes it.
 * An MCP session can only be used with the credential that created it.
 *
 * Request classes, answered here before the SDK transport sees them (the transport would otherwise answer a
 * session-less non-initialize POST with "Server not initialized" and report it through onerror):
 *  - no Mcp-Session-Id and not an initialize request → 400 -32000 "missing initialization" (no server is created);
 *  - an Mcp-Session-Id this process does not know (restart, idle close, DELETE) → 404 -32001 "Session not found",
 *    the spec's signal that the client must start a new session with initialize;
 *  - an initialize request without a session id → a new transport + server.
 * Both error classes log at most one stderr line per remote per 10 s, with a count of suppressed repeats.
 */
export interface McpHttpOptions {
  version: string;
  /** Runs one /command body as `auth` (schema parse + command authorization + execute). */
  command: (auth: Auth, command: Record<string, unknown>) => Promise<unknown>;
  snapshot: (auth: Auth) => Promise<unknown>;
  /** Extends a Hive session lease; throws for an unknown/expired session. */
  heartbeat: (sessionId: string) => void;
  /** Finishes a Hive session on DELETE /mcp. */
  finish: (auth: Auth, sessionId: string) => Promise<unknown>;
  maxSessions?: number;
  idleMs?: number;
  streamHeartbeatMs?: number;
  /** Minimum gap between two log lines of the same class for the same remote (default 10 s). */
  logIntervalMs?: number;
  /** stderr sink (tests capture it). Never stdout. */
  log?: (line: string) => void;
}

interface Entry {
  id: string; transport: StreamableHTTPServerTransport; server: McpServer; tools: HiveTools; auth: Auth;
  lastActive: number; openStreams: number; closeReason?: string;
}

const MAX_BODY = 1024 * 1024;
export const MISSING_INITIALIZATION = 'Bad Request: missing initialization: no Mcp-Session-Id header and the request is not an initialize request; send initialize to start a session';
export const SESSION_NOT_FOUND = 'Session not found';

const principal = (auth: Auth) => auth.tokenId ?? `operator:${auth.member}`;
function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
/** Right-most X-Forwarded-For entry (added by the platform proxy), else the socket peer. For logs only. */
function remoteOf(request: IncomingMessage): string {
  const forwarded = String(request.headers['x-forwarded-for'] ?? '').split(',').map(part => part.trim()).filter(Boolean);
  return forwarded.at(-1) ?? request.socket?.remoteAddress ?? 'unknown';
}
function jsonRpcError(response: ServerResponse, status: number, code: number, text: string): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code, message: text }, id: null }));
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const shortId = (id: string) => id.length > 12 ? `${id.slice(0, 8)}…` : id;
const clean = (value: unknown) => String(value).replace(/[^\x20-\x7e]/g, '?').slice(0, 80);

class BodyTooLarge extends Error {}
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY) throw new BodyTooLarge('Payload too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
/** The JSON-RPC method of a message or the first message of a batch, if it has one. */
function rpcMethod(body: unknown): string | undefined {
  const first = Array.isArray(body) ? body[0] : body;
  return first && typeof first === 'object' && typeof (first as { method?: unknown }).method === 'string' ? (first as { method: string }).method : undefined;
}
const isJsonRpc = (body: unknown) => (Array.isArray(body) ? body : [body]).every(m => !!m && typeof m === 'object' && (m as { jsonrpc?: unknown }).jsonrpc === '2.0');

export function createMcpHttpHandler(options: McpHttpOptions) {
  const sessions = new Map<string, Entry>();
  const maxSessions = options.maxSessions ?? 100;
  const idleMs = options.idleMs ?? 30 * 60_000;
  const logIntervalMs = options.logIntervalMs ?? 10_000;
  const log = options.log ?? ((line: string) => console.error(line));

  // Per (class, remote) rate limit so one misbehaving client cannot flood the logs.
  const limits = new Map<string, { next: number; suppressed: number }>();
  function logLimited(kind: string, remote: string, line: string): void {
    const now = Date.now();
    const key = `${kind}\u0000${remote}`;
    const state = limits.get(key);
    if (state && now < state.next) { state.suppressed++; return; }
    if (limits.size > 1000) for (const [k, v] of limits) if (now >= v.next) limits.delete(k);
    const suppressed = state?.suppressed ? ` [${state.suppressed} similar suppressed]` : '';
    limits.set(key, { next: now + logIntervalMs, suppressed: 0 });
    log(`${line}${suppressed}`);
  }

  /** Keeps the bound Hive session alive. A lost lease unbinds it once (one log line); the MCP session stays usable
   * and hive_register binds a new Hive session on it. An unbound entry is skipped, so nothing repeats. */
  function keepAlive(entry: Entry): void {
    const hive = entry.tools.sessionId;
    if (!hive) return;
    try { options.heartbeat(hive); }
    catch (error) {
      entry.tools.drop();
      log(`Hive /mcp: session ${entry.id} lost Hive session ${hive} (${errorText(error)}); unbound, hive_register binds a new one on the same MCP session`);
    }
  }

  function closeEntry(entry: Entry, reason: string): void {
    entry.closeReason ??= reason;
    void entry.transport.close().catch(error => log(`Hive /mcp: closing session ${entry.id} (${reason}) failed: ${errorText(error)}`));
  }

  // Open GET streams keep their Hive session alive between requests; idle MCP sessions are closed.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const entry of sessions.values()) {
      if (entry.openStreams > 0) keepAlive(entry);
      else if (now - entry.lastActive > idleMs) closeEntry(entry, 'idle');
    }
  }, options.streamHeartbeatMs ?? 30_000);
  sweep.unref();

  async function create(request: IncomingMessage, response: ServerResponse, auth: Auth, remote: string): Promise<void> {
    let body: unknown;
    let parsed = false;
    try { body = JSON.parse(await readBody(request)); parsed = true; }
    catch (error) {
      if (error instanceof BodyTooLarge) { jsonRpcError(response, 413, -32000, 'Payload too large'); return; }
    }
    const messages = Array.isArray(body) ? body : [body];
    if (!parsed || !messages.some(isInitializeRequest)) {
      const method = parsed ? rpcMethod(body) : undefined;
      logLimited('no-session', remote, `Hive /mcp: 400 missing initialization (POST without Mcp-Session-Id; json-rpc=${parsed && isJsonRpc(body) ? 'yes' : 'no'}, method=${method ? clean(method) : '-'}, remote=${remote})`);
      if (!parsed) jsonRpcError(response, 400, -32700, 'Parse error: Invalid JSON');
      else jsonRpcError(response, 400, -32000, MISSING_INITIALIZATION);
      return;
    }
    if (sessions.size >= maxSessions) {
      logLimited('full', remote, `Hive /mcp: 503 refused initialize, ${sessions.size} MCP sessions open (remote=${remote})`);
      jsonRpcError(response, 503, -32000, 'Too many open MCP sessions'); return;
    }
    const init = messages.find(isInitializeRequest)!;
    const server = new McpServer({ name: 'hive', version: options.version });
    const backend: ToolBackend = { command: command => options.command(auth, command), snapshot: () => options.snapshot(auth) };
    const tools = registerHiveTools(server, backend, {
      client: () => `mcp-http:${server.server.getClientVersion()?.name ?? 'unknown'}`.slice(0, 200),
    });
    let entry: Entry | undefined;
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      maxRequestBodySize: MAX_BODY,
      onsessioninitialized: id => {
        entry = { id, transport, server, tools, auth, lastActive: Date.now(), openStreams: 0 };
        sessions.set(id, entry);
        const client = init.params.clientInfo;
        log(`Hive /mcp: session ${id} initialized (client=${clean(client.name)} ${clean(client.version)}, protocol=${clean(init.params.protocolVersion)}, member=${auth.member}, remote=${remote})`);
      },
      // DELETE /mcp: the client ended the MCP session, so its Hive session ends too.
      onsessionclosed: async () => {
        if (entry) entry.closeReason ??= 'client DELETE';
        const hive = tools.sessionId;
        if (!hive) return;
        tools.drop();
        try { await options.finish(auth, hive); }
        catch (error) { log(`Hive /mcp: finishing Hive session ${hive} failed: ${errorText(error)}`); }
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (!id || sessions.get(id)?.transport !== transport) return;
      sessions.delete(id);
      log(`Hive /mcp: session ${id} closed (${entry?.closeReason ?? 'transport closed'})`);
    };
    transport.onerror = error => log(`Hive /mcp transport error${transport.sessionId ? ` (session ${transport.sessionId})` : ''}: ${errorText(error)}`);
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
    // The transport refused the initialize (e.g. bad Accept header): discard the unused server.
    if (!entry) await server.close().catch(() => {});
  }

  async function handle(request: IncomingMessage, response: ServerResponse, auth: Auth): Promise<void> {
    const remote = remoteOf(request);
    try {
      const id = header(request, 'mcp-session-id');
      if (!id) {
        if (request.method === 'POST') { await create(request, response, auth, remote); return; }
        logLimited('no-session', remote, `Hive /mcp: 400 missing initialization (${request.method} without Mcp-Session-Id; json-rpc=n/a, method=-, remote=${remote})`);
        jsonRpcError(response, 400, -32000, MISSING_INITIALIZATION); return;
      }
      const entry = sessions.get(id);
      if (!entry) {
        logLimited('unknown-session', remote, `Hive /mcp: 404 unknown or expired MCP session ${clean(shortId(id))} (${request.method}, remote=${remote}); the client must re-initialize`);
        request.resume();
        jsonRpcError(response, 404, -32001, SESSION_NOT_FOUND); return;
      }
      if (principal(entry.auth) !== principal(auth)) {
        logLimited('forbidden', remote, `Hive /mcp: 403 session ${entry.id} belongs to another credential (caller member=${auth.member}, remote=${remote})`);
        request.resume();
        jsonRpcError(response, 403, -32000, 'Forbidden: MCP session belongs to another credential'); return;
      }
      entry.lastActive = Date.now();
      if (request.method !== 'DELETE') keepAlive(entry);
      if (request.method === 'GET') {
        entry.openStreams++;
        response.once('close', () => { entry.openStreams--; entry.lastActive = Date.now(); });
      }
      await entry.transport.handleRequest(request, response);
    } catch (error) {
      log(`Hive /mcp request failed (${request.method}, remote=${remote}): ${errorText(error)}`);
      jsonRpcError(response, 500, -32603, 'Internal server error');
    }
  }

  /** For the daemon's auth layer: one rate-limited line per refused /mcp request (401/403) with the reason. */
  function authFailed(request: IncomingMessage, status: number, reason: string): void {
    const remote = remoteOf(request);
    logLimited(`auth-${status}`, remote, `Hive /mcp: ${status} ${reason} (${request.method}, remote=${remote})`);
  }

  async function closeAll(): Promise<void> {
    clearInterval(sweep);
    for (const entry of sessions.values()) entry.closeReason ??= 'shutdown';
    await Promise.all([...sessions.values()].map(entry => entry.transport.close().catch(() => {})));
    sessions.clear();
  }

  return { handle, authFailed, closeAll, get size() { return sessions.size; } };
}
