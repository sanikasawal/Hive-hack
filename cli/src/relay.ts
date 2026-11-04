import { connectedAt } from './context.js';
import { errorText } from './util.js';

/**
 * Operator fallback (laptop relay). Normally the hub calls the model itself and no laptop holds a model key. When the
 * hub's host cannot reach the provider, an operator can relay ONE analysis: Hive builds the request, this machine sends
 * it with MODEL_API_KEY read from the environment for this run only, and hands the raw response back. Hive validates
 * and records it like a direct call, labelled as relayed. The key is never written to disk, logged, or sent to Hive.
 */
export async function runRelay(): Promise<number> {
  const key = (process.env.MODEL_API_KEY ?? '').trim();
  console.log('Hive relay: sends one model analysis from this machine because the hub cannot reach the model provider.');
  if (!key) {
    console.log('MODEL_API_KEY is not set for this run. Run: MODEL_API_KEY=<key> hive-connect relay   (read from the environment only; never stored).');
    return 2;
  }
  const { hub } = connectedAt();
  const request = await hub.command<{ inputHash: string; model: string; baseUrl: string; body: string }>({ action: 'analysis_relay_request' });
  const base = (process.env.HIVE_MODEL_BASE_URL?.trim() || request.baseUrl).replace(/\/+$/, '');
  console.log(`Asking ${request.model} at ${base} from this machine…`);
  const started = Date.now();
  let httpStatus = 0;
  let responseText = '';
  try {
    const response = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: request.body, signal: AbortSignal.timeout(120_000) });
    httpStatus = response.status;
    responseText = await response.text();
  } catch (error) { responseText = error instanceof Error ? `${error.name}: ${error.message}` : String(error); }
  // A provider error may echo the key back; it must not reach Hive's records.
  if (key.length >= 4) responseText = responseText.split(key).join('[redacted]');
  const analysis = await hub.command<{ status: string; summary: string; error: string | null; model: string | null; latencyMs: number | null;
    findings: { kind: string; explanation: string; suggestion: string; proposedDeclaration?: string; confidence: string }[]; dropped: string[] }>(
    { action: 'analysis_relay_submit', inputHash: request.inputHash, httpStatus, responseText, latencyMs: Date.now() - started }, 60_000)
    .catch(error => { throw new Error(`Hive refused the relayed result: ${errorText(error)}`); });
  const lines = [`Hive analysis: ${analysis.status}${analysis.model ? ` (${analysis.model}, ${analysis.latencyMs} ms, relayed by this machine)` : ' (relayed by this machine)'}`];
  if (analysis.error) lines.push(`Error: ${analysis.error}`);
  if (analysis.summary) lines.push(`Summary: ${analysis.summary}`);
  for (const f of analysis.findings ?? []) {
    lines.push(`- [${f.kind}, ${f.confidence}] ${f.explanation}`, `  Suggestion: ${f.suggestion}`);
    if (f.proposedDeclaration) lines.push(`  Proposed declaration: ${f.proposedDeclaration}`);
  }
  if (analysis.dropped?.length) lines.push(`(Hive discarded ${analysis.dropped.length} uncited finding(s).)`);
  console.log(lines.join('\n'));
  return analysis.status === 'ok' || analysis.status === 'stale' ? 0 : 1;
}
