import { getConfig } from '../core/config';
import { getConsent } from '../core/consent';
import { hasNative, native } from '../core/native';
import {
  getSession,
  nextReplaySegmentIndex,
  peekSession,
  type SessionData,
} from '../core/session';
import { incrTelemetry } from '../core/telemetry';
import { REPLAY_BATCH_KEY, enqueue } from '../core/transport';
import { estimateJsonBytes } from '../core/size';
import { logger } from '../core/logger';
import { getCurrentViewInfo } from '../events/view-state';
import {
  BODY_ID,
  EventType,
  IncrementalSource,
  MouseInteraction,
  WireframeRecorder,
  type RRWebEvent,
  type WireframeSnapshot,
} from './rrweb';
import { clockOffset } from '../core/clock';

/** Snapshot interval while nothing prompts one. Unchanged screens send nothing. */
const CAPTURE_INTERVAL_MS = 1000;
/** Captures after a touch or a screen change, to catch the result and its animation. */
const FOLLOW_UP_DELAYS_MS = [120, 600];
/** A full snapshot at least this often, so a seek never replays a long chain. */
const FULL_SNAPSHOT_EVERY_MS = 5 * 60 * 1000;
const SEGMENT_MAX_EVENTS = 200;
const SEGMENT_MAX_BYTES = 60_000;
const SEGMENT_MAX_AGE_MS = 5000;
const TOUCH_MOVE_THROTTLE_MS = 50;
/**
 * A touch that moves further than this (dp) is a drag or a scroll. Its
 * follow-up captures are skipped: a list can still move after the finger
 * lifts, and each capture during that motion costs main thread time when
 * frames matter most. The capture loop records where the motion ends.
 */
const DRAG_SLOP_DP = 10;
const MAX_NODES = 2000;

let recorder: WireframeRecorder | null = null;
let wanted = false;
let recording = false;
let foreground = true;
let captureTimer: ReturnType<typeof setInterval> | null = null;
let followUps: Array<ReturnType<typeof setTimeout>> = [];
let capturing = false;
let pendingFull = true;
let lastFullAt = 0;
let segment: RRWebEvent[] = [];
let segmentBytes = 0;
let segmentTimer: ReturnType<typeof setTimeout> | null = null;
let segmentSessionId = '';
let flushedSessionId = '';
let lastTouchMove = 0;
let touchStart: { x: number; y: number } | null = null;
let dragging = false;

function eligible(): boolean {
  const c = getConfig();
  if (!c || !c.replay.enabled || !wanted || !foreground) return false;
  if (getConsent() !== 'granted') return false;
  const s = peekSession();
  if (!s || !s.sampled || !s.replaySampled) return false;
  return hasNative();
}

/** The session id once part of its replay is queued, for `replay_id` on events. */
export function replayIdForEvents(): string {
  const s = peekSession();
  return s && flushedSessionId === s.id && recording ? s.id : '';
}

/**
 * `ended` is the session that just ended, when the segment belongs to it.
 * Its counter is used then, because the live counter now belongs to the
 * new session.
 */
function flushSegment(ended?: SessionData | null) {
  if (segmentTimer) {
    clearTimeout(segmentTimer);
    segmentTimer = null;
  }
  if (segment.length === 0) return;
  const events = segment;
  const bytes = segmentBytes;
  const sessionId = segmentSessionId;
  segment = [];
  segmentBytes = 0;
  const index =
    ended && ended.id === sessionId ? ended.replaySegmentSeq++ : nextReplaySegmentIndex();
  enqueue(REPLAY_BATCH_KEY, { session_id: sessionId, segment_index: index, events }, bytes);
  flushedSessionId = sessionId;
}

function push(events: RRWebEvent[]) {
  if (events.length === 0) return;
  const sessionId = getSession(false).id;
  if (segment.length > 0 && segmentSessionId !== sessionId) flushSegment();
  segmentSessionId = sessionId;
  const offset = clockOffset();
  for (const e of events) {
    // Replay time must match event time, or the player puts taps and
    // errors at the wrong place.
    if (offset) e.timestamp += offset;
    segment.push(e);
    segmentBytes += estimateJsonBytes(e, SEGMENT_MAX_BYTES);
  }
  if (segment.length >= SEGMENT_MAX_EVENTS || segmentBytes >= SEGMENT_MAX_BYTES) {
    flushSegment();
  } else if (!segmentTimer) {
    segmentTimer = setTimeout(() => flushSegment(), SEGMENT_MAX_AGE_MS);
  }
}

function href(): string {
  return getCurrentViewInfo()?.url || `app://${getConfig()?.service ?? 'app'}`;
}

async function capture() {
  if (!recording || !recorder || capturing) return;
  capturing = true;
  try {
    const full = pendingFull || Date.now() - lastFullAt > FULL_SNAPSHOT_EVERY_MS;
    // On an idle screen native code skips the walk, unless a full
    // snapshot is due, which needs the whole screen.
    const raw = await native.captureWireframes({ maxNodes: MAX_NODES, skipUnchanged: !full });
    if (!recording || !recorder) return;
    const snapshot = JSON.parse(raw) as WireframeSnapshot & { unchanged?: boolean };
    if (snapshot?.unchanged) return;
    if (!snapshot || !Array.isArray(snapshot.nodes) || !(snapshot.width > 0)) return;
    const now = Date.now();
    const result = recorder.apply(snapshot, now, href(), full);
    if (result.full) {
      pendingFull = false;
      lastFullAt = now;
    }
    push(result.events);
  } catch (e) {
    incrTelemetry('replay_capture_failures');
    logger.debug('wireframe capture failed', e);
  } finally {
    capturing = false;
  }
}

