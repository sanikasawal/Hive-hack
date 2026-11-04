# Hive: start here (for a teammate and their Claude instance)

Written 2026-11-03 by the Claude Code session that built this repo, for the second team member joining before
the Meta Global AI Developer Hackathon deadline (**Tue Nov 4, 2026, 9:00 PM ET**). Read this file, then
`CLAUDE.md`, then `docs/PROGRESS.md`. Everything else is linked from here. Status lines below were true at the
time of writing; `git log` and `docs/PROGRESS.md` are the living record.

## 1. What Hive is, in four sentences
Hive is a local coordinator for several AI coding agents working on one TypeScript repository. Agents declare
their intentions through MCP tools; Hive finds real conflicts with deterministic rules and the TypeScript
compiler (for example two agents assuming different units for `getPrice`), asks Muse Spark to explain and
propose an interface, and records a versioned **Ghost Contract** that both agents sign. It stages the risky
edits itself with undo, and marks an agreement *verified* only when a real test passes on the real code.
Three states are kept strictly apart on every screen: agreement accepted, implementation matches, behavior
verified.

## 2. Hackathon facts that shape the work
- Event: Meta Global AI Developer Hackathon (Cerebral Valley + Meta), virtual, Oct 26 to Nov 4 2026.
  Submissions due Nov 4 9:00 PM ET. Judging Nov 4 to 8. Finals Nov 9.
- Theme fit: "Build for Your World". Track: decide (indie or startup).
- Rubric (from the waiver, per third-party notes): Impact 30, Use of Meta AI tooling 25, Demo 25 (working
  demo + roughly 3-minute video), Technical depth 20. Pass/fail gate: genuinely uses the Meta Model API.
  Reported hard rules: public repo, one submission per team, max 4 people, new work only (demo shows what was
  built during the event; disclose lineage).
- Meta tooling in Hive: Muse Spark (`muse-spark-1.3`) via `https://api.meta.ai/v1/chat/completions` for
  analysis and proposals (one live call verified Nov 2), and Muse Code as a client over MCP (NOT yet verified
  live; it was not installed on the build machine).
- Provenance: an older Hive (June 2026, different folder, not in this repo) exists. This repo was rebuilt from
  a starter kit from Nov 1 2026 onward; ideas were reused, no code copied verbatim. `docs/SOURCES.md` records
  this. State it plainly in the submission; do not claim eligibility, check the Official Rules.

## 3. Repository map
```
src/
  server/daemon.ts      one HTTP server: auth, routes, /ui static, /mcp, /healthz, graceful shutdown
  server/auth.ts        roles: admin (HIVE_TOKEN) | member | viewer; per-route and per-command checks
  server/tokens.ts      member tokens (sha256 hash + 8-char prefix stored; value shown once)
  server/tools.ts       the 16 MCP tool definitions shared by stdio and HTTP transports
  server/mcp.ts         stdio MCP adapter (one per coding-client session, heartbeats with retries)
  server/mcpHttp.ts     Streamable HTTP MCP at /mcp (one MCP session = one Hive session)
  server/schemas.ts     zod schemas for every /command action
  service.ts            composition root: graph per workspace, sync, cached snapshot, sanitized /api/view
  domain/               coordinator (sessions, intents, contracts, events), detect, types
  store/                node:sqlite store + migrations (schema.ts)
  graph/index.ts        ts-morph compiler index: symbols, edges through aliases/barrels, file hashes
  ops/                  staged add_field / change_signature engine with journal, rollback, crash recovery
  contracts/            Ghost Contract overlay checks, implementation evidence, async verification, claims
  intelligence/         Muse Spark analyzer (structured output, cited findings, cache, bounded retry)
  hooks/hook.ts         client lifecycle hook adapter (Claude Code JSON; Muse Code plain text + capture)
web/                    React + Vite dashboard (Arc UI components, Linear-style sidebar); built to web/dist,
                        served by the daemon at /ui. Table-of-content rail is used ONLY on the Activity screen.
tests/                  19 files, 73 tests (node --test), 
scripts/seed-demo.ts    starts a live, realistic workspace for screenshots and demos
scripts/smoke-model.ts  one real Muse Spark call; prints model, latency, tokens; never the key
demo/scenario.ts        labelled scripted replay of the whole flow (exit 0 = all states reached)
demo/evaluate.ts        ACCEPTANCE scenarios with/without Hive -> evaluation/results-*.{json,md}
railway.json, docs/SELF_HOSTING.md   hosting config + operator guide (docs/DEPLOY.md now points there)
cli/                    hive-connect CLI (spec section 4; compiled to cli/dist, Node 18+), when present
fixtures/billing        tiny sample app used by tests; ../hive-playground (outside this repo) is the bigger sample
config/                 client config templates (Claude Code MCP + hooks; Muse Code best guess)
docs/                   PRODUCT, ARCHITECTURE, BUILD_PLAN, ACCEPTANCE, PROGRESS, CLIENTS, CLOUD, DEPLOY,
                        HIVE_CLOUD_PLAN, UI_BRIEF, superpowers/specs/ (approved design spec)
HIVE_CLOUD_HANDOFF.md   code-verified description of the pre-cloud codebase (fact-checked)
```

