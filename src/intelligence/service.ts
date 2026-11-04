import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Coordinator } from '../domain/coordinator.ts';
import type { Finding } from '../domain/types.ts';
import { sha256, type GraphIndex } from '../graph/index.ts';
import type { Store } from '../store/sqlite.ts';
import type { ModelDiagnosis } from './meta.ts';
import { AnalysisInvalid, AnalysisUnavailable, type Analysis, type Analyzer, type EvidenceBundle, type EvidenceChange, type EvidenceDependent, type EvidenceSymbol } from './types.ts';

export interface AnalysisServiceOptions {
  store: Store;
  coordinator: Coordinator;
  graph: (workspaceId: string) => GraphIndex;
  sync: (workspaceId: string) => unknown;
  findings: () => Finding[];
  analyzer: Analyzer;
  /** Laptop changes to include as evidence (bounded by the provider). */
  changes?: () => EvidenceChange[];
  clock?: () => number;
}
type Row = { id: string; input_hash: string; revision: number; status: Analysis['status']; model: string | null; latency_ms: number | null; usage_json: string | null; result_json: string | null; error: string | null; created_at: number };

const EXCERPT_LINES = 40;
const MAX_SYMBOLS = 24;
const MAX_DEPENDENTS = 40;

/**
 * Explicit, cached model analysis. Selects a bounded evidence set, never holds a DB transaction
 * across the model call, re-checks the input hash after the response, and records failures as
 * visible `unavailable` / `invalid` states instead of silently reporting "no conflict".
 */
export class AnalysisService {
  private readonly store: Store;
  private readonly coordinator: Coordinator;
  private readonly graphFor: (workspaceId: string) => GraphIndex;
  private readonly sync: (workspaceId: string) => unknown;
  private readonly findings: () => Finding[];
  private readonly analyzer: Analyzer;
  private readonly changes: () => EvidenceChange[];
  private readonly clock: () => number;
  private inFlight: Promise<Analysis> | null = null;

  constructor(options: AnalysisServiceOptions) {
    this.store = options.store; this.coordinator = options.coordinator; this.graphFor = options.graph; this.sync = options.sync;
    this.findings = options.findings; this.analyzer = options.analyzer; this.changes = options.changes ?? (() => []); this.clock = options.clock ?? Date.now;
  }

