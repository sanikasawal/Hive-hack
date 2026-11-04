# Self-hosting a Hive hub

This page is for the person who runs the hub for a team. Teammates do not need any of it: they open an invite
link and run `hive-connect connect` (see the [README](../README.md)).

Hive is a plain Node program (no container image). A host needs Node >= 22.18, git, and a persistent disk.
One hub serves one team repository; run exactly **one** instance per database.

## 1. Install and run locally

```bash
git clone https://github.com/Vishal2602/Hive-hack.git hive && cd hive
npm install                 # ts-morph, the MCP SDK, zod; no native modules (SQLite is node:sqlite)
npm run build:web           # builds the React dashboard into web/dist (served at /ui)
HIVE_PROJECT_ROOT=/path/to/team-repo npm start
# dashboard: http://127.0.0.1:4317/ui   (sign in with HIVE_TOKEN)
```

`npm start` reads `.env` if present (`--env-file-if-exists`); `npm run start:prod` does not (the platform supplies
the environment). Never commit `.env`. Without `npm run build:web`, `/ui` answers 503 naming that command.

## 2. Admin token

`HIVE_TOKEN` is the operator (admin) credential. The daemon refuses to start without it and rejects the
placeholder value. Generate one locally and paste it straight into your host's secret store:

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
```

Sign in to `<hub>/ui` with it. From the Members screen create one token per person (member) or a read-only
viewer token for judges. From Connect, create an invite link `<hub>/ui/join#token=<member token>`; the token is
in the URL fragment, which browsers do not send to the server. Token values are shown once and stored hashed;
revoke them on Members. Connector credentials created by `hive-connect` pairing appear under their member and
can be revoked there too.

| Role | Can |
|---|---|
| admin (`HIVE_TOKEN` or an admin token) | everything, including tokens and `model_diagnose` |
| member / connector | register agents and act on its own sessions, `/mcp`, laptop sync, `checkout_report` |
| viewer | `GET /api/view`, `/me`, `/events` (scrubbed), `/healthz`; every POST and `/mcp` is 403 |

## 3. Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `HIVE_TOKEN` | **yes** | Operator (admin) credential. Never shown in the UI. |
| `HIVE_PUBLIC_URL` | recommended when hosted | Public base URL (for example `https://hive.example.com`). Used in invite links, the Connect command and `/connect.mjs`. Without it the hub derives it from `X-Forwarded-Proto` and `Host`. |
| `MODEL_API_KEY` | no | Meta Model API key for Muse Spark analysis. Lives **only** on the hub. Without it analysis reports "unavailable". Each analysis is a paid call. |
| `HIVE_MODEL` | no | Default `muse-spark-1.3`. |
| `HIVE_MODEL_BASE_URL` | no | Default `https://api.meta.ai/v1`. Point it at a pass-through (section 7) to change the egress. |
| `HIVE_MODEL_PROXY_URL` | no | `http://` or `https://` CONNECT proxy for model requests only (`user:pass@` supported; credentials never appear in errors). |
| `HIVE_REPO_URL` / `HIVE_REPO_BRANCH` | no | Cloned into `HIVE_PROJECT_ROOT` on first boot when that folder is missing or empty (section 5). |
| `HIVE_PROJECT_ROOT` | no | The repository Hive indexes, edits and verifies (default: current directory). |
| `HIVE_DATA_DIR` | no | SQLite state and recovery journal (default `<project root>/.hive`). |
| `HIVE_HOST` | no | Bind address, default `127.0.0.1`. Use `0.0.0.0` only behind TLS. |
| `PORT` / `HIVE_PORT` | no | Listen port, default 4317 (`PORT` wins; Railway sets it). |
| `HIVE_VERIFY_ALLOW` | no | Comma-separated command prefixes `hive_verify` may run. Default `npm test,npm run,node --test,npx tsc,npx vitest`. |
| `HIVE_HOOK_GATE` | no | Before a write that breaks a teammate: `ask` (default), `deny`, `warn`. |
| `HIVE_REQUIRE_AGREEMENT` | no | `1` also gates operations on symbols other sessions depend on. |
| `HIVE_TSCONFIG`, `HIVE_WEB_DIST` | no | Alternative tsconfig / dashboard build folder. |

## 4. Railway

`railway.json` builds with Railway's Node builder (Railpack: `npm ci && npm run build:web`), starts
`npm run start:prod`, runs one replica, health-checks `/healthz`, and requires a volume at `/data`.

1. New project → deploy from this GitHub repository. Add a **volume** mounted at `/data`.
2. Service variables:
   - `HIVE_TOKEN` (section 2), `HIVE_HOST=0.0.0.0`.
   - `HIVE_PROJECT_ROOT=/data/repo`, `HIVE_DATA_DIR=/data/.hive`.
   - `RAILPACK_DEPLOY_APT_PACKAGES=git` (the runtime image has no git; Hive needs it to clone and to read the base commit).
   - `HIVE_REPO_URL` (+ optional `HIVE_REPO_BRANCH`).
   - `HIVE_PUBLIC_URL=https://<your service domain>` once the domain exists.
   - Optional: `MODEL_API_KEY`, `HIVE_MODEL`, `HIVE_MODEL_BASE_URL`, `HIVE_MODEL_PROXY_URL`, `HIVE_VERIFY_ALLOW`.
3. Settings → Networking → generate a domain. Open `<domain>/ui`, sign in with `HIVE_TOKEN`, invite people.
4. Do not scale replicas: one daemon owns the SQLite file and the checkout.

With the Railway CLI (`railway login`, `railway link`), `railway variables --set KEY=value` sets variables and
`railway logs` shows the daemon's stderr. Set secrets from your own terminal; do not paste them into chats or files.

