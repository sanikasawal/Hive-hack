import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { UserError } from './util.js';

export async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new UserError(`Cannot ask "${question.trim()}" without a terminal; pass --yes (and --client) to run non-interactively.`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return await new Promise<string>(resolve => rl.question(question, answer => resolve(answer.trim()))); } finally { rl.close(); }
}

export async function confirm(question: string): Promise<boolean> {
  const answer = (await ask(`${question} [Y/n] `)).toLowerCase();
  return answer === '' || answer === 'y' || answer === 'yes';
}

/** Opens a URL in the default browser; failures are ignored (the URL is printed anyway). */
export function openBrowser(url: string): void {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] as const
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] as const : ['xdg-open', [url]] as const;
  try {
    const child = spawn(command, [...args], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => { /* no browser */ });
    child.unref();
  } catch { /* no browser */ }
}

/** A small stderr spinner; a single static line when stderr is not a terminal. */
export function spinner(text: string): { stop: (final?: string) => void } {
  if (!process.stderr.isTTY) { process.stderr.write(`${text}\n`); return { stop: final => { if (final) process.stderr.write(`${final}\n`); } }; }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const timer = setInterval(() => { process.stderr.write(`\r${frames[i++ % frames.length]} ${text}`); }, 100);
  return { stop: final => { clearInterval(timer); process.stderr.write(`\r\x1b[2K${final ? `${final}\n` : ''}`); } };
}
