#!/usr/bin/env node
import { connect } from './connect.js';
import { HubError } from './hub.js';
import { disconnect, status } from './manage.js';
import type { Client } from './state.js';
import { UserError, errorText } from './util.js';

const HELP = `hive-connect: connect this repository and your coding agent to a Hive workspace.

Usage:
  hive-connect connect [--hub URL] [--client claude|muse|other] [--yes] [--no-node] [--no-browser]
      Pair this checkout with Hive (browser approval), store the credential in the OS keychain,
      configure your coding client and start the local connector. Run again to reconnect.
  hive-connect status                 Hub, member, credential, connector process, last report.
  hive-connect disconnect [--keep-config]
      Stop the connector, revoke this credential, remove Hive's client entries, delete the credential.
  hive-connect mcp                    stdio MCP server bridged to <hub>/mcp (started by your client).
  hive-connect hook <event> [--client claude|muse]
      Client lifecycle hook: session-start, prompt, pre-write, post-write, session-end.
  hive-connect node [--once]          Local connector (normally started in the background by connect).
  hive-connect relay                  Operator fallback: relay one model analysis (MODEL_API_KEY from the environment).

Exit codes: 0 ok, 2 user or environment problem, 1 unexpected error.`;

interface Parsed { command: string; positional: string[]; flags: Map<string, string | true> }

const VALUE_FLAGS = new Set(['hub', 'client']);
export function parseArgs(argv: string[]): Parsed {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq > 0 ? eq : undefined);
    if (eq > 0) flags.set(name, arg.slice(eq + 1));
    else if (VALUE_FLAGS.has(name)) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UserError(`--${name} needs a value`);
      flags.set(name, value); i++;
    } else flags.set(name, true);
  }
  return { command, positional, flags };
}

function only(parsed: Parsed, allowed: string[]): void {
  for (const name of parsed.flags.keys()) if (!allowed.includes(name)) throw new UserError(`Unknown option --${name} for "${parsed.command}". See hive-connect --help.`);
}
function clientFlag(value: string | true | undefined, allowed: Client[]): Client | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as Client)) throw new UserError(`--client must be one of: ${allowed.join(', ')}`);
  return value as Client;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  switch (parsed.command) {
    case 'connect':
      only(parsed, ['hub', 'client', 'yes', 'no-node', 'no-browser']);
      return connect({ hub: parsed.flags.get('hub') as string | undefined, client: clientFlag(parsed.flags.get('client'), ['claude', 'muse', 'other']),
        yes: parsed.flags.has('yes'), node: !parsed.flags.has('no-node'), browser: !parsed.flags.has('no-browser') });
    case 'status': only(parsed, []); return status();
    case 'disconnect': only(parsed, ['keep-config']); return disconnect({ keepConfig: parsed.flags.has('keep-config') });
    case 'mcp': only(parsed, []); return (await import('./mcp.js')).runMcp();
    case 'hook': {
      only(parsed, ['client']);
      const event = parsed.positional[0];
      if (!event) throw new UserError('hook needs an event: session-start, prompt, pre-write, post-write or session-end');
      return (await import('./hook.js')).runHook(event, clientFlag(parsed.flags.get('client'), ['claude', 'muse']));
    }
    case 'node': only(parsed, ['once']); return (await import('./node.js')).runNode({ once: parsed.flags.has('once') });
    case 'relay': only(parsed, []); return (await import('./relay.js')).runRelay();
    case 'version': case '--version': case '-v':
      console.log((await import('./mcp.js')).VERSION); return 0;
    case 'help': case '--help': case '-h':
      console.log(HELP); return 0;
    default:
      throw new UserError(`Unknown command "${parsed.command}". See hive-connect --help.`);
  }
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
  // A hook must never block the coding client because of a Hive problem.
  if (process.argv[2] === 'hook') { process.stderr.write(`hive-connect hook: ${errorText(error)}\n`); process.exitCode = 0; return; }
  if (error instanceof UserError || error instanceof HubError) {
    process.stderr.write(`hive-connect: ${error.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`hive-connect: unexpected error: ${errorText(error)}\n${error instanceof Error && process.env.HIVE_CONNECT_DEBUG ? `${error.stack}\n` : ''}`);
    process.exitCode = 1;
  }
});
