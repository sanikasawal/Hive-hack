# Client integration: what Hive sees, gates, and only observes

Hive is one hub (daemon) plus thin per-client adapters. Coverage differs by client and by
path. This page states it precisely; nothing here claims universal pre-write enforcement.

## Setup with `hive-connect` (the supported path for teammates)

`hive-connect connect --hub <hub>` (spec: `docs/superpowers/specs/2026-11-03-connect-cli-design.md`, sections
1 and 4) pairs the laptop through the browser, keeps the connector credential in the OS keychain, and writes
**token-free** client configuration. Every entry below calls the CLI, which reads the credential at run time.

| Client | What `connect` writes | Hooks | MCP |
|---|---|---|---|
| Claude Code (`claude` on PATH or `~/.claude`) | `<repo>/.claude/settings.local.json` (added to `.git/info/exclude`), `<repo>/.mcp.json` | `hive-connect hook <event> --client claude` for SessionStart, UserPromptSubmit, PreToolUse and PostToolUse | stdio server `hive-connect mcp` |
| Muse Code (`muse` on PATH or `~/.config/muse/settings.json`) | `mcp_servers.hive = {transport:'stdio', command:'hive-connect', args:['mcp'], mode:'optional'}` in `~/.config/muse/settings.json` (backed up first), entries in `<repo>/.muse/hooks.json` | same events, `--client muse`; format is a best guess (below) | stdio server `hive-connect mcp` |
| Other MCP clients | nothing; prints the stdio command, and the HTTP alternative with a placeholder header | none | stdio or HTTP |

Rules the CLI follows: merges are idempotent (running `connect` twice leaves identical files), other settings
and other hooks are preserved, no token or secret is written to any file or environment block, and it never runs
`claude mcp add` with a token. `hive-connect disconnect` removes exactly Hive's entries, stops the background
node, revokes the credential on the hub (`connector_disconnect`) and deletes the keychain entry.

**stdio bridge (`hive-connect mcp`).** One process per client session. It opens a Streamable HTTP MCP session to
`<hub>/mcp` with the keychain credential and forwards `tools/list` and `tools/call`; one bridge process is one
Hive session. The hub binds an MCP session to the token that created it, answers 400 to a request without an
initialize and 404 to an unknown session id (tested in `tests/mcp-http.test.ts`).

**Hooks via the CLI (`hive-connect hook <event>`).** Same behaviour as `src/hooks/hook.ts` (tables below), but the
credential comes from the keychain instead of `HIVE_TOKEN` in a settings file.

**Background node (`hive-connect node`).** Detached, pidfile under `~/.config/hive/nodes/`; on start, every 30 s and
on (debounced) file changes it sends `checkout_report` (repo identity, branch, HEAD, dirty files with sha256) and
`remote_push` of changed `.ts`/`.tsx` files. `--no-node` skips it; hooks still sync at prompt time.

### Installing hive-connect before it is published

`hive-connect` is not on npm yet (publishing is a human step: `cd cli && npm login && npm publish --access
public`). Until then, from a clone of this repository, once the `cli/` package exists:

```bash
git clone https://github.com/Vishal2602/Hive-hack.git && cd Hive-hack/cli
npm install            # installs the CLI's own dependency (the MCP SDK)
npm install -g .       # puts hive-connect (and hive) on PATH, linked to this folder
```

Verified on 2026-11-03 with npm 10.9.8 using a probe package of the same shape: `npm install -g <folder>` alone
links the bin **without** installing the folder's dependencies, so the bin fails at import; running `npm install`
in the folder first, or installing a tarball (`npm pack` then `npm install -g ./hive-connect-<version>.tgz`),
works. `npx github:Vishal2602/Hive-hack#master` only provides `hive-connect` if the **root** `package.json`
declares that bin (npm cannot install a subfolder of a git repository); at the time of writing the root package
has no `bin`, so that form is not available.

### Older setup: `/connect.mjs`

Hubs still serve `/connect.mjs` and `/hook.mjs` (the previous one-line setup). That path writes `HIVE_URL` and
`HIVE_TOKEN` into `.claude/settings.local.json` and runs `claude mcp add` with the token; it never writes
`MODEL_API_KEY`. Prefer `hive-connect`, which keeps the token out of files.

## Paths into Hive

| Path | Mechanism | Status on the build machine (2026-11-02) |
|---|---|---|
| MCP tools (`hive_*`) | stdio adapter `src/server/mcp.ts`, one session per connection | Verified: transport test drives two independent stdio clients against one daemon |
| MCP tools over HTTP | Streamable HTTP at `/mcp` on the daemon (`src/server/mcpHttp.ts`), member/admin Bearer token | Verified in `tests/mcp-http.test.ts` against a real daemon; not yet used by a real Claude Code or Muse Code session |
| Client hooks | `src/hooks/hook.ts <event>` reads the client's JSON on stdin, calls the daemon over HTTP | Verified end-to-end against a real daemon with Claude Code's hook JSON shape (`tests/hooks.test.ts`); Muse Code shape unverified (not installed) |
| Direct file edits by anyone | Hash drift detected on the next read/operation; reindex; `direct_edit` event + finding | Verified in tests; detection is after the fact, never a block |

## MCP tools (both clients)

`hive_register`, `hive_set_intent`, `hive_context`, `hive_symbol`, `hive_reindex`,
`hive_preview_operation`, `hive_apply_operation`, `hive_propose_contract`, `hive_acknowledge`,
`hive_revise_contract`, `hive_reject_contract`, `hive_contract_check`, `hive_verify`,
`hive_claim`, `hive_analyze`, `hive_finish`.

