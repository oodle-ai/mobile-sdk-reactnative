import { uuid } from './ids';
import { storage } from './native';

const SESSION_KEY = 'session';
/** A session ends after this much time with no activity. */
export const SESSION_TIMEOUT_MS = 15 * 60 * 1000;
/** A session never lasts longer than this. */
export const SESSION_MAX_DURATION_MS = 4 * 60 * 60 * 1000;

export interface SessionData {
  id: string;
  createdAt: number;
  lastActivity: number;
  viewCount: number;
  errorCount: number;
  actionCount: number;
  sampled: boolean;
  replaySampled: boolean;
  replaySegmentSeq: number;
  /** An event of this session was marked as its first. */
  started: boolean;
  /** The session this one followed (`session.previous_id`), if any. */
  previousId?: string;
}

let current: SessionData | null = null;
let loaded = false;
let sessionRate = 100;
let replayRate = 100;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const renewListeners: Array<(s: SessionData, previous: SessionData | null) => void> = [];

export function setSampleRates(session: number, replay: number) {
  sessionRate = session;
  replayRate = replay;
}

function roll(rate: number): boolean {
  return Math.random() * 100 < rate;
}

function write() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (current) storage.setJSON(SESSION_KEY, current);
}

function scheduleWrite() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    write();
  }, 1000);
}

function load(): SessionData | null {
  const raw = storage.getJSON<Partial<SessionData> | null>(SESSION_KEY, null);
  if (!raw || typeof raw.id !== 'string') return null;
  const now = Date.now();
  return {
    id: raw.id,
    createdAt: raw.createdAt ?? now,
    lastActivity: raw.lastActivity ?? now,
    viewCount: raw.viewCount ?? 0,
    errorCount: raw.errorCount ?? 0,
    actionCount: raw.actionCount ?? 0,
    sampled: raw.sampled ?? true,
    replaySampled: raw.replaySampled ?? false,
    replaySegmentSeq: raw.replaySegmentSeq ?? 0,
    started: raw.started ?? true,
  };
}

function expired(s: SessionData, now: number): boolean {
  return (
    now - s.lastActivity > SESSION_TIMEOUT_MS ||
    now - s.createdAt > SESSION_MAX_DURATION_MS
  );
}

export function onSessionRenew(
  fn: (s: SessionData, previous: SessionData | null) => void,
) {
  renewListeners.push(fn);
}

function renew(now: number): SessionData {
  const previous = current;
  const sampled = roll(sessionRate);
  current = {
    id: uuid(),
    createdAt: now,
    lastActivity: now,
    viewCount: 0,
    errorCount: 0,
    actionCount: 0,
    sampled,
    replaySampled: sampled && roll(replayRate),
    replaySegmentSeq: 0,
    started: false,
    previousId: previous?.id,
  };
  write();
  for (const fn of renewListeners) {
    try {
      fn(current, previous);
    } catch {
      // A listener must not stop the session from starting.
    }
  }
  return current;
}

/**
 * Returns the live session, starting a new one when there is none or
 * the last one ran out. `activity` marks user-visible work; background
 * work such as periodic view updates passes false so it cannot keep an
 * idle session alive.
 */
export function getSession(activity = true): SessionData {
  const now = Date.now();
  if (!loaded) {
    loaded = true;
    current = load();
  }
  if (!current || expired(current, now)) return renew(now);
  if (activity) {
    current.lastActivity = now;
    scheduleWrite();
  }
  return current;
}

export function getSessionId(): string {
  return getSession(false).id;
}

/** The session as it is now, without starting or renewing one. */
export function peekSession(): SessionData | null {
  if (!loaded) {
    loaded = true;
    current = load();
  }
  return current;
}

/** True when the stored session would be replaced by the next event. */
export function isSessionExpired(now = Date.now()): boolean {
  const s = peekSession();
  return !s || expired(s, now);
}

/** Ends the session. The next event starts a new one. */
export function stopSession() {
  if (current) {
    current.lastActivity = 0;
    write();
  }
}

/**
 * Segment indices name the stored replay object, so they must never
 * repeat within a session. The counter is persisted with the session
 * and written through at once, because a lost increment would let the
 * next app start overwrite a stored segment.
 */
export function nextReplaySegmentIndex(): number {
  const s = getSession(false);
  const index = s.replaySegmentSeq;
  s.replaySegmentSeq = index + 1;
  write();
  return index;
}

/**
 * True once per session, for the event that is sent first. Readers count
 * sessions from this flag, whatever kind of event comes first.
 */
export function claimSessionStart(sessionId: string): boolean {
  const s = peekSession();
  if (!s || s.id !== sessionId || s.started) return false;
  s.started = true;
  write();
  return true;
}

export function incrementSessionCount(eventType: string) {
  const s = getSession(false);
  if (eventType === 'view') s.viewCount++;
  else if (eventType === 'error') s.errorCount++;
  else if (eventType === 'action') s.actionCount++;
  else return;
  scheduleWrite();
}

export function flushSession() {
  write();
}

/** Test hook. */
export function resetSessionState() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  current = null;
  loaded = false;
  renewListeners.length = 0;
}
