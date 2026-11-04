import { UserError, errorText } from './util.js';

/** HTTP error from the hub, with its status and message. */
export class HubError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'HubError'; }
}

export interface Me {
  role: 'admin' | 'member' | 'viewer';
  member: string;
  tokenId: string | null;
  kind?: string;
  connector?: { repoIdentity: string | null; machine: string | null };
  workspace: { id?: string; name: string };
  publicUrl?: string | null;
  hubUrl?: string;
  connect?: { cliCommand?: string };
}

/** Validates and normalizes a hub URL (http/https, no trailing slash, no path beyond the base). */
export function normalizeHub(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new UserError(`"${value}" is not a URL; pass the Hive address, e.g. --hub https://hive.example.com`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UserError(`The Hive address must start with https:// (got ${url.protocol})`);
  if (url.username || url.password) throw new UserError('The Hive address must not contain a user name or password');
  return `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\/(ui|mcp)$/, '')}`;
}

export class Hub {
  constructor(readonly url: string, private readonly token: string | null) {}

  private async request(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 15_000): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.url}${path}`, {
        method,
        headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause?.code;
      throw new HubError(0, `cannot reach Hive at ${this.url} (${cause ?? errorText(error)})`);
    }
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* plain text */ }
    if (!response.ok) {
      const message = parsed && typeof parsed === 'object' && 'error' in parsed ? String((parsed as { error: unknown }).error) : text.slice(0, 300);
      throw new HubError(response.status, `Hive answered HTTP ${response.status}: ${message}`);
    }
    return parsed;
  }

  me(): Promise<Me> { return this.request('GET', '/me') as Promise<Me>; }
  command<T = Record<string, unknown>>(command: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    return this.request('POST', '/command', command, timeoutMs) as Promise<T>;
  }
  snapshot<T = unknown>(): Promise<T> { return this.request('GET', '/snapshot') as Promise<T>; }
}