Polling with `hive_context` before dependent work is the supported baseline for every client.
Push into the agent's context exists only where a hook delivers it (below).

## Claude Code (installed here, v2.1.309)

Config templates: `config/claude-code.mcp.example.json` (MCP server) and
`config/claude-code.settings.example.json` (hooks). Replace `/ABSOLUTE/PATH/Hive`.

| Event | What the hook does | Gate? |
|---|---|---|
| `SessionStart`, `UserPromptSubmit` | `sync` (drift check) then injects a compact summary of findings, contracts and model status as `additionalContext` | No |
| `PreToolUse` on `Edit|Write|MultiEdit|NotebookEdit` | `hook_check` on `tool_input.file_path`: if the file is the producer file of a *proposed, not yet accepted* Ghost Contract → `permissionDecision: ask` (default; `HIVE_HOOK_GATE=deny` exits 2 and denies, `warn` only adds context). Adds context when the file is in another session's declared scope or its symbols are used by another session's files | Yes, for these four tools only |
| `PostToolUse` on the same tools | `sync` → reindex → reports the direct edit, new revision and any claim violations as context | No |

Not intercepted: `Bash` edits (`sed`, `git apply`, scripts), edits from other programs, edits in
worktrees the daemon does not know. These are detected afterwards by hash drift.

Hook output format used: stdout JSON `{"hookSpecificOutput": {"hookEventName", "additionalContext",
"permissionDecision", "permissionDecisionReason"}}`; exit code 2 + stderr to deny. This is the
Claude Code 2.x hook contract as understood at build time; `tests/hooks.test.ts` verifies our side
of it, not Claude Code itself.

## Muse Code (first demo client; NOT installed on the build machine)

Verified vs assumed, in one place:
- **Documented (Meta docs, fetched 2026-11-01):** settings path, `schema_version`, `mcp_servers` fields
  (`transport`, `command`, `args`, `env`, `mode`), `MUSE_SESSION_ID`, project hooks file location, event names.
- **Tested on our side:** the adapter's Muse output mode and payload capture (`tests/hooks.test.ts`).
- **Assumed, not verified live:** the hook stdin JSON, the stdout/exit-code contract, whether `PreToolUse` can
  block, the exact `hooks.json` entry format, and that Muse Code loads `hive-connect mcp` as written.

Documented facts (dev.meta.ai/docs/muse-code/extending and /configuration, fetched 2026-11-01):
user settings at `~/.config/muse/settings.json` with `"schema_version": 1`; MCP servers under
`mcp_servers` with `transport: "stdio"`, `command`, `args`, `env`, `mode`; `MUSE_SESSION_ID`
is passed to stdio servers; project hooks in `<project>/.muse/hooks.json` (only after the
folder is trusted); events `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`PostToolBatch`, `PreLLMCall`, `PostLLMCall`, `SessionEnd` (observational), …

Not documented on those pages, therefore unverified: the hook stdin JSON, the stdout/exit-code
contract, whether `PreToolUse` can block, and the exact `hooks` entry format.
`config/muse-code.settings.example.json` is a best-guess template and says so.

What the adapter does for Muse until that is verified: `--client muse` prints plain text on
stdout (context or reason) and exits 2 when it wants to block; every raw stdin payload is
appended to `<project>/.hive/hook-log.jsonl` so the real schema can be captured from one live
session and the adapter adjusted. Session messaging (`/docs/muse-code/session-messaging`) is
agent-to-agent plain text (≤ 8192 bytes) requested in natural language; it is not an API a hook
can call, so Hive does not use it.

## HTTP transport (added 2026-11-02/03)

Connect a client to a running daemon without a local adapter (placeholders; use a **member** token,
one per person or laptop; viewers are refused with 403):

```bash
claude mcp add --transport http hive https://<your-hive-host>/mcp --header "Authorization: Bearer <member-token>"
```

Same 16 `hive_*` tools as stdio. One MCP session is one Hive session: `hive_register` binds them,
every request on that MCP session heartbeats the Hive session, an open GET stream keeps it alive,
and DELETE `/mcp` finishes it. An MCP session can only be used with the token that created it, and
a member can only drive sessions registered with its own token. The dashboard's Connect page
produces this snippet with the host from `HIVE_PUBLIC_URL` (or the page origin). Use HTTPS for
anything but loopback; the daemon itself does not terminate TLS.

**Remote-agent caveat.** The daemon type-checks, edits (`hive_apply_operation`) and verifies
(`hive_verify`) only its own checkout at `HIVE_PROJECT_ROOT` on its own disk. An agent on another
laptop connected over HTTP MCP exchanges intents, findings and agreements, but Hive does not see
that laptop's files, and its hooks still run locally (they need `HIVE_URL` and a token). For a
hosted demo, run the agents in the same environment as the daemon against that checkout, with
distinct files to edit. Separate machines with independent checkouts need the worker architecture
in `docs/HIVE_CLOUD_PLAN.md`, which is not built.

## Fallback when hooks are unavailable

Explicit polling: agents call `hive_context` (and `hive_contract_check` when they participate
in a contract) before dependent work. The dashboard (`/ui`) shows the same state to the human.

## Session identity and expiry

Each stdio adapter owns one session and heartbeats every 30 s; the daemon lease is 120 s. A
client that exits without `hive_finish` is expired by lease; pending contracts it participated
in become stale, verified history is kept. Hooks are stateless and authenticate with a token
only (`HIVE_TOKEN` or a member token); they never impersonate a session.
