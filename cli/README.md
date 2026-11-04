# hive-connect

Connects the repository you are in, and your coding agent, to a hosted Hive workspace. One command:

```sh
npx hive-connect connect --hub https://<your hive>
```

Before the package is published to npm, run it from GitHub instead:

```sh
npx -y github:Vishal2602/Hive-hack connect --hub https://<your hive>
```

What `connect` does:

1. Detects the git repository (top level, `origin` normalized to `host/owner/repo`, first commit) and asks
   `Connect <name> (<remote>) to Hive at <hub>? [Y/n]` (`--yes` skips the question).
2. Starts a short-lived pairing: prints `Code: XXXX-XXXX` and opens `<hub>/ui/pair/<code>`
   (`--no-browser` only prints it). You approve in the browser while signed in to Hive.
3. Receives a connector credential (member role, bound to this repository, revocable on the Members page) and
   stores it in the OS keychain: macOS Keychain (`security`), Linux Secret Service (`secret-tool`), Windows
   Credential Locker (PowerShell; untested). Without one it falls back to `~/.config/hive/credentials.json`
   (mode 0600) and says so.
4. Configures your client (`--client claude|muse|other`, otherwise detected or asked), keeping existing settings:
   - Claude Code: Hive hooks in `.claude/settings.local.json`, the `hive` stdio MCP server in `.mcp.json`; both
     kept out of git via `.git/info/exclude`. No tokens are written to these files.
   - Muse Code: `mcp_servers.hive` in `~/.config/muse/settings.json` (one backup first) and `.muse/hooks.json`
     (hook format is a best guess).
   - Other: prints the stdio command and the Streamable HTTP alternative.
5. Starts the local connector (`hive-connect node`, detached; `--no-node` skips it), which reports the checkout
   (branch, HEAD, merge-base with the hub's base, dirty files with sha256) and syncs changed `.ts/.tsx` files.
6. Verifies (`/me`, one checkout report) and prints one next step.

Run `connect` again to reconnect (reuses a valid credential; files come out byte-identical).

| Command | Purpose |
| --- | --- |
| `status` | hub, member, credential validity, connector process, last report |
| `disconnect [--keep-config]` | stops the connector, revokes the credential, removes only Hive's config entries, deletes the stored credential |
| `mcp` | stdio MCP server bridged to `<hub>/mcp` with the stored credential (your client starts it) |
| `hook <event> [--client claude\|muse]` | client lifecycle hook (`session-start`, `prompt`, `pre-write`, `post-write`, `session-end`) |
| `node [--once]` | the local connector |
| `relay` | operator fallback: relays one model analysis with `MODEL_API_KEY` from the environment (never stored) |

Exit codes: 0 ok, 2 user or environment problem, 1 unexpected error. State lives in `$XDG_CONFIG_HOME/hive`
(default `~/.config/hive`): `connections.json` (no secrets), `nodes/` (pid, state, log), `logs/hooks.jsonl`.
`HIVE_CONNECT_NO_KEYCHAIN=1` forces the file store.

## Develop

```sh
npm ci && npm run build && npm test     # tests run against dist/, no network
```

`dist/` is committed so the GitHub form works without a build step.

## Publish (human step, not done yet)

The name `hive-connect` was unclaimed on npm on 2026-11-03.

```sh
cd cli
npm login
npm publish --access public    # prepublishOnly builds and runs the tests
```
