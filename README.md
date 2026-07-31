# Claude Speak

Hear your Claude Code sessions on claude.ai. A Chrome extension forwards each
session's output to a small local server, which reads it aloud with the macOS
`say` command — answers, questions, and short notes on what Claude is doing.

## Install

Needs macOS and Node 24+.

1. Start the relay server:

   ```sh
   node server.ts             # system default voice
   node server.ts Samantha    # or pick a voice (see `say -v '?'`)
   ```

2. Open `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the `extension/` directory
5. Open or reload a claude.ai tab

## What gets spoken

- **Answers** — with markdown made listenable: tables and code blocks are
  described ("a table with columns Size and File, and 10 rows", "a python code
  block") instead of recited, and headings, links, bullets and emphasis
  markers are stripped.
- **Questions** — when Claude asks something, the question and its numbered
  options are read out, so you can answer by ear. The session is blocked until
  you respond, so questions are never suppressed.
- **Tool calls** — a short line like "Rank files by line count", rate-limited
  so bursts of tool work don't stack up.
- Thinking, tool output, and subagent chatter are not spoken.

The knobs for this live at the top of `lib/frames.ts`.

## Controls

Single keypresses in the server's terminal:

| Key | Effect |
|-----|--------|
| `s` or space | Skip what's being read, move to the next utterance |
| `c` | Clear the queue and go quiet |
| `l` | List sessions, most recently active first |
| `1`–`9` | Use the Nth session from the list |
| `u` | Go back to following the most recent |
| `Ctrl+C` | Quit |

## Sessions

Several claude.ai tabs can relay at once, but only one session is spoken. By
default that's whichever session most recently produced output; picking one
with `1`–`9` locks onto it instead, and navigates a tab there if it isn't
open. `u` returns to automatic following.

## Status

The toolbar icon shows the connection state per tab: **green** when the tab is
connected to the relay, **red** when the server isn't reachable, with the
number of utterances spoken as the badge.

## Debugging

`ws-hook.js` and `http-tap.js` can log all observed WebSocket frames and API
calls to the page's console — flip the `DEBUG` const at the top of each file.
Recent traffic is always kept on `window.__claudeSpeakWS` and
`window.__claudeSpeakHTTP` (try `.dump()` and `.paths()`), logging or not.