Status: a Railway service was run by the operator on 2026-11-03 (the model probe in section 7 came from it). Its
public URL is not recorded in this repository.

## 5. Repository clone on first boot

When `HIVE_REPO_URL` is set and `HIVE_PROJECT_ROOT` is missing or empty, the hub clones it (optionally
`HIVE_REPO_BRANCH`) and runs `npm ci --ignore-scripts` there so type checks see package types. An existing,
non-empty folder is never touched. For a private repository use an HTTPS URL with a **read-only** token.

The hub's base commit does not move by itself. After merging to the team branch, update `/data/repo`
(for example `railway ssh` then `git -C /data/repo pull`, or delete the folder and redeploy) and restart.

## 6. What the hub does with laptops

Each member's `.ts`/`.tsx` changes (relative to the hub's base commit, plus untracked files) arrive through hooks
and the `hive-connect node` background process; they live in SQLite only, never in the hub's checkout. Before a
write, the hub type-checks base + every member's changes + the proposed edit in memory and reports breaks in
another member's files. `checkout_report` adds machine, branch, HEAD and dirty-file count for the dashboard; the
viewer view strips remote URLs with credentials and absolute paths. `hive_verify` runs allowlisted test commands
against the **hub's** checkout only.

## 7. Model diagnostics and egress

Run the admin-only `model_diagnose` command. The spec puts a **Diagnose** control under the dashboard's model
banner; until that screen lands, call it directly (token read from your shell, never typed into a file):

```bash
curl -s -X POST "$HIVE_HUB/command" -H "Authorization: Bearer $HIVE_TOKEN" \
  -H 'Content-Type: application/json' -d '{"action":"model_diagnose"}'
```

From the hub it calls `GET {base}/models` and a one-token chat completion, and returns status codes, short
excerpts (key redacted), request-id headers, the hub's egress IP (via `api.ipify.org`, best effort) and a
verdict: `not_configured`, `key_rejected`, `rate_limited`, `no_models_for_host`, `network_error` or `reachable`.

Observed on 2026-11-03: from the Railway service (US East and US West) the Meta Model API returned an **empty
model list / 404** for a key that lists every model from a laptop. Meta's docs say model availability can vary
by country. Two hub-side ways to change the egress; neither has been verified against the Meta API yet:

**Option A: CONNECT proxy.** Set `HIVE_MODEL_PROXY_URL=http://user:pass@proxy.example:3128` (any HTTP proxy that
supports `CONNECT` to `api.meta.ai:443`, in a location the provider serves). Only model requests use it; TLS is
end to end, so the proxy sees the host name, not the key.

**Option B: pass-through via `HIVE_MODEL_BASE_URL`.** A minimal Cloudflare Worker (it forwards the two
endpoints Hive uses and nothing else; it stores nothing):

```js
// worker.js — deploy with `npx wrangler deploy`; then HIVE_MODEL_BASE_URL=https://<worker>.workers.dev/v1
const UPSTREAM = 'https://api.meta.ai';
const ALLOWED = new Set(['GET /v1/models', 'POST /v1/chat/completions']);
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (!ALLOWED.has(`${request.method} ${url.pathname}`)) return new Response('Not found', { status: 404 });
    if (!request.headers.get('authorization')) return new Response('Unauthorized', { status: 401 });
    const headers = new Headers();
    for (const name of ['authorization', 'content-type', 'accept']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    return fetch(UPSTREAM + url.pathname + url.search, {
      method: request.method, headers, body: request.method === 'POST' ? request.body : undefined,
    });
  },
};
```

The key is still sent by the hub on every request and passes through the Worker in memory; anyone who finds the
Worker URL can use it only with their own key. A Worker changes the egress network, not necessarily the country:
check the result with Diagnose before relying on it.

**Operator fallback: laptop relay.** If neither works, an operator can relay one analysis from a laptop where the
key works: `hive-connect relay` (CLI) or `node .hive/hive-hook.mjs analyze` (older `/connect.mjs` setup), with
`MODEL_API_KEY` set in that shell for that run only. The hub hands out the exact request
(`analysis_relay_request`), the laptop sends it, and the raw response is posted back (`analysis_relay_submit`),
parsed and validated exactly like a direct call, and labelled **relayed** on the dashboard. The key is never
stored on the laptop or sent to the hub.

## 8. Upgrades and backups

- **Upgrade:** pull/redeploy the Hive code; migrations run on start (`src/store/schema.ts`). SIGTERM drains
  requests (`drainingSeconds: 30`). Rebuild the dashboard (`npm run build:web`; Railway does it in the build step).
- **Backup:** everything durable is in `HIVE_DATA_DIR`: `hive.db` in WAL mode plus its `-wal`/`-shm` files
  (tokens, sessions, agreements, events, laptop changes and the operation journal all live in that database). Use Railway volume backups, or stop the hub and copy the folder. A copy taken while running
  should use `sqlite3 hive.db ".backup out.db"`. The team repository checkout can be re-cloned.
- **Restore:** stop the hub, put the folder back, start. Connector credentials and tokens survive; pending
  pairings expire after 10 minutes anyway.

## 9. Limits

Single instance; no TLS in Hive (the host terminates it); `hive_verify` runs tests on the host without a
sandbox, so only point a hub at a repository you trust; edits outside a client's Edit/Write tools are seen at
the next prompt, not gated.

> Build note (2026-11-03): Railpack runs the root `npm run build` script automatically, which is how the dashboard gets built on every deploy (including `railway up`). `railway.json`'s buildCommand was not applied on an upload deploy, so do not rely on it alone.
