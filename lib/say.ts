// Speech queue — speaks with the macOS `say` command, one utterance at a time.

import { spawn, type ChildProcess } from 'node:child_process';

let voice: string | null = null;

const queue: string[] = [];
let current: ChildProcess | null = null;
let watchdog: NodeJS.Timeout | null = null;

export function setVoice(name?: string): void {
  voice = name || null;
}

function finishCurrent(): void {
  if (!current) return; // 'error' and 'close' can both fire for one child
  if (watchdog) clearTimeout(watchdog);
  watchdog = null;
  current = null;
  speakNext();
}

function speakNext(): void {
  if (current || queue.length === 0) return;
  const text = queue.shift()!;
  console.log(`[say] (${queue.length} queued) ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`);
  // Text goes via stdin, never argv — no quoting/injection concerns.
  const child = spawn('say', voice ? ['-v', voice] : [], { stdio: ['pipe', 'ignore', 'inherit'] });
  current = child;
  // Kill `say` if it wedges: ~1s per 10 characters, minimum 30s.
  const budgetMs = Math.max(30_000, text.length * 100);
  watchdog = setTimeout(() => {
    console.warn(`[say] stuck for ${Math.round(budgetMs / 1000)}s, killing`);
    child.kill('SIGKILL');
  }, budgetMs);
  child.on('close', finishCurrent);
  child.on('error', (err) => {
    console.error(`[say] spawn failed: ${err.message}`);
    finishCurrent();
  });
  child.stdin!.on('error', () => {}); // EPIPE if the child died mid-write
  child.stdin!.write(text);
  child.stdin!.end();
}

export function enqueue(text: string): void {
  if (!text) return;
  queue.push(text);
  speakNext();
}

export function stopSpeaking(): void {
  queue.length = 0;
  if (current) current.kill();
}

// Drop the current utterance but keep the queue: killing the child fires
// 'close', which advances to the next entry.
export function skipCurrent(): boolean {
  if (!current) return false;
  console.log(`[skip] dropping current, ${queue.length} still queued`);
  current.kill();
  return true;
}
