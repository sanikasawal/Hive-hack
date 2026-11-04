// /pair/:code: the browser half of `hive-connect connect`. The CLI prints a code and opens this page; the signed-in
// member checks the repository and machine and approves (or denies). Approval creates a connector credential for
// that member, which the CLI collects exactly once. Everything shown comes from pair_info and renders as text.
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CircleAlert } from 'lucide-react';
import { Alert } from '@/components/arc/alert/alert';
import { Button } from '@/components/arc/button/button';
import { PasswordField } from '@/components/arc/password-field/password-field';
import { ApiError, type PairingInfo } from '@/api';
import { Standalone, formatRelative, useHive, useNow } from '@/shell';
import { CLIENT_NOTES, tokenFromInvite, type ConnectClientId } from './connect/logic';
import styles from './pair/pair.module.css';

const POLL_MS = 2000;

/** "ABCD-EFGH": how the CLI prints the code, easier to compare by eye. */
function displayCode(code: string): string {
  const clean = code.toUpperCase().replace(/[\s-]/g, '');
  return clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

function clientLabel(client: string | null): string {
  if (!client) return 'Not given';
  return CLIENT_NOTES[client as ConnectClientId]?.name ?? client;
}

function countdown(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.round((expiresAt - now) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`;
}

type Load = { kind: 'loading' } | { kind: 'ready'; info: PairingInfo } | { kind: 'unknown' } | { kind: 'error'; message: string };

export default function Pair() {
  const { code: rawCode = '' } = useParams();
  const code = displayCode(rawCode);
  const { status, identity } = useHive();

  useEffect(() => { document.title = `Approve ${code} · Hive`; }, [code]);

  return (
    <Standalone>
      <div className={styles.wrap}>
        <section className={styles.card} aria-labelledby="pair-title">
          <span className={styles.wordmark}>Hive</span>
          {status === 'loading' ? (
            <div className={styles.heading} role="status">
              <h1 id="pair-title" className={styles.title}>Checking your sign-in</h1>
              <p className={styles.lede}>One moment while Hive confirms who you are.</p>
            </div>
          ) : !identity || status === 'signed-out' ? (
            <SignedOut code={code} />
          ) : identity.role === 'viewer' || identity.kind === 'connector' ? (
            <CannotApprove code={code} viewer={identity.role === 'viewer'} />
          ) : (
            <Approve code={code} member={identity.member} />
          )}
        </section>
        <p className={styles.footer}>
          <span>Code <span className={styles.mono}>{code}</span></span>
          <span>Only approve a code you just saw in your own terminal.</span>
        </p>
      </div>
    </Standalone>
  );
}

/** Not signed in in this tab: an invite link (or token) signs in here and the page continues. */
function SignedOut({ code }: { code: string }) {
  const { signIn } = useHive();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = useId();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const token = tokenFromInvite(value);
    if (!token) { setError('Paste the invite link you were sent (it contains #token=), or your member token.'); return; }
    setBusy(true);
    const result = await signIn(token);
    setBusy(false);
    if (!result.ok) setError(result.reason);
    else setValue('');
  }

  return (
    <>
      <div className={styles.heading}>
        <h1 id="pair-title" className={styles.title}>Sign in with an invite link</h1>
        <p className={styles.lede}>
          {'A terminal asked to connect a repository to Hive with code '}<span className={styles.mono}>{code}</span>
          {'. Sign in as the member it should connect as, then approve it. This browser tab is not signed in yet.'}
        </p>
      </div>
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        <PasswordField
          label="Invite link or member token"
          name="invite"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://…/ui/join#token=…"
          value={value}
          onChange={(event) => { setValue(event.target.value); if (error) setError(null); }}
          description="The link an admin sent you. It stays in this tab and is cleared when you close it."
          messages={{ showPassword: 'Show link', hidePassword: 'Hide link' }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
        {error && (
          <p id={errorId} className={styles.error} role="alert">
            <CircleAlert size={16} aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}
        <div className={styles.actions}>
          <Button type="submit" disabled={busy}>{busy ? 'Checking…' : 'Sign in and continue'}</Button>
        </div>
      </form>
      <p className={styles.muted}>No invite link? Ask an admin of this workspace to send you one from the Connect page.</p>
    </>
  );
}

function CannotApprove({ code, viewer }: { code: string; viewer: boolean }) {
  const { signOut } = useHive();
  return (
    <>
      <div className={styles.heading}>
        <h1 id="pair-title" className={styles.title}>Sign in with an invite link</h1>
        <p className={styles.lede}>
          {viewer
            ? `You are signed in with a viewer token, which can only read this workspace. To approve code ${code}, sign in with the member invite link an admin sent you.`
            : `This tab is signed in with a Hive Connect credential, which cannot approve pairings. Sign in with your member invite link to approve code ${code}.`}
        </p>
      </div>
      <div className={styles.actions}>
        <Button variant="secondary" onClick={signOut}>Use an invite link</Button>
      </div>
    </>
  );
}

function Approve({ code, member }: { code: string; member: string }) {
  const { client } = useHive();
  const now = useNow(1000);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);

  const fetchInfo = useCallback(async (): Promise<PairingInfo | null> => {
    try {
      const info = await client.pairInfo(code);
      setLoad({ kind: 'ready', info });
      return info;
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'http' && /unknown pairing code/i.test(error.message)) setLoad({ kind: 'unknown' });
      else if (error instanceof ApiError && error.kind === 'http' && error.status === 400) setLoad({ kind: 'unknown' });
      else setLoad(prev => prev.kind === 'ready' ? prev : { kind: 'error', message: error instanceof Error ? error.message : 'Hive did not answer.' });
      return null;
    }
  }, [client, code]);

  // Follow the pairing while it can still change (pending, or approved until the CLI collects it).
  const live = load.kind === 'loading' || load.kind === 'error' || (load.kind === 'ready' && (load.info.status === 'pending' || load.info.status === 'approved'));
  useEffect(() => {
    if (!live) return;
    void fetchInfo();
    const id = window.setInterval(() => { void fetchInfo(); }, POLL_MS);
    return () => window.clearInterval(id);
  }, [live, fetchInfo]);

  async function decide(kind: 'approve' | 'deny') {
    if (busy) return;
    setBusy(kind);
    setActionError(null);
    try {
      if (kind === 'approve') {
        const approved = await client.pairApprove(code);
        setLabel(approved.label);
        setLoad({ kind: 'ready', info: approved });
      } else {
        setLoad({ kind: 'ready', info: await client.pairDeny(code) });
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Hive did not accept the decision.');
      void fetchInfo();
    } finally {
      setBusy(null);
    }
  }

  if (load.kind === 'loading') {
    return (
      <div className={styles.heading} role="status">
        <h1 id="pair-title" className={styles.title}>Looking up code {code}</h1>
        <p className={styles.lede}>Fetching what this terminal asked for.</p>
      </div>
    );
  }
  if (load.kind === 'unknown') {
    return (
      <Outcome title="Hive does not know this code"
        text={`No pairing matches ${code}. Check that the address in your browser matches the code in your terminal, or run the command again for a new code.`} />
    );
  }
  if (load.kind === 'error') {
    return (
      <>
        <Outcome title="Cannot reach Hive" text={`${load.message} This page keeps trying every 2 seconds.`} />
        <div className={styles.actions}><Button variant="secondary" onClick={() => { void fetchInfo(); }}>Retry now</Button></div>
      </>
    );
  }

  const info = load.info;
  const repoName = info.repo.name || 'this repository';
  switch (info.status) {
    case 'approved':
      return (
        <>
          <Outcome title="Return to your terminal"
            text={`Approved. hive-connect picks up the credential within a few seconds and finishes setting up ${repoName} on ${info.machine}.`} />
          <Alert tone="success" title={`Connected as ${info.member ?? member}`}>
            {`The credential is labelled "${label ?? `${info.member ?? member} · ${info.machine} · ${repoName}`}". You can revoke it any time on Members.`}
          </Alert>
          <p className={styles.muted}><Link to="/">Open the dashboard</Link></p>
        </>
      );
    case 'consumed':
      return (
        <>
          <Outcome title="Return to your terminal"
            text={`This code was approved and the terminal has collected its credential, so ${repoName} on ${info.machine} is connected${info.member ? ` as ${info.member}` : ''}. The code cannot be used again.`} />
          <p className={styles.muted}><Link to="/members">See it on Members</Link> or <Link to="/">open the dashboard</Link>.</p>
        </>
      );
    case 'denied':
      return <Outcome title="Denied" text={`Nothing was connected. The command waiting in the terminal on ${info.machine} stops. Run it again if this was a mistake.`} />;
    case 'expired':
      return <Outcome title="This code expired" text="Codes are valid for 10 minutes. Run the command in your terminal again to get a new one." />;
    default:
      break;
  }

  return (
    <>
      <div className={styles.heading}>
        <h1 id="pair-title" className={styles.title}>{`Connect ${repoName} on ${info.machine}?`}</h1>
        <p className={styles.lede}>
          {`Approving gives the terminal on ${info.machine} its own credential, so its agents show up as ${member}. Check that the code matches your terminal: `}
          <span className={styles.code}>{displayCode(info.userCode)}</span>
        </p>
      </div>
      <dl className={styles.facts}>
        <div className={styles.fact}><dt>Repository</dt><dd>{repoName}</dd></div>
        <div className={styles.fact}>
          <dt>Remote</dt>
          <dd>{info.repo.identity ? <span className={styles.mono}>{info.repo.identity}</span> : 'No remote reported'}</dd>
        </div>
        <div className={styles.fact}><dt>Machine</dt><dd>{info.machine}</dd></div>
        <div className={styles.fact}><dt>Client</dt><dd>{clientLabel(info.client)}</dd></div>
        <div className={styles.fact}><dt>Connects as</dt><dd>{member}</dd></div>
        <div className={styles.fact}>
          <dt>Requested</dt>
          <dd>{`${formatRelative(info.createdAt, now)}, expires in ${countdown(info.expiresAt, now)}`}</dd>
        </div>
      </dl>
      {actionError && <Alert tone="danger" title="Hive did not record that">{actionError}</Alert>}
      <div className={styles.actions}>
        <Button variant="ghost" onClick={() => { void decide('deny'); }} disabled={busy !== null}>{busy === 'deny' ? 'Denying…' : 'Deny'}</Button>
        <Button onClick={() => { void decide('approve'); }} disabled={busy !== null}>{busy === 'approve' ? 'Approving…' : `Approve as ${member}`}</Button>
      </div>
      <p className={styles.muted}>Hive never stores the remote address itself, only the host and repository path shown above.</p>
    </>
  );
}

function Outcome({ title, text }: { title: string; text: string }) {
  return (
    <div className={styles.heading} role="status">
      <h1 id="pair-title" className={styles.title}>{title}</h1>
      <p className={styles.lede}>{text}</p>
    </div>
  );
}
