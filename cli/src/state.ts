import { join } from 'node:path';
import { configDir, readJson, sha256, writeJson } from './util.js';

/** One connected checkout. No secrets: the credential lives in the keychain (or credentials.json). */
export interface Connection {
  hub: string;
  repoIdentity: string | null;
  /** Keychain account: "<hubHost>|<repo key>". */
  account: string;
  repoName: string;
  tokenId: string | null;
  member: string | null;
  machine: string;
  client: Client;
  createdAt: string;
  /** Config files this tool created (deleted again on disconnect when only Hive's entries were left). */
  created?: string[];
}
export type Client = 'claude' | 'muse' | 'other';
type Connections = Record<string, Connection>;

export const connectionsPath = () => join(configDir(), 'connections.json');

export function loadConnections(): Connections { return readJson<Connections>(connectionsPath(), {}); }

export function getConnection(repoRoot: string): Connection | undefined { return loadConnections()[repoRoot]; }

export function saveConnection(repoRoot: string, connection: Connection): void {
  const all = loadConnections();
  all[repoRoot] = connection;
  writeJson(connectionsPath(), sortKeys(all), 0o600);
}

export function removeConnection(repoRoot: string): boolean {
  const all = loadConnections();
  if (!(repoRoot in all)) return false;
  delete all[repoRoot];
  writeJson(connectionsPath(), all, 0o600);
  return true;
}

function sortKeys<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

export function accountFor(hub: string, key: string): string { return `${new URL(hub).host}|${key}`; }

/** Files for the background connector of one checkout. */
export function nodeFiles(repoRoot: string): { pid: string; state: string; log: string } {
  const id = sha256(repoRoot).slice(0, 16);
  const dir = join(configDir(), 'nodes');
  return { pid: join(dir, `${id}.pid`), state: join(dir, `${id}.json`), log: join(dir, `${id}.log`) };
}
