// WebSocket channel to the extension: frames and the session catalog come up,
// spoke / command messages go down, and a dropped socket is an immediate
// signal that the tab is gone.
//
// ws:// from an HTTPS page would normally be blocked as mixed content, but
// localhost counts as a potentially-trustworthy origin — verified in Chrome.

import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { stopSpeaking } from './say.ts';
import { handleFrame } from './frames.ts';
import { absorbCatalog, onCommand, peekPendingCommand } from './sessions.ts';

const clients = new Set<WebSocket>();

export function clientCount(): number {
  return clients.size;
}

function send(socket: WebSocket, message: object): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

export function startWebSocket(port: number): WebSocketServer {
  onCommand((command) => {
    let reached = 0;
    for (const socket of clients) {
      send(socket, { type: 'command', ...command });
      reached += 1;
    }
    return reached;
  });

  const wss = new WebSocketServer({ port, host: '127.0.0.1' });

  wss.on('connection', (socket, req) => {
    clients.add(socket);
    console.log(`[ws] client connected from ${req.socket.remoteAddress} (${clients.size} open)`);

    // A selection made while no tab was connected still needs delivering.
    const pending = peekPendingCommand();
    if (pending) send(socket, { type: 'command', ...pending });

    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const text = data.toString();
      let message: any;
      try {
        message = JSON.parse(text);
      } catch {
        console.log(`[ws] recv (not json) ${text.slice(0, 120)}`);
        return;
      }
      if (message.type === 'frame' && message.frame) {
        try {
          const spoke = handleFrame(message.frame, message.url);
          if (spoke) send(socket, { type: 'spoke', kind: spoke });
        } catch (err: any) {
          console.warn(`[ws] frame failed: ${err.message}`);
        }
        return;
      }
      if (message.type === 'catalog') {
        try {
          absorbCatalog(message.sessions || []);
        } catch (err: any) {
          console.warn(`[ws] catalog failed: ${err.message}`);
        }
        return;
      }
      if (message.type === 'navigated') {
        // Whatever is mid-sentence belongs to the session the tab just left.
        stopSpeaking();
        return;
      }
      console.log(`[ws] recv ${text.slice(0, 120)}`);
    });

    socket.on('close', () => {
      clients.delete(socket);
      console.log(`[ws] client gone (${clients.size} open)`);
    });
    socket.on('error', (err) => {
      console.warn(`[ws] socket error: ${err.message}`);
      clients.delete(socket);
    });
  });

  return wss;
}
