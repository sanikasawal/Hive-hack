import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepoIdentity } from '../dist/repo.js';
import { isHiveHookCommand, mergeClaudeSettings, mergeMcpJson, mergeMuseHooks, mergeMuseSettings, unmergeClaudeSettings, unmergeMcpJson, unmergeMuseHooks, unmergeMuseSettings } from '../dist/clients.js';

test('repo identity normalization: ssh, https, credentials, ports, case, garbage', () => {
  const table = [
    ['git@github.com:a/b.git', 'github.com/a/b'],
    ['https://github.com/a/b.git', 'github.com/a/b'],
    ['https://github.com/a/b', 'github.com/a/b'],
    ['https://x:tok@GitHub.com/Acme/App.git/', 'github.com/Acme/App'],
    ['ssh://git@github.com:22/a/b.git', 'github.com/a/b'],
    ['git@gitlab.example.com:group/sub/proj.git', 'gitlab.example.com/group/sub/proj'],
    ['http://localhost:3000/a/b.git', 'localhost/a/b'],
    ['github.com/a/b', 'github.com/a/b'],
    ['/home/me/repos/b', null],
    ['file:///home/me/repos/b.git', null],
    ['C:\\repos\\b', null],
    ['../b', null],
    ['', null],
    [null, null],
    ['https://github.com/a/../b', null],
  ];
  for (const [input, expected] of table) assert.equal(normalizeRepoIdentity(input), expected, String(input));
});

const L = { command: '/opt/hive cli/main.js', args: [] };

test('Claude settings merge: idempotent, keeps user hooks and settings, strips legacy secrets, unmerge removes only Hive', () => {
  const existing = {
    permissions: { allow: ['Bash(ls)'] },
    env: { HIVE_URL: 'http://old', HIVE_TOKEN: 'secret', MODEL_API_KEY: 'k', KEEP: '1' },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] },
      { matcher: 'Edit', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.hive/hive-hook.mjs" pre-write --client claude' }] }] },
    enabledMcpjsonServers: ['other'],
  };
  const once = mergeClaudeSettings(existing, L);
  const twice = mergeClaudeSettings(once, L);
  assert.deepEqual(twice, once);
  assert.equal(JSON.stringify(twice), JSON.stringify(once), 'byte-identical key order');
  assert.deepEqual(once.env, { KEEP: '1' }, 'legacy HIVE_TOKEN / MODEL_API_KEY / HIVE_URL removed, the rest kept');
  assert.deepEqual(once.permissions, existing.permissions);
  assert.deepEqual(once.enabledMcpjsonServers, ['other', 'hive']);
  assert.equal(once.hooks.PreToolUse.length, 2, 'user hook kept, legacy Hive hook replaced');
  assert.equal(once.hooks.PreToolUse[0].hooks[0].command, 'echo mine');
  assert.equal(once.hooks.PreToolUse[1].hooks[0].command, "'/opt/hive cli/main.js' hook pre-write --client claude");
  assert.deepEqual(Object.keys(once.hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionStart', 'UserPromptSubmit']);
  for (const entries of Object.values(once.hooks)) for (const e of entries) for (const h of e.hooks) assert.ok(!/hive_|secret|Bearer/.test(h.command), 'no secrets in hook commands');

  const removed = unmergeClaudeSettings(once);
  assert.deepEqual(removed, { permissions: existing.permissions, env: { KEEP: '1' }, hooks: { PreToolUse: [existing.hooks.PreToolUse[0]] }, enabledMcpjsonServers: ['other'] });
});

test('.mcp.json and Muse merges are idempotent and reversible', () => {
  const mcp = { mcpServers: { other: { command: 'x' } } };
  const merged = mergeMcpJson(mcp, L);
  assert.deepEqual(mergeMcpJson(merged, L), merged);
  assert.deepEqual(merged.mcpServers.hive, { command: '/opt/hive cli/main.js', args: ['mcp'] });
  assert.deepEqual(mergeMcpJson({}, { command: 'npx', args: ['-y', 'hive-connect'] }).mcpServers.hive, { command: 'npx', args: ['-y', 'hive-connect', 'mcp'] });
  assert.deepEqual(unmergeMcpJson(merged), mcp);
  assert.deepEqual(unmergeMcpJson(mergeMcpJson({}, L)), {});

  const muse = { theme: 'dark', mcp_servers: { mine: { transport: 'stdio', command: 'y' } } };
  const museMerged = mergeMuseSettings(muse, L);
  assert.deepEqual(mergeMuseSettings(museMerged, L), museMerged);
  assert.deepEqual(museMerged.mcp_servers.hive, { transport: 'stdio', command: '/opt/hive cli/main.js', args: ['mcp'], mode: 'optional' });
  assert.deepEqual(unmergeMuseSettings(museMerged), muse);

  const hooks = { hooks: { PreToolUse: [{ command: 'my-linter' }] } };
  const hooksMerged = mergeMuseHooks(hooks, L);
  assert.equal(JSON.stringify(mergeMuseHooks(hooksMerged, L)), JSON.stringify(hooksMerged));
  assert.match(hooksMerged._comment, /best guess/);
  assert.equal(hooksMerged.hooks.PreToolUse[0].command, 'my-linter');
  assert.deepEqual(unmergeMuseHooks(hooksMerged), { _comment: hooksMerged._comment, hooks: { PreToolUse: [{ command: 'my-linter' }] } });
  assert.deepEqual(unmergeMuseHooks(mergeMuseHooks({}, L)), {});
});

test('Hive hook commands are recognised; user commands are not', () => {
  assert.ok(isHiveHookCommand('/usr/local/bin/hive-connect hook prompt --client claude'));
  assert.ok(isHiveHookCommand('npx -y hive-connect hook post-write --client muse'));
  assert.ok(isHiveHookCommand('node "$CLAUDE_PROJECT_DIR/.hive/hive-hook.mjs" prompt --client claude'));
  assert.ok(!isHiveHookCommand('echo hook'));
  assert.ok(!isHiveHookCommand('my-tool hook deploy'));
  assert.ok(!isHiveHookCommand(undefined));
});
