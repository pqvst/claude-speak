#!/usr/bin/env node
// Claude Speak relay server — receives Claude Code session frames from the
// Chrome extension over ws://localhost:8123 and speaks them with the macOS
// `say` command. All the judgment about what to speak lives on this side, so
// it can be changed and restarted without reloading the extension.
//
// Usage: node server.ts [voice]     (needs Node 24+; see `say -v '?'` for voices)

import { setVoice } from './lib/say.ts';
import { startWebSocket } from './lib/ws.ts';
import { listenForKeys } from './lib/keys.ts';

const PORT = Number(process.env.PORT) || 8123;
const voice = process.argv[2];

setVoice(voice);

const wss = startWebSocket(PORT);
wss.on('listening', () => {
  console.log(`claude-speak relay listening on ws://localhost:${PORT}`);
  console.log(`voice: ${voice || '(system default)'}`);
  if (process.stdin.isTTY) {
    console.log(
      'keys: [s]/[space] skip   [c] clear queue   [l] list sessions   [1-9] use session   [u] follow most recent   [ctrl-c] quit'
    );
  }
  listenForKeys();
});
