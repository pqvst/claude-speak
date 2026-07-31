// Keyboard control — raw mode so a single keypress acts immediately. Guarded
// on isTTY so the server still runs when its output is piped or redirected.

import { skipCurrent, stopSpeaking } from './say.ts';
import { listSessions, selectSession } from './sessions.ts';
import { clientCount } from './ws.ts';

function printSessions(): void {
  const all = listSessions();
  if (!all.length) {
    console.log('[sessions] none seen yet');
    return;
  }
  console.log(`[sessions] ${all.length} known, ${clientCount()} tab(s) connected`);
  all.forEach((s, i) => {
    const mark = s.speaking ? '►' : s.streaming ? '·' : ' ';
    const flags = [s.selected && 'in use', s.unread && 'unread'].filter(Boolean);
    console.log(
      `  ${mark} ${i + 1}. ${s.title}${flags.length ? ` (${flags.join(', ')})` : ''}`
    );
    console.log(`      ${s.id}  ${s.statusBucket || ''}${s.repo ? `  ${s.repo}` : ''}`);
    if (s.needsAction) console.log(`      waiting: ${s.needsAction}`);
    else if (s.lastSummary) console.log(`      ${s.lastSummary}`);
  });
}

export function listenForKeys(): void {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key: string) => {
    // Raw mode stops the terminal turning Ctrl+C into SIGINT, so quitting has
    // to be handled here.
    if (key === '\u0003') {
      stopSpeaking();
      process.exit(0);
    }
    if (key === 's' || key === ' ') {
      if (!skipCurrent()) console.log('[skip] nothing being spoken');
      return;
    }
    if (key === 'c') {
      console.log('[stop] clearing queue');
      stopSpeaking();
      return;
    }
    if (key === 'l') {
      printSessions();
      return;
    }
    // Use the Nth session from the `l` listing (same order), or follow again.
    if (/^[1-9]$/.test(key)) {
      const target = listSessions()[Number(key) - 1];
      if (!target) console.log(`[select] no session ${key} — press l to list`);
      else selectSession(target.id);
      return;
    }
    if (key === 'u') {
      selectSession(null);
    }
  });
}
