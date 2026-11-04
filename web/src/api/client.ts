// Typed client for the Hive daemon. Same-origin by default; the Bearer token lives in
// sessionStorage under "hive.token" (never localStorage, never in the bundle).
// No runtime imports: this file also runs under Node (strip-only) in the backend tests.
import type {
  Command, ConnectorDisconnected, CreatedToken, EventItem, Health, Me, MemberSummary, ModelDiagnosis, PairingApproved, PairingInfo, Role, SnapshotResponse,
  TokenRecord, VerificationRun, ViewResponse,
} from './types.ts';

export const TOKEN_STORAGE_KEY = 'hive.token';
export const DEFAULT_TIMEOUT_MS = 8_000;
/** The daemon caps /events pages at 1000. */
export const EVENTS_PAGE_LIMIT = 1000;

export type ApiErrorKind = 'http' | 'network' | 'timeout';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  /** HTTP status; 0 for network failures and timeouts. */
  readonly status: number;
  constructor(kind: ApiErrorKind, status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
  /** Server unreachable, timed out, or answering 5xx (e.g. 503 while draining). */
  get unreachable(): boolean { return this.kind !== 'http' || this.status >= 500; }
}

export interface TokenStore { get(): string | null; set(value: string | null): void }

/** sessionStorage-backed token store; falls back to memory when storage is unavailable. */
export function sessionTokenStore(key: string = TOKEN_STORAGE_KEY): TokenStore {
  let memory: string | null = null;
  const storage = (): Storage | null => {
    try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
  };
  return {
    get() {
      try { return storage()?.getItem(key) ?? memory; } catch { return memory; }
    },
    set(value) {
      memory = value;
      try {
        const s = storage();
        if (!s) return;
        if (value === null) s.removeItem(key); else s.setItem(key, value);
      } catch { /* memory only */ }
    },
  };
}

export function memoryTokenStore(initial: string | null = null): TokenStore {
  let value = initial;
  return { get: () => value, set: next => { value = next; } };
}

export interface ClientOptions {
  /** Origin of the daemon, '' for same-origin (the default). */
  baseUrl?: string;
  tokens?: TokenStore;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Called once when the stored token is refused with 401 (revoked or wrong). The token is cleared first. */
  onUnauthorized?: () => void;
}

export interface RequestOptions {
  /** Use this token instead of the stored one (sign-in checks). A 401 then does not sign out. */
  token?: string;
  timeoutMs?: number;
  body?: unknown;
}

