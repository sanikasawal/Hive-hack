// Step 3, Waiting. Follows the command from step 2 on live data: a new connector appears in member_list once the
// pairing is approved, its checkout report fills in branch, HEAD and local changes, and the first session through
// a connector credential ticks the last row. Baselines are taken when the Connect page opened, so older
// connectors and sessions do not count.
import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert } from '@/components/arc/alert/alert';
import { Button } from '@/components/arc/button/button';
import { Stepper, type StepperStep } from '@/components/arc/stepper/stepper';
import { formatClock, formatRelative, useHive, useLastPoll, useNow } from '@/shell';
import { connectProgress } from './logic';
import { connectorsOf } from './shared';
import styles from './Connect.module.css';

/** member_list refreshes every 10 s by default; while waiting it refreshes this often. */
const ACCESS_REFRESH_WHILE_WAITING_MS = 3000;

export interface WaitBaseline { connectorIds: string[]; sessionIds: string[] }

interface WaitingStepProps {
  baseline: WaitBaseline;
  /** Whose connection to follow (an invited teammate or the signed-in member); null follows anyone visible. */
  member: string | null;
  onBack: () => void;
  onStartOver: () => void;
}

export function WaitingStep({ baseline, member, onBack, onStartOver }: WaitingStepProps) {
  const { connection, memberSummaries, snapshot, sessionName, mode, refresh, me } = useHive();
  const { lastPollAt } = useLastPoll();
  const now = useNow(5000);
  const navigate = useNavigate();
  const offline = connection === 'offline';

  const progress = useMemo(() => connectProgress({
    member, baselineConnectorIds: baseline.connectorIds, baselineSessionIds: baseline.sessionIds,
    connectors: connectorsOf(memberSummaries), sessions: snapshot.sessions,
  }), [member, baseline, memberSummaries, snapshot.sessions]);
  const finished = progress.done === 3;

  useEffect(() => {
    if (mode !== 'live' || finished) return;
    void refresh({ access: true });
    const id = window.setInterval(() => { void refresh({ access: true }); }, ACCESS_REFRESH_WHILE_WAITING_MS);
    return () => window.clearInterval(id);
  }, [mode, finished, refresh]);

  const who = member === null || member === me?.name ? null : member;
  const possessive = who ? `${who}'s` : 'your';
  const c = progress.connector;
  const where = c ? [c.repoName, c.machine].filter(Boolean).join(' on ') : '';
  const checkout = c && c.reportedAt !== null
    ? `${c.branch ?? 'detached HEAD'}${c.headShort ? `@${c.headShort}` : ''}, ${c.dirtyCount === 0 ? 'no local changes' : `${c.dirtyCount} local ${c.dirtyCount === 1 ? 'change' : 'changes'}`}. Reported ${formatRelative(c.reportedAt, now)}.`
    : null;
  const agent = progress.sessionId ? sessionName(progress.sessionId) : null;

  const steps: StepperStep[] = [
    {
      id: 'hub', label: 'Hub reachable',
      description: offline ? undefined : `Hive answered at ${formatClock(lastPollAt)}.`,
      error: offline ? 'Hive is not answering. Waiting resumes when it is back.' : undefined,
    },
    {
      id: 'approved', label: 'Approved in the browser',
      description: c ? `Connected${where ? ` ${where}` : ''}${member === null ? ` as ${c.member}` : ''}.` : 'Ticks when the code from the terminal is approved on its approval page.',
    },
    {
      id: 'reported', label: 'Repository reported',
      description: checkout ?? 'Ticks when the background reporter sends the branch, HEAD and local changes.',
    },
    {
      id: 'agent', label: 'First agent registered',
      description: agent ? `${agent} registered.` : 'Ticks when the coding client starts in that folder and registers through the connection.',
    },
  ];
  const current = offline ? 0 : 1 + progress.done;

  return (
    <div className={styles.panel}>
      <div className={styles.waitHead}>
        <h2 className={styles.waitTitle}>{finished ? `${who ? `${who}'s` : 'Your'} agent is connected` : `Waiting for ${possessive} terminal`}</h2>
        {!finished && (
          <p className={styles.live} role="status">
            {!offline && <span className={styles.pulse} aria-hidden="true" />}
            {offline ? 'Paused while Hive is unreachable.' : 'This page updates on its own. Leave it open while they run the command.'}
          </p>
        )}
      </div>

      <Stepper orientation="vertical" steps={steps} current={Math.min(current, steps.length)} label={`Connection checklist for ${possessive} agent`} completeLabel="Agent connected" />

      {finished && (
        <Alert tone="success" title={`${agent ?? 'The agent'} is on the overview`}>
          Its intent, branch and local changes show up there. Hive checks its work against everyone else's from now on.
        </Alert>
      )}
      {!finished && progress.done === 2 && (
        <p className={styles.muted}>Almost there: start or restart the coding client in that repository folder.</p>
      )}

      <div className={styles.actions}>
        <Button variant="ghost" onClick={finished ? onStartOver : onBack}>{finished ? 'Connect another' : 'Back to the command'}</Button>
        <div className={styles.actionsEnd}>
          <Button variant={finished ? 'primary' : 'secondary'} onClick={() => navigate('/')}>Go to overview</Button>
        </div>
      </div>
    </div>
  );
}
