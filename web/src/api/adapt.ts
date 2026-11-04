// Pure adapters from wire data to the ServiceSnapshot shape the screens render.
// Viewers receive the viewer-safe HiveView; it is lifted into a ServiceSnapshot with every field
// the view does not carry left empty (no paths, payloads, assumptions or proposals are invented).
import type { Event, EventItem, ServiceSnapshot, SnapshotResponse, VerificationRun, ViewResponse } from './types.ts';

type Contract = ServiceSnapshot['contracts'][number];
type ViewContract = ViewResponse['contracts'][number];

const OPERATOR = 'operator';

/** "Sanika · pricing agent": member prefix added when the agent name does not already carry it. */
export function displaySessionName(name: string, member: string | null | undefined): string {
  if (!member || member === OPERATOR) return name;
  return name === member || name.startsWith(`${member} · `) ? name : `${member} · ${name}`;
}

export function viewRunToRun(contractId: string, run: ViewContract['verification'][number]): VerificationRun {
  const status = (['running', 'passed', 'failed', 'inconclusive', 'error'] as const).find(s => s === run.status) ?? (run.passed ? 'passed' : 'failed');
  return { id: run.id, contractId, version: run.version, command: run.command, status, exitCode: run.exitCode, passed: run.passed,
    overlay: false, revision: run.revision, sourceHashes: {}, output: '', reasons: [], at: run.at, finishedAt: run.finishedAt };
}

function viewContractToContract(contract: ViewContract): Contract {
  const latest = contract.versions.find(v => v.version === contract.version) ?? contract.versions[contract.versions.length - 1];
  const runs = contract.verification.map(run => viewRunToRun(contract.id, run));
  const participants = contract.participants.map(p => p.sessionId);
  return {
    id: contract.id, version: contract.version, title: contract.title, ownerSessionId: participants[0] ?? '',
    producerSymbol: contract.producerSymbol, declaration: latest?.declaration ?? '', behaviorNotes: '',
    participants,
    acknowledgements: contract.participants.filter(p => p.signedCurrent).map(p => p.sessionId),
    acknowledgementDetails: contract.versions.flatMap(v => v.signedBy.map(s => ({ sessionId: s.sessionId, version: v.version, intentRevision: 0, at: s.at }))),
    intentRevisions: {},
    status: contract.status as Contract['status'],
    evidence: {
      implemented: contract.implemented ? { symbol: contract.implemented.symbol, file: '', declarationHash: '', declaration: '', revision: contract.implemented.revision, at: contract.implemented.at } : null,
      verification: runs.length ? runs[runs.length - 1]! : null,
      ...(contract.staleReason ? { staleReason: contract.staleReason } : {}),
    },
    history: contract.versions.map(v => ({ version: v.version, declaration: v.declaration, behaviorNotes: '', participants, at: v.at })),
    createdAt: contract.createdAt, updatedAt: contract.updatedAt,
  };
}

/** Lifts the viewer-safe view into a ServiceSnapshot. `events` (from /events) replace the view's recent ones when present. */
export function viewToSnapshot(view: ViewResponse, events: EventItem[] = [], now = Date.now()): SnapshotResponse {
  const sessions = view.sessions.map(s => ({ id: s.id, name: displaySessionName(s.agent, s.member), workspaceId: '', client: null,
    expiresAt: now + 60_000, status: 'active' as const, member: s.member, tokenId: null, connector: s.connector ?? null }));
  const intents = view.sessions.filter(s => s.task !== null).map(s => ({ sessionId: s.id, task: s.task!, files: [], symbols: [], assumptions: [], revision: 0, at: 0 }));
  return {
    repository: { id: '', canonicalRoot: view.workspace.name, revision: view.revision },
    workspaces: [], sessions, intents,
    contracts: view.contracts.map(viewContractToContract),
    findings: view.findings.map(f => ({ kind: f.kind as ServiceSnapshot['findings'][number]['kind'], severity: f.severity as 'error' | 'warning' | 'info',
      sessions: f.sessions, evidence: f.evidence, source: f.source as 'deterministic' | 'compiler' | 'model', symbols: f.symbols, files: f.files })),
    events: (events.length ? events : view.events) as Event[],
    graph: { workspaceId: '', indexed: view.graph.indexed, symbols: view.graph.symbols, edges: 0, files: view.graph.files, lastSync: null },
    proposals: [], claims: [],
    analysis: view.analysis ? { id: '', status: view.analysis.status as NonNullable<ServiceSnapshot['analysis']>['status'], summary: view.analysis.summary,
      findings: [], model: view.analysis.model, latencyMs: view.analysis.latencyMs, usage: null, attempts: 0, dropped: [], inputHash: '', revision: view.revision,
      error: null, evidenceRefs: { symbols: [], files: [], sessions: [], candidates: 0 }, at: view.analysis.at,
      ...(view.analysis.relayedBy ? { relayedBy: view.analysis.relayedBy } : {}) } : null,
    model: view.model,
    ...(view.remote ? { remote: { baseCommit: view.remote.baseCommit, members: view.remote.members.map(m => ({ member: m.member, baseCommit: null, files: m.files })) } } : {}),
    cacheAgeMs: view.cacheAgeMs,
  };
}

/** Member/admin snapshot with session display names normalized and the accumulated event log swapped in. */
export function normalizeSnapshot(snapshot: SnapshotResponse, events: EventItem[] = []): SnapshotResponse {
  return {
    ...snapshot,
    sessions: snapshot.sessions.map(s => ({ ...s, name: displaySessionName(s.name, s.member) })),
    events: events.length ? (events as Event[]) : snapshot.events,
  };
}

/** Display names for every session the data mentions, including expired agreement participants (view only). */
export function sessionNames(snapshot: ServiceSnapshot, view: ViewResponse | null): Record<string, string> {
  const names: Record<string, string> = {};
  for (const contract of view?.contracts ?? []) {
    for (const p of contract.participants) if (p.agent) names[p.sessionId] = displaySessionName(p.agent, p.member);
  }
  for (const event of snapshot.events) {
    const payload = (event as Event).payload;
    if (event.type === 'session.registered' && payload && typeof payload.sessionId === 'string' && typeof payload.name === 'string') {
      names[payload.sessionId] = typeof payload.member === 'string' ? displaySessionName(payload.name, payload.member) : payload.name;
    }
  }
  for (const session of snapshot.sessions) names[session.id] = session.name;
  return names;
}
