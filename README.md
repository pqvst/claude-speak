# Claude Speak

A Chrome extension that reads Claude Code session content aloud. It taps the
page's WebSocket, forwards the session's protocol frames to a small local
server (`server.ts`), and the server speaks them with the macOS `say` command.

The server is TypeScript run directly by Node's native type stripping — no
build step. It needs Node 24 or newer.

## Install

1. Start the relay server:

   ```sh
   node server.ts             # system default voice
   node server.ts Samantha    # or pick a voice (see `say -v '?'`)
   ```

2. Open `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the `extension/` directory
5. Open or reload a claude.ai tab

## How it works

Claude Code sessions stream a typed `stream-json` protocol over a WebSocket,
and reading that is far more reliable than scraping the rendered page. Every
frame is explicitly typed, so an answer, a tool call and a thinking block are
trivially told apart instead of all looking like text nodes.

The extension lives in `extension/`; the server is `server.ts` at the root,
with its modules in `lib/`. The extension side is split across four files:

- **`ws-hook.js`** patches `window.WebSocket` and posts each frame to the
  content script. It has to run in the page's **MAIN world** at
  `document_start` — content scripts get their own isolated `window`, so
  patching from `content.js` would only ever intercept the content script's own
  sockets. (`"world": "MAIN"` needs Chrome 111+.)
- **`http-tap.js`** wraps `fetch` and `XMLHttpRequest` in the same world, purely
  to observe. Its one job in the speaking path is copying the session list when
  the app fetches it; otherwise it's a discovery tool for claude.ai's endpoints.
- **`content.js`** drops the noisy frame types and relays the rest over a
  WebSocket to `ws://localhost:8123`. It makes no HTTP requests at all. The
  socket has to be opened from this side because the isolated world isn't
  subject to claude.ai's `connect-src` CSP, which the page is.
- **`server.ts`** holds all the judgment: which blocks to speak, how to turn
  markdown into something listenable, when to announce a tool. Change it and
  restart — no extension reload needed.

`background.js` is a service worker that owns the toolbar icon and nothing else.

The server side is one module per concern:

| File | Concern |
|------|---------|
| `lib/say.ts` | the speech queue driving the `say` command |
| `lib/speechify.ts` | markdown → something listenable |
| `lib/announce.ts` | spoken announcements for questions |
| `lib/sessions.ts` | session registry, catalog, selection and follow |
| `lib/frames.ts` | which frames and blocks get spoken |
| `lib/ws.ts` | the WebSocket channel to the extension |
| `lib/keys.ts` | single-keypress terminal controls |

`ws://` from an HTTPS page would normally be blocked as mixed content, but
localhost counts as a potentially-trustworthy origin, so it's allowed — verified
in Chrome before the transport moved onto the socket.

Because completed `assistant` frames carry whole content blocks, there is no
debouncing: each block arrives once, in full. Duplicate suppression is exact
(every frame has a `uuid`), and replayed history is filtered by age using each
frame's absolute `created_at` rather than a guessed grace period after page
load.

### What gets spoken

- **Answers** — `text` blocks, with markdown converted to speech (below).
- **Questions** — when Claude asks something via `AskUserQuestion`, the
  question is read along with every option's label *and* description:
  *"Which should I work on? Option 1. Critical fixes (Recommended). Fix the
  broken Terms/Privacy layout…"* Options are numbered so you can refer back to
  them by ear. Questions ignore the tool rate limit and the `ANNOUNCE_TOOLS`
  switch, because the session is blocked until you answer and silence there is
  the worst case.
- **Tool calls** — the tool's `input.description`, read as-is, and only for
  tools that supply one. Bash writes a good one ("Rank files by line count");
  the ~150 MCP tools in a session would otherwise be read out as
  `mcp__Betterstack__create_chart_alert`.
- **Nothing else.** Thinking blocks arrive with empty text and only a
  signature — the reasoning is redacted on this stream, so there is nothing to
  say. Tool *results* are never spoken; they're raw stdout. Subagent output
  (a non-null `parent_tool_use_id`) is skipped by default.

Tool announcements are suppressed if anything was spoken in the last few
seconds, so bursts of fast tool calls don't stack up.

### Markdown to speech

Answers arrive as raw markdown, so the markup is stripped and the structures
that mean nothing aloud are described instead of recited:

- **Tables** become "a table with columns Size and File, and 10 rows." Read
  verbatim, a ten-row table is a solid minute of "pipe, eleven M B, pipe".
- **Code blocks** become "a python code block."
- Headings, bullets, links, images, emphasis and inline code markers are
  removed, keeping the text.