export class HiveClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  private readonly tokens: TokenStore;
  private readonly fetchImpl: typeof fetch;
  private unauthorizedListeners: Array<() => void> = [];

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.tokens = options.tokens ?? sessionTokenStore();
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    if (options.onUnauthorized) this.unauthorizedListeners.push(options.onUnauthorized);
  }

  get token(): string | null { return this.tokens.get(); }
  setToken(token: string | null): void { this.tokens.set(token === null ? null : token.trim()); }
  signOut(): void { this.tokens.set(null); }

  /** Subscribe to 401s on the stored token. Returns an unsubscribe function. */
  onUnauthorized(listener: () => void): () => void {
    this.unauthorizedListeners.push(listener);
    return () => { this.unauthorizedListeners = this.unauthorizedListeners.filter(l => l !== listener); };
  }

  async request<T>(method: 'GET' | 'POST', path: string, options: RequestOptions = {}): Promise<T> {
    const explicit = options.token !== undefined;
    const token = explicit ? options.token!.trim() : this.tokens.get();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method, headers, signal: controller.signal, cache: 'no-store',
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (error) {
      clearTimeout(timer);
      if (timedOut) throw new ApiError('timeout', 0, `Hive did not answer within ${Math.round((options.timeoutMs ?? this.timeoutMs) / 1000)} s`);
      throw new ApiError('network', 0, error instanceof Error && error.message ? `Cannot reach Hive (${error.message})` : 'Cannot reach Hive');
    }
    let text: string;
    try { text = await response.text(); } catch {
      clearTimeout(timer);
      throw new ApiError(timedOut ? 'timeout' : 'network', 0, timedOut ? 'Hive response timed out' : 'Hive response was interrupted');
    }
    clearTimeout(timer);
    let data: unknown = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    if (!response.ok) {
      const message = data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error : `HTTP ${response.status}`;
      if (response.status === 401 && !explicit && token) {
        this.tokens.set(null);
        for (const listener of [...this.unauthorizedListeners]) {
          try { listener(); } catch { /* listeners must not break the request path */ }
        }
      }
      throw new ApiError('http', response.status, message);
    }
    return data as T;
  }

  // ---- reads -------------------------------------------------------------------------------------
  health(): Promise<Health> { return this.request('GET', '/healthz'); }
  me(options: { token?: string } = {}): Promise<Me> { return this.request('GET', '/me', options); }
  /** Viewer-safe projection; any role. */
  view(options: { fresh?: boolean } = {}): Promise<ViewResponse> { return this.request('GET', `/api/view${options.fresh ? '?fresh=1' : ''}`); }
  /** Full cached snapshot; member/admin only (403 for viewers). */
  snapshot(options: { fresh?: boolean } = {}): Promise<SnapshotResponse> { return this.request('GET', `/snapshot${options.fresh ? '?fresh=1' : ''}`); }
  /** One page: ascending seq > after, at most `limit`. */
  events(after = 0, limit = EVENTS_PAGE_LIMIT): Promise<EventItem[]> {
    return this.request('GET', `/events?after=${Math.max(0, Math.floor(after))}&limit=${Math.min(Math.max(1, Math.floor(limit)), EVENTS_PAGE_LIMIT)}`);
  }
  /** Every event after `after`, paging until a short page (at most `maxPages` pages). */
  async eventsSince(after = 0, options: { limit?: number; maxPages?: number } = {}): Promise<EventItem[]> {
    const limit = options.limit ?? EVENTS_PAGE_LIMIT;
    const out: EventItem[] = [];
    let cursor = after;
    for (let page = 0; page < (options.maxPages ?? 10); page++) {
      const batch = await this.events(cursor, limit);
      out.push(...batch);
      if (batch.length < limit) break;
      cursor = batch[batch.length - 1]!.seq;
    }
    return out;
  }

  // ---- commands ----------------------------------------------------------------------------------
  command<T = unknown>(command: Command, options: { timeoutMs?: number } = {}): Promise<T> {
    return this.request<T>('POST', '/command', { body: command, timeoutMs: options.timeoutMs });
  }
  memberList(): Promise<MemberSummary[]> { return this.command({ action: 'member_list' }); }
  /** Admin only. The returned `token` value is shown once and never retrievable again. */
  tokenCreate(input: { label: string; member: string; role: Role; kind?: 'member' | 'connector' | 'viewer-link' }): Promise<CreatedToken> { return this.command({ action: 'token_create', ...input }); }
  tokenList(): Promise<TokenRecord[]> { return this.command({ action: 'token_list' }); }
  tokenRename(tokenId: string, label: string): Promise<TokenRecord> { return this.command({ action: 'token_rename', tokenId, label }); }
  tokenRevoke(tokenId: string): Promise<TokenRecord> { return this.command({ action: 'token_revoke', tokenId }); }
  /** Hive Connect approval page: what a pairing code asks for (members and admins; not viewers or connectors). */
  pairInfo(userCode: string): Promise<PairingInfo> { return this.command({ action: 'pair_info', userCode }); }
  /** Approves a pending pairing for the signed-in member. The CLI then receives the connector credential once. */
  pairApprove(userCode: string): Promise<PairingApproved> { return this.command({ action: 'pair_approve', userCode }); }
  pairDeny(userCode: string): Promise<PairingInfo> { return this.command({ action: 'pair_deny', userCode }); }
  /** Revokes a connector credential and clears its checkout report (own connectors; admins any). */
  connectorDisconnect(tokenId: string): Promise<ConnectorDisconnected> { return this.command({ action: 'connector_disconnect', tokenId }); }
  /** Admin: probes the model provider from the hub. Takes up to ~20 s (two requests plus an egress lookup). */
  modelDiagnose(): Promise<ModelDiagnosis> { return this.command({ action: 'model_diagnose' }, { timeoutMs: 45_000 }); }
  register(name: string, client?: string): Promise<{ id: string; name: string; expiresAt: number }> {
    return this.command({ action: 'register', name, ...(client ? { client } : {}) });
  }
  heartbeat(sessionId: string): Promise<unknown> { return this.command({ action: 'heartbeat', sessionId }); }
  finish(sessionId: string): Promise<{ finished: boolean }> { return this.command({ action: 'finish', sessionId }); }
  acknowledge(sessionId: string, contractId: string, version: number): Promise<unknown> { return this.command({ action: 'acknowledge', sessionId, contractId, version }); }
  verifyStatus(runId: string, sessionId?: string): Promise<VerificationRun> {
    return this.command({ action: 'verify_status', runId, ...(sessionId ? { sessionId } : {}) });
  }
}
