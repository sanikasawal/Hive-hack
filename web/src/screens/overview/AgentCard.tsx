// One agent: who runs it, what it is doing, where it is in the six steps, and its lease.
// The card opens into a quick look with the declared intent, since that is real extra content.
import { Avatar } from '@/components/arc/avatar/avatar';
import { Card } from '@/components/arc/card/card';
import { Progress } from '@/components/arc/progress/progress';
import { Stepper, type StepperStep } from '@/components/arc/stepper/stepper';
import type { ServiceSnapshot } from '@/api/types';
import { AGENT_STEPS, CLIENTS, type AgentStepKey, type AgentView } from '@/mock';
import { formatRelative, parseSymbolKey, useMediaQuery } from '@/shell';
import { STATE_LABEL, leaseText } from './derive';
import styles from './overview.module.css';

type SessionConnector = NonNullable<ServiceSnapshot['sessions'][number]['connector']>;

/** Hive Connect checkout of the agent's machine: "main@1a2b3c4 · 2 local changes". */
export function checkoutText(c: SessionConnector): string {
  const where = `${c.branch ?? 'detached HEAD'}${c.headShort ? `@${c.headShort}` : ''}`;
  return `${where} · ${c.dirtyCount === 0 ? 'no local changes' : `${c.dirtyCount} local ${c.dirtyCount === 1 ? 'change' : 'changes'}`}`;
}

const sentence = (text: string) => (text ? text[0]!.toUpperCase() + text.slice(1) : text);
const unique = <T,>(items: T[]) => [...new Set(items)];

/** Short names that fit under six markers side by side. The full label stays in the status line. */
const SHORT_LABEL: Record<AgentStepKey, string> = {
  registered: 'Registered',
  intent: 'Intent',
  working: 'Working',
  contract_pending: 'Agreement',
  implemented: 'Implemented',
  verified: 'Verified',
};

export function AgentCard({ agent, workspaceName, sessionName, now, viewer = false }: {
  agent: AgentView;
  workspaceName: string;
  sessionName: (id: string) => string;
  now: number;
  /** Viewer data (/api/view) carries no lease, client or intent details, so none are shown or invented. */
  viewer?: boolean;
}) {
  const { session, intent, progress, memberName, agentName } = agent;
  const client = CLIENTS.find(c => c.id === session.client)?.name ?? session.client ?? null;
  const connector = (session as { connector?: SessionConnector | null }).connector ?? null;
  const verified = progress.key === 'verified';
  const conflict = agent.findings.find(f => f.severity === 'error') ?? agent.findings.find(f => f.severity === 'warning');
  const others = conflict ? unique(conflict.sessions.filter(id => id !== session.id)).map(sessionName) : [];

  // Step names sit under the markers from 820 px; below that a single line says where the agent is.
  const wide = useMediaQuery('(min-width: 820px)');
  const inConflict = progress.key === 'contract_pending' && Boolean(conflict);
  const hard = conflict?.severity === 'error';
  const steps: StepperStep[] = AGENT_STEPS.map((step, index) => ({
    id: step.key,
    label: SHORT_LABEL[step.key],
    // Only a proven conflict turns the marker into an alert; warnings stay on the status line below.
    // A failing check marks the step after the current one (Verified), so Implemented reads as done.
    error: index === progress.step - 1 && inConflict && hard ? 'Conflict'
      : progress.failure && index === progress.step ? progress.failure : undefined,
  }));
  const current = verified ? AGENT_STEPS.length : progress.failure ? progress.step : progress.step - 1;

  const title = sentence(agentName);
  const position = `Step ${progress.step} of ${AGENT_STEPS.length}: ${progress.label.toLowerCase()}`;

  return (
    <Card
      className={styles.agentCard}
      title={title}
      description={intent?.task ?? 'No intent declared yet.'}
      avatar={<Avatar name={memberName} size="sm" />}
      meta={[memberName, client, connector?.machine].filter(Boolean).join(' · ')}
      status={[connector ? checkoutText(connector) : workspaceName, viewer ? null : leaseText(session, now)].filter(Boolean).join(' · ')}
      details={<AgentDetails agent={agent} client={client} workspaceName={workspaceName} now={now} viewer={viewer} connector={connector} />}
    >
      <div className={styles.agentSteps}>
        {wide ? (
          <Stepper
            steps={steps}
            current={current}
            label={`${title} progress`}
            completeLabel="Verified"
          />
        ) : (
          <Progress value={progress.step} max={AGENT_STEPS.length} label={position} />
        )}
        <p className={styles.stepStatus}>
          {wide && <span className={styles.stepPosition}>{position}. </span>}
          {progress.reason}
          {inConflict && (
            <span className={hard ? styles.stepConflict : styles.stepAttention}>
              {hard ? ' In conflict with ' : ' Needs coordination with '}{others.join(' and ') || 'another agent'}.
            </span>
          )}
        </p>
      </div>
    </Card>
  );
}

function AgentDetails({ agent, client, workspaceName, now, viewer, connector }: { agent: AgentView; client: string | null; workspaceName: string; now: number; viewer: boolean; connector: SessionConnector | null }) {
  const { intent, progress, contracts, findings, session } = agent;
  return (
    <dl className={styles.facts}>
      <div>
        <dt>Step {progress.step} of {AGENT_STEPS.length}: {progress.label}</dt>
        <dd>{progress.reason}</dd>
      </div>
      <div>
        <dt>Intent</dt>
        <dd>{!intent ? 'Not declared yet.' : viewer ? 'Declared. Files, symbols and assumptions are not shared with viewers.' : `Revision ${intent.revision}, declared ${formatRelative(intent.at, now)}.`}</dd>
      </div>
      {intent && intent.files.length > 0 && (
        <div>
          <dt>Files</dt>
          <dd><ul className={styles.codeList}>{intent.files.map(f => <li key={f}><code>{f}</code></li>)}</ul></dd>
        </div>
      )}
      {intent && intent.symbols.length > 0 && (
        <div>
          <dt>Symbols</dt>
          <dd><ul className={styles.codeList}>{intent.symbols.map(s => { const p = parseSymbolKey(s); return <li key={s}><code>{p.name}</code> in <code>{p.file}</code></li>; })}</ul></dd>
        </div>
      )}
      {intent && intent.assumptions.length > 0 && (
        <div>
          <dt>Assumptions</dt>
          <dd><ul className={styles.codeList}>{intent.assumptions.map(a => <li key={a.key}><code>{a.key}</code> is <code>{a.value}</code></li>)}</ul></dd>
        </div>
      )}
      {connector && (
        <div>
          <dt>Checkout</dt>
          <dd>{`${connector.repoName || workspaceName}${connector.machine ? ` on ${connector.machine}` : ''}: ${checkoutText(connector)}. Reported ${formatRelative(connector.reportedAt, now)}.`}</dd>
        </div>
      )}
      <div>
        <dt>Agreements</dt>
        <dd>{contracts.length ? contracts.map(c => `${c.title} (${STATE_LABEL[c.status].toLowerCase()})`).join(', ') : 'None yet.'}</dd>
      </div>
      <div>
        <dt>Findings</dt>
        <dd>{findings.length ? `${findings.length} involve this agent; ${findings.filter(f => f.severity !== 'info').length} need attention.` : 'None.'}</dd>
      </div>
      <div>
        <dt>Session</dt>
        <dd>{client ? `${client} in ${workspaceName}` : workspaceName}{viewer ? '' : `, ${leaseText(session, now)}`}. <code>{session.id.slice(0, 8)}</code></dd>
      </div>
    </dl>
  );
}
