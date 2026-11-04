// Shared test helpers: a tiny fake Hive hub (node:http + the MCP SDK), temp git repositories and an async CLI runner.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const CLI = fileURLToPath(new URL('../dist/main.js', import.meta.url));

async function readBody(request) {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  return body ? JSON.parse(body) : undefined;
}

/**
 * Fake hub. Pairing approves after `approveAfter` polls and mints one member token per pairing.
 * Every authenticated call is recorded in `calls` as { action | path, token, body }.
 */
export async function startFakeHub({ approveAfter = 2, member = 'alice' } = {}) {
  const tokens = new Map(); // token -> { id, revoked }
  const pairings = new Map();
  const calls = [];
  const sessions = new Map(); // MCP session id -> transport
  let url = '';

  const auth = request => {
    const match = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '');
    const record = match && tokens.get(match[1]);
    return record && !record.revoked ? { token: match[1], ...record } : null;
  };
  const json = (response, status, body) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

  const mcpServer = () => {
    const server = new McpServer({ name: 'fake-hive', version: '0.0.1' });
    server.tool('echo', 'Echoes the text back', { text: z.string() }, async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }));
    server.tool('fail', 'Always fails as a tool error', {}, async () => ({ content: [{ type: 'text', text: 'nope' }], isError: true }));
    return server;
  };

  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://x').pathname;
      if (path === '/mcp') {
        const who = auth(request);
        if (!who) return json(response, 401, { error: 'Unauthorized' });
        const sessionId = request.headers['mcp-session-id'];
        if (request.method === 'POST') {
          const body = await readBody(request);
          if (sessionId) {
            const transport = sessions.get(sessionId);
            if (!transport) return json(response, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
            calls.push({ path: '/mcp', method: body?.method, token: who.token });
            return transport.handleRequest(request, response, body);
          }
          if (!isInitializeRequest(body)) return json(response, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'missing initialization' }, id: null });
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: id => { sessions.set(id, transport); } });
          await mcpServer().connect(transport);
          calls.push({ path: '/mcp', method: 'initialize', token: who.token });
          return transport.handleRequest(request, response, body);
        }
        const transport = sessionId && sessions.get(sessionId);
        if (!transport) return json(response, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
        if (request.method === 'DELETE') { calls.push({ path: '/mcp', method: 'DELETE', token: who.token }); sessions.delete(sessionId); }
        return transport.handleRequest(request, response);
      }
      if (request.method === 'GET' && path === '/me') {
        const who = auth(request);
        if (!who) return json(response, 401, { error: 'Unauthorized' });
        calls.push({ path: '/me', token: who.token });
        return json(response, 200, { role: 'member', member, tokenId: who.id, kind: 'connector', workspace: { name: 'fake-workspace' }, publicUrl: null, hubUrl: url,
          connect: { cliCommand: `npx hive-connect connect --hub ${url}` } });
      }
      if (request.method === 'GET' && path === '/snapshot') {
        if (!auth(request)) return json(response, 401, { error: 'Unauthorized' });
        return json(response, 200, { sessions: [], findings: [], contracts: [], repository: { revision: 7 }, analysis: null });
      }
      if (request.method === 'POST' && path === '/command') {
        const body = await readBody(request);
        if (body.action === 'pair_start') {
          const id = randomUUID();
          const userCode = 'ABCDEFGH';
          const pollSecret = randomBytes(16).toString('hex');
          pairings.set(id, { polls: 0, pollSecret, status: 'pending', body });
          calls.push({ action: 'pair_start', body });
          return json(response, 200, { pairingId: id, userCode, pollSecret, verifyUrl: `${url}/ui/pair/${userCode}`, expiresAt: Date.now() + 600_000, interval: 1 });
        }
        if (body.action === 'pair_poll') {
          const pairing = pairings.get(body.pairingId);
          if (!pairing || pairing.pollSecret !== body.pollSecret) return json(response, 400, { error: 'Unknown pairing or wrong poll secret' });
          calls.push({ action: 'pair_poll' });
          if (pairing.status === 'consumed') return json(response, 200, { status: 'consumed' });
          if (++pairing.polls < approveAfter) return json(response, 200, { status: 'pending', expiresAt: Date.now() + 600_000, interval: 1 });
          const token = `hive_mem_${randomBytes(16).toString('hex')}`;
          const tokenId = randomUUID();
          tokens.set(token, { id: tokenId, revoked: false });
          pairing.status = 'consumed';
          return json(response, 200, { status: 'approved', token, tokenId, member, label: `${member} · m · r`, repo: pairing.body.repo });
        }
        const who = auth(request);
        if (!who) return json(response, 401, { error: 'Unauthorized' });
        calls.push({ action: body.action, token: who.token, body });
        switch (body.action) {
          case 'checkout_report': return json(response, 200, { tokenId: who.id, member, ...body, reportedAt: Date.now() });
          case 'remote_status': return json(response, 200, { baseCommit: null, members: [], member });
          case 'remote_push': return json(response, 200, { stored: body.files.map(f => f.path), cleared: [], rejected: [], baseCommit: null, warnings: [] });
          case 'sync': return json(response, 200, { changed: [], added: [], removed: [] });
          case 'hook_check': return json(response, 200, { file: body.file, pendingContracts: [], declaredBy: [], dependentSessions: [] });
          case 'connector_disconnect': tokens.get(who.token).revoked = true; return json(response, 200, { disconnected: true, tokenId: who.id });
          default: return json(response, 400, { error: `fake hub: unsupported ${body.action}` });
        }
      }
      json(response, 404, { error: 'Not found' });
    } catch (error) {
      if (!response.headersSent) json(response, 500, { error: String(error) });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, calls, tokens,
    /** Forgets every MCP session, as a redeployed hub would. */
    dropSessions: () => sessions.clear(),
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

export function tempDir(prefix) { return realpathSync(mkdtempSync(join(tmpdir(), prefix))); }

const gitEnv = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' };
export function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...gitEnv } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A temp git repository with one commit and an origin remote. */
export function makeRepo(remote = 'git@github.com:Acme/Widgets.git') {
  const root = tempDir('hive-cli-repo-');
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'index.ts'), 'export const one = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  if (remote) git(root, 'remote', 'add', 'origin', remote);
  return root;
}

/** Isolated environment: temp HOME and XDG_CONFIG_HOME, file credential store, fast polling, no inherited Hive vars. */
export function isolatedEnv(extra = {}) {
  const home = tempDir('hive-cli-home-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), HIVE_CONNECT_NO_KEYCHAIN: '1', HIVE_CONNECT_POLL_MS: '30', ...extra };
  for (const name of ['HIVE_URL', 'HIVE_TOKEN', 'HIVE_CONNECT_COMMAND', 'MUSE_SESSION_ID', 'MODEL_API_KEY']) if (!(name in extra)) delete env[name];
  return { home, config: join(home, '.config', 'hive'), env };
}

/** Runs the CLI asynchronously (the fake hub lives in this process, so spawnSync would deadlock). */
export function runCli(args, { cwd, env, input = '', onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; onStdout?.(stdout, child); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
