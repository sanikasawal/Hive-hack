# Progress

Fresh build in progress. Old repository source has NOT been imported or read.
Status words below are precise: "implemented + tested" means an automated test
exercises the behavior; "built, unverified live" means code exists but the live
system it integrates with was not available in the build environment.

## Phase 0 — validate starter and access (done 2026-11-01)
- Environment: Node v22.22.3, npm 10.9.8 (starter said Node 24; type stripping and
  `node:sqlite` both work on 22.22, so `engines` is now `>=22.18.0`).
- `npm install` ok (lockfile pinned: ts-morph 27.0.2, MCP SDK 1.32.2, zod 3.25.76, TS 5.9.3).
- Starter `npm run check`: typecheck clean, 11/11 tests passed. `npm run demo` ran.
- Transport smoke test (daemon + two independent stdio MCP clients) passes.
- Model access: no `MODEL_API_KEY` in the environment, no `.env`. Live Meta smoke test
  is BLOCKED; model work proceeds with mocked boundary tests only.
- Muse Code: NOT installed on this machine (no binary, no `~/.config/muse`). Official docs
  (dev.meta.ai, fetched 2026-11-01) confirm: user settings `~/.config/muse/settings.json`
  with `mcp_servers` block (`transport: "stdio"`, `command`, `args`, `env`), `MUSE_SESSION_ID`
  passed to stdio servers, project hooks in `.muse/hooks.json`, events SessionStart,
  UserPromptSubmit, PreToolUse, PostToolUse, PostToolBatch, PreLLMCall, PostLLMCall,
  SessionEnd. The hook stdin/stdout schema and exit-code semantics are NOT documented
  on those pages, so any hook adapter is "built to documented event names, unverified".
- Meta API facts used: `POST https://api.meta.ai/v1/chat/completions`, Bearer
  `MODEL_API_KEY`, structured output via `response_format: {type: "json_schema", json_schema:
  {name, schema}}`, error shape `{error:{message,type,param,code}}`, retry 429/500/503 with
  exponential backoff + jitter and `Retry-After`, never retry 400/401/404/413, don't retry 504.

## Phase 1 — persistence and workspaces (done 2026-11-01)
- `src/store/sqlite.ts` + `src/store/schema.ts`: built-in `node:sqlite` (no native module),
  WAL, busy timeout, versioned migrations, nested-safe `transaction()`.
- Full durable schema from ARCHITECTURE.md created (repositories, workspaces, sessions,
  intents, files, symbols, edges, proposals, contracts, contract_versions,
  acknowledgements, claims, events, verification_runs, analyses, journal).
- `Coordinator` rewritten over the store: repository identity by canonical root,
  workspaces (worktree dirs with base commit when git is present), session leases with
  lazy TTL expiry, per-session intent revisions (history kept), durable events, code
  revision counter, contract versions with exact-version acknowledgements, revise
  (clears acks), reject/cancel, stale on intent change / finish / expiry.
- Daemon: `HIVE_PROJECT_ROOT`, `HIVE_DATA_DIR` (default `<root>/.hive/hive.db`),
  `GET /events?after=`, new actions `revise`, `reject`. MCP adapter: 8 tools.
- Tests: 17/17 (restart preserves state; expired leases released after restart; worktree
  registration; v1 acks cannot satisfy v2; reject vs cancel; durable event query).
- Gate met: two clients share state (transport test), restart preserves it, expired
  sessions release scope.

## Phase 2 — compiler evidence (done 2026-11-02)
- `src/graph/index.ts` (`GraphIndex`): ts-morph program over the workspace tsconfig; symbols
  keyed `relative/path.ts#Qualified.name:kind` (functions, classes + members, interfaces +
  members, type aliases, enums + members, variables, namespaces); overload sets share one key
  with `meta.overloads`; normalized `meta.signature`; declaration hashes; file hashes.
- Edges resolved through the compiler: every identifier → symbol → aliased symbol → declaration,
  so imports, barrels (`export { x as y }`) and re-exports land on the original declaration.
  `export *` names no identifier and (correctly) yields no edge.
- Excluded files (tsconfig `exclude`) are not indexed. Incremental reindex keeps row IDs by
  logical key; an explicit `keyMap` carries an ID through a rename. `changes()` /
  `quickChanges()` detect direct edits by hash.
