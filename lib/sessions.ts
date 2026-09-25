// Session registry and selection. Several claude.ai tabs can relay at once;
// every session seen is recorded, and only one is spoken — the explicitly
// selected one, or with no selection, whichever most recently produced output.
//
// The suffix is the identifier that joins everything: the session list reports
// `cse_<suffix>`, the page URL `session_<suffix>`, and frames carry an
// unrelated uuid. A prefixed id is still tolerated on input, since that is
// what you get from copying a URL.

import { stopSpeaking } from './say.ts';
import type { Frame } from './types.ts';

// A session as observed from its frame stream, keyed by uuid session_id.
interface StreamSession {
  suffix: string | null;
  cwd: string | null;
  lastSummary: string | null;
  lastActivity: number;
}

// A session as claude.ai's own list reports it.
interface CatalogEntry {
  suffix: string;
  title: string | null;
  statusBucket?: string | null;
  needsAction?: string | null;
  lastSummary?: string | null;
  repo?: string | null;
  unread?: boolean;
  lastEventAt?: string | null;
  // Filled in from the stream registry when the session is relaying.
  cwd?: string | null;
  streamActivity?: number;
}

interface SessionView {
  id: string;
  title: string;
  repo: string | null;
  statusBucket: string | null;
  needsAction: string | null;
  lastSummary: string | null;
  unread: boolean;
  streaming: boolean;
  selected: boolean;
  speaking: boolean;
}

interface NavigateCommand {
  action: 'navigate';
  suffix: string;
  url: string;
}

const sessions = new Map<string, StreamSession>();

// Sessions as claude.ai's own list reports them, keyed by suffix — the only
// way to know about sessions that aren't currently open in a tab.
const catalog = new Map<string, CatalogEntry>();

function suffixOf(id: unknown): string | null {
  return typeof id === 'string' ? id.replace(/^(cse_|session_)/, '') : null;
}

// Page URLs always use the `session_` prefix; `cse_` appears only in the list.
const SESSION_ID_IN_URL = /\/session_([A-Za-z0-9]{6,})/;

// For frames that carry no session_id at all (permission prompts), the tab
// URL is the only way to tell which session they belong to.
export function suffixFromUrl(url?: string): string | null {
  return url?.match(SESSION_ID_IN_URL)?.[1] ?? null;
}

const urlForSuffix = (suffix: string): string => `https://claude.ai/code/session_${suffix}`;

// Pending navigation for the extension: delivered when set, and held so a tab
// that connects later still gets it. Cleared once the session streams.
let pendingCommand: NavigateCommand | null = null;

// Delivery is registered by the WebSocket layer, so this module doesn't
// depend on the transport. Returns how many tabs were reached.
let deliver: (command: NavigateCommand) => number = () => 0;
export function onCommand(fn: (command: NavigateCommand) => number): void {
  deliver = fn;
}

export function peekPendingCommand(): NavigateCommand | null {
  return pendingCommand;
}

export function absorbCatalog(entries: any[]): number {
  let added = 0;
  for (const entry of entries) {
    const suffix = suffixOf(entry?.id);
    if (!suffix) continue;
    if (!catalog.has(suffix)) added += 1;
    const summary = entry.external_metadata?.post_turn_summary || {};
    catalog.set(suffix, {
      suffix,
      title: entry.title || null,
      // `blocked` means the session is waiting on an answer.
      statusBucket: entry.status_bucket || null,
      needsAction: summary.needs_action || null,
      lastSummary: summary.status_detail || null,
      repo: (entry.config?.outcomes || []).map((o: any) => o.git_info?.repo).filter(Boolean)[0] || null,
      unread: Boolean(entry.unread),
      lastEventAt: entry.last_event_at || null,
    });
  }
  if (added) console.log(`[catalog] ${catalog.size} sessions known (+${added})`);
  return catalog.size;
}

let selectedSuffix: string | null = null;
let followedSuffix: string | null = null;

// The suffix whose output is currently being spoken.
function activeSuffix(): string | null {
  return selectedSuffix || followedSuffix;
}

// When a session last did anything, from whichever source knows: frames seen
// on its live stream, or the catalog's last_event_at.
function recencyOf(e: CatalogEntry): number {
  return Math.max(e.streamActivity || 0, Date.parse(e.lastEventAt || '') || 0);
}

