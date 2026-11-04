import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CLI, isolatedEnv, makeRepo, runCli, startFakeHub } from './helpers.mjs';

async function connected(hub) {
  const repo = makeRepo();
  const { env } = isolatedEnv();
  const run = await runCli(['connect', '--hub', hub.url, '--client', 'claude', '--yes', '--no-browser', '--no-node'], { cwd: repo, env });
  assert.equal(run.code, 0, run.stderr);
  const token = Object.values(JSON.parse(readFileSync(join(env.XDG_CONFIG_HOME, 'hive', 'credentials.json'), 'utf8')))[0];
  return { repo, env, token };
}

test('mcp bridge: stdio client → hive-connect mcp → hub /mcp; mirrors tools, forwards calls and isError, survives a lost session', async () => {
  const hub = await startFakeHub({ approveAfter: 1 });
  const { repo, env, token } = await connected(hub);
  let stderr = '';
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], cwd: repo, env, stderr: 'pipe' });
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(t => t.name).sort(), ['echo', 'fail']);
    const echo = tools.tools.find(t => t.name === 'echo');
    assert.equal(echo.description, 'Echoes the text back');
    assert.equal(echo.inputSchema.properties.text.type, 'string');

    const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    assert.deepEqual(result.content, [{ type: 'text', text: 'echo: hi' }]);
    assert.ok(!result.isError);
    const failed = await client.callTool({ name: 'fail', arguments: {} });
    assert.equal(failed.isError, true);
    assert.deepEqual(failed.content, [{ type: 'text', text: 'nope' }]);
    assert.ok(hub.calls.filter(c => c.path === '/mcp').every(c => c.token === token), 'bridge authenticates with the stored credential');

    // Hub redeploy: every MCP session forgotten → the bridge re-initializes once, transparently.
    const inits = hub.calls.filter(c => c.method === 'initialize').length;
    hub.dropSessions();
    const again = await client.callTool({ name: 'echo', arguments: { text: 'after restart' } });
    assert.deepEqual(again.content, [{ type: 'text', text: 'echo: after restart' }]);
    assert.equal(hub.calls.filter(c => c.method === 'initialize').length, inits + 1);
    assert.match(stderr, /starting a new one/);
  } finally {
    await client.close();
    await hub.close();
  }
});

test('mcp bridge writes nothing but MCP frames to stdout', async () => {
  const hub = await startFakeHub({ approveAfter: 1 });
  const { repo, env } = await connected(hub);
  try {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [CLI, 'mcp'], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', c => { out += c; });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } })}\n`);
    for (let i = 0; i < 50 && !out.includes('\n'); i++) await new Promise(r => setTimeout(r, 50));
    child.stdin.end();
    await new Promise(r => child.on('close', r));
    const lines = out.trim().split('\n');
    for (const line of lines) assert.equal(JSON.parse(line).jsonrpc, '2.0');
    assert.equal(JSON.parse(lines[0]).result.serverInfo.name, 'hive');
  } finally { await hub.close(); }
});

test('node --once sends checkout_report with dirty file hashes and pushes changed .ts files', async () => {
  const hub = await startFakeHub({ approveAfter: 1 });
  const { repo, env, token } = await connected(hub);
  try {
    const content = 'export const added = 2;\n';
    writeFileSync(join(repo, 'src', 'new.ts'), content);
    writeFileSync(join(repo, 'src', 'index.ts'), 'export const one = 11;\n');
    writeFileSync(join(repo, 'notes.md'), 'not synced\n');
    const before = hub.calls.length;
    const run = await runCli(['node', '--once'], { cwd: repo, env });
    assert.equal(run.code, 0, run.stderr);
    const calls = hub.calls.slice(before);
    const report = calls.find(c => c.action === 'checkout_report');
    assert.ok(report && report.token === token);
    assert.equal(report.body.branch, 'main');
    assert.match(report.body.head, /^[0-9a-f]{40}$/);
    assert.equal(report.body.baseCommit, null, 'no hub base known');
    assert.deepEqual(report.body.repo.identity, 'github.com/Acme/Widgets');
    const dirty = Object.fromEntries(report.body.dirty.map(d => [d.path, d]));
    assert.equal(dirty['src/new.ts'].sha256, createHash('sha256').update(content).digest('hex'));
    assert.equal(dirty['src/new.ts'].status, '??');
    assert.equal(dirty['src/index.ts'].status, 'M');
    assert.ok(dirty['notes.md'], 'every dirty file is reported');
    const push = calls.find(c => c.action === 'remote_push');
    assert.equal(push.body.replace, true);
    assert.deepEqual(push.body.files.map(f => f.path).sort(), ['src/index.ts', 'src/new.ts'], 'only .ts/.tsx contents are pushed');
    assert.equal(push.body.files.find(f => f.path === 'src/new.ts').content, content);
  } finally { await hub.close(); }
});

test('hook: Claude Code JSON contract with the stored credential; never blocks when not connected or hub down', async () => {
  const hub = await startFakeHub({ approveAfter: 1 });
  const { repo, env } = await connected(hub);
  try {
    const prompt = await runCli(['hook', 'prompt', '--client', 'claude'], { cwd: repo, env, input: JSON.stringify({ cwd: repo, prompt: 'hello' }) });
    assert.equal(prompt.code, 0, prompt.stderr);
    const out = JSON.parse(prompt.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(out.hookSpecificOutput.additionalContext, /Hive coordinator \(revision 7\)/);

    const pre = await runCli(['hook', 'pre-write', '--client', 'claude'], { cwd: repo, env,
      input: JSON.stringify({ cwd: repo, tool_name: 'Edit', tool_input: { file_path: join(repo, 'README.md'), old_string: 'a', new_string: 'b' } }) });
    assert.equal(pre.code, 0);
    assert.equal(JSON.parse(pre.stdout).hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.ok(hub.calls.some(c => c.action === 'hook_check' && c.body.file === 'README.md'), 'paths are sent repository-relative');

    const muse = await runCli(['hook', 'session-start', '--client', 'muse'], { cwd: repo, env, input: '{}' });
    assert.equal(muse.code, 0);
    assert.match(muse.stdout, /^Hive coordinator/);

    const { env: otherEnv } = isolatedEnv();
    const lonely = await runCli(['hook', 'prompt', '--client', 'claude'], { cwd: repo, env: otherEnv, input: '{}' });
    assert.equal(lonely.code, 0);
    assert.match(JSON.parse(lonely.stdout).hookSpecificOutput.additionalContext, /not connected/);

    await hub.close();
    const down = await runCli(['hook', 'pre-write', '--client', 'claude'], { cwd: repo, env, input: JSON.stringify({ cwd: repo, tool_name: 'Write', tool_input: { file_path: 'src/x.ts', content: 'x' } }) });
    assert.equal(down.code, 0, 'unreachable hub never blocks');
    const downOut = JSON.parse(down.stdout).hookSpecificOutput;
    assert.equal(downOut.permissionDecision, undefined);
    assert.match(downOut.additionalContext, /unreachable/);
  } finally { await hub.close().catch(() => {}); }
});
