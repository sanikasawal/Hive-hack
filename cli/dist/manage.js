import { unconfigureClaude, unconfigureMuse } from './clients.js';
import { deleteCredential, readCredential } from './credentials.js';
import { Hub, HubError } from './hub.js';
import { isAlive, nodePid, readNodeState, stopNode } from './node.js';
import { detectRepo } from './repo.js';
import { getConnection, removeConnection } from './state.js';
import { UserError, errorText } from './util.js';
function ago(iso) {
    if (!iso)
        return 'never';
    const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
    return seconds < 90 ? `${seconds}s ago` : seconds < 5400 ? `${Math.round(seconds / 60)} min ago` : `${Math.round(seconds / 3600)} h ago`;
}
export async function status() {
    const repo = detectRepo();
    const connection = getConnection(repo.root);
    if (!connection) {
        console.log(`${repo.name}: not connected to Hive. Run: hive-connect connect --hub <hive address>`);
        return 2;
    }
    const token = readCredential(connection.account);
    let credential = 'missing from the keychain (run hive-connect connect)';
    let member = connection.member ?? 'unknown';
    let ok = false;
    if (token) {
        try {
            const me = await new Hub(connection.hub, token).me();
            credential = `valid (${me.role}${me.kind ? `, ${me.kind}` : ''})`;
            member = me.member;
            ok = true;
        }
        catch (error) {
            credential = error instanceof HubError && error.status === 401 ? 'rejected by Hive (revoked?); run hive-connect connect to pair again' : `not checked: ${errorText(error)}`;
        }
    }
    const pid = nodePid(repo.root);
    const state = readNodeState(repo.root);
    const alive = pid !== null && isAlive(pid);
    console.log(`Hub:         ${connection.hub}`);
    console.log(`Member:      ${member}`);
    console.log(`Repository:  ${repo.name} (${connection.repoIdentity ?? 'no origin remote'}) at ${repo.root}`);
    console.log(`Client:      ${connection.client}`);
    console.log(`Credential:  ${credential}`);
    console.log(`Connector:   ${alive ? `running (pid ${pid})` : pid ? `dead (stale pid ${pid}); run hive-connect connect to restart it` : 'not running'}`);
    console.log(`Last report: ${ago(state?.lastReportAt)}${state?.lastError ? ` (last error: ${state.lastError})` : ''}`);
    return ok ? 0 : 2;
}
export async function disconnect(options) {
    const repo = detectRepo();
    const connection = getConnection(repo.root);
    if (!connection)
        throw new UserError(`${repo.name} is not connected to Hive; nothing to disconnect.`);
    const stopped = await stopNode(repo.root);
    const lines = [stopped ? 'Stopped the local connector.' : 'No local connector was running.'];
    const token = readCredential(connection.account);
    if (token) {
        try {
            await new Hub(connection.hub, token).command({ action: 'connector_disconnect' });
            lines.push('Revoked this connector credential on Hive.');
        }
        catch (error) {
            lines.push(error instanceof HubError && error.status === 401 ? 'The credential was already revoked on Hive.'
                : `Could not revoke the credential on Hive (${errorText(error)}); revoke "${connection.member ?? ''} · ${connection.machine} · ${connection.repoName}" on the Members page.`);
        }
    }
    if (!options.keepConfig) {
        const touched = connection.client === 'claude' ? unconfigureClaude(repo.root, connection.created ?? [])
            : connection.client === 'muse' ? unconfigureMuse(repo.root, connection.created ?? []) : [];
        lines.push(touched.length ? `Removed Hive's entries from: ${touched.join(', ')}` : 'No client configuration to remove.');
    }
    else
        lines.push('Kept client configuration (--keep-config).');
    deleteCredential(connection.account);
    removeConnection(repo.root);
    lines.push('Deleted the stored credential.', `Disconnected ${repo.name} from ${connection.hub}.`);
    for (const line of lines)
        console.log(line);
    return 0;
}
