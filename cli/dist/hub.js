import { UserError, errorText } from './util.js';
/** HTTP error from the hub, with its status and message. */
export class HubError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = 'HubError';
    }
}
/** Validates and normalizes a hub URL (http/https, no trailing slash, no path beyond the base). */
export function normalizeHub(value) {
    let url;
    try {
        url = new URL(value.trim());
    }
    catch {
        throw new UserError(`"${value}" is not a URL; pass the Hive address, e.g. --hub https://hive.example.com`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
        throw new UserError(`The Hive address must start with https:// (got ${url.protocol})`);
    if (url.username || url.password)
        throw new UserError('The Hive address must not contain a user name or password');
    return `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\/(ui|mcp)$/, '')}`;
}
export class Hub {
    url;
    token;
    constructor(url, token) {
        this.url = url;
        this.token = token;
    }
    async request(method, path, body, timeoutMs = 15_000) {
        let response;
        try {
            response = await fetch(`${this.url}${path}`, {
                method,
                headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: AbortSignal.timeout(timeoutMs),
            });
        }
        catch (error) {
            const cause = error.cause?.code;
            throw new HubError(0, `cannot reach Hive at ${this.url} (${cause ?? errorText(error)})`);
        }
        const text = await response.text();
        let parsed = text;
        try {
            parsed = text ? JSON.parse(text) : null;
        }
        catch { /* plain text */ }
        if (!response.ok) {
            const message = parsed && typeof parsed === 'object' && 'error' in parsed ? String(parsed.error) : text.slice(0, 300);
            throw new HubError(response.status, `Hive answered HTTP ${response.status}: ${message}`);
        }
        return parsed;
    }
    me() { return this.request('GET', '/me'); }
    command(command, timeoutMs) {
        return this.request('POST', '/command', command, timeoutMs);
    }
    snapshot() { return this.request('GET', '/snapshot'); }
}
