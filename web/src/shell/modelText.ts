// Plain-language model status for the banner under the page heading. Pure and import-free, so the backend
// test suite runs it under Node directly (strip-only).

/**
 * The hub writes "unavailable" errors as one human sentence, then " Details: " and the technical part
 * (src/intelligence/meta.ts). Older errors have no "Details:"; then the whole text is the sentence.
 */
export function splitUnavailable(error: string | null | undefined): { sentence: string; details: string | null } {
  const text = (error ?? '').trim();
  if (!text) return { sentence: 'The model did not answer. Deterministic and compiler findings are unaffected.', details: null };
  const at = text.indexOf(' Details: ');
  if (at < 0) return { sentence: text, details: null };
  const details = text.slice(at + ' Details: '.length).trim();
  return { sentence: text.slice(0, at).trim(), details: details || null };
}

export type DiagnoseVerdictKey = 'not_configured' | 'key_rejected' | 'no_models_for_host' | 'rate_limited' | 'reachable' | 'network_error';

/** Headline per model_diagnose verdict, and the tone the banner uses for it. */
export const DIAGNOSE_VERDICT: Readonly<Record<DiagnoseVerdictKey, { title: string; tone: 'success' | 'warning' | 'danger' | 'info' }>> = {
  not_configured: { title: 'Not configured: the hub has no model key', tone: 'info' },
  key_rejected: { title: 'Key rejected by the provider', tone: 'danger' },
  no_models_for_host: { title: 'No models offered to this host', tone: 'warning' },
  rate_limited: { title: 'Rate limited by the provider', tone: 'warning' },
  reachable: { title: 'Reachable: the model answered from this hub', tone: 'success' },
  network_error: { title: 'The hub could not reach the provider', tone: 'danger' },
};

export function verdictText(verdict: string): { title: string; tone: 'success' | 'warning' | 'danger' | 'info' } {
  return (DIAGNOSE_VERDICT as Record<string, { title: string; tone: 'success' | 'warning' | 'danger' | 'info' }>)[verdict]
    ?? { title: `Verdict: ${verdict}`, tone: 'info' };
}

/** "HTTP 404", "no answer" or "not tried" for one diagnose probe. */
export function probeText(status: number | null, tried: boolean): string {
  if (!tried) return 'not tried';
  return status === null ? 'no answer' : `HTTP ${status}`;
}