// One entry per session, merging the catalog (everything that exists) with
// the stream registry (what is relaying right now). Most recently active
// first — this order is also what the keyboard's 1-9 selection indexes.
export function listSessions(): SessionView[] {
  const merged = new Map<string, CatalogEntry>();
  for (const [suffix, entry] of catalog) merged.set(suffix, { ...entry });
  for (const session of sessions.values()) {
    const suffix = session.suffix;
    if (!suffix) continue;
    const entry = merged.get(suffix) || { suffix, title: null };
    entry.cwd = session.cwd;
    entry.lastSummary = session.lastSummary || entry.lastSummary;
    entry.streamActivity = session.lastActivity;
    merged.set(suffix, entry);
  }
  return [...merged.values()]
    .sort((a, b) => recencyOf(b) - recencyOf(a))
    .map((e): SessionView => ({
      id: e.suffix,
      title: e.title || e.cwd || e.suffix,
      repo: e.repo ?? null,
      statusBucket: e.statusBucket ?? null,
      needsAction: e.needsAction ?? null,
      lastSummary: e.lastSummary ?? null,
      unread: Boolean(e.unread),
      streaming: Boolean(e.streamActivity),
      selected: e.suffix === selectedSuffix,
      speaking: e.suffix === activeSuffix(),
    }));
}

export function record(frame: Frame, url?: string): StreamSession | null {
  // `user` frames carry the session_… id rather than the uuid, so they cannot
  // key the registry — the uuid-bearing frames do that.
  const id = frame.session_id;
  if (!id || id.startsWith('session_')) return null;

  let session = sessions.get(id);
  if (!session) {
    session = { suffix: null, cwd: null, lastSummary: null, lastActivity: 0 };
    sessions.set(id, session);
  }
  session.lastActivity = Date.now();

  if (url && !session.suffix) {
    const suffix = suffixFromUrl(url);
    if (suffix) {
      session.suffix = suffix;
      console.log('[session] streaming ' + session.suffix);
      // The tab arrived where it was told to go, so the instruction is spent.
      if (pendingCommand && pendingCommand.suffix === session.suffix) {
        pendingCommand = null;
      }
    } else {
      // Without a suffix a frame can never match a selection — say so loudly
      // rather than letting it present as unexplained silence.
      console.warn(`[session] no session id found in tab URL: ${url}`);
    }
  }
  if (frame.subtype === 'init') {
    session.cwd = frame.cwd || session.cwd;
  }
  if (frame.subtype === 'post_turn_summary' && frame.status_detail) {
    session.lastSummary = frame.status_detail;
  }
  return session;
}

// Cut the previous session off so two never interleave mid-sentence.
function follow(suffix: string | null): void {
  if (!suffix || followedSuffix === suffix) return;
  if (followedSuffix !== null) {
    console.log('[session] following ' + suffix + ', was ' + followedSuffix + ' — clearing queue');
    stopSpeaking();
  }
  followedSuffix = suffix;
}

// Whether a frame from this suffix should be spoken. With nothing selected the
// frame claims the follow slot — the last session to produce output wins.
export function shouldSpeak(suffix: string | null): boolean {
  if (selectedSuffix === null) {
    follow(suffix);
    return true;
  }
  if (suffix === selectedSuffix) return true;
  if (!suffix) console.warn('[session] frame has no resolvable session id — gated out');
  return false;
}

// Accepts any id form; null clears the selection. Selecting a session that is
// not streaming pushes a navigation to the extension — the only way to make it
// start streaming, since the server cannot drive Chrome.
export function selectSession(anyId: string | null): void {
  if (!anyId) {
    selectedSuffix = null;
    pendingCommand = null;
    console.log('[session] selection cleared — following most recent');
    return;
  }
  const suffix = suffixOf(anyId)!;
  const streaming = [...sessions.values()].some((s) => s.suffix === suffix);
  if (!streaming && !catalog.has(suffix)) {
    console.warn(
      `[session] cannot select ${anyId}: suffix ${suffix} is not in the catalog ` +
        `(${catalog.size} known) and is not streaming`
    );
    return;
  }

  if (selectedSuffix !== suffix) stopSpeaking();
  selectedSuffix = suffix;

  if (streaming) {
    pendingCommand = null;
    console.log('[session] selected ' + suffix + ' (already streaming)');
    return;
  }
  pendingCommand = { action: 'navigate', suffix, url: urlForSuffix(suffix) };
  const reached = deliver(pendingCommand);
  console.log(
    `[session] selected ${suffix} — navigate ${pendingCommand.url} sent to ${reached} tab(s)` +
      (reached ? '' : ' — nothing connected, held until one is')
  );
}
