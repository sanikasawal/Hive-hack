# Hive Connect: product flow, CLI and hub changes (spec, 2026-11-03)

Goal: a public user joins a hosted Hive workspace from their existing repository with ONE command,
never installs the Hive backend, never supplies a Meta key, and their agent appears on the hosted dashboard.
Builds on what exists at commit 1c7ff6b: member tokens with roles, `/me`, `/mcp` (Streamable HTTP), hooks,
laptop sync (`remote_push`, `remote_check`, `remote_status`), `/connect.mjs` and `/hook.mjs` served by the hub,
first-boot repository clone (`HIVE_REPO_URL`), Railway hosting (Node builder, volume at /data).

## 1. User flow
1. Admin signs in to the hosted dashboard with the operator token, invites a teammate: the Connect screen
   produces an invite link `<hub>/ui/join#token=<member token>` (member role; browser session only).
2. Teammate opens the link (signed in as member), sees one command:
   `npx hive-connect connect --hub <hub>` (hub pre-filled). They run it inside their existing repository.
3. The CLI detects the repository (git toplevel, normalized remote URL, root commit, name) and asks
   "Connect <name> (<remote>) to Hive at <hub>? [Y/n]".
4. Pairing: CLI calls `POST /command {action:'pair_start', repo, machine, client}` (unauthenticated, rate-limited),
   gets `{pairingId, userCode, pollSecret, verifyUrl, expiresAt}`; prints the code and opens
   `<hub>/ui/pair/<userCode>`. The signed-in teammate approves ("Connect <repo> on <machine> as <member>").
   Approval creates a **connector credential**: a member-role token with kind `connector`, label
   `<member> · <machine> · <repo name>`, bound to repo identity; it is revocable on Members.
5. CLI polls `pair_poll {pairingId, pollSecret}` until `approved` (token returned once), stores the token in the
   OS keychain (macOS `security`, Linux `secret-tool` when present, Windows `cmdkey`), else in
   `~/.config/hive/credentials.json` mode 0600 with a visible warning.
6. CLI detects supported clients (Claude Code: `claude` on PATH or `~/.claude`; Muse Code: `muse` on PATH or
   `~/.config/muse/settings.json`); if both or none, asks. Configuration is idempotent and preserves existing
   settings:
   - Claude Code: merge Hive hooks into `<repo>/.claude/settings.local.json` (commands call the CLI:
     `hive-connect hook <event> --client claude`; NO tokens or env secrets in files) and add the Hive MCP server
     to `<repo>/.mcp.json` as a stdio server `hive-connect mcp` (token-free; the bridge reads the keychain).
     Add `.claude/settings.local.json` to `.git/info/exclude`. Never run `claude mcp add` with the token.
   - Muse Code: merge `mcp_servers.hive = {transport:'stdio', command:'hive-connect', args:['mcp'], mode:'optional'}`
     into `~/.config/muse/settings.json` (backup first) and write `<repo>/.muse/hooks.json` entries (format marked
     best-guess; never overwrite other hooks).
   - Other MCP client: print the stdio command and the HTTP alternative with a placeholder header.
7. Local connector: `hive-connect node` runs in the background (detached, pidfile under `~/.config/hive/nodes/`):
   on start and every 30 s and on file changes (debounced), it sends `checkout_report` (repo identity, branch,
   HEAD, merge-base with the hub base when known, dirty files with sha256) and `remote_push` of changed .ts/.tsx
   contents (existing semantics). `--no-node` skips it; hooks still sync at prompt time.
8. Verify: `GET /me` with the credential, one `checkout_report`, then print exactly one next step:
   "Start or restart Claude Code in this folder. Your agent will appear at <hub>/ui."
9. `hive-connect status` (credential valid? node running? last report), `hive-connect connect` again = reconnect
   (reuses a valid credential, re-applies config without duplicates), `hive-connect disconnect` (stops node,
   revokes the credential via `connector_disconnect`, removes Hive entries from config files, deletes keychain
   entry; leaves everything else untouched).

## 2. Hub changes (backend)
- Migration: `tokens` gains `kind` ('member' | 'connector' | 'viewer-link'), `repo_identity`, `machine`,
  `last_seen_at`; new table `pairings(id, user_code, poll_secret_hash, repo_json, machine, client, status,
  token_id, created_at, expires_at, approved_by)`; new table `checkouts(token_id PK, member, repo_json, branch,
  head, base_commit, dirty_json, reported_at)`.
