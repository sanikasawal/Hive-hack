import { basename } from 'node:path';
import { Coordinator, type CoordinatorOptions, type SessionConnector, type SnapshotSession } from './domain/coordinator.ts';
import { CheckoutService, stripUrlCredentials } from './server/checkouts.ts';
import type { Finding, Intent, Snapshot } from './domain/types.ts';
import { GraphIndex, type FileChanges, type IndexedEdge, type IndexedSymbol } from './graph/index.ts';
import { ClaimService, type Claim, type ClaimRule } from './contracts/claims.ts';
import { ContractService, type ContractCheck } from './contracts/service.ts';
import type { ProposeInput, ReviseInput } from './domain/coordinator.ts';
import type { Contract, VerificationRun } from './domain/types.ts';
import { MetaAnalyzer, type ModelDiagnosis } from './intelligence/meta.ts';
import { AnalysisService } from './intelligence/service.ts';
import type { Analysis, Analyzer } from './intelligence/types.ts';
import { OperationEngine, type Gate } from './ops/engine.ts';
import type { ApplyResult, Proposal, SemanticOperation, OperationPreview } from './ops/types.ts';
import { RemoteChanges, type RemoteState } from './remote/service.ts';
import type { Store } from './store/sqlite.ts';

export interface ServiceOptions extends Omit<CoordinatorOptions, 'detectors' | 'store'> {
  store: Store;
  tsconfig?: string;
  gates?: Gate[];
  /** Test hook forwarded to the operation engine. */
  onFileWritten?: (file: string, index: number) => void;
  verifyAllow?: string[];
  requireAgreementForDependents?: boolean;
  /** Verification child timeout (default 120 s) and kept output bytes (default 64 KB). */
  verifyTimeoutMs?: number;
  verifyOutputLimit?: number;
  /** Model adapter. Defaults to MetaAnalyzer over MODEL_API_KEY; tests inject a fake. */
  analyzer?: Analyzer;
}
export interface GraphSummary { workspaceId: string; indexed: boolean; symbols: number; edges: number; files: number; lastSync: FileChanges | null }
export interface ServiceSnapshot extends Snapshot { sessions: SnapshotSession[]; graph: GraphSummary; proposals: Proposal[]; claims: Claim[]; analysis: Analysis | null; model: ModelSnapshot; remote?: RemoteState }
/** Model state for members/admins: the key itself never appears, only whether it is set on the hub. lastDiagnose is memory only. */
export interface ModelSnapshot { configured: boolean; model: string; baseUrlHost?: string | null; proxy?: boolean; lastDiagnose?: ModelDiagnosis | null }
export interface HookCheck {
  file: string;
  pendingContracts: { id: string; version: number; title: string; missing: string[] }[];
  declaredBy: { sessionId: string; name: string; task: string }[];
  dependentSessions: { sessionId: string; name: string; task: string }[];
  revision: number;
}
export interface SymbolReport { symbol: IndexedSymbol | null; dependents: IndexedEdge[]; dependentFiles: string[]; candidates: string[] }

const DIRECT_EDIT_WINDOW_MS = 10 * 60_000;

/**
 * Composition root used by the daemon: one coordinator, one compiler index per workspace,
 * direct-edit detection before every read, and compiler-backed findings.
 */
export class HiveService {
  readonly coordinator: Coordinator;
  readonly engine: OperationEngine;
  readonly contracts: ContractService;
  readonly claims: ClaimService;
  readonly analysis: AnalysisService;
  readonly analyzer: Analyzer;
  readonly remote: RemoteChanges;
  /** Hive Connect checkout reports, one per connector/member token. */
  readonly checkouts: CheckoutService;
  readonly store: Store;
  private readonly graphs = new Map<string, GraphIndex>();
  private readonly lastSync = new Map<string, FileChanges>();
  private readonly tsconfig: string | undefined;
  private readonly clock: () => number;
  /** Journals left 'writing' by a previous process and restored by the engine at construction. */
  readonly recoveredJournals: number;
  private cache: { snapshot: ServiceSnapshot; at: number; seq: number } | null = null;
  private dirty = true;
  private commandsInFlight = 0;