  /** Bounded evidence: live intents, candidates, live contracts, declarations named by intents/candidates, their dependents. */
  buildEvidence(workspaceId: string = this.coordinator.workspaceId): EvidenceBundle {
    const graph = this.graphFor(workspaceId);
    const intents = this.coordinator.intents();
    const candidates = this.findings().filter(f => f.kind !== 'direct_edit');
    const contracts = this.coordinator.contracts().filter(c => ['proposed', 'accepted', 'implemented', 'verified'].includes(c.status))
      .map(c => ({ id: c.id, version: c.version, title: c.title, producerSymbol: c.producerSymbol, declaration: c.declaration, behaviorNotes: c.behaviorNotes, participants: c.participants, status: c.status }));
    const wanted = new Set<string>();
    for (const intent of intents) {
      for (const symbol of intent.symbols) wanted.add(symbol);
      for (const assumption of intent.assumptions) wanted.add(assumption.key.replace(/:[^#:]*$/, ''));
    }
    for (const candidate of candidates) for (const symbol of candidate.symbols ?? []) wanted.add(symbol);
    const symbols: EvidenceSymbol[] = [];
    const dependents: EvidenceDependent[] = [];
    const seen = new Set<string>();
    for (const reference of wanted) {
      const symbol = graph.resolve(reference);
      if (!symbol || seen.has(symbol.key) || symbols.length >= MAX_SYMBOLS) continue;
      seen.add(symbol.key);
      symbols.push({ key: symbol.key, file: symbol.file, line: symbol.line, kind: symbol.kind, signature: symbol.meta.signature ?? null, excerpt: excerpt(graph, symbol.file, symbol.line) });
      for (const edge of graph.dependents(symbol.key).slice(0, 10)) {
        if (dependents.length >= MAX_DEPENDENTS) break;
        dependents.push({ symbol: symbol.key, from: edge.from, file: edge.file, line: edge.line });
      }
    }
    const revision = this.coordinator.revision();
    const changes = this.changes();
    const inputHash = sha256(JSON.stringify({ revision, intents: intents.map(i => [i.sessionId, i.revision]), contracts: contracts.map(c => [c.id, c.version, c.status]), candidates: candidates.map(c => [c.kind, c.sessions, c.evidence]), symbols: symbols.map(s => s.key),
      ...(changes.length ? { changes: changes.map(c => [c.member, c.file, sha256(c.diff)]) } : {}) }));
    return { revision, inputHash, intents, candidates, contracts, symbols, dependents, ...(changes.length ? { changes } : {}) };
  }

  private rowToAnalysis(row: Row): Analysis {
    const result = row.result_json ? JSON.parse(row.result_json) as Partial<Analysis> : {};
    return { id: row.id, status: row.status, summary: result.summary ?? '', findings: result.findings ?? [], model: row.model, latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
      usage: row.usage_json ? JSON.parse(row.usage_json) as Analysis['usage'] : null, attempts: result.attempts ?? 0, dropped: result.dropped ?? [], inputHash: row.input_hash,
      revision: Number(row.revision), error: row.error, evidenceRefs: result.evidenceRefs ?? { symbols: [], files: [], sessions: [], candidates: 0 }, at: Number(row.created_at),
      ...(result.relayedBy ? { relayedBy: result.relayedBy } : {}) };
  }
  latest(): Analysis | null {
    const row = this.store.get<Row>('SELECT * FROM analyses WHERE repository_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', this.coordinator.repositoryId);
    return row ? this.rowToAnalysis(row) : null;
  }
  list(limit = 20): Analysis[] {
    return this.store.all<Row>('SELECT * FROM analyses WHERE repository_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', this.coordinator.repositoryId, limit).map(r => this.rowToAnalysis(r)).reverse();
  }
  private record(analysis: Analysis): Analysis {
    this.store.transaction(() => {
      this.store.run('INSERT INTO analyses(id, repository_id, input_hash, revision, status, model, latency_ms, usage_json, result_json, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        analysis.id, this.coordinator.repositoryId, analysis.inputHash, analysis.revision, analysis.status, analysis.model, analysis.latencyMs, analysis.usage ? JSON.stringify(analysis.usage) : null,
        JSON.stringify({ summary: analysis.summary, findings: analysis.findings, attempts: analysis.attempts, dropped: analysis.dropped, evidenceRefs: analysis.evidenceRefs,
          ...(analysis.relayedBy ? { relayedBy: analysis.relayedBy } : {}) }), analysis.error, analysis.at);
      this.coordinator.emit(`analysis.${analysis.status}`, analysis.status === 'ok' || analysis.status === 'stale' ? `${analysis.model}: ${analysis.findings.length} finding(s), ${analysis.latencyMs} ms` : analysis.error ?? analysis.status,
        { analysisId: analysis.id, status: analysis.status, model: analysis.model, findings: analysis.findings.length });
    });
    return analysis;
  }

  // ---- model diagnosis (admin) ----------------------------------------------------------------------
  private lastDiagnosis: ModelDiagnosis | null = null;
  /** The most recent model_diagnose result since this hub started (memory only). */
  get lastDiagnose(): ModelDiagnosis | null { return this.lastDiagnosis; }
  /** Runs the analyzer's diagnosis (GET /models + a one-token chat completion from this hub) and keeps the result. */
  async diagnose(): Promise<ModelDiagnosis> {
    const analyzer = this.analyzer as Partial<{ diagnose(): Promise<ModelDiagnosis> }>;
    if (typeof analyzer.diagnose !== 'function') throw new Error('This Hive analyzer does not support model_diagnose');
    const result = await analyzer.diagnose.call(this.analyzer);
    this.lastDiagnosis = result;
    return result;
  }

  // ---- laptop relay ---------------------------------------------------------------------------------
  // When this host cannot reach the model (the Meta API returns no models to some cloud hosts), a member's
  // laptop sends the request with its own key and posts back the raw response. Hive builds the request and
  // validates the answer exactly as for a direct call; the laptop only carries bytes.
  private relays = new Map<string, { bundle: EvidenceBundle; known: string[]; at: number }>();

  relayRequest(): { inputHash: string; revision: number; model: string; baseUrl: string; body: string } {
    const analyzer = this.analyzer as Partial<{ requestBody(b: EvidenceBundle): string; model: string; baseUrl: string }>;
    if (typeof analyzer.requestBody !== 'function') throw new Error('This Hive analyzer does not support laptop relay');
    this.sync(this.coordinator.workspaceId);
    const bundle = this.buildEvidence();
    const known = [...new Set([...bundle.intents.map(i => i.sessionId), ...(bundle.changes ?? []).flatMap(c => c.sessionIds)])];
    const now = this.clock();
    for (const [hash, entry] of this.relays) if (now - entry.at > 10 * 60_000) this.relays.delete(hash);
    this.relays.set(bundle.inputHash, { bundle, known, at: now });
    return { inputHash: bundle.inputHash, revision: bundle.revision, model: analyzer.model ?? 'muse-spark-1.3', baseUrl: analyzer.baseUrl ?? 'https://api.meta.ai/v1', body: analyzer.requestBody(bundle) };
  }

  relaySubmit(input: { inputHash: string; httpStatus: number; responseText: string; latencyMs: number; via: string }): Analysis {
    const entry = this.relays.get(input.inputHash);
    if (!entry) throw new Error('Unknown or expired relay request; request a new one');
    this.relays.delete(input.inputHash);
    const analyzer = this.analyzer as Partial<{ parseResponse(t: string, b: EvidenceBundle, k: string[], l: number): Awaited<ReturnType<Analyzer['analyze']>> }>;
    const { bundle } = entry;
    const base: Analysis = { id: randomUUID(), status: 'unavailable', summary: '', findings: [], model: null, latencyMs: input.latencyMs, usage: null, attempts: 1, dropped: [], inputHash: bundle.inputHash,
      revision: bundle.revision, error: null, at: this.clock(), relayedBy: input.via,
      evidenceRefs: { symbols: bundle.symbols.map(s => s.key), files: [...new Set([...bundle.symbols.map(s => s.file), ...(bundle.changes ?? []).map(c => c.file)])], sessions: bundle.intents.map(i => i.sessionId), candidates: bundle.candidates.length } };
    if (input.httpStatus < 200 || input.httpStatus >= 300) {
      const sentence = input.httpStatus === 0 ? `The laptop relaying this request (${input.via}) could not reach the model provider.`
        : `The model provider did not accept the request relayed by ${input.via} (HTTP ${input.httpStatus}).`;
      return this.record({ ...base, error: `${sentence} Details: Meta API HTTP ${input.httpStatus} (relayed by ${input.via}): ${input.responseText.slice(0, 300)}` });
    }
    try {
      const result = analyzer.parseResponse!(input.responseText, bundle, entry.known, input.latencyMs);
      const status: Analysis['status'] = this.buildEvidence().inputHash === bundle.inputHash ? 'ok' : 'stale';
      return this.record({ ...base, status, summary: result.summary, findings: result.findings, model: result.model, usage: result.usage, dropped: result.dropped,
        error: status === 'stale' ? 'Code or intents changed while the model was thinking; kept for reference. Run again.' : null });
    } catch (error) {
      if (error instanceof AnalysisInvalid) return this.record({ ...base, status: 'invalid', error: `${error.message} (relayed by ${input.via})` });
      throw error;
    }
  }

  /** Runs (or reuses) an analysis for the current evidence. Concurrent callers share one in-flight request. */
  analyze(sessionId: string, options: { force?: boolean } = {}): Promise<Analysis> {
    const session = this.coordinator.heartbeat(sessionId);
    this.sync(session.workspaceId);
    const bundle = this.buildEvidence(session.workspaceId);
    if (!options.force) {
      const cached = this.store.get<Row>("SELECT * FROM analyses WHERE repository_id = ? AND input_hash = ? AND status = 'ok' ORDER BY created_at DESC LIMIT 1", this.coordinator.repositoryId, bundle.inputHash);
      if (cached) return Promise.resolve({ ...this.rowToAnalysis(cached), status: 'cached' });
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run(bundle, session.workspaceId).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async run(bundle: EvidenceBundle, workspaceId: string): Promise<Analysis> {
    const base: Analysis = { id: randomUUID(), status: 'unavailable', summary: '', findings: [], model: null, latencyMs: null, usage: null, attempts: 0, dropped: [], inputHash: bundle.inputHash,
      revision: bundle.revision, error: null, at: this.clock(),
      evidenceRefs: { symbols: bundle.symbols.map(s => s.key), files: [...new Set([...bundle.symbols.map(s => s.file), ...(bundle.changes ?? []).map(c => c.file)])], sessions: bundle.intents.map(i => i.sessionId), candidates: bundle.candidates.length } };
    try {
      const result = await this.analyzer.analyze(bundle, [...new Set([...bundle.intents.map(i => i.sessionId), ...(bundle.changes ?? []).flatMap(c => c.sessionIds)])]);
      // Revalidate: inputs may have moved while the model was thinking.
      const after = this.buildEvidence(workspaceId);
      const status: Analysis['status'] = after.inputHash === bundle.inputHash ? 'ok' : 'stale';
      return this.record({ ...base, status, summary: result.summary, findings: result.findings, model: result.model, latencyMs: result.latencyMs, usage: result.usage, attempts: result.attempts, dropped: result.dropped,
        error: status === 'stale' ? 'Intents, contracts or code changed during analysis; result is kept for reference but not cached. Run again.' : null });
    } catch (error) {
      if (error instanceof AnalysisUnavailable) return this.record({ ...base, status: 'unavailable', attempts: error.attempts, error: error.message });
      if (error instanceof AnalysisInvalid) return this.record({ ...base, status: 'invalid', attempts: error.attempts, error: error.message });
      return this.record({ ...base, status: 'unavailable', error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function excerpt(graph: GraphIndex, file: string, line: number): string {
  const abs = graph.abs(file);
  if (!existsSync(abs)) return '';
  const lines = readFileSync(abs, 'utf8').split('\n');
  return lines.slice(Math.max(0, line - 1), line - 1 + EXCERPT_LINES).join('\n');
}