- Commands: `pair_start` (unauth; 10 min TTL; 8-char code from an unambiguous alphabet; max 5 pending per IP
  and 60/h total), `pair_poll` (unauth; needs pollSecret; returns the token exactly once then `consumed`),
  `pair_approve {userCode}` (member or admin; creates the connector token for the approver's member; admin may
  pass `member`), `pair_deny`, `checkout_report` (connector or member), `connector_disconnect` (revokes the
  caller's own connector token and clears its checkout row), `model_diagnose` (admin; see 3).
- Auth: connector tokens behave as members (own sessions only) and may call `remote_*`, `checkout_report`,
  `connector_disconnect`. Viewers unchanged.
- Snapshot/view: sessions carry `connector` {machine, repo name, branch, head short, dirtyCount, reportedAt};
  Members lists connectors per member with revoke; `/api/view` sanitized (no remote URLs with credentials, no
  absolute paths).

## 3. Model credential stays on the hub
- Remove `MODEL_API_KEY` from anything written to laptops (`src/hooks/connect.ts`, CLI). The laptop relay
  remains only as an explicit operator fallback (`hive-connect relay`, key from the environment at run time,
  never stored) and is labelled as relayed in the dashboard.
- `model_diagnose` (admin): from the hub, `GET {baseUrl}/models` and a one-token chat completion; returns
  status codes, response excerpts, request id headers, the hub's egress IP (via `https://api.ipify.org`, best
  effort) and a plain-language verdict: not configured / key rejected / no models offered to this host /
  reachable. Dashboard shows it under the model banner for admins.
- `HIVE_MODEL_PROXY_URL`: optional HTTP(S) CONNECT proxy for Meta API requests (implemented with node:https
  CONNECT tunnelling, no new dependency) so an operator can route the hub's model traffic through an egress
  the Meta API accepts. `HIVE_MODEL_BASE_URL` already allows a reverse proxy; document a minimal Cloudflare
  Worker pass-through in SELF_HOSTING.md as the other option. Analysis state when the provider cannot be
  reached: `unavailable` with the provider's status and the diagnose hint; never "no conflict".

## 4. CLI package
- Directory `cli/`, npm name `hive-connect` (available on 2026-11-03), bins `hive-connect` and `hive`.
  TypeScript compiled to `cli/dist` (committed so `npx github:Vishal2602/Hive-hack#master` works before
  publishing). Runtime: Node 18+, dependencies: `@modelcontextprotocol/sdk` (for the stdio→HTTP bridge) only.
- Commands: `connect`, `status`, `disconnect`, `node`, `mcp` (stdio bridge to `<hub>/mcp` with the keychain
  credential; forwards tools/list and tools/call; one Hive session per client process), `hook <event>`
  (same behaviour as src/hooks/hook.ts, credential from keychain), `relay` (operator fallback).
- Publishing (human step): `cd cli && npm login && npm publish --access public`. Until then the README shows
  the `npx github:` form.

## 5. Docs restructure
- README: public user first (invite link, one command, what they see), then links. Maintainer material
  (backend install, dashboard build, env vars, admin token, Railway, volume, repository clone) moves to
  `docs/SELF_HOSTING.md`. `docs/DEMO.md`: optional guided demo with the sample project (`scripts/seed-demo.ts`).
- `docs/CLIENTS.md`, `TEAMMATE_START_HERE.md`, `docs/PROGRESS.md` updated. No claims beyond what tests prove.

## 6. Tests
- Pairing lifecycle (start → approve → poll once → consumed; expiry; wrong secret; deny; rate limit).
- Connector token: acts as member on own sessions; `connector_disconnect` revokes and clears checkout.
- `checkout_report` validation and sanitized view; dashboard shows machine/branch/head/dirty count.
- CLI: repo identity normalization (ssh/https remotes), config merges idempotent for `.mcp.json`,
  `.claude/settings.local.json`, Muse settings (run twice → identical files), keychain fallback file 0600,
  `disconnect` removes exactly Hive's entries, stdio→HTTP bridge end to end against a spawned hub.
- `model_diagnose` against a fake provider (not configured / 401 / empty model list / ok); proxy tunnelling
  against a local CONNECT proxy stub.
- Acceptance (isolated, no network): one hub on a temp DB; two users with separate HOME dirs and separate
  clones of hive-playground; admin invites both (browser tokens); each runs the CLI `connect` programmatically
  with pairing approved through their browser token; both connectors report checkouts; two MCP clients through
  the stdio bridge register, set colliding intents; the finding reaches both via `hive_context` and the `prompt`
  hook output; the scripted "agent" changes its intent after reading it; the dashboard view lists both agents.
  A separate opt-in script `scripts/acceptance-live.ts` runs the same with two real `claude -p` sessions
  (spends the user's Claude usage; not part of `npm test`).

## 7. Out of scope now
Accounts with passwords or SSO, multi-workspace hubs, email invitations, Windows credential testing,
publishing to npm (human), proving the hosted model fix without access to the deployment.
