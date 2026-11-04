import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../store/sqlite.ts';
import { detect } from './detect.ts';
import type {
  Acknowledgement, Contract, ContractEvidence, ContractStatus, ContractVersion, Event, Finding,
  Intent, IntentInput, Repository, Session, SessionStatus, Snapshot, Workspace,
} from './types.ts';

const PENDING_CONTRACT: ContractStatus[] = ['proposed', 'accepted', 'implemented'];
const LIVE_CONTRACT: ContractStatus[] = ['proposed', 'accepted', 'implemented', 'verified'];

export interface CoordinatorOptions {
  store?: Store;
  clock?: () => number;
  ttl?: number;
  /** Canonical project root. Defaults to the current working directory. */
  root?: string;
  /** Extra finding producers (compiler graph, claims). Each receives the live intents. */
  detectors?: Array<(intents: Intent[]) => Finding[]>;
}
export interface RegisterOptions { workspace?: string; client?: string; tokenId?: string | null; member?: string | null }
export interface ProposeInput {
  title: string;
  declaration: string;
  participants: string[];
  producerSymbol?: string;
  behaviorNotes?: string;
  proposalId?: string;
}
export interface ReviseInput { title?: string; declaration?: string; behaviorNotes?: string }
/** The local checkout behind a session, from the last checkout_report of the session's token (Hive Connect). */
export interface SessionConnector { machine: string | null; repoName: string; branch: string | null; headShort: string | null; dirtyCount: number; reportedAt: number }
export type SnapshotSession = Session & { connector?: SessionConnector | null };

type SessionRow = { id: string; workspace_id: string; name: string; client: string | null; lease_expires_at: number; status: SessionStatus; token_id: string | null; member: string | null };
type IntentRow = { session_id: string; revision: number; task: string; scope_json: string; assumptions_json: string; created_at: number };
type ContractRow = {
  id: string; version: number; owner_session_id: string; title: string; producer_symbol: string | null; declaration: string;
  behavior_notes: string; participants_json: string; intent_revisions_json: string; status: ContractStatus; evidence_json: string;
  created_at: number; updated_at: number;
};

