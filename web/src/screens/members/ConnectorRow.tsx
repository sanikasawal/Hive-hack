// One Hive Connect credential (a connector): the machine and repository it is bound to, its last checkout report
// (branch@head, local changes), when it was last seen, and Disconnect. Every value came from people or machines,
// so it renders as text only.
import { Laptop } from 'lucide-react';
import { ConfirmMorph } from '@/components/arc/confirm-morph/confirm-morph';
import { useToastStack } from '@/components/arc/toast-stack/toast-stack';
import type { ConnectorSummary } from '@/api';
import { formatDateTime, formatRelative } from '@/shell';
import { useTokenActions } from './model';
import styles from './members.module.css';

interface ConnectorRowProps {
  connector: ConnectorSummary;
  /** Admins may disconnect any connector; a member only their own. */
  canDisconnect: boolean;
  offline: boolean;
  now: number;
  /** Agents registered through this credential right now. */
  agents: string[];
}

/** "main@1a2b3c4 · 3 local changes", or what is known so far. */
export function checkoutLine(c: Pick<ConnectorSummary, 'branch' | 'headShort' | 'dirtyCount' | 'reportedAt'>): string {
  if (c.reportedAt === null) return 'No checkout report yet';
  const where = `${c.branch ?? 'detached HEAD'}${c.headShort ? `@${c.headShort}` : ''}`;
  return `${where} · ${c.dirtyCount === 0 ? 'no local changes' : `${c.dirtyCount} local ${c.dirtyCount === 1 ? 'change' : 'changes'}`}`;
}

export function ConnectorRow({ connector: c, canDisconnect, offline, now, agents }: ConnectorRowProps) {
  const { disconnect } = useTokenActions();
  const { toast } = useToastStack();
  const title = [c.machine, c.repoName].filter(Boolean).join(' · ') || c.label;
  const seen = Math.max(c.reportedAt ?? 0, c.lastUsedAt ?? 0) || null;

  const confirm = async () => {
    try {
      await disconnect(c.tokenId);
    } catch (error) {
      toast({ type: 'error', title: `Could not disconnect ${title}`, description: error instanceof Error ? error.message : 'Hive did not accept the change.' });
      throw error;
    }
    toast({ type: 'success', title: `Disconnected ${title}`, description: 'Its credential is revoked. The terminal on that machine has to run hive-connect connect again.' });
  };

  return (
    <li className={styles.token}>
      <span className={styles.tokenIcon} aria-hidden="true"><Laptop size={16} strokeWidth={1.75} /></span>
      <div className={styles.tokenMain}>
        <div className={styles.tokenTitle}><span className={styles.tokenLabel}>{title}</span></div>
        <p className={styles.tokenMeta}>
          <span>{checkoutLine(c)}</span>
          <span title={seen !== null ? formatDateTime(seen) : undefined}>{seen !== null ? `Last seen ${formatRelative(seen, now)}` : 'Not seen yet'}</span>
        </p>
        <p className={styles.tokenAgents}>
          {c.repoIdentity ? `${c.repoIdentity}. ` : ''}
          {agents.length ? `Agents: ${agents.join(', ')}.` : 'No agent connected through it right now.'}
        </p>
      </div>
      {canDisconnect && (
        <div className={styles.tokenAction}>
          <ConfirmMorph
            label="Disconnect"
            prompt={`Disconnect ${title}?`}
            confirmLabel="Hold to disconnect"
            pendingLabel="Disconnecting"
            doneLabel="Disconnected"
            errorLabel="Not disconnected"
            confirmMode="hold"
            disabled={offline}
            onConfirm={confirm}
          />
        </div>
      )}
    </li>
  );
}
