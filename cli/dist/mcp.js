import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { connectedAt } from './context.js';
import { errorText, warn } from './util.js';
/**
 * stdio → Streamable HTTP bridge. The coding client starts `hive-connect mcp` (no token in its config); the bridge
 * reads the stored credential, connects to <hub>/mcp with Authorization: Bearer, mirrors tools/list and forwards
 * tools/call (results, including isError, unchanged). One upstream MCP session per bridge process, i.e. one Hive
 * session per client process. When the hub forgets the session (a redeploy answers 404), the bridge initializes a
 * new upstream session once and retries. stdout carries only MCP frames; all logging goes to stderr.
 */
export const VERSION = (() => {
    try {
        return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    }
    catch {
        return '0.0.0';
    }
})();
const log = (line) => warn(`hive-connect mcp: ${line}`);
function isSessionGone(error) {
    if (error instanceof StreamableHTTPError)
        return error.code === 404;
    return /\b404\b|Session not found/i.test(errorText(error));
}
export async function runMcp() {
    const ctx = connectedAt();
    const endpoint = new URL(`${ctx.hub.url}/mcp`);
    let upstream = null;
    let connecting = null;
    const open = async () => {
        const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${ctx.token}` } } });
        const client = new Client({ name: 'hive-connect-bridge', version: VERSION });
        client.onerror = error => log(`upstream: ${errorText(error)}`);
        await client.connect(transport);
        upstream = { client, transport };
        log(`connected to ${endpoint.href} (session ${transport.sessionId ?? 'none'})`);
        return client;
    };
    const get = () => {
        if (upstream)
            return Promise.resolve(upstream.client);
        connecting ??= open().finally(() => { connecting = null; });
        return connecting;
    };
    const reset = async () => {
        const old = upstream;
        upstream = null;
        if (old)
            await old.client.close().catch(() => { });
    };
    /** Runs `call` against the upstream; on a lost session (404) re-initializes once and retries. */
    const forward = async (what, call) => {
        try {
            return await call(await get());
        }
        catch (error) {
            if (error instanceof McpError && !isSessionGone(error))
                throw error;
            if (!isSessionGone(error)) {
                log(`${what} failed: ${errorText(error)}`);
                throw error;
            }
            log(`${what}: Hive no longer knows this session (hub restarted?); starting a new one`);
            await reset();
            return call(await get());
        }
    };
    const server = new Server({ name: 'hive', version: VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async (request) => forward('tools/list', client => client.listTools(request.params)));
    server.setRequestHandler(CallToolRequestSchema, async (request) => forward(`tools/call ${request.params.name}`, client => client.callTool(request.params)));
    // Connect upstream eagerly so the first tools/list is fast; failures are reported per request.
    get().catch(error => log(`cannot reach Hive yet: ${errorText(error)}`));
    const transport = new StdioServerTransport();
    let closing = false;
    const close = async () => {
        if (closing)
            return;
        closing = true;
        // Ends the upstream MCP session (DELETE /mcp), which finishes the Hive session.
        try {
            await upstream?.transport.terminateSession();
        }
        catch { /* best effort */ }
        await reset();
        process.exit(0);
    };
    transport.onclose = () => { void close(); };
    process.stdin.on('end', () => { void close(); });
    process.on('SIGTERM', () => { void close(); });
    process.on('SIGINT', () => { void close(); });
    await server.connect(transport);
    return new Promise(() => { });
}
