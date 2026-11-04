import { hostname } from 'node:os';
import { configureClaude, configureMuse, detectClients, unconfigureClaude, unconfigureMuse, launcher, otherClientInstructions, type ConfigResult } from './clients.js';
import { deleteCredential, readCredential, storeCredential } from './credentials.js';
import { Hub, HubError, normalizeHub, type Me } from './hub.js';
import { startNodeDetached } from './node.js';
import { ask, confirm, openBrowser, spinner } from './prompt.js';
import { detectRepo, repoKey, stripUrlCredentials, type RepoInfo } from './repo.js';
import { accountFor, getConnection, saveConnection, type Client } from './state.js';
import { hubBase, reportCheckout } from './sync.js';
import { UserError, errorText, sleep } from './util.js';

export interface ConnectOptions { hub?: string; client?: Client; yes: boolean; node: boolean; browser: boolean }

const CLIENT_NAMES: Record<Client, string> = { claude: 'Claude Code', muse: 'Muse Code', other: 'another MCP client' };
const CLIENT_LABELS: Record<Client, string> = { claude: 'claude-code', muse: 'muse-code', other: 'mcp' };

async function chooseClient(options: ConnectOptions, previous: Client | undefined): Promise<Client> {
  if (options.client) return options.client;
  if (previous) return previous;
  const found = detectClients();
  if (found.length === 1) return found[0]!;
  if (options.yes) return found[0] ?? 'claude';
  const answer = await ask(`Which coding client should Hive configure? ${found.length ? `(found: ${found.map(c => CLIENT_NAMES[c]).join(', ')}) ` : ''}[1] Claude Code  [2] Muse Code  [3] other MCP client  (1) `);
  return answer === '2' || /^muse/i.test(answer) ? 'muse' : answer === '3' || /^other/i.test(answer) ? 'other' : 'claude';
}

/** Device pairing: pair_start → show the code → open the approval page → poll until the signed-in member decides. */
async function pair(hubUrl: string, repo: RepoInfo, machine: string, client: Client, options: ConnectOptions): Promise<{ token: string; tokenId: string; member: string }> {
  const anonymous = new Hub(hubUrl, null);
  const started = await anonymous.command<{ pairingId: string; userCode: string; pollSecret: string; verifyUrl: string; expiresAt: number; interval?: number }>({
    action: 'pair_start', repo: { name: repo.name, identity: repo.identity, rootCommit: repo.rootCommit }, machine, client: CLIENT_LABELS[client],
  });
  const code = started.userCode.length === 8 ? `${started.userCode.slice(0, 4)}-${started.userCode.slice(4)}` : started.userCode;
  console.log('');
  console.log(`Code: ${code}`);
  console.log(`Approve this connection in your browser (signed in to Hive): ${started.verifyUrl}`);
  console.log('Check that the code on the page matches before you approve.');
  if (options.browser) openBrowser(started.verifyUrl);
  const intervalMs = Number(process.env.HIVE_CONNECT_POLL_MS) || Math.max(1, started.interval ?? 2) * 1000;
  const wait = spinner('Waiting for approval in the browser…');
  let failures = 0;
  try {
    for (;;) {
      if (Date.now() > started.expiresAt + 5_000) throw new UserError('The pairing code expired. Run hive-connect connect again.');
      await sleep(intervalMs);
      let result: { status: string; token?: string; tokenId?: string; member?: string; interval?: number };
      try {
        result = await anonymous.command({ action: 'pair_poll', pairingId: started.pairingId, pollSecret: started.pollSecret });
        failures = 0;
      } catch (error) {
        if (error instanceof HubError && error.status >= 400 && error.status < 500 && error.status !== 429) throw new UserError(`Pairing failed: ${error.message}`);
        if (++failures >= 15) throw new UserError(`Lost contact with Hive while waiting for approval: ${errorText(error)}`);
        continue;
      }
      if (result.status === 'pending') continue;
      if (result.status === 'approved' && result.token) { wait.stop(`Approved by ${result.member}.`); return { token: result.token, tokenId: result.tokenId!, member: result.member! }; }
      if (result.status === 'denied') throw new UserError('The connection was denied in the browser. Nothing was changed.');
      if (result.status === 'expired') throw new UserError('The pairing code expired before it was approved. Run hive-connect connect again.');
      throw new UserError(`Pairing ended with status "${result.status}". Run hive-connect connect again.`);
    }
  } catch (error) {
    wait.stop();
    throw error;
  }
}