## 4. What is done (as of commit 91a7491)
- Backend phases 1 to 7 from `docs/BUILD_PLAN.md`: persistence, compiler index, staged operations, Ghost
  Contracts with verification, Muse Spark analysis (mock-tested + one live call), hooks, scripted demo and
  evaluation harness.
- Cloud build (Nov 2 to 3): member tokens with roles; viewer-safe `/api/view` (no paths, excerpts, diffs or
  secrets); `/me`; hostable daemon (`HIVE_HOST`, `PORT`, `/healthz`, SIGTERM drain, cached snapshots, fixed
  `/events` paging); asynchronous verification (`running | passed | failed | inconclusive | error`, never
  blocks heartbeats); MCP over HTTP at `/mcp`; `railway.json` + `docs/DEPLOY.md` (Docker removed 2026-11-03);
  React dashboard core (live API client, store, Linear sidebar) served at `/ui`.
- Dashboard screens wired to live data; design review approved; local release checks passed.
- Quality: `npm run typecheck` clean; `npm test` 105/105 (about 20 s); live smoke of health, viewer refusal and token issuance passed.

## 5. Build status at the last update (2026-11-03, commit 91a7491)
The cloud build is complete and committed. Dashboard screens are wired to live data (commit 46bf54d), the
design manager approved the live app on its third review round (68 screenshots at 390/820/1440 in light and
dark plus viewer and offline states; sidebar is Linear-style; the table-of-content rail appears only on
Activity), and the release checks that can run locally all passed (commit 91a7491): restart persistence,
slow verification with live heartbeats (health, snapshot and heartbeat under 5 ms during a 5 s run), viewer
refusal with a secret-free `web/dist`, journal recovery. (A Docker build also passed then; Docker was removed on 2026-11-03.)

## 6. What is left (priority order)
1. **Hosting.** Nothing is deployed. Plan of record: one Railway service + volume (`docs/HIVE_CLOUD_PLAN.md`,
   `docs/DEPLOY.md`). Alternatives analysed in `docs/CLOUD.md` (GitHub Codespaces, Cloudflare tunnel). Needs a
   human-owned account; never create paid resources without the owner's go-ahead.
2. **Muse Code live.** Install (`curl -fsSL https://dev.meta.ai/install.sh | sh`), sign in, add Hive as an
   MCP server (HTTP: `/mcp` with `Authorization: Bearer <member token>`; or stdio via `src/server/mcp.ts`),
   run one session on the playground, capture `.hive/hook-log.jsonl` to learn the hook schema, then fix
   `src/hooks/hook.ts` Muse output. `docs/CLIENTS.md` says exactly what is verified vs assumed.
3. **Two real agents.** Pricing agent + invoice agent (+ UI agent) on `hive-playground` (tasks in its README),
   Hive running with `HIVE_PROJECT_ROOT` pointing at that checkout, dashboard open. Record whether each agent
   changed its plan after a Hive message and which edit paths were not intercepted.
4. **Video (about 3 minutes)** per `docs/ACCEPTANCE.md`: tasks and shared dependency, the conflict with
   evidence, the Ghost Contract and both signatures, continued work, the combined test on real code, measured
   result, one honest limitation. Label any replay as scripted.
5. **Submission text**: what it does, Meta tooling used (Spark analysis with real token numbers from
   `evaluation/`, Muse Code client), provenance note, repo link, video link.
6. Nice to have: live `npm run evaluate -- --repeats 3` with the key (real token/latency columns),
   `rename_symbol`/`add_endpoint` (explicitly rejected today).

## 7. How to run
```bash
npm install                      # Node >= 22.18 (built on 22.22.3); no native modules
npm run check                    # typecheck + 73 tests
npm run demo                     # scripted replay, exit 0 expected
npm run build:web                # builds the dashboard into web/dist
HIVE_PROJECT_ROOT=/path/to/repo npm start    # daemon on 127.0.0.1:4317; dashboard http://127.0.0.1:4317/ui
node --disable-warning=ExperimentalWarning scripts/seed-demo.ts --port 4318   # live demo workspace
```
Sign in to `/ui` with the admin token (`HIVE_TOKEN` from `.env`, or the token the seed script prints), then
use Connect to generate member/viewer tokens. Roles: admin (everything), member (own sessions), viewer
(read-only `/api/view`, `/me`, `/events`).