function scheduleFollowUps() {
  if (!recording) return;
  for (const t of followUps) clearTimeout(t);
  followUps = FOLLOW_UP_DELAYS_MS.map((d) => setTimeout(() => void capture(), d));
}

function startLoop() {
  if (captureTimer) return;
  captureTimer = setInterval(() => void capture(), CAPTURE_INTERVAL_MS);
}

function stopLoop() {
  if (captureTimer) clearInterval(captureTimer);
  captureTimer = null;
  for (const t of followUps) clearTimeout(t);
  followUps = [];
}

/** Starts or stops recording to match the settings, consent and app state. */
export function syncRecording() {
  const should = eligible();
  if (should === recording) return;
  if (should) {
    const c = getConfig()!;
    if (!recorder) recorder = new WireframeRecorder({ textAndInputPrivacy: c.replay.textAndInputPrivacy });
    recording = true;
    pendingFull = true;
    startLoop();
    void capture();
  } else {
    recording = false;
    stopLoop();
    flushSegment();
    recorder?.reset();
  }
}

export function initReplay() {
  const c = getConfig();
  if (!c?.replay.enabled) return;
  wanted = c.replay.startRecordingImmediately;
  syncRecording();
}

export function startRecording() {
  wanted = true;
  syncRecording();
}

export function stopRecording() {
  wanted = false;
  syncRecording();
}

export function isRecording(): boolean {
  return recording;
}

/** A lost segment breaks the deltas after it; the next capture is a full snapshot. */
export function onSegmentDropped() {
  incrTelemetry('replay_rebases');
  pendingFull = true;
  recorder?.reset();
}

export function onViewChanged() {
  if (!recording) return;
  pendingFull = true;
  scheduleFollowUps();
}

export function onReplaySessionRenew(previous: SessionData | null) {
  flushSegment(previous);
  recorder?.reset();
  pendingFull = true;
  recording = false;
  stopLoop();
  syncRecording();
}

export function onReplayBackground() {
  foreground = false;
  recording = false;
  stopLoop();
  flushSegment();
}

export function onReplayForeground() {
  foreground = true;
  recorder?.reset();
  pendingFull = true;
  syncRecording();
}

// --- Touches, from OodleProvider ---

function touchAllowed(): boolean {
  return recording && getConfig()?.replay.touchPrivacy !== 'hide';
}

function trackDrag(x: number, y: number) {
  if (!touchStart || dragging) return;
  if (Math.abs(x - touchStart.x) > DRAG_SLOP_DP || Math.abs(y - touchStart.y) > DRAG_SLOP_DP) dragging = true;
}

export function recordTouchStart(x: number, y: number) {
  touchStart = { x, y };
  dragging = false;
  if (!touchAllowed()) return;
  push([
    {
      type: EventType.IncrementalSnapshot,
      data: { source: IncrementalSource.MouseInteraction, type: MouseInteraction.TouchStart, id: BODY_ID, x, y },
      timestamp: Date.now(),
    },
  ]);
}

export function recordTouchMove(x: number, y: number) {
  trackDrag(x, y);
  if (!touchAllowed()) return;
  const now = Date.now();
  if (now - lastTouchMove < TOUCH_MOVE_THROTTLE_MS) return;
  lastTouchMove = now;
  push([
    {
      type: EventType.IncrementalSnapshot,
      data: { source: IncrementalSource.TouchMove, positions: [{ x, y, id: BODY_ID, timeOffset: 0 }] },
      timestamp: now,
    },
  ]);
}

export function recordTouchEnd(x: number, y: number, tap: boolean) {
  trackDrag(x, y);
  const dragged = dragging;
  touchStart = null;
  dragging = false;
  if (recording && !dragged) scheduleFollowUps();
  if (!touchAllowed()) return;
  const now = Date.now();
  const events: RRWebEvent[] = [
    {
      type: EventType.IncrementalSnapshot,
      data: { source: IncrementalSource.MouseInteraction, type: MouseInteraction.TouchEnd, id: BODY_ID, x, y },
      timestamp: now,
    },
  ];
  if (tap) {
    events.push({
      type: EventType.IncrementalSnapshot,
      data: { source: IncrementalSource.MouseInteraction, type: MouseInteraction.Click, id: BODY_ID, x, y },
      timestamp: now,
    });
  }
  push(events);
}

/** Sends the open segment now (app going to the background, fatal error). */
export function flushReplay() {
  flushSegment();
}

/** Test hook. */
export function resetReplay() {
  stopLoop();
  if (segmentTimer) clearTimeout(segmentTimer);
  segmentTimer = null;
  recorder = null;
  wanted = false;
  recording = false;
  foreground = true;
  capturing = false;
  pendingFull = true;
  lastFullAt = 0;
  segment = [];
  segmentBytes = 0;
  segmentSessionId = '';
  flushedSessionId = '';
  lastTouchMove = 0;
  touchStart = null;
  dragging = false;
}