type EventRow = { seq: number; type: string; payload_json: string; created_at: number };
function rowToEvent(row: EventRow): Event {
  const { detail, ...payload } = JSON.parse(row.payload_json) as { detail: string } & Record<string, unknown>;
  return { seq: Number(row.seq), at: Number(row.created_at), type: row.type, detail, payload };
}
function gitHead(root: string): string | null {
  const result = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Service layer over the durable store. The daemon owns exactly one instance;
 * stdio adapters never instantiate it. Every public method is synchronous and
 * runs inside one SQLite transaction, which serializes state changes.
 */
export class Coordinator {
  readonly store: Store;
  readonly root: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  private readonly clock: () => number;
  private readonly ttl: number;
  private readonly detectors: Array<(intents: Intent[]) => Finding[]>;

  constructor(options: CoordinatorOptions = {}) {
    this.store = options.store ?? new Store(':memory:');
    this.clock = options.clock ?? Date.now;
    this.ttl = options.ttl ?? 120_000;
    this.detectors = options.detectors ?? [];
    this.root = realpathSync(resolve(options.root ?? process.cwd()));
    const { repositoryId, workspaceId } = this.store.transaction(() => {
      const repositoryId = this.upsertRepository(this.root);
      return { repositoryId, workspaceId: this.upsertWorkspace(repositoryId, this.root) };
    });
    this.repositoryId = repositoryId;
    this.workspaceId = workspaceId;
    this.expire();
  }

  // ---- repository / workspace -------------------------------------------------
  private upsertRepository(root: string): string {
    this.store.run('INSERT INTO repositories(id, canonical_root, revision, created_at) VALUES (?, ?, 0, ?) ON CONFLICT(canonical_root) DO NOTHING',
      randomUUID(), root, this.clock());
    return this.store.get<{ id: string }>('SELECT id FROM repositories WHERE canonical_root = ?', root)!.id;
  }
  private upsertWorkspace(repositoryId: string, realRoot: string): string {
    this.store.run('INSERT INTO workspaces(id, repository_id, real_root, base_commit, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(repository_id, real_root) DO NOTHING',
      randomUUID(), repositoryId, realRoot, gitHead(realRoot), this.clock());
    return this.store.get<{ id: string }>('SELECT id FROM workspaces WHERE repository_id = ? AND real_root = ?', repositoryId, realRoot)!.id;
  }
  repository(): Repository {
    const row = this.store.get<{ id: string; canonical_root: string; revision: number }>('SELECT id, canonical_root, revision FROM repositories WHERE id = ?', this.repositoryId)!;
    return { id: row.id, canonicalRoot: row.canonical_root, revision: Number(row.revision) };
  }
  revision(): number { return this.repository().revision; }
  /** Bumps the code revision. Callers (operation engine, reindex) do this after source changed. */
  bumpRevision(reason: string): number {
    return this.store.transaction(() => {
      this.store.run('UPDATE repositories SET revision = revision + 1 WHERE id = ?', this.repositoryId);
      const revision = this.revision();
      this.emit('revision.bumped', `${revision}: ${reason}`, { revision, reason });
      return revision;
    });
  }
  workspaces(): Workspace[] {
    return this.store.all<{ id: string; repository_id: string; real_root: string; base_commit: string | null }>(
      'SELECT id, repository_id, real_root, base_commit FROM workspaces WHERE repository_id = ? ORDER BY created_at', this.repositoryId)
      .map(row => ({ id: row.id, repositoryId: row.repository_id, realRoot: row.real_root, baseCommit: row.base_commit }));
  }
  workspace(id: string): Workspace {
    const found = this.workspaces().find(workspace => workspace.id === id);
    if (!found) throw new Error('Unknown workspace');
    return found;
  }

  // ---- events --------------------------------------------------------------------
  emit(type: string, detail: string, payload: Record<string, unknown> = {}): Event {
    const at = this.clock();
    const result = this.store.run('INSERT INTO events(repository_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)',
      this.repositoryId, type, JSON.stringify({ detail, ...payload }), at);
    return { seq: Number(result.lastInsertRowid), at, type, detail, payload };
  }
  /**
   * Paging read: the first `limit` events with seq > afterSeq, ascending. Passing the last seq of one
   * page as the next `afterSeq` returns every event exactly once (no gaps, no repeats).
   */
  events(afterSeq = 0, limit = 200): Event[] {
    return this.store.all<EventRow>(
      'SELECT seq, type, payload_json, created_at FROM events WHERE repository_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
      this.repositoryId, afterSeq, limit).map(rowToEvent);
  }
  /** The most recent `limit` events, ascending (for snapshots and recent-activity detectors, not paging). */
  recentEvents(limit = 200): Event[] {
    return this.store.all<EventRow>(
      'SELECT seq, type, payload_json, created_at FROM events WHERE repository_id = ? ORDER BY seq DESC LIMIT ?',
      this.repositoryId, limit).reverse().map(rowToEvent);
  }
  /** Highest event seq (0 when none); a cheap change marker for snapshot caching. */
  lastEventSeq(): number {
    return Number(this.store.get<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM events WHERE repository_id = ?', this.repositoryId)?.seq ?? 0);
  }

  // ---- sessions -------------------------------------------------------------------
  private rowToSession(row: SessionRow): Session {
    return { id: row.id, name: row.name, workspaceId: row.workspace_id, client: row.client, expiresAt: Number(row.lease_expires_at), status: row.status,
      member: row.member ?? null, tokenId: row.token_id ?? null };
  }
  private expire(): void {
    const now = this.clock();
    const rows = this.store.all<{ id: string }>("SELECT id FROM sessions WHERE status = 'active' AND lease_expires_at <= ? AND workspace_id IN (SELECT id FROM workspaces WHERE repository_id = ?)", now, this.repositoryId);
    if (!rows.length) return;
    this.store.transaction(() => {
      for (const { id } of rows) {
        this.store.run("UPDATE sessions SET status = 'expired', updated_at = ? WHERE id = ?", now, id);
        this.staleContractsFor(id, `session ${id} expired`);
        this.emit('session.expired', id, { sessionId: id });
      }
    });
  }
  private requireSession(id: string): Session {
    this.expire();
    const row = this.store.get<SessionRow>("SELECT * FROM sessions WHERE id = ? AND status = 'active'", id);
    if (!row) throw new Error('Unknown or expired session; register again');
    return this.rowToSession(row);
  }
  register(name: string, options: RegisterOptions = {}): Session {
    return this.store.transaction(() => {
      this.expire();
      let workspaceId = this.workspaceId;
      if (options.workspace) {
        const real = realpathSync(resolve(options.workspace));
        if (!statSync(real).isDirectory()) throw new Error('Workspace must be a directory');
        workspaceId = this.upsertWorkspace(this.repositoryId, real);
      }
      const now = this.clock();
      const session: Session = { id: randomUUID(), name, workspaceId, client: options.client ?? null, expiresAt: now + this.ttl, status: 'active',
        member: options.member ?? null, tokenId: options.tokenId ?? null };
      this.store.run('INSERT INTO sessions(id, workspace_id, name, client, lease_expires_at, status, created_at, updated_at, token_id, member) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        session.id, session.workspaceId, session.name, session.client, session.expiresAt, 'active', now, now, session.tokenId ?? null, session.member ?? null);
      this.emit('session.registered', `${session.member ? `${session.member} · ` : ''}${name} (${session.id})`, { sessionId: session.id, name, member: session.member ?? null, workspaceId });
      return session;
    });
  }
  heartbeat(id: string): Session {
    return this.store.transaction(() => {
      const session = this.requireSession(id);
      session.expiresAt = this.clock() + this.ttl;
      this.store.run('UPDATE sessions SET lease_expires_at = ?, updated_at = ? WHERE id = ?', session.expiresAt, this.clock(), id);
      return session;
    });
  }
  finish(id: string): void {
    this.store.transaction(() => {
      this.requireSession(id);
      this.store.run("UPDATE sessions SET status = 'finished', updated_at = ? WHERE id = ?", this.clock(), id);
      this.staleContractsFor(id, `session ${id} finished`);
      this.emit('session.finished', id, { sessionId: id });
    });
  }
  sessions(): Session[] {
    this.expire();
    return this.store.all<SessionRow>("SELECT * FROM sessions WHERE status = 'active' AND workspace_id IN (SELECT id FROM workspaces WHERE repository_id = ?) ORDER BY created_at, rowid", this.repositoryId)
      .map(row => this.rowToSession(row));
  }
  session(id: string): Session | undefined {
    const row = this.store.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', id);
    return row ? this.rowToSession(row) : undefined;
  }

  // ---- intents ----------------------------------------------------------------------
  private rowToIntent(row: IntentRow): Intent {
    const scope = JSON.parse(row.scope_json) as { files: string[]; symbols: string[] };
    return { sessionId: row.session_id, revision: Number(row.revision), task: row.task, files: scope.files, symbols: scope.symbols,
      assumptions: JSON.parse(row.assumptions_json) as Intent['assumptions'], at: Number(row.created_at) };
  }
  setIntent(id: string, input: IntentInput): Intent {
    return this.store.transaction(() => {
      this.heartbeat(id);
      if (new Set(input.assumptions.map(a => a.key)).size !== input.assumptions.length)
        throw new Error('Each assumption key must be unique');
      const previous = this.intent(id);
      const revision = (previous?.revision ?? 0) + 1;
      const intent: Intent = { ...structuredClone(input), sessionId: id, revision, at: this.clock() };
      this.store.run('INSERT INTO intents(id, session_id, revision, task, scope_json, assumptions_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        randomUUID(), id, revision, input.task, JSON.stringify({ files: input.files, symbols: input.symbols }), JSON.stringify(input.assumptions), intent.at);
      if (previous) this.staleContractsFor(id, `intent of ${id} changed to revision ${revision}`, PENDING_CONTRACT);
      this.emit('intent.updated', `${id}@${revision}: ${input.task}`, { sessionId: id, revision });
      return intent;
    });
  }
  intent(sessionId: string): Intent | undefined {
    const row = this.store.get<IntentRow>('SELECT * FROM intents WHERE session_id = ? ORDER BY revision DESC LIMIT 1', sessionId);
    return row ? this.rowToIntent(row) : undefined;
  }
  /** Latest intent of every active session. */
  intents(): Intent[] {
    this.expire();
    return this.store.all<IntentRow>(`SELECT i.* FROM intents i JOIN sessions s ON s.id = i.session_id
      WHERE s.status = 'active' AND s.workspace_id IN (SELECT id FROM workspaces WHERE repository_id = ?)
        AND i.revision = (SELECT MAX(revision) FROM intents WHERE session_id = i.session_id) ORDER BY s.created_at, s.rowid`, this.repositoryId)
      .map(row => this.rowToIntent(row));
  }

  // ---- contracts ---------------------------------------------------------------------
  private rowToContract(row: ContractRow): Contract {
    const acknowledgementDetails = this.store.all<{ session_id: string; version: number; intent_revision: number; created_at: number }>(
      'SELECT session_id, version, intent_revision, created_at FROM acknowledgements WHERE contract_id = ? AND version = ? ORDER BY created_at', row.id, row.version)
      .map((ack): Acknowledgement => ({ sessionId: ack.session_id, version: Number(ack.version), intentRevision: Number(ack.intent_revision), at: Number(ack.created_at) }));
    const history = this.store.all<{ version: number; declaration: string; behavior_notes: string; participants_json: string; created_at: number }>(
      'SELECT version, declaration, behavior_notes, participants_json, created_at FROM contract_versions WHERE contract_id = ? ORDER BY version', row.id)
      .map((v): ContractVersion => ({ version: Number(v.version), declaration: v.declaration, behaviorNotes: v.behavior_notes, participants: JSON.parse(v.participants_json) as string[], at: Number(v.created_at) }));
    return {
      id: row.id, version: Number(row.version), title: row.title, ownerSessionId: row.owner_session_id, producerSymbol: row.producer_symbol,
      declaration: row.declaration, behaviorNotes: row.behavior_notes, participants: JSON.parse(row.participants_json) as string[],
      acknowledgements: acknowledgementDetails.map(ack => ack.sessionId), acknowledgementDetails,
      intentRevisions: JSON.parse(row.intent_revisions_json) as Record<string, number>, status: row.status,
      evidence: JSON.parse(row.evidence_json) as ContractEvidence, history, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    };
  }
  contract(id: string): Contract {
    const row = this.store.get<ContractRow>('SELECT * FROM contracts WHERE id = ? AND repository_id = ?', id, this.repositoryId);
    if (!row) throw new Error('Unknown contract');
    return this.rowToContract(row);
  }
  contracts(): Contract[] {
    return this.store.all<ContractRow>('SELECT * FROM contracts WHERE repository_id = ? ORDER BY created_at', this.repositoryId).map(row => this.rowToContract(row));
  }
  private setContractStatus(contract: Contract, status: ContractStatus, evidence: ContractEvidence = contract.evidence): void {
    this.store.run('UPDATE contracts SET status = ?, evidence_json = ?, updated_at = ? WHERE id = ?', status, JSON.stringify(evidence), this.clock(), contract.id);
  }
  /** Marks live contracts involving a session as stale. Verified contracts stay unless `statuses` includes them. */
  private staleContractsFor(sessionId: string, reason: string, statuses: ContractStatus[] = PENDING_CONTRACT): void {
    for (const contract of this.contracts()) {
      if (!statuses.includes(contract.status) || !contract.participants.includes(sessionId)) continue;
      this.setContractStatus(contract, 'stale', { ...contract.evidence, staleReason: reason });
      this.emit('contract.stale', `${contract.id}: ${reason}`, { contractId: contract.id, reason });
    }
  }
  /** Marks live contracts whose producer symbol or participant files changed as stale (used after code changes). */
  staleContractsForFiles(files: string[], reason: string): Contract[] {
    const changed: Contract[] = [];
    for (const contract of this.contracts()) {
      if (!LIVE_CONTRACT.includes(contract.status)) continue;
      const producerFile = contract.producerSymbol?.split('#')[0];
      const participantFiles = contract.participants.flatMap(id => this.intent(id)?.files ?? []);
      const touched = files.some(file => file === producerFile || participantFiles.includes(file));
      if (!touched) continue;
      this.setContractStatus(contract, 'stale', { ...contract.evidence, staleReason: reason });
      this.emit('contract.stale', `${contract.id}: ${reason}`, { contractId: contract.id, reason });
      changed.push(contract);
    }
    return changed;
  }
  propose(owner: string, input: ProposeInput): Contract {
    return this.store.transaction(() => {
      this.requireSession(owner);
      const participants = [...new Set([owner, ...input.participants])];
      const intentRevisions: Record<string, number> = {};
      for (const id of participants) {
        this.requireSession(id);
        const intent = this.intent(id);
        if (!intent) throw new Error('Each participant must register an intent first');
        intentRevisions[id] = intent.revision;
      }
      const now = this.clock();
      const id = randomUUID();
      this.store.run(`INSERT INTO contracts(id, repository_id, version, proposal_id, owner_session_id, title, producer_symbol, declaration, behavior_notes,
        participants_json, intent_revisions_json, status, evidence_json, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', '{}', ?, ?)`,
        id, this.repositoryId, input.proposalId ?? null, owner, input.title, input.producerSymbol ?? null, input.declaration, input.behaviorNotes ?? '',
        JSON.stringify(participants), JSON.stringify(intentRevisions), now, now);
      this.store.run('INSERT INTO contract_versions(contract_id, version, declaration, behavior_notes, participants_json, created_at) VALUES (?, 1, ?, ?, ?, ?)',
        id, input.declaration, input.behaviorNotes ?? '', JSON.stringify(participants), now);
      this.emit('contract.proposed', `${input.title} (${id} v1)`, { contractId: id, version: 1, owner, participants });
      return this.contract(id);
    });
  }
  acknowledge(id: string, contractId: string, version: number): Contract {
    return this.store.transaction(() => {
      this.heartbeat(id);
      const contract = this.store.get<ContractRow>('SELECT * FROM contracts WHERE id = ? AND repository_id = ?', contractId, this.repositoryId);
      if (!contract || Number(contract.version) !== version) throw new Error('Unknown contract version');
      const participants = JSON.parse(contract.participants_json) as string[];
      if (!participants.includes(id)) throw new Error('Not a contract participant');
      if (contract.status === 'stale') throw new Error('Contract is stale; propose a new agreement or revise it');
      if (contract.status === 'rejected' || contract.status === 'cancelled') throw new Error(`Contract is ${contract.status}`);
      const intent = this.intent(id);
      this.store.run('INSERT OR IGNORE INTO acknowledgements(contract_id, version, session_id, intent_revision, created_at) VALUES (?, ?, ?, ?, ?)',
        contractId, version, id, intent?.revision ?? 0, this.clock());
      const acknowledged = this.store.all<{ session_id: string }>('SELECT session_id FROM acknowledgements WHERE contract_id = ? AND version = ?', contractId, version).map(r => r.session_id);
      // Emit the signature before acceptance so the event log never shows acceptance ahead of the final signature.
      this.emit('contract.acknowledged', `${contractId} v${version} by ${id}`, { contractId, version, sessionId: id });
      if (contract.status === 'proposed' && participants.every(p => acknowledged.includes(p))) {
        this.store.run("UPDATE contracts SET status = 'accepted', updated_at = ? WHERE id = ?", this.clock(), contractId);
        this.emit('contract.accepted', `${contractId} v${version} accepted by all participants`, { contractId, version });
      }
      return this.contract(contractId);
    });
  }
  /** New version: clears acknowledgements, returns to proposed. Only participants may revise. */
  revise(id: string, contractId: string, input: ReviseInput): Contract {
    return this.store.transaction(() => {
      this.heartbeat(id);
      const contract = this.contract(contractId);
      if (!contract.participants.includes(id)) throw new Error('Not a contract participant');
      if (contract.status === 'rejected' || contract.status === 'cancelled') throw new Error(`Contract is ${contract.status}`);
      const version = contract.version + 1;
      const declaration = input.declaration ?? contract.declaration;
      const behaviorNotes = input.behaviorNotes ?? contract.behaviorNotes;
      const intentRevisions: Record<string, number> = {};
      for (const participant of contract.participants) intentRevisions[participant] = this.intent(participant)?.revision ?? 0;
      const now = this.clock();
      this.store.run(`UPDATE contracts SET version = ?, title = ?, declaration = ?, behavior_notes = ?, intent_revisions_json = ?, status = 'proposed', evidence_json = '{}', updated_at = ? WHERE id = ?`,
        version, input.title ?? contract.title, declaration, behaviorNotes, JSON.stringify(intentRevisions), now, contractId);
      this.store.run('INSERT INTO contract_versions(contract_id, version, declaration, behavior_notes, participants_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        contractId, version, declaration, behaviorNotes, JSON.stringify(contract.participants), now);
      this.emit('contract.revised', `${contractId} v${version} by ${id}; prior acknowledgements no longer count`, { contractId, version, sessionId: id });
      return this.contract(contractId);
    });
  }
  reject(id: string, contractId: string, reason: string): Contract {
    return this.store.transaction(() => {
      this.heartbeat(id);
      const contract = this.contract(contractId);
      if (!contract.participants.includes(id)) throw new Error('Not a contract participant');
      const status: ContractStatus = contract.ownerSessionId === id ? 'cancelled' : 'rejected';
      this.setContractStatus(contract, status, { ...contract.evidence, staleReason: reason });
      this.emit(`contract.${status}`, `${contractId} ${status} by ${id}: ${reason}`, { contractId, sessionId: id, reason });
      return this.contract(contractId);
    });
  }
  /** Quiet evidence update: no status change, no event. */
  setEvidence(contractId: string, evidence: ContractEvidence): void {
    this.store.run('UPDATE contracts SET evidence_json = ?, updated_at = ? WHERE id = ? AND repository_id = ?', JSON.stringify(evidence), this.clock(), contractId, this.repositoryId);
  }
  /** Used by the contract service to record implementation/verification evidence. */
  updateContract(contractId: string, status: ContractStatus, evidence: ContractEvidence, detail: string): Contract {
    return this.store.transaction(() => {
      const contract = this.contract(contractId);
      this.setContractStatus(contract, status, evidence);
      this.emit(`contract.${status}`, `${contractId} v${contract.version}: ${detail}`, { contractId, version: contract.version });
      return this.contract(contractId);
    });
  }

  // ---- snapshot -------------------------------------------------------------------------
  findings(): Finding[] {
    const intents = this.intents();
    const all = [...detect(intents)];
    for (const detector of this.detectors) all.push(...detector(intents));
    return all;
  }
  snapshot(): Snapshot & { sessions: SnapshotSession[] } {
    this.expire();
    const intents = this.intents();
    const findings = [...detect(intents)];
    for (const detector of this.detectors) findings.push(...detector(intents));
    return structuredClone({ repository: this.repository(), workspaces: this.workspaces(), sessions: this.withConnectors(this.sessions()), intents,
      contracts: this.contracts(), findings, events: this.recentEvents() });
  }
  /** Joins each session's token to its latest checkout report (one indexed read per distinct token). */
  private withConnectors(sessions: Session[]): SnapshotSession[] {
    const cache = new Map<string, SessionConnector | null>();
    const lookup = (tokenId: string): SessionConnector | null => {
      if (cache.has(tokenId)) return cache.get(tokenId)!;
      const row = this.store.get<{ machine: string | null; token_machine: string | null; repo_json: string; branch: string | null; head: string | null; dirty_json: string; reported_at: number }>(
        'SELECT c.machine, t.machine AS token_machine, c.repo_json, c.branch, c.head, c.dirty_json, c.reported_at FROM checkouts c LEFT JOIN tokens t ON t.id = c.token_id WHERE c.token_id = ?', tokenId);
      let found: SessionConnector | null = null;
      if (row) {
        const repo = JSON.parse(row.repo_json) as { name?: string };
        found = { machine: row.token_machine ?? row.machine ?? null, repoName: repo.name ?? '', branch: row.branch, headShort: row.head ? row.head.slice(0, 7) : null,
          dirtyCount: (JSON.parse(row.dirty_json) as unknown[]).length, reportedAt: Number(row.reported_at) };
      }
      cache.set(tokenId, found);
      return found;
    };
    return sessions.map(session => ({ ...session, connector: session.tokenId ? lookup(session.tokenId) : null }));
  }
}