Env var names (never commit values): `HIVE_TOKEN` (required, admin), `MODEL_API_KEY` (optional, Muse Spark),
`HIVE_MODEL`, `HIVE_MODEL_BASE_URL`, `HIVE_PORT` / `PORT`, `HIVE_HOST` (default loopback), `HIVE_PUBLIC_URL`
(cloud link shown in Connect), `HIVE_URL` (adapter/hook target), `HIVE_PROJECT_ROOT`, `HIVE_DATA_DIR`,
`HIVE_DB=:memory:` (tests), `HIVE_TSCONFIG`, `HIVE_VERIFY_ALLOW`, `HIVE_REQUIRE_AGREEMENT`, `HIVE_HOOK_GATE`,
`HIVE_PLAYGROUND`. `.env` exists locally only; `.env.example` lists the basics.

Connect a coding agent over HTTP (what the Connect screen renders):
`claude mcp add --transport http hive <publicUrl>/mcp --header "Authorization: Bearer <member token>"`.
Co-located agents can also use the stdio adapter (`config/claude-code.mcp.example.json`).

## 8. Rules that must hold (short form; `CLAUDE.md` is authoritative)
- TypeScript only; Node runs `.ts` natively in strip-only mode under `src/ tests/ scripts/ demo/`: no
  constructor parameter properties, no enums, imports end in `.ts`. `web/` is Vite-built and exempt.
- Model output proposes; deterministic code validates and executes. Never run agent-provided commands outside
  the verify allowlist. Never print or commit secrets; no `console.log` on MCP stdout.
- Proposed, accepted, implemented and verified are different states; green only with passing evidence.
- Tests must verify behavior and failures; keep `npm test` green; add tests with features.
- Honest docs: do not claim deployment, live Muse Code, or a two-agent run until they happened.
- UI: Arc UI components (free tier), semantic tokens, sentence case, both themes, Linear-style sidebar; the
  table-of-content rail only on Activity.

## 9. Working as two people with two Claude instances
- Pull before you start; work on a branch per task; small commits; never force-push `master`.
- Do not both edit `src/server/daemon.ts`, `src/service.ts` or `src/server/schemas.ts` at the same time; say
  who owns the backend and who owns `web/` for the session.
- One daemon per database: never point two daemons at the same `.hive/hive.db`. Use `HIVE_DB=:memory:` or a
  temp `HIVE_DATA_DIR` for experiments. Tests spawn their own daemons on random ports.
- Keep the machine awake during long agent runs (the build stalled once when the laptop slept).
- Known risks to keep in mind (details in `HIVE_CLOUD_HANDOFF.md`, section 10): single instance only; the
  daemon checks and edits its own checkout, so remote agents coordinate intents but their local edits are not
  compiler-checked; SQLite on a volume needs WAL-capable storage; backups are manual.

## 10. Useful entry points for a Claude instance
- Fast orientation: `docs/PROGRESS.md`, then `git log --stat -5`.
- Backend behavior by example: `tests/contracts.test.ts`, `tests/ops.test.ts`, `tests/auth.test.ts`,
  `tests/mcp-http.test.ts`, `tests/hostable.test.ts`, `tests/verify-async.test.ts`.
- API surface: `src/server/schemas.ts` (every command), `src/server/daemon.ts` (every route).
- Dashboard data contract: `src/service.ts` (`ServiceSnapshot`, `viewCached`), `web/src/api/`.
- Deployment: `docs/SELF_HOSTING.md`, `railway.json`. Guided demo: `docs/DEMO.md`.

## 11. hive-connect and publishing (added 2026-11-03)
The public path for a teammate is now: invite link from the dashboard (`<hub>/ui/join#token=…`), then one
command in their own clone: `npx hive-connect connect --hub <hub>`. It pairs through the browser (`pair_start` →
approve at `<hub>/ui/pair/<code>` → `pair_poll` returns a connector token once), stores the token in the OS
keychain, writes token-free Claude Code / Muse Code config that calls `hive-connect hook …` and
`hive-connect mcp`, and starts `hive-connect node` (checkout reports + laptop sync). Spec:
`docs/superpowers/specs/2026-11-03-connect-cli-design.md`; client details: `docs/CLIENTS.md`.

The model key stays on the hub (`MODEL_API_KEY` is never written to laptops). If the hub's egress is refused by
the Meta API, see `docs/SELF_HOSTING.md` section 7 (`model_diagnose`, `HIVE_MODEL_PROXY_URL`, a pass-through
`HIVE_MODEL_BASE_URL`, and the operator-only laptop relay).

Publishing (a human step; needs the npm account owner):
```bash
cd cli && npm login && npm publish --access public
```
Until it is published, install from a clone: `cd cli && npm install && npm install -g .` (verified shape; plain
`npm install -g ./cli` without the local install leaves the MCP SDK missing). `npx github:Vishal2602/Hive-hack`
only works if the root `package.json` exposes the `hive-connect` bin, which it does not today.

Verified vs pending at this update: hub pairing, connectors, checkout reports, `model_diagnose` and the proxy are
in `npm test`. Pending: the `cli/` package itself and its tests, npm publishing, a recorded public hub URL, the
hosted model fix (needs the deployment), Muse Code live, and a two-person run.
