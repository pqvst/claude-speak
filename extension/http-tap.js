// Claude Speak — HTTP tap, for discovering claude.ai's own API endpoints.
//
// This is a discovery tool, not part of the speaking path. The WebSocket is
// per-session: it carries one session's frames and its control channel returns
// only that session's config. Nothing on it enumerates the user's other
// sessions. So listing sessions has to go through claude.ai's own HTTP API,
// and this tap exists to find out what that API is.
//
// Runs in the page's MAIN world at document_start, same reasoning as
// ws-hook.js: the page's `fetch` and `XMLHttpRequest` are not the ones a
// content script sees, and the patch has to land before the app makes its
// first request.
//
// Only same-origin API paths are recorded — static assets, analytics and
// third-party calls are ignored, which keeps the log readable and avoids
// hoovering up unrelated traffic. Requests always pass through untouched; a
// failure in here is caught and never breaks the page.

(() => {
  const TAG = '[claude-speak:http]';
  const MAX_CALLS = 200;

  // Path prefixes worth recording. Everything else is skipped.
  const INTERESTING = /^\/(api|bapi|v\d)\//;

  // Response bodies are only kept for JSON under this size — enough to see the
  // shape of a session list without buffering megabytes of unrelated payloads.
  const MAX_BODY = 200_000;

  if (window.__claudeSpeakHTTP) return;

  const calls = [];
  const tap = {
    enabled: true,
    calls,
    clear() {
      calls.length = 0;
    },
    // Paths seen, with counts — the quickest way to spot the endpoint that
    // backs the session list in the UI.
    paths() {
      const counts = new Map();
      for (const c of calls) {
        const key = `${c.method} ${c.path}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      return [...counts]
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${String(n).padStart(3)} ${k}`)
        .join('\n');
    },
    // Calls whose response body mentions a term — e.g. find('session_01')
    // to locate whatever returns session identifiers.
    find(term) {
      return calls
        .filter((c) => typeof c.body === 'string' && c.body.includes(term))
        .map((c) => `${c.method} ${c.url}\n${c.body.slice(0, 2000)}`)
        .join('\n\n');
    },
    dump() {
      return calls
        .map((c) => `${c.method} ${c.url} -> ${c.status}\n${c.body ?? '(body not captured)'}`)
        .join('\n\n');
    },
  };
  window.__claudeSpeakHTTP = tap;

  function pathOf(url) {
    try {
      const parsed = new URL(url, location.href);
      if (parsed.origin !== location.origin) return null;
      return parsed.pathname;
    } catch {
      return null;
    }
  }

  // The session list. Its response is handed to the content script whenever the
  // app fetches it. The request that produced it is kept on the console handle
  // for debugging only — nothing replays it, so the catalog is purely
  // observed and no traffic is generated on the user's behalf.
  const SESSION_LIST = /^\/v\d\/code\/sessions/;

  // Headers the browser owns; fetch() ignores or rejects attempts to set them.
  const UNSETTABLE = /^(host|cookie|content-length|connection|origin|referer|user-agent|sec-|proxy-|te$|trailer|transfer-encoding|upgrade)/i;

  function headersOf(args) {
    const out = {};
    const collect = (h) => {
      if (!h) return;
      if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach((v, k) => (out[k] = v));
      else if (Array.isArray(h)) for (const [k, v] of h) out[k] = v;
      else for (const k in h) out[k] = h[k];
    };
    const [request, init] = args;
    if (request && typeof request !== 'string' && request.headers) collect(request.headers);
    if (init && init.headers) collect(init.headers);
    const safe = {};
    for (const k in out) if (!UNSETTABLE.test(k)) safe[k] = out[k];
    return safe;
  }

  function record(method, url, status, body, headers) {
    if (!tap.enabled) return;
    const path = pathOf(url);
    if (!path || !INTERESTING.test(path)) return;
    calls.push({ method, url, path, status, body, headers, t: performance.now() });
    if (calls.length > MAX_CALLS) calls.shift();
    console.log(`${TAG} ${method} ${path} -> ${status}`);

    if (!SESSION_LIST.test(path) || status !== 200 || !body) return;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return;
    }
    if (!parsed || !Array.isArray(parsed.data)) return;
    tap.sessionRequest = { url, headers: headers || {} };
    window.postMessage(
      { __claudeSpeak: 'catalog', sessions: parsed.data },
      location.origin
    );
    console.log(`${TAG} session list captured (${parsed.data.length} sessions)`);
  }

  // --- fetch ---------------------------------------------------------------

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (...args) {
      const request = args[0];
      const url = typeof request === 'string' ? request : (request && request.url) || '';
      const method =
        (args[1] && args[1].method) || (request && request.method) || 'GET';
      return nativeFetch.apply(this, args).then((response) => {
        try {
          const path = pathOf(url);
          if (!path || !INTERESTING.test(path)) return response;
          const type = response.headers.get('content-type') || '';
          const reqHeaders = headersOf(args);
          if (!type.includes('json')) {
            record(method, url, response.status, null, reqHeaders);
            return response;
          }
          // Read from a clone so the app still gets an unconsumed body.
          response
            .clone()
            .text()
            .then((text) => record(method, url, response.status, text.slice(0, MAX_BODY), reqHeaders))
            .catch(() => record(method, url, response.status, null, reqHeaders));
        } catch (err) {
          console.warn(`${TAG} failed to log fetch:`, err);
        }
        return response;
      });
    };
  }

  // --- XMLHttpRequest ------------------------------------------------------

  const NativeXHR = window.XMLHttpRequest;
  if (typeof NativeXHR === 'function') {
    const open = NativeXHR.prototype.open;
    NativeXHR.prototype.open = function (method, url, ...rest) {
      this.__claudeSpeakMethod = method;
      this.__claudeSpeakUrl = url;
      this.__claudeSpeakHeaders = {};
      return open.call(this, method, url, ...rest);
    };
    const setHeader = NativeXHR.prototype.setRequestHeader;
    NativeXHR.prototype.setRequestHeader = function (name, value) {
      if (this.__claudeSpeakHeaders && !UNSETTABLE.test(name)) {
        this.__claudeSpeakHeaders[name] = value;
      }
      return setHeader.call(this, name, value);
    };
    const send = NativeXHR.prototype.send;
    NativeXHR.prototype.send = function (...args) {
      this.addEventListener('load', () => {
        try {
          const type = this.getResponseHeader('content-type') || '';
          const body =
            type.includes('json') && typeof this.responseText === 'string'
              ? this.responseText.slice(0, MAX_BODY)
              : null;
          record(
            this.__claudeSpeakMethod || 'GET',
            this.__claudeSpeakUrl || '',
            this.status,
            body,
            this.__claudeSpeakHeaders || {}
          );
        } catch (err) {
          console.warn(`${TAG} failed to log xhr:`, err);
        }
      });
      return send.apply(this, args);
    };
  }

  console.log(`${TAG} HTTP patched — try __claudeSpeakHTTP.paths()`);
})();
