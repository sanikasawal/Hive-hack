// Shared pieces for the Connect flow.
import type { ReactNode } from 'react';
import { CopyButton } from '@/components/arc/copy-button/copy-button';
import type { ConnectorSummary, MemberSummary } from '@/api';
import type { ConnectClientId, ConnectorLike } from './logic';
import styles from './Connect.module.css';

/** An invite created on step 1 in this visit. The link carries a token shown once; it lives in component state only. */
export interface CreatedInvite {
  memberName: string;
  link: string;
  tokenId: string;
  /** "hive_mem_abcd1234": what Members shows for this token. */
  prefix: string;
}

/** Where each client's snippet goes, in one sentence (advanced token path). `name` is null for the signed-in person. */
export function whereToPaste(client: ConnectClientId, name: string | null): string {
  const self = name === null;
  switch (client) {
    case 'claude-code':
      return self
        ? 'Run this once in a terminal, inside the repository folder you work in. It installs the Hive hook and MCP server for this project and keeps the token out of git. Restart Claude Code afterwards.'
        : `${name} runs this once in a terminal, inside the repository folder they work in. It installs the Hive hook and MCP server for that project and keeps the token out of git. Then they restart Claude Code.`;
    case 'muse-code':
      return self
        ? 'Add this block to the MCP servers section of your Muse Code configuration, then reconnect.'
        : `${name} adds this block to the MCP servers section of their Muse Code configuration, then reconnects.`;
    default:
      return `${self ? 'Point' : `${name} points`} any MCP client that supports streamable HTTP with request headers at this URL, sending this header on every request.`;
  }
}

/** Connectors from member_list (admins: everyone's; members: their own), flattened with their member. */
export function connectorsOf(summaries: readonly MemberSummary[]): (ConnectorSummary & ConnectorLike)[] {
  return summaries.flatMap(m => (m.connectors ?? []).map(c => ({ ...c, member: m.member })));
}

export function CopyRow({ value, label, large = false, children }: { value: string; label: string; large?: boolean; children?: ReactNode }) {
  return (
    <div className={styles.valueRow}>
      <span className={[styles.value, large ? styles.valueLarge : ''].join(' ')}>{children ?? value}</span>
      <CopyButton value={value} label={label} />
    </div>
  );
}

export function StatusDot({ tone }: { tone: 'success' | 'warning' | 'danger' | 'neutral' }) {
  return <span className={styles.dot} data-tone={tone} aria-hidden="true" />;
}
