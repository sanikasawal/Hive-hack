import { readCredential } from './credentials.js';
import { Hub, normalizeHub } from './hub.js';
import { detectRepo } from './repo.js';
import { getConnection } from './state.js';
import { UserError } from './util.js';
/**
 * The connected checkout containing `cwd`: repository, connections.json row and stored credential.
 * HIVE_URL + HIVE_TOKEN in the environment override (operator use, CI). Throws UserError when not connected.
 */
export function connectedAt(cwd = process.cwd()) {
    const repo = detectRepo(cwd);
    const envToken = process.env.HIVE_TOKEN?.trim();
    const envUrl = process.env.HIVE_URL?.trim();
    const connection = getConnection(repo.root);
    if (envToken && envUrl) {
        const hubUrl = normalizeHub(envUrl);
        return { repo, token: envToken, hub: new Hub(hubUrl, envToken),
            connection: connection ?? { hub: hubUrl, repoIdentity: repo.identity, account: '', repoName: repo.name, tokenId: null, member: null, machine: '', client: 'other', createdAt: '' } };
    }
    if (!connection)
        throw new UserError(`${repo.root} is not connected to Hive. Run: hive-connect connect --hub <hive address>`);
    const token = readCredential(connection.account);
    if (!token)
        throw new UserError(`The Hive credential for ${repo.name} is missing from the keychain. Run hive-connect connect again.`);
    return { repo, connection, token, hub: new Hub(connection.hub, token) };
}
