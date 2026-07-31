// Frame handling — decides what, if anything, each protocol frame is worth
// saying, and queues it.

import { enqueue } from './say.ts';
import { speechify } from './speechify.ts';
import { questionAnnouncement } from './announce.ts';
import { record, shouldSpeak } from './sessions.ts';
import type { Frame } from './types.ts';

// What was spoken for a frame, reported back for the extension's badge.
type SpokeKind = 'answer' | 'question' | 'status' | null;

// Speak a short line when Claude starts a tool call, so long stretches of tool
// work aren't just silence. Only tools that supply an input.description are
// announced — Bash writes a good one ("Rank files by line count"), while the
// ~150 MCP tools in a session would otherwise be read out as
// "mcp__Betterstack__create_chart_alert".
const ANNOUNCE_TOOLS = true;

// Minimum quiet time before a tool announcement; only suppresses bursts.
const TOOL_GAP_MS = 4000;

// Subagent output (a non-null parent_tool_use_id) is a fleet of agents talking
// at once — off by default.
const SPEAK_SUBAGENTS = false;

// Frames older than this when they arrive are replayed history, not new
// content. Generous, to tolerate clock skew; real history is minutes or hours
// old, not seconds.
const HISTORY_SKEW_MS = 60_000;

const startedAt = Date.now();

// Blocks already queued, as `${uuid}:${index}`. Only recent keys matter for
// dedupe, so cap the set instead of growing forever.
const spokenBlocks = new Set<string>();
const SPOKEN_BLOCKS_MAX = 5000;

let lastSpokeAt = 0;

function isReplayedHistory(frame: Frame): boolean {
  const created = Date.parse(frame.created_at || '');
  return Number.isFinite(created) && created < startedAt - HISTORY_SKEW_MS;
}

export function handleFrame(frame: Frame, url?: string): SpokeKind {
  const session = record(frame, url);

  if (frame.type !== 'assistant') return null;
  if (isReplayedHistory(frame)) return null;
  if (frame.parent_tool_use_id && !SPEAK_SUBAGENTS) return null;
  if (!shouldSpeak(session && session.suffix)) return null;

  const content = frame.message?.content;
  const blocks = Array.isArray(content) ? content : [];

  let spoke: SpokeKind = null;
  const speak = (text: string, kind: NonNullable<SpokeKind>) => {
    enqueue(text);
    lastSpokeAt = Date.now();
    spoke = kind;
  };

  blocks.forEach((block, index) => {
    const key = `${frame.uuid}:${index}`;
    if (spokenBlocks.has(key)) return;
    spokenBlocks.add(key);
    if (spokenBlocks.size > SPOKEN_BLOCKS_MAX) {
      spokenBlocks.delete(spokenBlocks.values().next().value!);
    }

    if (block.type === 'text') {
      const text = speechify(block.text);
      if (text) speak(text, 'answer');
      return;
    }
    // Thinking blocks arrive with empty text — the reasoning is redacted on
    // this stream, so there is nothing to say.
    if (block.type !== 'tool_use') return;

    // A question is the whole point of speaking: it ignores the tool toggle
    // and the rate gate, since the session is blocked until you answer.
    if (block.name === 'AskUserQuestion') {
      const asked = questionAnnouncement(block.input);
      if (asked) speak(asked, 'question');
      return;
    }

    if (!ANNOUNCE_TOOLS) return;
    const description = block.input?.description;
    if (!description) return; // unnamed or MCP tools stay silent
    if (Date.now() - lastSpokeAt < TOOL_GAP_MS) return;
    speak(String(description).trim(), 'status');
  });
  return spoke;
}
