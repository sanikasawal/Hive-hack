import type { Contract, Finding, Intent } from '../domain/types.ts';

export interface EvidenceSymbol { key: string; file: string; line: number; kind: string; signature: string | null; excerpt: string }
export interface EvidenceDependent { symbol: string; from: string; file: string; line: number }
/** A member's uncommitted change, synced from their laptop: a bounded unified diff against the hub's base. */
export interface EvidenceChange { member: string; sessionIds: string[]; file: string; diff: string }
export interface EvidenceBundle {
  revision: number;
  inputHash: string;
  intents: Intent[];
  candidates: Finding[];
  contracts: Pick<Contract, 'id' | 'version' | 'title' | 'producerSymbol' | 'declaration' | 'behaviorNotes' | 'participants' | 'status'>[];
  symbols: EvidenceSymbol[];
  dependents: EvidenceDependent[];
  /** Laptop changes (optional; absent when nobody synced). */
  changes?: EvidenceChange[];
}
export type ModelFindingKind = 'semantic_conflict' | 'structural_conflict' | 'harmless_overlap' | 'needs_clarification';
export interface ModelFinding {
  sessionIds: string[];
  kind: ModelFindingKind;
  explanation: string;
  /** Must quote symbol keys, file paths, assumption keys or values present in the evidence bundle. */
  evidence: string[];
  suggestion: string;
  proposedDeclaration?: string;
  behaviorNotes?: string;
  confidence: 'low' | 'medium' | 'high';
}
export interface ModelUsage { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null }
export interface AnalyzerResult { summary: string; findings: ModelFinding[]; model: string | null; usage: ModelUsage | null; latencyMs: number; attempts: number; dropped: string[] }
export interface Analyzer { analyze(bundle: EvidenceBundle, knownSessions: string[]): Promise<AnalyzerResult> }

export type AnalysisStatus = 'ok' | 'cached' | 'unavailable' | 'invalid' | 'stale';
export interface Analysis {
  id: string;
  status: AnalysisStatus;
  summary: string;
  findings: ModelFinding[];
  model: string | null;
  latencyMs: number | null;
  usage: ModelUsage | null;
  attempts: number;
  dropped: string[];
  inputHash: string;
  revision: number;
  error: string | null;
  evidenceRefs: { symbols: string[]; files: string[]; sessions: string[]; candidates: number };
  at: number;
  /** Member whose laptop sent this request (operator relay fallback); absent for a direct call from the hub. */
  relayedBy?: string;
}

export class AnalysisUnavailable extends Error {
  readonly attempts: number;
  constructor(message: string, attempts = 1) { super(message); this.name = 'AnalysisUnavailable'; this.attempts = attempts; }
}
export class AnalysisInvalid extends Error {
  readonly attempts: number;
  constructor(message: string, attempts = 1) { super(message); this.name = 'AnalysisInvalid'; this.attempts = attempts; }
}
