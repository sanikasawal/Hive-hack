// Admin-only advanced path: a token for an MCP client configured by hand (no hive-connect). The value is shown
// once, with a snippet built from the hub's real endpoints. Most people should use the one command instead.
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/arc/alert/alert';
import { Button } from '@/components/arc/button/button';
import { CodeBlock } from '@/components/arc/code-block/code-block';
import { Input } from '@/components/arc/input/input';
import { Select } from '@/components/arc/select/select';
import { ROLE_DESCRIPTION, ROLE_LABEL, type Role } from '@/mock';
import { useHive } from '@/shell';
import { CONNECT_CLIENTS, clientById, configSnippet, mcpUrl, type ConnectClientId } from './logic';
import { CopyRow, whereToPaste } from './shared';
import styles from './Connect.module.css';

const ROLES: Role[] = ['member', 'admin', 'viewer'];

export function AdvancedToken({ hubUrl }: { hubUrl: string }) {
  const { createToken, connection } = useHive();
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [client, setClient] = useState<ConnectClientId>('mcp');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ secret: string; member: string; client: ConnectClientId } | null>(null);
  const offline = connection === 'offline';

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const person = name.trim();
    if (!person) { setError('Enter whose token this is.'); return; }
    if (busy || offline) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createToken({ name: person, role, label: `${person} · ${clientById(client).name}`.slice(0, 80), client });
      setCreated({ secret: result.secret, member: result.member.name, client });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Hive could not create the token.');
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    const option = clientById(created.client);
    return (
      <div className={styles.advanced}>
        <CopyRow value={created.secret} label="Copy token" />
        <Alert tone="warning" title="This is the only time Hive shows this token">
          Copy it now and send it privately. Revoke it on Members if it is lost.
        </Alert>
        {created.client === 'mcp' ? (
          <dl className={styles.facts}>
            <div className={styles.fact}><dt>URL</dt><dd><CopyRow value={mcpUrl(hubUrl)} label="Copy URL" /></dd></div>
            <div className={styles.fact}><dt>Header</dt><dd><CopyRow value={`Authorization: Bearer ${created.secret}`} label="Copy header" /></dd></div>
          </dl>
        ) : (
          <CodeBlock code={configSnippet(created.client, hubUrl, created.secret)} filename={option.snippetLabel} language={option.snippetLanguage} />
        )}
        <p className={styles.muted}>{whereToPaste(created.client, created.member)}</p>
        {option.caveat && <p className={styles.muted}>{option.caveat}</p>}
        <div className={styles.actions}>
          <span />
          <div className={styles.actionsEnd}><Button variant="secondary" onClick={() => { setCreated(null); setName(''); }}>Create another</Button></div>
        </div>
      </div>
    );
  }

  return (
    <form className={styles.advanced} onSubmit={onSubmit} noValidate>
      <p className={styles.secondary}>
        For an MCP client set up by hand, without hive-connect. The token goes into that client's configuration, so prefer the one command when you can.
      </p>
      <div className={styles.formRow}>
        <Input label="Name" placeholder="Priya" autoComplete="off" maxLength={60} value={name}
          onChange={(event) => { setName(event.target.value); if (error) setError(null); }} />
        <Select label="Role" value={role} onValueChange={(value) => setRole(value as Role)} description={ROLE_DESCRIPTION[role]}
          options={ROLES.map(r => ({ value: r, label: ROLE_LABEL[r] }))} />
      </div>
      <Select label="Client" value={client} onValueChange={(value) => setClient(value as ConnectClientId)}
        options={CONNECT_CLIENTS.map(c => ({ value: c.id, label: c.name }))} />
      {error && <Alert tone="danger" title="Hive did not create the token">{error}</Alert>}
      <div className={styles.actions}>
        <span />
        <div className={styles.actionsEnd}><Button type="submit" variant="secondary" disabled={busy || offline}>{busy ? 'Creating…' : 'Create token'}</Button></div>
      </div>
    </form>
  );
}
