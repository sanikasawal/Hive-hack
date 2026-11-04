// Store glue for the Members screen: turns the live store (or ?mock=1 prototype data) into access rows,
// and wraps the admin token actions so failures reach the UI instead of being swallowed.
import { useCallback, useMemo } from 'react';
import { CLIENTS, type ClientId } from '@/mock';
import { useHive, type HiveStore } from '@/shell';
import type { TokenRecord } from '@/api';
import { buildAccess, type Access, type AccessInput, type SessionLike } from './access';

/** Where "Invite member" lands: the invite step (step 1) of the connect flow. */
export const INVITE_PATH = '/connect?step=invite';

export function clientName(client: string | null): string {
  if (!client) return 'Unknown client';
  return CLIENTS.find(c => c.id === (client as ClientId))?.name ?? client;
}

/** Prototype data lifted into the live shapes, so ?mock=1 renders through the same code path. */
function mockInputs(store: Pick<HiveStore, 'tokens' | 'members' | 'me' | 'sessionName'>): Pick<AccessInput, 'me' | 'tokens' | 'sessions'> {
  const nameOf = (memberId: string) => store.members.find(m => m.id === memberId)?.name ?? memberId;
  const tokens: TokenRecord[] = store.tokens.map(t => ({ id: t.id, label: t.label, member: nameOf(t.memberId), role: t.role, prefix: t.prefix,
    createdBy: '', createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, revokedAt: t.revokedAt }));
  const sessions: SessionLike[] = store.tokens.flatMap(t => t.agentSessionIds.map(id => ({
    id, name: store.sessionName(id), client: t.client, member: nameOf(t.memberId), tokenId: t.id })));
  const me = store.me;
  const myToken = me ? store.tokens.find(t => t.memberId === me.id && !t.revokedAt) : undefined;
  return { me: me ? { role: me.role, member: me.name, tokenId: myToken?.id ?? null } : null, tokens, sessions };
}

/** Access rows for the signed-in role, recomputed when the store's data or `now` changes. */
export function useAccess(now: number): Access {
  const { mode, identity, tokenRecords, memberSummaries, snapshot, client, tokens, members, me, sessionName } = useHive();
  const signedInToken = mode === 'live' && identity?.tokenId ? client.token : null;
  const sessions = snapshot.sessions;
  return useMemo(() => (mode === 'mock'
    ? buildAccess({ ...mockInputs({ tokens, members, me, sessionName }), now })
    : buildAccess({ me: identity, tokens: tokenRecords, sessions, memberNames: memberSummaries.map(m => m.member), signedInToken, now,
      connectorTokenIds: memberSummaries.filter(m => m.member === identity?.member).flatMap(m => (m.connectors ?? []).map(c => c.tokenId)) })),
  [mode, identity, tokenRecords, memberSummaries, sessions, signedInToken, now, tokens, members, me, sessionName]);
}

/**
 * Rename and revoke. Live mode calls the daemon directly so a refusal (403, unknown token, offline)
 * rejects and the control shows it; then members and tokens refresh at once.
 */
export function useTokenActions() {
  const { mode, client, refresh, revokeToken, renameToken } = useHive();
  const revoke = useCallback(async (tokenId: string) => {
    if (mode === 'mock') return revokeToken(tokenId);
    try { await client.tokenRevoke(tokenId); } finally { void refresh({ access: true }); }
  }, [mode, client, refresh, revokeToken]);
  const rename = useCallback(async (tokenId: string, label: string) => {
    if (mode === 'mock') return renameToken(tokenId, label.trim());
    try { await client.tokenRename(tokenId, label.trim()); } finally { void refresh({ access: true }); }
  }, [mode, client, refresh, renameToken]);
  /** Hive Connect credential: connector_disconnect revokes it and clears its checkout report (own, or any for admins). */
  const disconnect = useCallback(async (tokenId: string) => {
    if (mode === 'mock') return revokeToken(tokenId);
    try { await client.connectorDisconnect(tokenId); } finally { void refresh({ access: true }); }
  }, [mode, client, refresh, revokeToken]);
  return { revoke, rename, disconnect };
}