### Tuning

The knobs are all at the top of `lib/frames.ts`: `ANNOUNCE_TOOLS`,
`TOOL_GAP_MS`, `SPEAK_SUBAGENTS`, `HISTORY_SKEW_MS`.

## Controls

With the server in the foreground, single keypresses act immediately:

| Key | Effect |
|-----|--------|
| `s` or space | Skip whatever is being read out and move to the next utterance |
| `c` | Clear the queue and go quiet |
| `l` | List the sessions seen so far |
| `1`–`9` | Use the Nth session from the `l` listing |
| `u` | Go back to following the most recent |
| `Ctrl+C` | Quit |

Skipping drops only the current utterance, so cutting off a long answer still
lets the next thing be read.

## Sessions

Nothing on the WebSocket enumerates sessions — that socket is per-session and its
control channel only describes the one it belongs to. The list comes from
claude.ai's own endpoint:

```
GET /v1/code/sessions?statuses=active&statuses=paused&limit=50
```

That is **observed, never requested**. `http-tap.js` copies the response whenever
the app fetches it, and `content.js` relays the copy. An earlier version rebuilt
the request to refresh on a timer, which meant guessing at required headers (it
400s without `anthropic-version`) and generating traffic nobody asked for. The
cost of observing only is staleness: the list is as fresh as the app's last fetch.

Each entry carries a real `title`, the repo, `statusBucket`, and the latest
`post_turn_summary` — including `needsAction`, set when a session is **blocked
waiting on an answer**. The listing is ordered by recency: whenever the session
last did anything, judged from its live frame stream or, for sessions not open
in a tab, the list's `last_event_at`. Most recent first — the `1`–`9` keys
index this order.

### One id: the suffix

A session has three identifiers sharing one suffix:

| Form | Where it appears |
|------|------------------|
| `cse_01Kg3nT6…` | the session list |
| `session_01Kg3nT6…` | the page URL |
| `2ec66404-…` (uuid) | every frame |

The suffix is the only one that joins them, so it's the only id this server
emits or needs. A prefixed id is still accepted on input, since that's what you
get from copying a URL.

### Choosing and activating

One tab streams one session, so listening to a different one means navigating.
The server can't drive Chrome, so it pushes a navigate instruction down the
socket and `content.js` sets `location.href` — no `chrome.tabs` permission
needed. A selection made while no tab is connected is held and delivered when
one arrives.

Press `l` in the server's terminal to list sessions, `1`–`9` to use one from
that list, and `u` to go back to auto-following.

With no session chosen, whichever session most recently produced output is
followed. Switching cuts the previous session off rather than interleaving two.

## Status indicator

The toolbar icon is the status light — nothing is injected into the page:

- **Green** — the tab's relay socket is connected.
- **Red** — the relay server isn't reachable; start `node server.ts`.
- **Badge** — how many utterances the server has accepted, so a rising number
  means the whole chain is working.
- **Tooltip** — the same in words.

State is per tab, since two claude.ai tabs can have different socket states.
`background.js` owns the icon because `chrome.action` is not reachable from a
content script, and it draws the circles with `OffscreenCanvas` rather than
shipping PNGs, so there are no image assets to keep in sync with the colors.

## WebSocket logging

`ws-hook.js` also logs every frame to the console, prefixed with
`[claude-speak:ws]`. Frames are logged as raw text, in full — not as expandable
objects and not truncated — so what you see is exactly what went over the wire
and can be pasted elsewhere. Binary frames are decoded as UTF-8 when they
happen to be text.

Captured frames are kept on `window.__claudeSpeakWS`. The helpers all return
plain strings, so DevTools' `copy()` can put a frame straight on the clipboard
instead of you selecting it out of the log:

```js
copy(__claudeSpeakWS.last())      // raw text of the most recent frame
copy(__claudeSpeakWS.dump())      // every buffered frame
__claudeSpeakWS.last(3)           // the 3rd most recent, raw
__claudeSpeakWS.pretty()          // re-indented, for reading rather than pasting
__claudeSpeakWS.frames            // last 500: { id, url, dir, data, t }
__claudeSpeakWS.clear()
__claudeSpeakWS.enabled = false   // silence the console logging
```

Use `copy(__claudeSpeakWS.dump())` rather than selecting text out of the
console pane — the console adds `ws-hook.js:NN` prefixes and truncates long
lines, both of which corrupt a captured dump.

If nothing appears beyond the initial "WebSocket patched" line, the page isn't
streaming over a WebSocket — regular claude.ai chat may use server-sent events
over `fetch` instead, which would need an equivalent patch on `window.fetch`.
