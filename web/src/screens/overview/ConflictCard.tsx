// The hero: the one conflict that most needs a person, in plain language, with its evidence.
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/arc/badge/badge';
import { Button } from '@/components/arc/button/button';
import { CodeBlock } from '@/components/arc/code-block/code-block';
import { formatDuration, formatRelative } from '@/shell';
import { STATE_LABEL, signatureCount, type ConflictView, type Freshness, type ModelView, type Part } from './derive';
import styles from './overview.module.css';

const MODEL_NAME = 'Muse Spark';

export function Prose({ parts }: { parts: Part[] }) {
  return <>{parts.map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span> : <code key={i}>{p.code}</code>))}</>;
}

export function ConflictCard({ conflict, now }: { conflict: ConflictView; now: number }) {
  const navigate = useNavigate();
  const { model, contract } = conflict;
  // The model's explanation of this conflict leads when there is one; otherwise the deterministic summary.
  const lead = model.kind === 'ok' ? model.finding.explanation || model.analysis.summary || conflict.summary : conflict.summary;

  // The declaration to show. A model proposal that is already the agreement's current version is not new:
  // it is shown as the interface on record. Only a declaration that differs from the record is "proposed".
  const suggested = model.kind === 'ok' && model.finding.proposedDeclaration ? model.finding.proposedDeclaration : null;
  const matchesContract = Boolean(suggested && contract && suggested.trim() === contract.declaration.trim());
  const proposal = matchesContract ? null : suggested;
  const declaration = proposal ?? contract?.declaration ?? null;
  const notes = (model.kind === 'ok' && proposal ? model.finding.behaviorNotes : contract?.behaviorNotes) ?? '';

  return (
    <section className={styles.hero} aria-labelledby="current-conflict-title">
      <div className={styles.heroHead}>
        <Badge tone={conflict.tone} dot>{conflict.chip}</Badge>
        <span className={styles.muted}>{conflict.eyebrow}</span>
      </div>
      <h2 id="current-conflict-title" className={styles.heroTitle}>{conflict.title}</h2>
      <p className={styles.heroLead}>{lead}</p>
      {model.kind === 'ok' && lead !== conflict.summary && <p className={styles.body}>{conflict.summary}</p>}

      <div className={styles.heroSection}>
        <h3 className={styles.subhead}>Evidence</h3>
        <ul className={styles.evidence}>
          {conflict.evidence.map(item => (
            <li key={item.id}>
              <span className={styles.evidenceLabel}>{item.label}</span>
              <span className={styles.evidenceText}><Prose parts={item.parts} /></span>
              <span className={styles.evidenceSource}>{item.source}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className={styles.heroSection}>
        <h3 className={styles.subhead}>Affected</h3>
        <dl className={styles.affected}>
          {conflict.symbols.length > 0 && (
            <div>
              <dt>Symbols</dt>
              <dd>
                <ul className={styles.inlineList}>
                  {conflict.symbols.map(s => <li key={s.key}><code>{s.name}</code> <span className={styles.muted}>in</span> <code>{s.file}</code></li>)}
                </ul>
              </dd>
            </div>
          )}
          {conflict.files.length > 0 && (
            <div>
              <dt>Files</dt>
              <dd><ul className={styles.inlineList}>{conflict.files.map(f => <li key={f}><code>{f}</code></li>)}</ul></dd>
            </div>
          )}
        </dl>
      </div>

      {declaration && (
        <div className={styles.heroSection}>
          <h3 className={styles.subhead}>{proposal ? 'Proposed interface' : 'Interface on record'}</h3>
          {model.kind === 'ok' && model.finding.suggestion && <p className={styles.body}>{model.finding.suggestion}</p>}
          <CodeBlock
            code={declaration}
            filename={proposal ? `Proposed by ${MODEL_NAME}` : `${contract?.title ?? 'Agreement'}, version ${contract?.version ?? 1}`}
            language="ts"
          />
          {notes && (
            <ul className={styles.notes}>
              {notes.split('\n').filter(Boolean).map((line, i) => <li key={i}>{line}</li>)}
            </ul>
          )}
          {contract && <p className={styles.muted}>{contractStatusLine(conflict, matchesContract)}</p>}
        </div>
      )}

      <footer className={styles.heroFoot}>
        <p className={styles.attribution}><ModelLine model={model} now={now} /></p>
        {contract
          ? <Button variant="primary" onClick={() => navigate(`/agreements/${contract.id}`)}>Open agreement</Button>
          : conflict.tone === 'neutral'
            ? <Button variant="secondary" onClick={() => navigate('/activity')}>Open activity</Button>
            : <Button variant="secondary" onClick={() => navigate('/agreements')}>View agreements</Button>}
      </footer>
    </section>
  );
}

function contractStatusLine(conflict: ConflictView, matchesContract: boolean): string {
  const contract = conflict.contract!;
  const { signed, total } = signatureCount(contract);
  const parts: string[] = [];
  parts.push(matchesContract
    ? `${MODEL_NAME} points to this same declaration. ${signed} of ${total} participants signed version ${contract.version}.`
    : `"${contract.title}" is at version ${contract.version}, ${signed} of ${total} signed.`);
  parts.push(`It is ${STATE_LABEL[contract.status].toLowerCase()}`);
  const run = conflict.appliedRun;
  if (contract.status !== 'verified' && run && run.status === 'running') parts[1] += ', and a test run on applied code is still running';
  else if (contract.status !== 'verified' && run && !run.passed) {
    parts[1] += run.exitCode === null ? `, not verified: the last run on applied code was ${run.status}` : `, not verified: the last run on applied code exited ${run.exitCode}`;
  }
  if (conflict.overlayPass && contract.status !== 'verified') parts[1] += `. A passing run on staged code does not count until the change is applied`;
  parts[1] += '.';
  return parts.join(' ');
}

const FRESHNESS: Record<Freshness, (revision: number) => string> = {
  fresh: () => '',
  cached: revision => ` Reused from an identical earlier request at revision ${revision}; the inputs have not changed since.`,
  stale: revision => ` Based on revision ${revision}; intents, agreements or code have changed since, so it may be out of date.`,
};

function ModelLine({ model, now }: { model: ModelView; now: number }) {
  switch (model.kind) {
    case 'ok': {
      const a = model.analysis;
      const bits = [
        a.latencyMs !== null && model.freshness !== 'cached' ? formatDuration(a.latencyMs) : null,
        a.usage?.totalTokens != null && model.freshness !== 'cached' ? `${a.usage.totalTokens.toLocaleString('en')} tokens` : null,
        `${model.finding.confidence} confidence`,
        formatRelative(a.at, now),
      ].filter(Boolean);
      return <>
        Explained by {MODEL_NAME} <code>{a.model ?? 'unknown model'}</code>{a.relayedBy ? `, relayed from ${a.relayedBy}'s machine` : ''}. {bits.join(' · ')}.
        {FRESHNESS[model.freshness](a.revision)}
      </>;
    }
    case 'summary': {
      const a = model.analysis;
      const count = model.findings === 1 ? '1 finding' : `${model.findings} findings`;
      return <>
        {MODEL_NAME} <code>{a.model ?? 'unknown model'}</code>{a.relayedBy ? `, relayed from ${a.relayedBy}'s machine,` : ''} reported {count} {formatRelative(a.at, now)}
        {a.summary.trim() ? <>: <span>{a.summary}</span></> : '.'} Model details are not shared with viewers.
        {FRESHNESS[model.freshness](a.revision)}
      </>;
    }
    case 'nothing':
      return <>
        {MODEL_NAME} reviewed this at revision {model.analysis.revision} and added nothing to the findings above.
        {FRESHNESS[model.freshness](model.analysis.revision)}
      </>;
    case 'unavailable':
      return <>{MODEL_NAME} is unavailable{model.analysis.attempts ? ` after ${model.analysis.attempts} attempts` : ''}. The explanation above comes from intents, the compiler index and test runs only.</>;
    case 'invalid':
      return <>{MODEL_NAME} answered, but the answer cited evidence Hive could not find, so it was discarded. The explanation above comes from deterministic findings only.</>;
    case 'pending':
      return <>{MODEL_NAME} has not looked at this yet. The explanation above comes from deterministic findings only.</>;
    case 'not_configured':
      return <>No model is configured. The explanation above comes from intents, the compiler index and test runs only.</>;
  }
}
