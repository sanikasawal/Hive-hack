// Step 2, Run one command. `npx hive-connect connect --hub <hub>` inside the repository: the CLI confirms the
// repository, pairs through the browser (/pair/<code>), keeps the credential in the OS keychain and configures the
// coding client. The command comes from /me (connect.cliCommand) so it names the hub's public address.
import { useId } from 'react';
import { Button } from '@/components/arc/button/button';
import SegmentedControl from '@/components/arc/segmented-control/segmented-control';
import { Select } from '@/components/arc/select/select';
import { useHive, useMediaQuery } from '@/shell';
import { CLIENT_NOTES, CONNECT_CLIENTS, REMOTE_SCOPE_NOTE, type ConnectClientId } from './logic';
import { CopyRow } from './shared';
import styles from './Connect.module.css';

interface CommandStepProps {
  command: string;
  hubUrl: string;
  /** Who runs it: null for the signed-in person, else the invited teammate's name. */
  person: string | null;
  client: ConnectClientId;
  onClientChange: (client: ConnectClientId) => void;
  onBack: () => void;
  onContinue: () => void;
}

export function CommandStep({ command, hubUrl, person, client, onClientChange, onBack, onContinue }: CommandStepProps) {
  const { identity, mode } = useHive();
  const narrow = useMediaQuery('(max-width: 519px)');
  const labelId = useId();
  const self = person === null;
  const fromOrigin = mode === 'live' && identity !== null && !identity.publicUrl;
  const options = CONNECT_CLIENTS.map(c => ({ value: c.id, label: CLIENT_NOTES[c.id].name }));

  return (
    <div className={styles.panel}>
      <section className={styles.section} aria-labelledby="command-title">
        <div className={styles.sectionHead}>
          <h2 id="command-title" className={styles.sectionTitle}>{self ? 'Run one command in your repository' : `${person} runs one command in their repository`}</h2>
          <p className={styles.secondary}>
            {self
              ? 'Open a terminal in the repository you already work in and run this. You do not install the Hive backend or supply a model key.'
              : `After opening the invite link, ${person} opens a terminal in the repository they already work in and runs this. They need Node 18 or newer and git; no Hive backend, no model key.`}
          </p>
        </div>
        <CopyRow value={command} label="Copy command" large />
        {fromOrigin && (
          <p className={styles.muted}>
            {`HIVE_PUBLIC_URL is not set, so the hub address is the one this page was opened on (${hubUrl}). Teammates on other machines need an address they can reach.`}
          </p>
        )}
      </section>

      <section className={styles.section} aria-labelledby="happens-title">
        <h2 id="happens-title" className={styles.sectionTitle}>What happens next</h2>
        <ol className={styles.steps}>
          <li>It asks to confirm the repository it found (name and remote).</li>
          <li>It prints a code and opens an approval page in the browser. {self ? 'You approve' : `${person} approves`} it while signed in.</li>
          <li>The credential goes into the OS keychain (or a private file with a warning when there is no keychain), never into the repository.</li>
          <li>It configures the coding client and starts a small background reporter for the branch, HEAD and local changes.</li>
        </ol>
      </section>

      <section className={styles.section} aria-labelledby="client-title">
        <div className={styles.sectionHead}>
          <h2 id="client-title" className={styles.sectionTitle}>Coding client</h2>
          <p className={styles.secondary}>The command detects Claude Code and Muse Code and asks when it finds both or neither.</p>
        </div>
        {narrow ? (
          <Select label="Client" value={client} onValueChange={(value) => onClientChange(value as ConnectClientId)} options={options} />
        ) : (
          <div className={[styles.field, styles.fieldStart].join(' ')}>
            <span id={labelId} className={styles.fieldLabel}>Client</span>
            <SegmentedControl label="Client" value={client} onValueChange={(value) => onClientChange(value as ConnectClientId)} options={options} />
          </div>
        )}
        <p className={styles.secondary}>{CLIENT_NOTES[client].note}</p>
        <p className={styles.muted}>{REMOTE_SCOPE_NOTE}</p>
      </section>

      <div className={styles.actions}>
        <Button variant="ghost" onClick={onBack}>Back</Button>
        <div className={styles.actionsEnd}>
          <Button onClick={onContinue}>{self ? 'I ran it: wait for my agent' : 'Wait for their agent'}</Button>
        </div>
      </div>
    </div>
  );
}
