// Step 1, Invite. Admins create an invite link: a member-role browser token (token_create, kind 'member') whose
// value rides after the # of <hub>/ui/join, shown once. Members see their own link, built from the token this tab
// signed in with (it never leaves the browser).
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Alert } from '@/components/arc/alert/alert';
import { Button } from '@/components/arc/button/button';
import { Input } from '@/components/arc/input/input';
import { useHive } from '@/shell';
import { signedInToken } from '@/shell/store';
import { prefixFromSecret } from '../members/access';
import { inviteLink } from './logic';
import { CopyRow, type CreatedInvite } from './shared';
import styles from './Connect.module.css';

interface InviteStepProps {
  hubUrl: string;
  invite: CreatedInvite | null;
  onCreated: (invite: CreatedInvite) => void;
  onReset: () => void;
  onContinue: () => void;
}

export function InviteStep({ hubUrl, invite, onCreated, onReset, onContinue }: InviteStepProps) {
  const { me, identity, connection, mode, client, refresh } = useHive();
  const isAdmin = me?.role === 'admin';
  const offline = connection === 'offline';
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | undefined>();
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = import.meta.env.BASE_URL;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (offline || busy) return;
    const person = name.trim();
    if (!person) { setNameError('Enter the name of the person you are inviting.'); return; }
    if (person.length > 60) { setNameError('Keep the name to 60 characters or fewer.'); return; }
    setBusy(true);
    setCreateError(null);
    try {
      if (mode === 'mock') throw new Error('Invite links need a live Hive. Turn off prototype data with ?mock=0.');
      // Member role, browser session only. The value is returned once and never stored by Hive.
      const created = await client.tokenCreate({ label: `${person} · invite link`, member: person, role: 'member', kind: 'member' });
      onCreated({ memberName: created.record.member, link: inviteLink(hubUrl, base, created.token), tokenId: created.record.id,
        prefix: prefixFromSecret(created.token) ?? '' });
      setName('');
      void refresh({ access: true });
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Hive could not create the invite.');
    } finally {
      setBusy(false);
    }
  }

  if (!isAdmin) {
    const token = signedInToken();
    return (
      <div className={styles.panel}>
        <section className={styles.section} aria-labelledby="own-link-title">
          <div className={styles.sectionHead}>
            <h2 id="own-link-title" className={styles.sectionTitle}>Your invite link</h2>
            <p className={styles.secondary}>
              {`Opening it in a browser signs in as ${me?.name ?? 'you'}. Use it in the browser where your terminal opens the approval page, or on another device. Treat it like a password.`}
            </p>
          </div>
          {token && identity?.tokenId
            ? <CopyRow value={inviteLink(hubUrl, base, token)} label="Copy your invite link" />
            : <p className={styles.muted}>This tab has no member token to build a link from. Use the invite link an admin sent you.</p>}
          <p className={styles.muted}>Only admins can invite other people. Ask one if a teammate needs access.</p>
        </section>
        <div className={styles.actions}>
          <span />
          <div className={styles.actionsEnd}><Button onClick={onContinue}>Next: run one command</Button></div>
        </div>
      </div>
    );
  }

  if (invite) {
    return (
      <div className={styles.panel}>
        <section className={styles.section} aria-labelledby="invite-link-title">
          <div className={styles.sectionHead}>
            <h2 id="invite-link-title" className={styles.sectionTitle}>{`Invite link for ${invite.memberName}`}</h2>
            <p className={styles.secondary}>
              {`Send it privately. Opening it signs ${invite.memberName} in as a member, in that browser tab only. The token sits after the #, so it never reaches a server log, but anyone holding the link can use it.`}
            </p>
          </div>
          <CopyRow value={invite.link} label="Copy invite link" />
          <Alert tone="warning" title="This is the only time Hive shows this link">
            {`Hive keeps only the token's first characters${invite.prefix ? ` (${invite.prefix})` : ''}. If the link is lost, revoke it on Members and create a new one.`}
          </Alert>
        </section>
        <div className={styles.actions}>
          <Button variant="ghost" onClick={onReset}>Invite someone else</Button>
          <div className={styles.actionsEnd}><Button onClick={onContinue}>Next: the command they run</Button></div>
        </div>
        <p className={styles.muted}>
          Inviting someone else hides this link for good. It stays valid until you revoke it on <Link to="/members">Members</Link>.
        </p>
      </div>
    );
  }

  return (
    <form className={styles.panel} onSubmit={onSubmit} noValidate aria-labelledby="invite-title">
      <div className={styles.sectionHead}>
        <h2 id="invite-title" className={styles.sectionTitle}>Who are you inviting?</h2>
        <p className={styles.secondary}>
          Each person gets their own member link, so you can see whose agent did what and revoke one person without touching anyone else.
        </p>
      </div>
      <Input
        label="Name"
        placeholder="Priya"
        autoComplete="off"
        maxLength={60}
        value={name}
        onChange={(event) => { setName(event.target.value); if (nameError) setNameError(undefined); }}
        description="Their agents and machines show up under this name."
        error={nameError}
      />
      {createError && <Alert tone="danger" title="Hive did not create the invite">{createError}</Alert>}
      <div className={styles.actions}>
        <Button type="button" variant="ghost" onClick={onContinue}>Skip: connect my own repository</Button>
        <div className={styles.actionsEnd}>
          <Button type="submit" disabled={offline || busy}>{busy ? 'Creating…' : 'Create invite link'}</Button>
        </div>
      </div>
      {offline && <p className={styles.muted} role="status">Hive is unreachable, so invites cannot be created right now.</p>}
    </form>
  );
}
