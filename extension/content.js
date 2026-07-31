// Claude Speak — relays Claude Code session frames to the local server over a
// WebSocket, and acts on what the server sends back.
//
// ws-hook.js patches the page's WebSocket in the MAIN world and posts each
// frame here; this script forwards the interesting ones and does nothing else
// clever. Every judgment about what is worth speaking lives in server.js, so
// that logic can change without reloading the extension.
//
// Nothing is injected into the page — status shows on the toolbar icon via
// background.js.
//
// Two things have to happen on this side specifically. The isolated world isn't
// subject to claude.ai's connect-src CSP, so it can reach localhost — the page
// world cannot. And claude.ai's session-list endpoint needs the page's origin
// and cookies, which only a content script shares.
//
// ws:// from an HTTPS page would normally be blocked as mixed content, but
// localhost counts as a potentially-trustworthy origin, so it is allowed. This
// was verified in Chrome before the transport was moved here.

const SOCKET_URL = 'ws://localhost:8123';

// The frame types the server reads: `assistant` carries completed content
// blocks, `system` carries session boundaries. Everything else on the socket is
// streaming deltas, keep-alives and sandbox chatter — most of the traffic, none
// of it needed once whole blocks are the unit of work.
const RELAY_TYPES = new Set(['assistant', 'system']);

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15_000;

let socket = null;
let reconnectDelay = RECONNECT_MIN_MS;
let currentUrl = location.href;

// --- Status ------------------------------------------------------------------
// Reported to the toolbar icon rather than drawn into the page: green when the
// relay socket is connected, red when it isn't, with the number of utterances
// spoken as the badge. background.js owns the icon, because `chrome.action` is
// not reachable from a content script.

let spokenCount = 0;
let connected = false;

function report() {
  try {
    chrome.runtime.sendMessage({
      type: 'claude-speak-state',
      connected,
      spokenCount,
    });
  } catch {
    // The worker may be starting, or the extension reloading. The next state
    // change reports again, so a dropped message is not worth handling.
  }
}

report(); // red until the socket opens

// --- Socket -----------------------------------------------------------------

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function connect() {
  socket = new WebSocket(SOCKET_URL);

  socket.addEventListener('open', () => {
    console.log('[claude-speak] connected to', SOCKET_URL);
    reconnectDelay = RECONNECT_MIN_MS;
    connected = true;
    report();
    if (lastSessions) send({ type: 'catalog', sessions: lastSessions });
  });

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === 'spoke') {
      spokenCount += 1;
      report();
      return;
    }
    // Only one session streams per tab, so listening to a different one means
    // navigating. location.href keeps this to the tab the script is already in,
    // needing no chrome.tabs permission and no background worker.
    if (message.type === 'command' && message.action === 'navigate' && message.url) {
      // Compared on the id alone, so a query string or trailing path doesn't
      // cause a needless reload of the session already open.
      const idOf = (u) => (u.match(/\/session_([A-Za-z0-9]{6,})/) || [])[1];
      if (idOf(message.url) && idOf(message.url) === idOf(location.href)) return;
      console.log('[claude-speak] navigating to', message.url);
      location.href = message.url;
    }
  });

  // A dropped socket is an immediate signal that the relay is gone, which the
  // old fetch-per-frame arrangement could only discover by failing.
  const retry = () => {
    socket = null;
    connected = false;
    report();
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  };
  socket.addEventListener('close', retry);
  socket.addEventListener('error', () => {
    // 'close' always follows 'error', so reconnection is handled there.
    console.warn('[claude-speak] socket error');
  });
}

connect();

// --- Frames -----------------------------------------------------------------

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.__claudeSpeak !== 'frame' || !data.frame) return;
  if (!RELAY_TYPES.has(data.frame.type)) return;
  send({ type: 'frame', frame: data.frame, url: location.href });
});

// --- Session catalog ------------------------------------------------------
// Nothing on the page's WebSocket enumerates sessions — that socket is
// per-session — so the list comes from claude.ai's own endpoint.
//
// Purely observed: http-tap.js copies the response whenever the app fetches its
// own session list, and that copy is forwarded here. No request is ever made on
// our behalf. An earlier version rebuilt the request to refresh on a timer,
// which meant both guessing at required headers (it 400d without
// `anthropic-version`) and issuing traffic the user never asked for. The cost of
// observing only is staleness: the list is as fresh as the app's last fetch.

let lastSessions = null; // resent on reconnect, so a server restart isn't blank

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.__claudeSpeak !== 'catalog') return;
  lastSessions = data.sessions || [];
  console.log(`[claude-speak] session list observed (${lastSessions.length})`);
  send({ type: 'catalog', sessions: lastSessions });
});

// Navigating between sessions doesn't reload the page, and the first frame of
// the new session may be seconds away — stop talking as soon as the URL moves.
setInterval(() => {
  if (location.href === currentUrl) return;
  currentUrl = location.href;
  send({ type: 'navigated', url: currentUrl });
}, 500);

console.log('[claude-speak] relaying session frames over', SOCKET_URL);
