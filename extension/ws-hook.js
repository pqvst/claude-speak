// Claude Speak — WebSocket tap.
//
// Logs every frame the page sends or receives. This runs in the page's MAIN
// world at document_start (see manifest.json): content scripts live in an
// isolated world with their own `window`, so patching WebSocket from
// content.js would only ever intercept the content script's own sockets, not
// the app's. document_start matters too — the patch has to be in place before
// the app opens its connections.
//
// `window.WebSocket` is replaced with a Proxy rather than a subclass so that
// WebSocket.prototype, instanceof, and the static constants stay untouched.
// Outgoing frames are caught by patching send() on the prototype; incoming
// ones by attaching a listener in the construct trap (listeners fire in
// registration order, so this one runs before the app's).

(() => {
  const TAG = '[claude-speak:ws]';
  const MAX_FRAMES = 500; // retained on window.__claudeSpeakWS.frames

  const Native = window.WebSocket;
  if (!Native || Native.__claudeSpeakPatched) return;

  const frames = [];
  const ids = new WeakMap();
  let socketCount = 0;

  // Console handle. Everything here returns a plain string, so it can be
  // handed straight to DevTools' copy() — copy(__claudeSpeakWS.last()) puts
  // the raw frame on the clipboard, which is far less fiddly than selecting
  // it out of the console log.
  const tap = {
    enabled: true,
    frames,
    clear() {
      frames.length = 0;
    },
    // Raw text of the most recent frame, or of the nth most recent.
    last(n = 1) {
      const frame = frames[frames.length - n];
      return frame ? String(frame.data) : '';
    },
    // Same, re-indented — for eyeballing a dense frame rather than pasting it.
    pretty(n = 1) {
      try {
        return JSON.stringify(JSON.parse(tap.last(n)), null, 2);
      } catch {
        return tap.last(n);
      }
    },
    dump() {
      return frames
        .map((f) => `${f.dir === 'in' ? '<<' : '>>'} #${f.id} ${f.data}`)
        .join('\n');
    },
  };
  window.__claudeSpeakWS = tap;

  function record(id, url, dir, data) {
    frames.push({ id, url, dir, data, t: performance.now() });
    if (frames.length > MAX_FRAMES) frames.shift();

    // Logged as the raw string, in full, rather than a parsed object: the
    // console renders objects expandable but gives you no way to copy the
    // original text back out of one, and a truncated preview can't be pasted
    // anywhere useful either. `enabled` gates only this console noise —
    // buffering and forwarding carry on regardless.
    if (tap.enabled) {
      console.log(`${TAG} #${id} ${dir === 'in' ? '← recv' : '→ send'}`, data);
    }
    forward(dir, data);
  }

  // Hand frames to content.js, which lives in the isolated world. The relay
  // POST has to happen over there: a fetch to localhost from this world would
  // be blocked by claude.ai's connect-src CSP.
  function forward(dir, data) {
    if (typeof data !== 'string') return;
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object' || frame.type === 'keep_alive') return;
    window.postMessage({ __claudeSpeak: 'frame', dir, frame }, location.origin);
  }

  // Frames arrive as string, Blob, ArrayBuffer or a typed array. Decode the
  // binary forms as UTF-8 when they happen to be text; Blob decoding is async,
  // so those frames can land in the buffer slightly out of order.
  function capture(id, url, dir, data) {
    if (typeof data === 'string' || data == null) {
      record(id, url, dir, data);
      return;
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      data
        .text()
        .then((text) => record(id, url, dir, text))
        .catch(() => record(id, url, dir, data));
      return;
    }
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      try {
        record(id, url, dir, new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        record(id, url, dir, bytes);
      }
      return;
    }
    record(id, url, dir, data);
  }

  const nativeSend = Native.prototype.send;
  Native.prototype.send = function (data) {
    try {
      capture(ids.get(this) || 0, this.url, 'out', data);
    } catch (err) {
      console.warn(`${TAG} failed to log outgoing frame:`, err);
    }
    return nativeSend.call(this, data);
  };

  window.WebSocket = new Proxy(Native, {
    construct(target, args) {
      const socket = Reflect.construct(target, args);
      const id = ++socketCount;
      ids.set(socket, id);
      console.log(`${TAG} #${id} open`, socket.url);

      socket.addEventListener('message', (event) => {
        try {
          capture(id, socket.url, 'in', event.data);
        } catch (err) {
          console.warn(`${TAG} failed to log incoming frame:`, err);
        }
      });
      socket.addEventListener('close', (event) => {
        console.log(`${TAG} #${id} close`, event.code, event.reason || '');
      });
      socket.addEventListener('error', () => {
        console.warn(`${TAG} #${id} error`, socket.url);
      });

      return socket;
    },
  });

  Object.defineProperty(window.WebSocket, '__claudeSpeakPatched', { value: true });
  console.log(`${TAG} WebSocket patched — frames on window.__claudeSpeakWS`);
})();