export async function connect(options: ConnectOptions): Promise<number> {
  const repo = detectRepo();
  const existing = getConnection(repo.root);
  const rawHub = options.hub ?? process.env.HIVE_URL ?? existing?.hub;
  if (!rawHub) throw new UserError('Pass the Hive address: hive-connect connect --hub https://<your hive>  (the Connect page in the dashboard shows the exact command)');
  const hubUrl = normalizeHub(rawHub);
  if (existing && existing.hub !== hubUrl) throw new UserError(`${repo.name} is connected to ${existing.hub}. Run hive-connect disconnect first to switch to ${hubUrl}.`);

  const shownRemote = repo.remote ? stripUrlCredentials(repo.remote) : 'no origin remote';
  if (!options.yes && !(await confirm(`Connect ${repo.name} (${shownRemote}) to Hive at ${hubUrl}?`))) {
    console.log('Cancelled; nothing was changed.');
    return 2;
  }
  if (!repo.identity) console.error('Note: this repository has no recognizable origin remote; Hive will identify it by its first commit.');

  const client = await chooseClient(options, existing?.client);
  const machine = (existing?.machine || hostname() || 'laptop').replace(/[\0-\x1f\x7f]/g, '').slice(0, 80);
  const account = existing?.account || accountFor(hubUrl, repoKey(repo));

  // Reconnect: a stored credential the hub still accepts is reused (no pairing).
  let token = readCredential(account);
  let me: Me | null = null;
  let tokenId = existing?.tokenId ?? null;
  if (token) {
    try { me = await new Hub(hubUrl, token).me(); }
    catch (error) {
      if (error instanceof HubError && error.status === 401) {
        console.error('The stored Hive credential is no longer accepted (revoked or expired); pairing again.');
        deleteCredential(account);
        token = null;
      } else throw new UserError(errorText(error));
    }
  }
  const reconnect = Boolean(token && me);
  if (!token) {
    const paired = await pair(hubUrl, repo, machine, client, options);
    token = paired.token;
    tokenId = paired.tokenId;
    const where = storeCredential(account, token);
    console.log(`Credential stored in ${where === 'file' ? 'a protected file (0600)' : `the OS ${where}`}.`);
  }
  const hub = new Hub(hubUrl, token);
  if (!me) me = await hub.me().catch(error => { throw new UserError(`Hive did not accept the new credential: ${errorText(error)}`); });
  if (me.role !== 'member' && me.role !== 'admin') throw new UserError(`This credential has the ${me.role} role; agents need a member credential.`);
  tokenId = me.tokenId ?? tokenId;

  // Client configuration (idempotent; preserves everything that is not Hive's).
  const l = launcher();
  if (existing && existing.client !== client) {
    if (existing.client === 'claude') unconfigureClaude(repo.root, existing.created ?? []);
    if (existing.client === 'muse') unconfigureMuse(repo.root, existing.created ?? []);
  }
  let config: ConfigResult = { files: [], created: [], notes: [] };
  if (client === 'claude') config = configureClaude(repo.root, l);
  else if (client === 'muse') config = configureMuse(repo.root, l);
  const created = [...new Set([...(existing?.created ?? []), ...config.created])].sort();
  saveConnection(repo.root, { hub: hubUrl, repoIdentity: repo.identity, account, repoName: repo.name, tokenId, member: me.member, machine, client,
    createdAt: existing?.createdAt ?? new Date().toISOString(), ...(created.length ? { created } : {}) });

  // Local connector process.
  let nodeLine = 'Local connector: not started (--no-node); hooks still sync your changes at prompt time.';
  if (options.node) {
    const pid = await startNodeDetached(repo.root);
    nodeLine = `Local connector: running in the background (pid ${pid}); stop it with hive-connect disconnect.`;
  }

  // Verification: the credential works and one checkout report is accepted.
  try {
    await reportCheckout(hub, repo, await hubBase(hub), machine);
  } catch (error) {
    throw new UserError(`Connected, but Hive refused the checkout report: ${errorText(error)}`);
  }

  console.log('');
  console.log(`${reconnect ? 'Reconnected' : 'Connected'} ${repo.name} to Hive workspace "${me.workspace.name}" at ${hubUrl} as ${me.member}.`);
  if (config.files.length) console.log(`${CLIENT_NAMES[client]} configured: ${config.files.join(', ')}`);
  for (const note of config.notes) console.log(`- ${note}`);
  if (client === 'other') for (const line of otherClientInstructions(l, hubUrl)) console.log(line);
  console.log(nodeLine);
  console.log('Verified: credential accepted and checkout reported.');
  console.log('');
  console.log(client === 'other'
    ? `Add the MCP server above to your client and start it in this folder. Your agent will appear at ${hubUrl}/ui.`
    : `Start or restart ${CLIENT_NAMES[client]} in this folder. Your agent will appear at ${hubUrl}/ui.`);
  return 0;
}