  constructor(options: ServiceOptions) {
    this.store = options.store;
    this.tsconfig = options.tsconfig;
    this.clock = options.clock ?? Date.now;
    this.coordinator = new Coordinator({ ...options, detectors: [intents => this.graphFindings(intents), () => this.directEditFindings(), () => this.claims.findings(this.graph()), () => this.remote.findings()] });
    this.checkouts = new CheckoutService(this.store, this.clock);
    this.remote = new RemoteChanges({ store: this.store, coordinator: this.coordinator, graph: () => this.graph(), clock: this.clock });
    this.claims = new ClaimService(this.store, this.coordinator.repositoryId, this.clock);
    this.contracts = new ContractService({ store: this.store, coordinator: this.coordinator, graph: id => this.graph(id), sync: id => this.sync(id), clock: this.clock,
      verifyAllow: options.verifyAllow, requireAgreementForDependents: options.requireAgreementForDependents,
      verifyTimeoutMs: options.verifyTimeoutMs, verifyOutputLimit: options.verifyOutputLimit });
    this.recoveredJournals = Number(this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM journal WHERE status = 'writing'")?.n ?? 0);
    this.engine = new OperationEngine({ store: this.store, coordinator: this.coordinator, graph: id => this.graph(id), sync: id => this.sync(id),
      gates: [this.contracts.gate(), this.claims.gate(id => this.graph(id)), ...(options.gates ?? [])], clock: this.clock, onFileWritten: options.onFileWritten });
    this.analyzer = options.analyzer ?? new MetaAnalyzer();
    this.analysis = new AnalysisService({ store: this.store, coordinator: this.coordinator, graph: id => this.graph(id), sync: id => this.sync(id), findings: () => this.coordinator.findings(), analyzer: this.analyzer, changes: () => this.remote.evidence(), clock: this.clock });
  }

  analyze(sessionId: string, options: { force?: boolean } = {}): Promise<Analysis> { return this.analysis.analyze(sessionId, options); }

  /** Pre-write check used by client hooks: is this file under a pending agreement or inside another session's declared scope? */
  hookCheck(file: string): HookCheck {
    const graph = this.graph();
    const rel = graph.rel(graph.abs(file));
    const pending = this.coordinator.contracts().filter(c => c.status === 'proposed' && c.producerSymbol?.split('#')[0] === rel)
      .map(c => ({ id: c.id, version: c.version, title: c.title, missing: c.participants.filter(p => !c.acknowledgements.includes(p)) }));
    const declaredBy = this.coordinator.intents().filter(i => i.files.includes(rel)).map(i => ({ sessionId: i.sessionId, name: this.coordinator.session(i.sessionId)?.name ?? i.sessionId, task: i.task }));
    const dependents = graph.symbolsInFile(rel).flatMap(symbol => graph.dependents(symbol.key)).filter(edge => edge.file !== rel);
    const dependentSessions = this.coordinator.intents().filter(i => dependents.some(edge => i.files.includes(edge.file))).map(i => ({ sessionId: i.sessionId, name: this.coordinator.session(i.sessionId)?.name ?? i.sessionId, task: i.task }));
    return { file: rel, pendingContracts: pending, declaredBy, dependentSessions, revision: this.coordinator.revision() };
  }

  // ---- operations (engine + contract evidence refresh) ----------------------------------------
  preview(sessionId: string, operation: SemanticOperation): OperationPreview { return this.engine.preview(sessionId, operation); }
  apply(sessionId: string, proposalId: string): ApplyResult {
    const result = this.engine.apply(sessionId, proposalId);
    if (result.status === 'applied') this.contracts.refresh();
    return result;
  }

  // ---- contracts ---------------------------------------------------------------------------------
  propose(sessionId: string, input: ProposeInput): Contract { this.sync(this.coordinator.heartbeat(sessionId).workspaceId); return this.contracts.propose(sessionId, input); }
  revise(sessionId: string, contractId: string, input: ReviseInput): Contract { return this.contracts.revise(sessionId, contractId, input); }
  contractCheck(sessionId: string, contractId: string): ContractCheck { return this.contracts.check(sessionId, contractId); }
  /** Starts verification and returns the run as 'running' immediately; see verifyStatus / waitForRun. */
  verify(sessionId: string, contractId: string, command: string): VerificationRun { return this.contracts.verify(sessionId, contractId, command); }
  verifyStatus(runId: string): VerificationRun { return this.contracts.status(runId); }
  /** Waits up to timeoutMs (default 90 s) for a run; a run still in flight comes back with status 'running'. */
  waitForRun(runId: string, timeoutMs?: number): Promise<VerificationRun> { return this.contracts.waitForRun(runId, timeoutMs); }
  /** Verification child processes still running; shutdown drains these with drainVerifications(). */
  get inFlightVerifications(): number { return this.contracts.inFlightVerifications; }
  drainVerifications(): Promise<void> { return this.contracts.drain(); }
  claim(sessionId: string, rule: ClaimRule): Claim {
    const session = this.coordinator.heartbeat(sessionId);
    const claim = this.claims.register(`${session.name} (${session.id})`, rule);
    this.coordinator.emit('claim.registered', `${rule.kind} ${rule.symbol}.${rule.field}${rule.type ? `: ${rule.type}` : ''} by ${session.name}`, { claimId: claim.id, sessionId });
    return claim;
  }

  /** Index for a workspace, built on first use. */
  graph(workspaceId: string = this.coordinator.workspaceId): GraphIndex {
    let graph = this.graphs.get(workspaceId);
    if (!graph) {
      const workspace = this.coordinator.workspace(workspaceId);
      graph = new GraphIndex({ store: this.store, workspaceId, root: workspace.realRoot, clock: this.clock,
        ...(workspaceId === this.coordinator.workspaceId && this.tsconfig ? { tsconfig: this.tsconfig } : {}) });
      this.graphs.set(workspaceId, graph);
    }
    if (!graph.isIndexed()) this.reindex(workspaceId, 'initial index');
    return graph;
  }

  /** Full reindex: bumps the code revision when sources changed and stales contracts touching them. */
  reindex(workspaceId: string = this.coordinator.workspaceId, reason = 'reindex requested'): FileChanges & { symbols: number; edges: number; files: number; revision: number } {
    const graph = this.graphs.get(workspaceId) ?? this.graph(workspaceId);
    const wasIndexed = graph.isIndexed();
    const result = graph.reindex();
    this.lastSync.set(workspaceId, { changed: result.changed, added: result.added, removed: result.removed });
    const touched = [...result.changed, ...result.added, ...result.removed];
    let revision = this.coordinator.revision();
    if (!wasIndexed || touched.length) {
      revision = this.coordinator.bumpRevision(`${reason}: ${touched.length ? touched.join(', ') : `${result.files} files indexed`}`);
      if (wasIndexed && touched.length) {
        this.coordinator.emit('direct_edit', `Files changed outside Hive operations: ${touched.join(', ')}`, { files: touched, workspaceId, revision });
        // A promise is not withdrawn by code; its implementation/verification evidence is re-derived.
        this.contracts.refresh();
      }
    }
    return { ...result, revision };
  }

  /** Cheap drift check on known files; reindexes when something changed. Called before reads and operations. */
  sync(workspaceId: string = this.coordinator.workspaceId): FileChanges {
    const graph = this.graph(workspaceId);
    const quick = graph.quickChanges();
    if (quick.changed.length || quick.removed.length) return this.reindex(workspaceId, 'direct edit detected');
    return quick;
  }

  graphSummary(workspaceId: string = this.coordinator.workspaceId): GraphSummary {
    const graph = this.graph(workspaceId);
    const count = (table: string) => Number(this.store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`, workspaceId)!.n);
    return { workspaceId, indexed: graph.isIndexed(), symbols: count('symbols'), edges: count('edges'), files: count('files'), lastSync: this.lastSync.get(workspaceId) ?? null };
  }

  symbolReport(reference: string, workspaceId: string = this.coordinator.workspaceId): SymbolReport {
    this.sync(workspaceId);
    const graph = this.graph(workspaceId);
    const symbol = graph.resolve(reference) ?? null;
    const candidates = symbol ? [] : graph.symbols().filter(s => s.key.includes(reference)).map(s => s.key).slice(0, 20);
    return { symbol, dependents: symbol ? graph.dependents(symbol.key) : [], dependentFiles: symbol ? graph.dependentFiles(symbol.key) : [], candidates };
  }

  /** Compiler-backed candidates: one session declares work on a symbol that another session's scope depends on. */
  graphFindings(intents: Intent[]): Finding[] {
    const findings: Finding[] = [];
    const seen = new Set<string>();
    for (const writer of intents) {
      const session = this.coordinator.session(writer.sessionId);
      if (!session) continue;
      const graph = this.graph(session.workspaceId);
      for (const reference of writer.symbols) {
        const symbol = graph.resolve(reference);
        if (!symbol) continue;
        const dependents = graph.dependents(symbol.key);
        if (!dependents.length) continue;
        for (const reader of intents) {
          if (reader.sessionId === writer.sessionId) continue;
          const hits = dependents.filter(edge => reader.files.includes(edge.file) || reader.symbols.some(s => graph.resolve(s)?.key === edge.from));
          if (!hits.length) continue;
          const id = [writer.sessionId, reader.sessionId, symbol.key].join('|');
          if (seen.has(id)) continue;
          seen.add(id);
          const where = hits.slice(0, 3).map(edge => `${edge.from} (${edge.file}:${edge.line})`).join('; ');
          findings.push({ kind: 'dependent_write', severity: 'warning', sessions: [writer.sessionId, reader.sessionId], source: 'compiler',
            symbols: [symbol.key], files: [...new Set(hits.map(h => h.file))],
            evidence: `${writer.sessionId} declares work on ${symbol.key} (${symbol.meta.signature ?? symbol.kind}); ${reader.sessionId}'s scope depends on it: ${where}` });
        }
      }
    }
    return findings;
  }

  /** Recent direct edits, surfaced as findings so clients see them after the fact. */
  directEditFindings(): Finding[] {
    const since = this.clock() - DIRECT_EDIT_WINDOW_MS;
    const intents = this.coordinator.intents();
    return this.coordinator.recentEvents(500).filter(event => event.type === 'direct_edit' && event.at >= since).map(event => {
      const files = (event.payload?.files as string[] | undefined) ?? [];
      const sessions = intents.filter(intent => intent.files.some(file => files.includes(file))).map(intent => intent.sessionId);
      return { kind: 'direct_edit', severity: 'info', sessions, source: 'deterministic', files, evidence: `${event.detail} (detected ${new Date(event.at).toISOString()}, revision ${String(event.payload?.revision ?? '?')})` } satisfies Finding;
    });
  }

  snapshot(): ServiceSnapshot {
    this.sync();
    return this.buildSnapshot();
  }

  /** Snapshot without a drift check: no file hashing, only DB reads and graph lookups. */
  private buildSnapshot(): ServiceSnapshot {
    const analyzer = this.analyzer as { configured?: boolean; model?: string; baseUrlHost?: string; proxy?: boolean };
    return { ...this.coordinator.snapshot(), graph: this.graphSummary(), proposals: this.engine.proposals(20), claims: this.claims.active(), analysis: this.analysis.latest(),
      model: { configured: analyzer.configured ?? true, model: analyzer.model ?? 'custom', baseUrlHost: analyzer.baseUrlHost ?? null, proxy: analyzer.proxy ?? false,
        lastDiagnose: this.analysis.lastDiagnose }, remote: this.remote.state() };
  }

  // ---- snapshot cache ------------------------------------------------------------------------------
  /**
   * Cached snapshot for HTTP reads. Rebuilt (without hashing files) when a command marked it dirty, an
   * event was emitted since it was built (e.g. an async verification finished) or a cached lease expired;
   * file drift is picked up by refreshTick() (the daemon's 5 s timer) or `fresh` (forces sync).
   */
  snapshotCached(options: { fresh?: boolean } = {}): ServiceSnapshot & { cacheAgeMs: number } {
    const now = this.clock();
    if (options.fresh) this.rebuild(true);
    else if (!this.cache || this.dirty || this.cache.seq !== this.coordinator.lastEventSeq()
      || this.cache.snapshot.sessions.some(session => session.expiresAt <= now)) this.rebuild(false);
    const cache = this.cache!;
    return { ...cache.snapshot, cacheAgeMs: Math.max(0, this.clock() - cache.at) };
  }
  /** Viewer-safe projection of the cached snapshot, with its age. */
  viewCached(options: { fresh?: boolean } = {}): HiveView & { cacheAgeMs: number } {
    const { cacheAgeMs, ...snapshot } = this.snapshotCached(options);
    return { ...this.viewSnapshot(snapshot), cacheAgeMs };
  }
  /** Marks the cached snapshot stale; the next read rebuilds it. */
  markDirty(): void { this.dirty = true; }
  /** Timer body: cheap drift check (quickChanges) on indexed workspaces; full sync + rebuild only on drift. */
  refreshTick(): { drift: boolean } {
    let drift = false;
    for (const [workspaceId, graph] of this.graphs) {
      if (!graph.isIndexed()) continue;
      const quick = graph.quickChanges();
      if (quick.changed.length || quick.removed.length) { this.reindex(workspaceId, 'direct edit detected'); drift = true; }
    }
    if (drift) this.rebuild(false);
    return { drift };
  }
  /** Starts the refresh timer (unref'd); returns a stop function. Errors are logged to stderr, never thrown. */
  startSnapshotTimer(intervalMs = 5_000): () => void {
    const timer = setInterval(() => {
      try { this.refreshTick(); } catch (error) { console.error('Hive: snapshot refresh failed:', error instanceof Error ? error.message : error); }
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
  /**
   * Command wrapper used by the daemon: counts in-flight commands (shutdown drains them) and marks the
   * snapshot dirty after a successful command.
   */
  async track<T>(run: () => T | Promise<T>): Promise<T> {
    this.commandsInFlight++;
    try {
      const result = await run();
      this.dirty = true;
      return result;
    } finally { this.commandsInFlight--; }
  }
  /** Commands (apply, verify start, analyze, ...) currently executing through track(). */
  get inFlightCommands(): number { return this.commandsInFlight; }
  /** Health without sync or compiler work: whether the default workspace has an index in the DB. */
  health(): { revision: number; indexed: boolean; recoveredJournals: number } {
    const graph = this.graphs.get(this.coordinator.workspaceId);
    const indexed = graph ? graph.isIndexed()
      : Boolean(this.store.get('SELECT 1 AS one FROM files WHERE workspace_id = ? LIMIT 1', this.coordinator.workspaceId));
    return { revision: this.coordinator.revision(), indexed, recoveredJournals: this.recoveredJournals };
  }
  private rebuild(sync: boolean): void {
    const snapshot = sync ? this.snapshot() : this.buildSnapshot();
    this.dirty = false;
    this.cache = { snapshot, at: this.clock(), seq: this.coordinator.lastEventSeq() };
  }

  /**
   * Viewer-safe projection. Pass a cached snapshot to avoid a sync; the extra lookups here are cheap
   * indexed reads (session names, acknowledgements per version, recent verification runs).
   */
  viewSnapshot(snapshot: ServiceSnapshot = this.snapshot()): HiveView {
    const sessionsById: ViewExtras['sessionsById'] = {};
    const signatures: ViewExtras['signatures'] = {};
    const runs: ViewExtras['runs'] = {};
    for (const session of snapshot.sessions) sessionsById[session.id] = { name: session.name, member: session.member ?? null };
    for (const contract of snapshot.contracts) {
      for (const id of contract.participants) {
        if (sessionsById[id]) continue;
        const session = this.coordinator.session(id);
        if (session) sessionsById[id] = { name: session.name, member: session.member ?? null };
      }
      signatures[contract.id] = this.store.all<{ version: number; session_id: string; created_at: number }>(
        'SELECT version, session_id, created_at FROM acknowledgements WHERE contract_id = ? ORDER BY version, created_at', contract.id)
        .map(row => ({ version: Number(row.version), sessionId: row.session_id, at: Number(row.created_at) }));
      runs[contract.id] = this.contracts.runs(contract.id).slice(-5);
    }
    return sanitizeView(snapshot, { sessionsById, signatures, runs });
  }

  /** Members with their active sessions. Token metadata (never values) is included only when the caller passes it (admin). */
  members(tokens: MemberToken[] = [], snapshot: Pick<ServiceSnapshot, 'sessions' | 'intents'> = { sessions: this.coordinator.sessions(), intents: this.coordinator.intents() },
    connectorTokens: MemberToken[] = []): MemberSummary[] {
    const byMember = new Map<string, MemberSummary>();
    const entry = (member: string): MemberSummary => {
      let found = byMember.get(member);
      if (!found) { found = { member, roles: [], tokens: [], connectors: [], sessions: [] }; byMember.set(member, found); }
      return found;
    };
    for (const token of tokens) {
      const found = entry(token.member);
      if (token.revokedAt === null && !found.roles.includes(token.role)) found.roles.push(token.role);
      found.tokens.push({ id: token.id, label: token.label, role: token.role, kind: token.kind ?? 'member', prefix: token.prefix, createdAt: token.createdAt, lastUsedAt: token.lastUsedAt, revokedAt: token.revokedAt });
    }
    for (const token of [...tokens, ...connectorTokens]) {
      if (token.kind !== 'connector' || token.revokedAt !== null) continue;
      const found = entry(token.member);
      const list = found.connectors ??= [];
      if (list.some(c => c.tokenId === token.id)) continue;
      list.push(connectorSummary(token, this.checkouts.get(token.id)));
    }
    for (const session of snapshot.sessions) {
      const found = entry(session.member ?? OPERATOR);
      if (found.member === OPERATOR && !found.roles.includes('admin')) found.roles.push('admin');
      const intent = snapshot.intents.find(i => i.sessionId === session.id);
      found.sessions.push({ id: session.id, agent: session.name, client: session.client, task: intent ? cap(intent.task, 120) : null });
    }
    return [...byMember.values()];
  }
}

// ---- viewer-safe projection (pure) ------------------------------------------------------------------
const OPERATOR = 'operator';
export interface MemberToken { id: string; label: string; member: string; role: string; kind?: string; repoIdentity?: string | null; machine?: string | null; prefix: string;
  createdAt: number; lastUsedAt: number | null; lastSeenAt?: number | null; revokedAt: number | null }
/** An active connector credential and its last checkout report (relative paths only, no remote URL). */
export interface ConnectorSummary {
  tokenId: string; label: string; machine: string | null; repoIdentity: string | null; repoName: string | null; branch: string | null;
  headShort: string | null; dirtyCount: number; reportedAt: number | null; lastUsedAt: number | null; createdAt: number;
}
export interface MemberSummary {
  member: string;
  roles: string[];
  tokens: Pick<MemberToken, 'id' | 'label' | 'role' | 'kind' | 'prefix' | 'createdAt' | 'lastUsedAt' | 'revokedAt'>[];
  /** Active connectors for this member. Admins see everyone's; a member sees their own. */
  connectors?: ConnectorSummary[];
  sessions: { id: string; agent: string; client: string | null; task: string | null }[];
}
export interface ViewExtras {
  sessionsById: Record<string, { name: string; member: string | null }>;
  signatures: Record<string, { version: number; sessionId: string; at: number }[]>;
  runs: Record<string, VerificationRun[]>;
}
export interface ViewSessionRef { sessionId: string; member: string | null; agent: string | null }
export interface HiveView {
  workspace: { name: string };
  revision: number;
  graph: { indexed: boolean; symbols: number; files: number };
  model: { configured: boolean; model: string };
  sessions: { id: string; member: string; agent: string; task: string | null; step: string; connector?: SessionConnector | null }[];
  members: { member: string; sessions: number }[];
  findings: { kind: string; severity: string; source: string; evidence: string; sessions: string[]; symbols: string[]; files: string[] }[];
  contracts: {
    id: string; title: string; version: number; status: string; producerSymbol: string | null;
    participants: (ViewSessionRef & { signedCurrent: boolean })[];
    versions: { version: number; declaration: string; at: number; signedBy: (ViewSessionRef & { at: number })[] }[];
    implemented: { symbol: string; revision: number; at: number } | null;
    verification: { id: string; version: number; command: string; status: string; exitCode: number | null; passed: boolean; revision: number; at: number; finishedAt: number | null }[];
    staleReason: string | null;
    createdAt: number; updatedAt: number;
  }[];
  events: ViewEvent[];
  analysis: { status: string; summary: string; model: string | null; latencyMs: number | null; findings: number; at: number; relayedBy?: string } | null;
  /** Laptop sync: which members have uncommitted changes Hive is checking (relative paths only). */
  remote?: { baseCommit: string | null; members: { member: string; files: { path: string; deleted: boolean; updatedAt: number }[] }[] };
}
export interface ViewEvent { seq: number; at: number; type: string; detail: string }

function connectorSummary(token: MemberToken, checkout: { machine: string | null; repo: { name: string; identity: string | null }; branch: string | null; head: string | null; dirty: unknown[]; reportedAt: number } | undefined): ConnectorSummary {
  const clean = (value: string | null | undefined, max: number) => value ? cap(stripUrlCredentials(value), max) : null;
  return { tokenId: token.id, label: cap(token.label, 80), machine: clean(token.machine ?? checkout?.machine, 80), repoIdentity: clean(token.repoIdentity ?? checkout?.repo.identity, 200),
    repoName: clean(checkout?.repo.name, 120), branch: clean(checkout?.branch, 120), headShort: checkout?.head ? checkout.head.slice(0, 7) : null,
    dirtyCount: checkout?.dirty.length ?? 0, reportedAt: checkout?.reportedAt ?? null, lastUsedAt: token.lastUsedAt, createdAt: token.createdAt };
}

export function cap(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
/** Removes workspace roots, other absolute paths and token-shaped strings, then caps the length. */
export function scrubText(value: string, roots: string[], max: number): string {
  let out = stripUrlCredentials(value);
  for (const root of [...roots].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(`${root}/`).join('').split(root).join('.');
  out = out.replace(/(^|[\s(:'"=,[])(?:~\/|\/|[A-Za-z]:\\)[^\s'"(),\]]+/g, '$1[path]');
  out = out.replace(/hive_(adm|mem|view)_[0-9A-Za-z]+/g, 'hive_$1_[redacted]');
  return cap(out, max);
}
function relativeOnly(values: string[] | undefined, max = 50): string[] {
  return (values ?? []).filter(v => !v.startsWith('/') && !v.startsWith('~') && !/^[A-Za-z]:[\\/]/.test(v) && !v.split(/[\\/]/).includes('..'))
    .slice(0, max).map(v => cap(v, 200));
}
export function sanitizeEvents(events: { seq: number; at: number; type: string; detail: string }[], roots: string[]): ViewEvent[] {
  return events.map(event => ({ seq: event.seq, at: event.at, type: cap(event.type, 80), detail: scrubText(event.detail, roots, 200) }));
}
const STEP_RANK: Record<string, number> = { proposed: 1, accepted: 2, implemented: 3, verified: 4 };
const STEP_LABEL = ['declared intent', 'agreement proposed', 'agreement accepted', 'implemented', 'verified'];

/** Presentation-only view for viewers: no absolute paths, excerpts, diffs, hook payloads, assumptions or token values. */
export function sanitizeView(snapshot: ServiceSnapshot, extras: ViewExtras): HiveView {
  const roots = [snapshot.repository.canonicalRoot, ...snapshot.workspaces.map(w => w.realRoot)];
  const text = (value: string, max: number) => scrubText(value, roots, max);
  const ref = (sessionId: string): ViewSessionRef => {
    const known = extras.sessionsById[sessionId];
    return { sessionId, member: known ? known.member ?? OPERATOR : null, agent: known ? cap(known.name, 80) : null };
  };
  const sessions = snapshot.sessions.map(session => {
    const intent = snapshot.intents.find(i => i.sessionId === session.id);
    let rank = -1;
    if (intent) {
      rank = 0;
      for (const contract of snapshot.contracts) if (contract.participants.includes(session.id)) rank = Math.max(rank, STEP_RANK[contract.status] ?? 0);
    }
    const c = session.connector;
    const connector: SessionConnector | null = c ? { machine: c.machine ? text(c.machine, 80) : null, repoName: text(c.repoName, 120),
      branch: c.branch ? text(c.branch, 120) : null, headShort: c.headShort && /^[0-9a-f]{1,12}$/i.test(c.headShort) ? c.headShort : null,
      dirtyCount: Math.max(0, Math.trunc(c.dirtyCount)), reportedAt: c.reportedAt } : null;
    return { id: session.id, member: cap(session.member ?? OPERATOR, 80), agent: cap(session.name, 80), task: intent ? text(intent.task, 120) : null,
      step: rank < 0 ? 'joined' : STEP_LABEL[rank]!, connector };
  });
  const members = new Map<string, number>();
  for (const session of sessions) members.set(session.member, (members.get(session.member) ?? 0) + 1);
  return {
    workspace: { name: cap(basename(snapshot.repository.canonicalRoot), 80) },
    revision: snapshot.repository.revision,
    graph: { indexed: snapshot.graph.indexed, symbols: snapshot.graph.symbols, files: snapshot.graph.files },
    model: { configured: snapshot.model.configured, model: cap(snapshot.model.model, 80) },
    sessions,
    members: [...members].map(([member, count]) => ({ member, sessions: count })),
    findings: snapshot.findings.map(finding => ({ kind: finding.kind, severity: finding.severity, source: finding.source, evidence: text(finding.evidence, 300),
      sessions: finding.sessions.slice(0, 10), symbols: relativeOnly(finding.symbols), files: relativeOnly(finding.files) })),
    contracts: snapshot.contracts.map(contract => {
      const signed = extras.signatures[contract.id] ?? contract.acknowledgementDetails.map(a => ({ version: a.version, sessionId: a.sessionId, at: a.at }));
      const implemented = contract.evidence.implemented;
      const runs = extras.runs[contract.id] ?? (contract.evidence.verification ? [contract.evidence.verification] : []);
      return {
        id: contract.id, title: text(contract.title, 200), version: contract.version, status: contract.status,
        producerSymbol: contract.producerSymbol ? relativeOnly([contract.producerSymbol])[0] ?? null : null,
        participants: contract.participants.map(id => ({ ...ref(id), signedCurrent: signed.some(s => s.version === contract.version && s.sessionId === id) })),
        versions: contract.history.map(v => ({ version: v.version, declaration: text(v.declaration, 2000), at: v.at,
          signedBy: signed.filter(s => s.version === v.version).map(s => ({ ...ref(s.sessionId), at: s.at })) })),
        implemented: implemented ? { symbol: relativeOnly([implemented.symbol])[0] ?? '[path]', revision: implemented.revision, at: implemented.at } : null,
        verification: runs.map(run => ({ id: run.id, version: run.version, command: text(run.command, 200), status: run.status ?? (run.passed ? 'passed' : 'failed'),
          exitCode: run.exitCode, passed: run.passed, revision: run.revision, at: run.at, finishedAt: run.finishedAt ?? null })),
        staleReason: contract.evidence.staleReason ? text(contract.evidence.staleReason, 200) : null,
        createdAt: contract.createdAt, updatedAt: contract.updatedAt,
      };
    }),
    events: sanitizeEvents(snapshot.events.slice(-100), roots),
    analysis: snapshot.analysis ? { status: snapshot.analysis.status, summary: text(snapshot.analysis.summary, 300), model: snapshot.analysis.model,
      latencyMs: snapshot.analysis.latencyMs, findings: snapshot.analysis.findings.length, at: snapshot.analysis.at,
      ...(snapshot.analysis.relayedBy ? { relayedBy: cap(snapshot.analysis.relayedBy, 80) } : {}) } : null,
    remote: { baseCommit: snapshot.remote?.baseCommit ? snapshot.remote.baseCommit.slice(0, 12) : null,
      members: (snapshot.remote?.members ?? []).slice(0, 20).map(m => ({ member: cap(m.member, 80),
        files: m.files.filter(f => relativeOnly([f.path]).length).slice(0, 50).map(f => ({ path: cap(f.path, 200), deleted: f.deleted, updatedAt: f.updatedAt })) })) },
  };
}