- Service layer (`src/service.ts`): lazy per-workspace index, cheap drift check before every
  snapshot/operation, `direct_edit` events + findings, compiler-backed `dependent_write`
  candidates (one session declares work on a symbol another session's files depend on).
- MCP: `hive_symbol` (signature, dependents, dependent files), `hive_reindex`.
- Tests: aliases/overloads/members/excluded fixture, dependents, stale detection, ID
  preservation, rename mapping, hash change. Gate met.

## Phase 3 — first real operations (done 2026-11-02)
- `src/ops/engine.ts`: preview stages the change in a fresh in-memory compiler project (disk
  untouched), computes baseline-relative new diagnostics, a unified diff, compiler-resolved
  callers with per-caller breakage notes, source hashes of edited + dependent files, and runs
  deterministic gates. Any new diagnostic or gate reason is an explicit rejection.
- Apply: in-process writer lock → recheck revision and source hashes → re-stage → durable
  journal row (`writing`) → write files → one DB transaction (reindex, revision bump, proposal
  result, journal `committed`). Failure restores files from the journal and reindexes; a
  journal left `writing` by a dead process is restored on the next start (`recover()`).
- `add_field`: interface, class, object-literal type alias (or intersection with one). Required
  fields that break existing literals are rejected naming the caller; nothing is invented.
- `change_signature`: non-overloaded functions/methods from a declaration string; removed
  parameters delete the matching argument at compiler-resolved call sites; new required
  parameters are never guessed (callers reported as unfixable); overload sets are refused.
- `rename_symbol` / `add_endpoint`: rejected explicitly as not implemented (stretch).
- Tests: unsupported ops, required/optional add_field, unfixable callers, call-site argument
  removal, overload refusal, injected failure after first write (files + DB + index restored),
  simulated crash recovered on restart, same-base concurrency (second apply stale), direct edit
  between preview and apply. Gate met.

## Phase 4 — Ghost Contracts and claims (done 2026-11-02)
- `src/contracts/overlay.ts`: declaration validation (single named ambient declaration, no body,
  no `any`, name must match the producer symbol); overlay check builds an isolated project where
  the producer file's declaration is replaced by the promise and type-checks consumer files;
  real check does the same without the overlay; `satisfies()` compares the declaration's shape
  with the indexed implementation (functions: exact signature; types: promised members present).
- `src/contracts/service.ts`: propose/revise validate and record the overlay result; status
  moves accepted → implemented only on compiler evidence; `verify` runs an allowlisted command
  (default prefixes `npm test`, `npm run`, `node --test`, `npx tsc`, `npx vitest`; no shell
  metacharacters; no shell) and records exit code, output, source hashes, revision; `verified`
  requires exit 0 AND real type-check AND implementation evidence. Later source changes drop
  verified → implemented until verification runs again. Agreement gate blocks a Hive operation
  on a producer symbol whose contract is proposed but not accepted.
- `src/contracts/claims.ts`: `field_required` claim; violations in current source are findings;
  staged operations that would break a claim are rejected.
- MCP: `hive_contract_check`, `hive_verify`, `hive_claim`; `hive_propose_contract` takes
  `producerSymbol` + `behaviorNotes`; `hive_revise_contract`, `hive_reject_contract`.
- Tests: validation, findings incl. compiler `dependent_write`, consumer builds against overlay
  while real check fails and nothing is verified, agreement gate → implemented → failing
  behavior test → passing behavior test → verified → downgrade on later edit, revision re-arms
  the gate, allowlist, claim violation + gate. Gate met.
- Fixture note: `fixtures/billing` now uses `.ts` import specifiers (allowImportingTsExtensions)
  so its behavior test `tests/pricing.test.ts` runs under Node without a build step.

## Phase 5 — Meta intelligence (built + mocked tests 2026-11-02; live smoke BLOCKED, no key)
- `src/intelligence/meta.ts` (`MetaAnalyzer`): `POST {HIVE_MODEL_BASE_URL|https://api.meta.ai/v1}/chat/completions`,
  model `HIVE_MODEL|muse-spark-1.3`, Bearer `MODEL_API_KEY`, `temperature: 0`, structured output via
  `response_format: {type: "json_schema", json_schema: {name: "HiveAnalysis", schema}}`, 30 s timeout,
  ≤ 3 attempts with exponential backoff + jitter and `Retry-After` on 429/500/503 and on
  timeouts; 400/401/403/404/413 and 504 are not retried. Output validated with zod; findings
  must cite a symbol key, file, assumption key or value from the bundle and name only known
  sessions; proposed declarations using `any` are dropped (dropped reasons are recorded).
- `src/intelligence/service.ts` (`AnalysisService`): bounded evidence (live intents, candidate
  findings, live contracts, ≤ 24 declarations with 40-line excerpts, ≤ 40 dependents); cache by
  input hash; no DB transaction across the call; input hash re-checked after the response
  (`stale` if moved); explicit states `ok | cached | unavailable | invalid | stale`; model id,
  latency and token usage recorded in `analyses`. Concurrent callers share one in-flight call.
- MCP `hive_analyze`; snapshot carries `analysis` and `model.configured`.
- Tests (injected fetch): no key → unavailable; bundle content and request shape; cache + recompute;
  malformed output → invalid; timeout retries → unavailable; 429 + Retry-After then ok; 400 and 504
  not retried; uncited/unknown-session/`any` findings dropped; mid-call change → stale.
- NOT done: real API smoke test (needs `MODEL_API_KEY` in `.env`), evaluation of harmless-overlap
  judgement quality (live only).

## Phase 6 — client checkpoint integration (built 2026-11-02; Muse Code unverified, not installed)
- `src/hooks/hook.ts`: events `session-start`, `prompt`, `pre-write`, `post-write`, `session-end`;
  Claude Code JSON output (`additionalContext`, `permissionDecision ask|deny`, exit 2), Muse plain
  text; raw stdin logged to `.hive/hook-log.jsonl`; daemon down → context note, never a block.
- Daemon token-only actions for hooks: `sync`, `hook_check`. Templates in `config/`.
- `docs/CLIENTS.md` states coverage precisely (what is gated, what is only observed).
- Test: real daemon + hook process: findings injected into context; `ask` on the producer file of
  a proposed contract; `deny` mode exit 2; gate clears after acceptance; post-write reindex emits
  `direct_edit`; daemon-down fallback.
- NOT done: two real independent Muse Code sessions altering their plans (needs an install and a
  human-driven session); the same with Claude Code is possible locally with the templates but was
  not run in this build (it spends the user's Claude usage). No capture of a live hook payload yet.

## Phase 7 — dashboard, scripted demo, evaluation (done 2026-11-02; real-agent run NOT done)
- (Superseded 2026-11-02/03: `src/dashboard/index.html` was deleted and replaced by the React app in `web/`,
  see "Cloud build" below.) `src/dashboard/index.html` served by the daemon at `/` and `/ui` without auth (static, secret-free,
  CSP); token pasted once into sessionStorage; polls `/snapshot` every 2 s; agent cards, selected
  finding with evidence and before/after, contract lifecycle with exact-version acknowledgements,
  verification evidence, event timeline; empty/offline/stale/model-unavailable states; green only
  with `evidence.verification.passed === true`; text nodes only. Read-only, polling only.
  Verified over HTTP and a fake DOM; not opened in a real browser here (extension unavailable).
- `demo/scenario.ts` (`npm run demo`): labelled scripted replay of the full path; exit 1 on any
  missed state. `demo/evaluate.ts` (`npm run evaluate`): ACCEPTANCE scenarios with Hive, no-Hive
  controls, no-conflict control, harmless overlap, direct edit, injected model timeout/malformed
  output; measured latency; results in `evaluation/`.
- Full suite: 47/47; typecheck clean.

## Cloud build 2026-11-02/03 (local build + local release checks; NOT deployed)
Spec: `docs/superpowers/specs/2026-11-02-hive-cloud-app-design.md`; plan: `docs/HIVE_CLOUD_PLAN.md`.
What landed (implemented + tested unless stated):
- **Roles and member tokens** (`src/server/auth.ts`, `src/server/tokens.ts`): `HIVE_TOKEN` is the operator
  (admin); `token_create/list/rename/revoke` (admin-only) issue `admin`/`member`/`viewer` tokens. The secret is
  returned once and stored hashed; comparison is constant-time. Members may only drive sessions registered with
  their own token. Viewers may only GET `/api/view`, `/me`, `/events` (scrubbed: no payloads, no absolute paths)
  and `/healthz`; every POST, `/snapshot` and `/mcp` is 403 for them.
- **Hostable daemon** (`src/server/daemon.ts`): `HIVE_HOST` (loopback default; warns on non-loopback), `PORT`
  then `HIVE_PORT`; unauthenticated `GET /healthz` (DB reads only, never sync); cached snapshot with a drift
  timer (`?fresh=1` forces a sync for members/admins); paged `/events?after=&limit=`; SIGTERM/SIGINT refuse new
  writes, drain in-flight apply/verify (max 10 s), close SQLite and exit 0.
- **Async verification** (`src/contracts/service.ts`): `verify` returns a run id immediately; the test command
  runs as a child process with an allowlisted command, minimal environment, timeout and bounded output;
  `verify_status` polls it; one run per contract at a time.
- **HTTP MCP** (`src/server/mcpHttp.ts`): Streamable HTTP at `/mcp`, same 16 `hive_*` tools as stdio
  (`src/server/tools.ts`); one MCP session = one Hive session, bound to the token that created it.
- **Container** (`Dockerfile`, `.dockerignore`, `deploy/entrypoint.sh`, `deploy/playground/`, `railway.json`,
  `docs/DEPLOY.md`): volume at `/data`, playground initialised once from the bundled snapshot, never reset.
- **React dashboard** (`web/`, served by the daemon at `/ui`, `src/server/static.ts`): Linear-style sidebar,
  sign-in with a token (sessionStorage only), live polling of `/snapshot` + `/events` (admin/member) or
  `/api/view` + `/events` (viewer), Overview, Agreements (with verification runs), Activity, Members/tokens,
  Connect (invite + client snippets). CSP with a hashed theme script; path traversal and symlinks refused;
  `npm run build:web` builds it, and `/ui` answers 503 naming that command when no build exists.
- **Seed script** `scripts/seed-demo.ts`: the billing scenario on a temp copy of the playground for dashboard
  work (the consumer edit is made by the script and logged as such; no model call).
- Tests: `npm test` 107/107 (the 47 earlier tests kept); root and web typecheck clean; web build clean.
  Release checks run 2026-11-03 are in `VERIFICATION.md`.

Remaining for the cloud demo (not done):
1. **Railway deploy** per `docs/DEPLOY.md` (volume at `/data`, `HIVE_TOKEN`, `RAILWAY_RUN_UID=0`,
   `HIVE_PUBLIC_URL`), then repeat the release checks against the hosted URL, including a backup restore.
2. **Muse Code live**: install it, connect over stdio or HTTP MCP, capture the real hook payload schema.
3. **Two real agents** on the hosted checkout (distinct files), registration, a hook firing, a conflict
   delivered and a revised agent action; save a redacted trace.
4. **Video** of the 2-3 minute demo; label any scripted part.
5. Known gaps: the Connect waiting step still shows a "simulate" button that does nothing in live mode;
   for admins/members the agreement page lists only runs it saw while polling (the snapshot carries the
   latest run per agreement); `HIVE_CLOUD_HANDOFF.md` still describes the pre-cloud code in places.

## Docker removed (2026-11-03)
Dockerfile, `.dockerignore`, `deploy/entrypoint.sh` and `tests/container.test.ts` deleted; `railway.json` now uses
Railway's Node builder (`npm ci && npm run build:web`, start `npm run start:prod`). The bundled playground snapshot
moved out of the repo to `../hive-playground` (its own git repo; client configs point at this checkout). Nothing on
the host creates `/data/repo` automatically any more; the planned laptop-sync work will clone the team repo.
Direction chosen by the team: each teammate's agent runs on their own laptop and sends changed files to the hosted
hub, which compiles the combination.

## Laptop sync (built + tested 2026-11-03; not yet run with two real people)
- `src/remote/service.ts`: members' changed files in SQLite (`remote_files`, migration 6); in-memory combined
  type-check (base + others + mine + proposed edit, baseline-relative); `structural_incompatibility` findings
  attributing breaks to the member whose change caused them; diffs as model evidence.
- Commands `remote_status`, `remote_push`, `remote_check` (members/admins; files owned by the caller's member name).
- Hook (`src/hooks/hook.ts`): local root from the client's `cwd`; full sync on session start/prompt; pre-write
  check derived from Edit/Write/MultiEdit input; post-write push. Gate on breaking another member's files.
- `/hook.mjs` and `/connect.mjs` served by the daemon (transpiled, secret-free); one-line setup on the Connect screen.
- `HIVE_REPO_URL` first-boot clone (`src/server/prepare.ts`). Overview shows a "Laptop changes" panel.
- Tests: `tests/remote.test.ts` (two laptop clones + served setup + gate + findings + revert + path safety + model
  evidence + first boot). Suite 109/109.
- Not done: live two-person run, Railway deploy, Muse Code hook (output format still unverified).

## Remaining (human or access needed)
1. Put a real `MODEL_API_KEY` in `.env`, run `npm run demo` and `npm run evaluate -- --repeats 3`
   to produce the first live Muse Spark analyses; keep the written results (do not cherry-pick).
2. Install Muse Code, add the MCP server and hooks from `config/muse-code.settings.example.json`,
   run one session, read `.hive/hook-log.jsonl` to capture the real hook stdin schema, and adjust
   `src/hooks/hook.ts` output to the documented/observed contract.
3. Two-real-agent run (Muse Code, or Claude Code with the Claude templates): pricing agent +
   invoice agent + UI agent on a copy of `fixtures/billing`; record whether each agent changed its
   plan after a Hive message and which edit paths were not intercepted.
4. Record the 2–3 minute demo per ACCEPTANCE.md (dashboard at `/ui` alongside the two agents);
   label any replay as scripted.
5. Stretch only after that: `rename_symbol`, `add_endpoint`, more claim kinds, SSE for the dashboard.


## Docs restructure for Hive Connect (2026-11-03, spec section 5)
- `README.md` is now public-user first: what Hive does, "Join a workspace" (invite link + `hive-connect connect
  --hub <hub>`), what you will see, supported clients, FAQ (no Meta key and no backend needed on laptops), then
  links. Maintainer material moved to `docs/SELF_HOSTING.md` (install, dashboard build, env table incl.
  `HIVE_PUBLIC_URL` and `HIVE_MODEL_PROXY_URL`, admin token and roles, Railway, first-boot clone, volume,
  `model_diagnose`, the CONNECT proxy and a minimal Cloudflare Worker pass-through, laptop relay as operator
  fallback, upgrades and backups). `docs/DEPLOY.md` is a pointer. New `docs/DEMO.md` (seed script + the three
  playground agent tasks). `docs/CLIENTS.md` gains the CLI setup, stdio bridge, CLI hooks and a Muse Code
  verified-vs-assumed list. `TEAMMATE_START_HERE.md` section 11 covers hive-connect and publishing.
- Checked while writing: `npm install -g <folder>` does not install that folder's dependencies (probe package,
  npm 10.9.8); `npm install` in the folder first, or a packed tarball, works. The root `package.json` has no
  `bin`, so `npx github:Vishal2602/Hive-hack` does not provide `hive-connect`.
- Not verified / pending: the `cli/` package was not in the tree when these docs were written (the docs describe
  the spec's contract for it); npm publishing (human); a public hub URL; the dashboard Diagnose control;
  Cloudflare Worker and proxy options against the real Meta API; Muse Code live; two-person run.

## Hive Connect acceptance and release checks (2026-11-03, spec section 6)
- `tests/acceptance-two-users.test.ts` (in `npm test`, ~2 s): one spawned hub (temp file DB in `HIVE_DATA_DIR`,
  `HIVE_PROJECT_ROOT` = temp clone of `../hive-playground`, random port); two users (`ana`, `ben`) with separate
  `HOME`/`XDG_CONFIG_HOME` and separate clones; admin creates two member invite tokens; each user runs
  `cli/dist/main.js connect --hub --no-browser --yes --client claude` with `HIVE_CONNECT_NO_KEYCHAIN=1`, pairing
  approved with that user's browser token (`pair_approve`). Asserts: credentials.json mode 0600 with one connector
  credential; `.mcp.json` (token-free stdio `hive-connect mcp`) and `.claude/settings.local.json` hooks written and
  excluded from git; reconnect reuses the credential and leaves both files byte-identical; both connectors in
  `member_list` with branch/head; two MCP clients through the stdio bridge register (members ana/ben); `/api/view`
  lists both members with `branch@head`; colliding intents (cents vs dollars) give `assumption_mismatch` in
  `hive_context` for both; `hook prompt --client claude` for ben (fake stdin) puts the finding in
  `additionalContext`; ben's new intent (getPrice cents) removes the mismatch; ana's `disconnect` revokes the
  credential (`/me` 401, ben still 200), removes the created config files, credential and connection.
- `scripts/acceptance-live.ts` (opt-in, not in `npm test`; spends Claude usage): same setup, then two real
  `claude -p` sessions (`--mcp-config <clone>/.mcp.json --strict-mcp-config`, stream-json, hook events) with the
  README pricing and invoice tasks; writes a redacted trace to `acceptance/trace-<ts>.json` (git-ignored) and prints
  a table. Only `--dry-run` was run (bridge spawned exactly as `.mcp.json` says lists 16 hive tools per user).
- Release checks: see VERIFICATION.md "Hive Connect release checks".
- Hosted hub: `https://hive-hack-production.up.railway.app` runs commit `b22bea0` (Railpack builds the dashboard via the
  root `build` script). Verified against it on 2026-11-03: dashboard routes, the real CLI connect/status/bridge
  (16 tools)/disconnect round trip, and admin `model_diagnose` (verdict `no_models_for_host`, request ids in
  VERIFICATION.md "Hosted hub checks").
- Remaining: `npm publish` of `cli/` (human); Muse Code live session; a real two-agent run
  (`node --disable-warning=ExperimentalWarning scripts/acceptance-live.ts`); Meta accepting the Railway host (or an
  accepted egress via `HIVE_MODEL_PROXY_URL`) before hub-side model analysis works.
