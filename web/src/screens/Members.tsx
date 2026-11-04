// Members and tokens: who can reach this workspace over its cloud link, and the tokens their agents use.
// Admins see every member (token_list + member_list); members see only themselves; viewers get a
// read-only explanation and the viewer-safe list of who has agents connected.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserPlus } from 'lucide-react';
import { Alert } from '@/components/arc/alert/alert';
import { Button } from '@/components/arc/button/button';
import { EmptyState } from '@/components/arc/empty-state/empty-state';
import { Skeleton } from '@/components/arc/skeleton/skeleton';
import { Page, useHive, useNow } from '@/shell';
import { AccessAside } from './members/AccessAside';
import { MemberSection } from './members/MemberSection';
import { canManageTokens, countAgents } from './members/access';
import { INVITE_PATH, useAccess } from './members/model';
import styles from './members/members.module.css';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export default function Members() {
  const { role: myRole, status, connection, view, events, error, memberSummaries, snapshot, sessionName, me } = useHive();
  const navigate = useNavigate();
  const now = useNow(15_000);
  const [previewViewer, setPreviewViewer] = useState(false);
  const access = useAccess(now);

  const signedInRole = myRole ?? 'viewer';
  const role = previewViewer ? 'viewer' : signedInRole;
  const offline = connection === 'offline';
  const manageable = canManageTokens(role);
  const tokenEventsLogged = events.some(e => e.type.startsWith('token.'));
  const invite = () => navigate(INVITE_PATH);

  const others = access.rows.filter(r => !r.isMe);
  const connectorsBy = new Map(memberSummaries.map(m => [m.member, m.connectors ?? []]));
  const agentsByToken: Record<string, string[]> = {};
  for (const s of snapshot.sessions) if (s.tokenId) (agentsByToken[s.tokenId] ??= []).push(sessionName(s.id));
  // What /api/view would list: members with at least one connected agent.
  const previewPeople = access.rows.filter(r => r.agents.length > 0).map(r => ({ member: r.name, sessions: r.agents.length }));
  const summary = role === 'viewer'
    ? 'Who can reach this workspace over its cloud link. Viewers can look, not change.'
    : access.scope === 'own'
      ? 'You and the agents you have connected. Only admins see everyone.'
      : `${plural(access.rows.length, 'person', 'people')} and ${plural(access.activeTokens, 'active token', 'active tokens')}. Members join over the cloud link from anywhere.`;

  const aside = (
    <AccessAside myRole={signedInRole} previewViewer={previewViewer} onPreviewViewerChange={setPreviewViewer} tokenEventsLogged={tokenEventsLogged} />
  );

  if (status === 'loading' && !myRole) {
    return (
      <Page title="Members" description="Loading members and tokens.">
        <Skeleton label="Loading members" lines={4} avatar />
      </Page>
    );
  }

  return (
    <Page
      title="Members"
      description={summary}
      actions={role !== 'admin' ? undefined : (
        <Button variant="primary" onClick={invite} disabled={offline}>
          <UserPlus size={16} strokeWidth={1.75} aria-hidden="true" />
          Invite member
        </Button>
      )}
    >
      {role === 'viewer' && (
        <Alert tone="info" title={previewViewer ? 'Previewing the viewer role' : 'You have read-only access'}>
          {previewViewer
            ? 'Viewers do not see tokens, and invite, rename and revoke are hidden. Turn off the preview to see your own view again.'
            : 'Viewer tokens can read the workspace and its activity. They cannot see tokens, connect agents or change access. Ask an admin if you need more.'}
        </Alert>
      )}
      {role === 'member' && (
        <Alert tone="info" title="Only admins manage tokens">
          You can see the token you signed in with, your connected machines and their agents, and disconnect your own machines. Ask an admin to invite people, rename or revoke tokens.
        </Alert>
      )}
      {offline && manageable && (
        <p className={styles.offlineNote}>You are offline. Inviting, renaming and revoking come back when the connection does.</p>
      )}
      {error && manageable && !offline && (
        <p className={styles.offlineNote} role="status">Last refresh failed: {error}</p>
      )}

      <div className={styles.layout}>
        <div className={styles.list}>
          {role === 'viewer' ? (
            <ViewerPeople people={view?.members ?? (previewViewer ? previewPeople : null)} />
          ) : (
            <>
              {access.rows.map(row => (
                <MemberSection key={row.id} row={row} manageable={manageable} offline={offline} now={now}
                  connectors={previewViewer ? [] : connectorsBy.get(row.name) ?? []}
                  canDisconnect={!previewViewer && (signedInRole === 'admin' || row.name === me?.name)} agentsByToken={agentsByToken} />
              ))}
              {access.scope === 'all' && others.length === 0 && (
                <div className={styles.empty}>
                  <EmptyState
                    title="No one else has joined yet"
                    description="Invite a teammate to generate their token and a ready config for their coding agent. They connect over the cloud link from wherever they work."
                    action={<Button variant="secondary" onClick={invite} disabled={offline}>Invite member</Button>}
                  />
                </div>
              )}
            </>
          )}
        </div>
        {aside}
      </div>
    </Page>
  );
}

/** Viewer-safe list (from /api/view): member names and how many agents each has connected. */
function ViewerPeople({ people }: { people: { member: string; sessions: number }[] | null }) {
  if (people === null) {
    return (
      <p className={styles.noTokens}>Viewers see who has agents connected and nothing about tokens.</p>
    );
  }
  if (people.length === 0) {
    return (
      <div className={styles.empty}>
        <EmptyState title="No agents connected" description="When members connect agents, their names appear here." />
      </div>
    );
  }
  return (
    <section className={styles.panel} aria-labelledby="connected-heading">
      <h2 id="connected-heading" className={styles.panelTitle}>People with agents connected</h2>
      <ul className={styles.people}>
        {people.map(p => (
          <li key={p.member} className={styles.person}>
            <span className={styles.agentName}>{p.member}</span>
            <span className={styles.agentClient}>{countAgents(p.sessions)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
