// Connection and model notices. Page renders the connection notice; screens that show
// model output render <ModelNotice /> next to it. For admins the model notice carries a Diagnose action
// (model_diagnose) that shows the hub's view of the provider; relayed analyses are labelled as such.
import { useState } from 'react';
import { Alert } from '@/components/arc/alert/alert';
import { Button } from '@/components/arc/button/button';
import type { ModelDiagnosis } from '@/api';
import { formatClock, formatDuration } from './format';
import { probeText, splitUnavailable, verdictText } from './modelText';
import { useLastPoll, useMock } from './store';
import styles from './StateNotices.module.css';

export function ConnectionNotice() {
  const { connection, workspace } = useMock();
  const { lastPollAt, ageMs } = useLastPoll();
  if (connection === 'offline') {
    return (
      <Alert tone="danger" title="Hive is unreachable">
        {`Cannot reach ${workspace.cloudLink}. You are looking at data from ${formatClock(lastPollAt)}, so none of it is live. Actions are paused until the server answers.`}
      </Alert>
    );
  }
  if (connection === 'stale' || ageMs > 10_000) {
    return (
      <Alert tone="warning" title="Updates are delayed">
        {`The last update arrived ${Math.round(ageMs / 1000)} seconds ago. Hive keeps retrying; treat agent progress as out of date until it catches up.`}
      </Alert>
    );
  }
  return null;
}

export function ModelNotice() {
  const { model, snapshot, role } = useMock();
  const admin = role === 'admin';
  const analysis = snapshot.analysis;
  if (model === 'not_configured' || !snapshot.model.configured) {
    return (
      <div className={styles.stack}>
        <Alert tone="info" title="No model is configured">
          Hive still raises deterministic and compiler findings. Plain-language explanations and proposed declarations are off until an admin adds a model key to the hub.
        </Alert>
        {admin && <Diagnose />}
      </div>
    );
  }
  if (analysis?.status === 'unavailable') {
    const { sentence, details } = splitUnavailable(analysis.error);
    return (
      <div className={styles.stack}>
        <Alert tone="warning" title="Muse Spark is unavailable">
          {`${sentence} Deterministic and compiler findings are unaffected, and this is not a "no conflict" result.`}
          {details && <span className={styles.details}>{details}</span>}
        </Alert>
        {admin && <Diagnose />}
      </div>
    );
  }
  if (analysis?.relayedBy && (analysis.status === 'ok' || analysis.status === 'cached')) {
    return (
      <Alert tone="info" title="Analysis relayed from a laptop">
        {`The latest Muse Spark analysis was sent from ${analysis.relayedBy}'s machine through the operator relay, not by this hub. Hive validated it exactly like a direct call.`}
      </Alert>
    );
  }
  return null;
}

/** Admin: model_diagnose from the hub (GET /models, a one-token chat, egress IP) and its plain-language verdict. */
function Diagnose() {
  const { client, snapshot, mode, refresh } = useMock();
  const [result, setResult] = useState<ModelDiagnosis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = result ?? snapshot.model.lastDiagnose ?? null;

  async function run() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'mock') throw new Error('Diagnosis needs a live hub.');
      setResult(await client.modelDiagnose());
      void refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The diagnosis did not finish.');
    } finally {
      setBusy(false);
    }
  }

  const verdict = shown ? verdictText(shown.verdict) : null;
  return (
    <section className={styles.diagnose} aria-labelledby="diagnose-title">
      <div className={styles.diagnoseHead}>
        <div className={styles.diagnoseText}>
          <h2 id="diagnose-title" className={styles.diagnoseTitle}>Model connection</h2>
          <p className={styles.muted}>Asks the provider from this hub: its model list and a one-token reply. Admins only.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => { void run(); }} disabled={busy}>{busy ? 'Diagnosing…' : shown ? 'Diagnose again' : 'Diagnose'}</Button>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {shown && verdict && (
        <div className={styles.result} role="status">
          <p className={styles.verdict} data-tone={verdict.tone}>{verdict.title}</p>
          {shown.hints.length > 0 && <ul className={styles.hints}>{shown.hints.map((hint, i) => <li key={i}>{hint}</li>)}</ul>}
          <dl className={styles.facts}>
            <div><dt>Model</dt><dd>{`${shown.model} at ${shown.baseUrlHost}${shown.proxy ? ' via HIVE_MODEL_PROXY_URL' : ''}`}</dd></div>
            <div><dt>Model list</dt><dd>{`${probeText(shown.modelsStatus, shown.configured)}${shown.modelsCount !== null ? `, ${shown.modelsCount} ${shown.modelsCount === 1 ? 'model' : 'models'}` : ''}${shown.modelListed === false ? ', configured model not listed' : ''}`}</dd></div>
            <div><dt>One-token reply</dt><dd>{probeText(shown.chatStatus, shown.configured)}</dd></div>
            <div><dt>Hub egress IP</dt><dd>{shown.egressIp ?? 'Unknown'}</dd></div>
            {shown.requestIds.length > 0 && <div><dt>Request ids</dt><dd className={styles.mono}>{shown.requestIds.join(', ')}</dd></div>}
            {shown.chatExcerpt && <div><dt>Reply excerpt</dt><dd className={styles.mono}>{shown.chatExcerpt}</dd></div>}
            {shown.modelsExcerpt && <div><dt>Model list excerpt</dt><dd className={styles.mono}>{shown.modelsExcerpt}</dd></div>}
          </dl>
          <p className={styles.muted}>{`Checked ${formatClock(shown.at)} in ${formatDuration(shown.latencyMs)}.`}</p>
        </div>
      )}
    </section>
  );
}
