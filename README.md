# Hive

Hive keeps several AI coding agents working on one TypeScript repository from breaking each other's work.
Each agent tells Hive what it is about to change; Hive checks every teammate's in-progress changes together
with the TypeScript compiler and deterministic rules, and tells an agent before it writes code that would
break someone else. When two agents disagree about a shared interface, Hive records a versioned agreement
(a **Ghost Contract**) that both sign, and only calls it *verified* when a real test passes on the real code.

## Join a workspace

Someone on your team runs a Hive hub and sends you an **invite link** like
`https://<hub>/ui/join#token=…`. Open it: you are signed in to the team dashboard in that browser tab
(the token stays in the tab; it is never sent to the server in the URL).

The dashboard's Connect screen then shows one command with your hub filled in. Run it **inside your own
clone of the team repository**:

```bash
npx hive-connect connect --hub https://<hub>
```

> **Status:** the `hive-connect` package is not on npm yet. Until it is published, install it from a clone
> of this repository: see [Installing hive-connect before it is published](docs/CLIENTS.md#installing-hive-connect-before-it-is-published).

What the command does, in order:
1. Detects the repository (folder, remote, branch) and asks `Connect <name> (<remote>) to Hive at <hub>? [Y/n]`.
2. Prints a short code and opens `<hub>/ui/pair/<code>` in your browser. You approve
   "Connect <repo> on <machine> as <you>". No token is copied or pasted.
3. Stores the resulting connector credential in your OS keychain (macOS Keychain, Linux `secret-tool`, Windows
   Credential Manager, untested), or in `~/.config/hive/credentials.json` (mode 0600) with a warning when no keychain exists.
4. Configures your coding client for this repository only, without touching your other settings, and starts a
   small background process that keeps Hive informed of your branch and changed `.ts`/`.tsx` files.
5. Prints one next step: **start or restart Claude Code in this folder.**

Later: `hive-connect status` (is everything connected), `hive-connect connect` again (repairs the setup, no
duplicates), `hive-connect disconnect` (stops the background process, revokes the credential and removes only
Hive's entries from your config files).

## What you will see

- **On the dashboard** (`<hub>/ui`): your agent appears next to your teammates' agents with your machine,
  branch, short HEAD and number of changed files; findings (for example "pricing agent changes `getPrice` to
  cents, invoice agent still expects dollars"), agreements and their state: *proposed*, *accepted*,
  *implemented*, *verified*. These words are never merged on any screen.
- **In your agent's session**: at session start and on every prompt the agent receives a short Hive summary.
  Before it edits a file, Hive type-checks the edit together with everyone's in-progress changes; if the edit
  would break a file a teammate is changing, Claude Code asks you before writing it.
- **Model analysis** (Meta Muse Spark) explains conflicts that type-check but disagree in meaning (units,
  formats). It runs on the hub; if the hub cannot reach the model, the dashboard says *unavailable*, never
  "no conflict".

## Supported clients

| Client | How Hive connects | Status |
|---|---|---|
| Claude Code | stdio MCP server `hive-connect mcp` in `<repo>/.mcp.json` + hooks in `<repo>/.claude/settings.local.json` | Hub side tested (hook contract, HTTP MCP, pairing); the CLI's bridge and hook commands land with `cli/`; see [docs/CLIENTS.md](docs/CLIENTS.md) |
| Muse Code | `mcp_servers.hive` in `~/.config/muse/settings.json` + `<repo>/.muse/hooks.json` | MCP fields follow Meta's docs; the hook format is a best guess, **not verified live** |
| Any other MCP client | the stdio command `hive-connect mcp`, or HTTP MCP at `<hub>/mcp` with a bearer header | Generic MCP; no hooks |

## FAQ

**Do I need a Meta (Muse Spark) API key?** No. The model key lives only on the hub. Nothing Hive writes on your
laptop contains it.

**Do I need to install or run the Hive backend?** No. You only need Node 18+, git, and your coding client. The
hub is run once by whoever administers the workspace.

**Does Hive change my files?** The connect command writes only Hive's own entries to `.mcp.json`,
`.claude/settings.local.json` (excluded from git via `.git/info/exclude`) and, for Muse Code, its settings
(backed up first). Your source files are sent to the hub so it can type-check them; the hub never writes them
back to your laptop.

**Where is my token?** In your OS keychain (or the 0600 fallback file). It is never put in config files,
environment variables or hook commands. `hive-connect disconnect` deletes it and revokes it on the hub.

**What does Hive not catch?** Type errors are found deterministically; meaning-level conflicts depend on the
model. Edits made outside the client's Edit/Write tools are picked up at the next prompt, not blocked.

**Is anyone's code run on the hub?** Only the hub's own checkout of the repository, and only test commands on
the hub's allowlist (`HIVE_VERIFY_ALLOW`). Commands proposed by an agent never run otherwise.

## More

- [docs/DEMO.md](docs/DEMO.md): a guided demo with the sample billing project and three agent tasks.
- [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md): run your own hub (install, dashboard build, environment
  variables, admin token, Railway, model diagnostics, upgrades and backups).
- [docs/CLIENTS.md](docs/CLIENTS.md): exactly what each client integration does and what is verified.
- Developing Hive: Node 22.18+, `npm install && npm run check` (typecheck + tests), then
  [TEAMMATE_START_HERE.md](TEAMMATE_START_HERE.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
  [docs/PROGRESS.md](docs/PROGRESS.md) (what is implemented, tested, and not yet verified live).

## Honest status (2026-11-03)

- The hub side (pairing, connector credentials, checkout reports, model diagnostics, `HIVE_MODEL_PROXY_URL`) and the
  `hive-connect` CLI in `cli/` are implemented and covered by `npm test` (141 tests, including
  `tests/acceptance-two-users.test.ts`, which runs the real CLI for two users against a spawned hub) and
  `npm run test:cli` (12 tests). Spec:
  [docs/superpowers/specs/2026-11-03-connect-cli-design.md](docs/superpowers/specs/2026-11-03-connect-cli-design.md).
- The team hub is hosted at `https://hive-hack-production.up.railway.app` (Railway, one service). From that host the
  Meta Model API accepts the key but lists no models and answers `model_not_found` for `muse-spark-1.3`; the same key
  works from a laptop. Model analysis on that hub therefore shows *unavailable* until the host is accepted. See
  [model diagnostics](docs/SELF_HOSTING.md#7-model-diagnostics-and-egress).
- **Pending:** publishing `hive-connect` to npm, Muse Code verified live, and a run with two real people on two laptops.
- Built during the Meta Global AI Developer Hackathon (Nov 2026) from a starter kit; see `docs/SOURCES.md`.
