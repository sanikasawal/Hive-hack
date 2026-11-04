import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, ensureDir, onPath, readJson, warn, writeJson } from './util.js';

/**
 * Credential storage, best available first:
 *  - macOS: the login keychain via `security` (generic password, service "hive-connect");
 *  - Linux: the Secret Service via `secret-tool` when it is installed and a keyring answers;
 *  - Windows: the Credential Locker (PasswordVault) via PowerShell. `cmdkey /generic` can store but never read a
 *    secret back, so it cannot serve the bridge; PasswordVault is the readable equivalent (untested here);
 *  - otherwise $XDG_CONFIG_HOME/hive/credentials.json with mode 0600 and a one-line warning.
 * HIVE_CONNECT_NO_KEYCHAIN=1 forces the file store (tests, headless machines).
 */
export const SERVICE = 'hive-connect';
export type StoreKind = 'keychain' | 'secret-service' | 'credential-locker' | 'file';

export const credentialsPath = () => join(configDir(), 'credentials.json');

function backend(): StoreKind {
  if (process.env.HIVE_CONNECT_NO_KEYCHAIN === '1') return 'file';
  if (process.platform === 'darwin' && onPath('security')) return 'keychain';
  if (process.platform === 'linux' && onPath('secret-tool')) return 'secret-service';
  if (process.platform === 'win32' && onPath('powershell')) return 'credential-locker';
  return 'file';
}

const PS_VAULT = '[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime];$v=New-Object Windows.Security.Credentials.PasswordVault;';
function powershell(script: string, input?: string): { ok: boolean; out: string } {
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', input, windowsHide: true, timeout: 15_000 });
  return { ok: result.status === 0, out: result.stdout ?? '' };
}

function fileRead(account: string): string | null {
  return readJson<Record<string, string>>(credentialsPath(), {})[account] ?? null;
}
function fileWrite(account: string, token: string | null): void {
  const path = credentialsPath();
  const all = readJson<Record<string, string>>(path, {});
  if (token === null) {
    if (!(account in all)) return;
    delete all[account];
  } else all[account] = token;
  ensureDir(configDir());
  writeJson(path, all, 0o600);
}

function nativeWrite(kind: StoreKind, account: string, token: string): boolean {
  switch (kind) {
    case 'keychain':
      return spawnSync('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-l', `Hive connector (${account})`, '-w', token], { stdio: 'ignore' }).status === 0;
    case 'secret-service':
      // The secret is read from stdin, so it never appears in the process list.
      return spawnSync('secret-tool', ['store', `--label=Hive connector (${account})`, 'service', SERVICE, 'account', account], { input: token, stdio: ['pipe', 'ignore', 'ignore'], timeout: 15_000 }).status === 0;
    case 'credential-locker':
      return powershell(`${PS_VAULT}$t=[Console]::In.ReadToEnd().Trim();try{$v.Remove($v.Retrieve('${SERVICE}','${account.replace(/'/g, "''")}'))}catch{};$v.Add((New-Object Windows.Security.Credentials.PasswordCredential('${SERVICE}','${account.replace(/'/g, "''")}',$t)))`, token).ok;
    default: return false;
  }
}
function nativeRead(kind: StoreKind, account: string): string | null {
  let out: string | null = null;
  if (kind === 'keychain') {
    const result = spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    out = result.status === 0 ? result.stdout : null;
  } else if (kind === 'secret-service') {
    const result = spawnSync('secret-tool', ['lookup', 'service', SERVICE, 'account', account], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 });
    out = result.status === 0 ? result.stdout : null;
  } else if (kind === 'credential-locker') {
    const result = powershell(`${PS_VAULT}$c=$v.Retrieve('${SERVICE}','${account.replace(/'/g, "''")}');$c.RetrievePassword();$c.Password`);
    out = result.ok ? result.out : null;
  }
  const token = out?.trim();
  return token ? token : null;
}
function nativeDelete(kind: StoreKind, account: string): void {
  if (kind === 'keychain') spawnSync('security', ['delete-generic-password', '-s', SERVICE, '-a', account], { stdio: 'ignore' });
  else if (kind === 'secret-service') spawnSync('secret-tool', ['clear', 'service', SERVICE, 'account', account], { stdio: 'ignore', timeout: 15_000 });
  else if (kind === 'credential-locker') powershell(`${PS_VAULT}try{$v.Remove($v.Retrieve('${SERVICE}','${account.replace(/'/g, "''")}'))}catch{}`);
}

/** Stores the credential; returns where it went. Falls back to the 0600 file when the native store refuses. */
export function storeCredential(account: string, token: string): StoreKind {
  const kind = backend();
  if (kind !== 'file' && nativeWrite(kind, account, token)) {
    fileWrite(account, null);
    return kind;
  }
  fileWrite(account, token);
  warn(`Warning: no usable OS keychain; the Hive credential is stored in ${credentialsPath()} (mode 0600, readable only by you).`);
  return 'file';
}

export function readCredential(account: string): string | null {
  const kind = backend();
  if (kind !== 'file') {
    const token = nativeRead(kind, account);
    if (token) return token;
  }
  return existsSync(credentialsPath()) ? fileRead(account) : null;
}

export function deleteCredential(account: string): void {
  const kind = backend();
  if (kind !== 'file') nativeDelete(kind, account);
  if (existsSync(credentialsPath())) fileWrite(account, null);
}

export function credentialStoreName(): StoreKind { return backend(); }
