import { join } from 'node:path';
import { configDir, readJson, sha256, writeJson } from './util.js';
export const connectionsPath = () => join(configDir(), 'connections.json');
export function loadConnections() { return readJson(connectionsPath(), {}); }
export function getConnection(repoRoot) { return loadConnections()[repoRoot]; }
export function saveConnection(repoRoot, connection) {
    const all = loadConnections();
    all[repoRoot] = connection;
    writeJson(connectionsPath(), sortKeys(all), 0o600);
}
export function removeConnection(repoRoot) {
    const all = loadConnections();
    if (!(repoRoot in all))
        return false;
    delete all[repoRoot];
    writeJson(connectionsPath(), all, 0o600);
    return true;
}
function sortKeys(value) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}
export function accountFor(hub, key) { return `${new URL(hub).host}|${key}`; }
/** Files for the background connector of one checkout. */
export function nodeFiles(repoRoot) {
    const id = sha256(repoRoot).slice(0, 16);
    const dir = join(configDir(), 'nodes');
    return { pid: join(dir, `${id}.pid`), state: join(dir, `${id}.json`), log: join(dir, `${id}.log`) };
}
