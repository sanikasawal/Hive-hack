import { copyFileSync, existsSync, readdirSync, readFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, git, homeDir, onPath, readJson, shellQuote, writeJson } from './util.js';
/**
 * Resolves how hooks and MCP clients call this CLI. HIVE_CONNECT_COMMAND overrides (tests, wrappers). When run
 * through npx (the script lives in an npx cache), the stable form is `npx -y hive-connect`. Otherwise the absolute
 * path the CLI was started with (process.argv[1]; an npm bin symlink stays a symlink, so upgrades keep working).
 * On Windows a .js file is not directly executable, so node is named explicitly.
 */
export function launcher() {
    const override = process.env.HIVE_CONNECT_COMMAND?.trim();
    if (override) {
        const parts = override.split(' ').filter(Boolean);
        return { command: parts[0], args: parts.slice(1) };
    }
    const entry = process.argv[1] ? resolve(process.argv[1]) : fileURLToPath(new URL('./main.js', import.meta.url));
    if (/[\\/]_npx[\\/]/.test(entry) || /[\\/]npm-cache[\\/]/.test(entry)) {
        // Run through npx: the cache may be cleaned, so clients call npx again. Before the npm package is published the
        // CLI runs from the GitHub repository (root package), which npx must be pointed at instead.
        return { command: 'npx', args: ['-y', packageName(entry) === 'hive-connect' ? 'hive-connect' : GITHUB_SPEC] };
    }
    if (process.platform === 'win32' && /\.m?js$/.test(entry))
        return { command: process.execPath, args: [entry] };
    return { command: entry, args: [] };
}
export const GITHUB_SPEC = 'github:Vishal2602/Hive-hack';
/** Name of the package that contains `file` (nearest package.json walking up). */
function packageName(file) {
    let dir = dirname(file);
    for (let i = 0; i < 6; i++) {
        const manifest = join(dir, 'package.json');
        if (existsSync(manifest)) {
            try {
                const name = JSON.parse(readFileSync(manifest, 'utf8')).name ?? null;
                if (name)
                    return name;
            }
            catch { /* keep walking */ }
        }
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return null;
}
export function commandLine(l, ...args) {
    return [l.command, ...l.args, ...args].map(shellQuote).join(' ');
}
// ---- shared helpers ------------------------------------------------------------------------------
const HOOK_ARG = /\bhook (session-start|prompt|pre-write|post-write|session-end)( --client (claude|muse))?\s*$/;
/** A hook command that belongs to Hive: this CLI's hook subcommand, or the older .hive/hive-hook.mjs script. */
export function isHiveHookCommand(command) {
    return typeof command === 'string' && (command.includes('hive-hook.mjs') || HOOK_ARG.test(command));
}
export const HOOK_EVENTS = [
    { event: 'SessionStart', arg: 'session-start', timeout: 30 },
    { event: 'UserPromptSubmit', arg: 'prompt', timeout: 30 },
    { event: 'PreToolUse', arg: 'pre-write', matcher: 'Edit|Write|MultiEdit', timeout: 30 },
    // Bash too: agents sometimes edit with shell redirection; the hook then re-syncs every changed file.
    { event: 'PostToolUse', arg: 'post-write', matcher: 'Edit|Write|MultiEdit|Bash', timeout: 60 },
];
function withoutHive(entries) {
    return (Array.isArray(entries) ? entries : []).filter(entry => !entry?.hooks?.some(h => isHiveHookCommand(h?.command)));
}
/** Adds `line` to the repository's .git/info/exclude when missing (keeps local config out of commits). */
export function excludeFromGit(root, line) {
    const exclude = git(root, ['rev-parse', '--git-path', 'info/exclude'])?.trim();
    if (!exclude)
        return;
    const path = isAbsolute(exclude) ? exclude : resolve(root, exclude);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (current.split(/\r?\n/).includes(line))
        return;
    ensureDir(dirname(path), 0o755);
    appendFileSync(path, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
}
function isTracked(root, rel) { return git(root, ['ls-files', '--error-unmatch', rel]) !== null; }
// ---- Claude Code ---------------------------------------------------------------------------------
/** settings.local.json with Hive's hooks (replacing older Hive hooks) and the project MCP server enabled. Pure. */
export function mergeClaudeSettings(existing, l) {
    const settings = { ...existing };
    const hooks = { ...(existing.hooks ?? {}) };
    for (const { event, arg, matcher, timeout } of HOOK_EVENTS) {
        const kept = withoutHive(hooks[event]);
        kept.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: commandLine(l, 'hook', arg, '--client', 'claude'), timeout }] });
        hooks[event] = kept;
    }
    settings.hooks = hooks;
    // Older Hive setups stored the hub URL, a member token and even a model key here; the credential now lives in the keychain.
    const env = existing.env;
    if (env && ('HIVE_TOKEN' in env || 'MODEL_API_KEY' in env || 'HIVE_URL' in env)) {
        const clean = { ...env };
        delete clean.HIVE_TOKEN;
        delete clean.MODEL_API_KEY;
        delete clean.HIVE_URL;
        if (Object.keys(clean).length)
            settings.env = clean;
        else
            delete settings.env;
    }
    const enabled = Array.isArray(existing.enabledMcpjsonServers) ? existing.enabledMcpjsonServers : [];
    if (!enabled.includes('hive'))
        settings.enabledMcpjsonServers = [...enabled, 'hive'];
    return settings;
}
export function unmergeClaudeSettings(existing) {
    const settings = { ...existing };
    if (existing.hooks && typeof existing.hooks === 'object') {
        const hooks = {};
        for (const [event, entries] of Object.entries(existing.hooks)) {
            const kept = withoutHive(entries);
            if (kept.length)
                hooks[event] = kept;
        }
        if (Object.keys(hooks).length)
            settings.hooks = hooks;
        else
            delete settings.hooks;
    }
    if (Array.isArray(existing.enabledMcpjsonServers)) {
        const kept = existing.enabledMcpjsonServers.filter(name => name !== 'hive');
        if (kept.length)
            settings.enabledMcpjsonServers = kept;
        else
            delete settings.enabledMcpjsonServers;
    }
    return settings;
}
export function mergeMcpJson(existing, l) {
    const servers = { ...(existing.mcpServers ?? {}) };
    servers.hive = { command: l.command, args: [...l.args, 'mcp'] };
    return { ...existing, mcpServers: servers };
}
export function unmergeMcpJson(existing) {
    const result = { ...existing };
    if (result.mcpServers && typeof result.mcpServers === 'object') {
        const servers = { ...result.mcpServers };
        delete servers.hive;
        if (Object.keys(servers).length)
            result.mcpServers = servers;
        else
            delete result.mcpServers;
    }
    return result;
}
const claudePaths = (root) => ({ settings: join(root, '.claude', 'settings.local.json'), mcp: join(root, '.mcp.json') });
export function configureClaude(root, l) {
    const { settings, mcp } = claudePaths(root);
    const created = [settings, mcp].filter(path => !existsSync(path));
    writeJson(settings, mergeClaudeSettings(readJson(settings, {}), l));
    writeJson(mcp, mergeMcpJson(readJson(mcp, {}), l));
    excludeFromGit(root, '.claude/settings.local.json');
    // .mcp.json now names a path on this machine: keep it out of commits unless the project already tracks it.
    if (!isTracked(root, '.mcp.json'))
        excludeFromGit(root, '.mcp.json');
    const notes = [];
    if (isTracked(root, '.mcp.json'))
        notes.push('.mcp.json is tracked by git; the "hive" entry names a path on this machine, so do not commit that change.');
    const legacy = readJson(join(homeDir(), '.claude.json'), {});
    const local = legacy.projects?.[root]?.mcpServers?.hive;
    if (local)
        notes.push('An older "hive" MCP server is registered for this folder in ~/.claude.json and overrides .mcp.json; remove it with: claude mcp remove --scope local hive');
    return { files: [settings, mcp], created, notes };
}
export function unconfigureClaude(root, created) {
    const { settings, mcp } = claudePaths(root);
    const touched = [];
    for (const [path, unmerge] of [[settings, unmergeClaudeSettings], [mcp, unmergeMcpJson]]) {
        if (!existsSync(path))
            continue;
        const next = unmerge(readJson(path, {}));
        if (!Object.keys(next).length && created.includes(path)) {
            unlinkSync(path);
            touched.push(path);
            continue;
        }
        if (writeJson(path, next))
            touched.push(path);
    }
    return touched;
}
// ---- Muse Code -------------------------------------------------------------------------------------
export const museSettingsPath = () => join(process.env.XDG_CONFIG_HOME?.trim() || join(homeDir(), '.config'), 'muse', 'settings.json');
const museHooksPath = (root) => join(root, '.muse', 'hooks.json');
const MUSE_COMMENT = 'Hive entries written by hive-connect. The Muse Code hook format is not publicly documented; this layout is a best guess and may need adjusting. Entries whose command runs "hook <event>" belong to Hive; everything else is left untouched.';
export function mergeMuseSettings(existing, l) {
    const servers = { ...(existing.mcp_servers ?? {}) };
    servers.hive = { transport: 'stdio', command: l.command, args: [...l.args, 'mcp'], mode: 'optional' };
    return { ...existing, mcp_servers: servers };
}
export function unmergeMuseSettings(existing) {
    const result = { ...existing };
    if (result.mcp_servers && typeof result.mcp_servers === 'object') {
        const servers = { ...result.mcp_servers };
        delete servers.hive;
        result.mcp_servers = servers;
    }
    return result;
}
export function mergeMuseHooks(existing, l) {
    const hooks = { ...(existing.hooks ?? {}) };
    for (const { event, arg, matcher, timeout } of HOOK_EVENTS) {
        const kept = (Array.isArray(hooks[event]) ? hooks[event] : []).filter(entry => !isHiveHookCommand(entry?.command));
        kept.push({ ...(matcher ? { matcher } : {}), command: commandLine(l, 'hook', arg, '--client', 'muse'), timeout });
        hooks[event] = kept;
    }
    return { _comment: MUSE_COMMENT, ...existing, hooks };
}
export function unmergeMuseHooks(existing) {
    const result = { ...existing };
    const hooks = {};
    for (const [event, entries] of Object.entries(existing.hooks ?? {})) {
        const kept = (Array.isArray(entries) ? entries : []).filter(entry => !isHiveHookCommand(entry?.command));
        if (kept.length)
            hooks[event] = kept;
    }
    if (Object.keys(hooks).length)
        result.hooks = hooks;
    else
        delete result.hooks;
    if (result._comment === MUSE_COMMENT && !result.hooks)
        delete result._comment;
    return result;
}
/** One backup of the user's Muse settings before the first Hive change: settings.json.bak-<timestamp>. */
function backupOnce(path) {
    if (!existsSync(path))
        return null;
    const dir = dirname(path);
    if (readdirSync(dir).some(name => name.startsWith(`${basename(path)}.bak-`)))
        return null;
    const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(path, backup);
    return backup;
}
export function configureMuse(root, l) {
    const settings = museSettingsPath();
    const hooksFile = museHooksPath(root);
    const created = [settings, hooksFile].filter(path => !existsSync(path));
    const notes = [];
    const current = readJson(settings, {});
    const next = mergeMuseSettings(current, l);
    if (JSON.stringify(next) !== JSON.stringify(current)) {
        const backup = backupOnce(settings);
        if (backup)
            notes.push(`Backed up your Muse settings to ${backup}`);
    }
    writeJson(settings, next);
    writeJson(hooksFile, mergeMuseHooks(readJson(hooksFile, {}), l));
    excludeFromGit(root, '.muse/hooks.json');
    notes.push('Muse Code hook format is a best guess (.muse/hooks.json); the MCP server is the dependable part.');
    return { files: [settings, hooksFile], created, notes };
}
export function unconfigureMuse(root, created) {
    const touched = [];
    const settings = museSettingsPath();
    if (existsSync(settings)) {
        const next = unmergeMuseSettings(readJson(settings, {}));
        const empty = Object.keys(next).every(key => key === 'mcp_servers' && !Object.keys(next.mcp_servers).length);
        if (empty && created.includes(settings)) {
            unlinkSync(settings);
            touched.push(settings);
        }
        else if (writeJson(settings, next))
            touched.push(settings);
    }
    const hooksFile = museHooksPath(root);
    if (existsSync(hooksFile)) {
        const next = unmergeMuseHooks(readJson(hooksFile, {}));
        if (!Object.keys(next).length && created.includes(hooksFile)) {
            unlinkSync(hooksFile);
            touched.push(hooksFile);
        }
        else if (writeJson(hooksFile, next))
            touched.push(hooksFile);
    }
    return touched;
}
// ---- detection -------------------------------------------------------------------------------------
export function detectClients() {
    const found = [];
    if (onPath('claude') || existsSync(join(homeDir(), '.claude')))
        found.push('claude');
    if (onPath('muse') || existsSync(museSettingsPath()))
        found.push('muse');
    return found;
}
export function otherClientInstructions(l, hub) {
    return [
        'Configure your MCP client with ONE of:',
        `  stdio (recommended; reads the credential from your keychain):  ${commandLine(l, 'mcp')}`,
        `  Streamable HTTP:  ${hub}/mcp  with header  Authorization: Bearer <token>`,
        '  (<token> is a member token from the Members page; hive-connect never prints the stored credential.)',
    ];
}
