import { getConfig } from '../core/config';
import { getConsent } from '../core/consent';
import { baseContext } from '../core/context';
import { uuid } from '../core/ids';
import { logger } from '../core/logger';
import { tryConsume } from '../core/rate-limiter';
import {
  claimSessionStart,
  getSession,
  incrementSessionCount,
  isSessionExpired,
  peekSession,
} from '../core/session';
import { incrTelemetry } from '../core/telemetry';
import {
  EVENTS_BATCH_KEY,
  enqueue,
  isServerRateLimited,
  upsert,
} from '../core/transport';

export type EventData = Record<string, unknown>;

/**
 * Types that a broken app can produce in a loop. Views and visibility
 * changes are left out: they happen at human speed, and losing one
 * breaks a pairing (a view with no end, a hide with no return).
 */
const RATE_LIMITED = new Set(['error', 'action', 'console', 'resource', 'long_task']);

/** Fields beforeSend cannot change: the event's identity. */
const FIXED_FIELDS = ['session_id', 'event_type', 'timestamp', 'log_record_uid', 'view_id'];

let viewCounter: ((data: EventData) => void) | null = null;

/** The views module counts each event in the view it happened in. */
export function setViewCounter(fn: (data: EventData) => void) {
  viewCounter = fn;
}

function applyBeforeSend(event: EventData): EventData | null {
  const hook = getConfig()?.beforeSend;
  if (!hook) return event;
  const fixed: EventData = {};
  for (const f of FIXED_FIELDS) fixed[f] = event[f];
  try {
    const out = hook(event);
    if (out === null) return null;
    const base = out && typeof out === 'object' ? out : event;
    return { ...base, ...fixed };
  } catch (e) {
    // The hook may exist to remove something that must not be sent, so
    // an event whose hook throws is dropped rather than sent unchanged.
    logger.warn('beforeSend threw; the event is dropped', e);
    return null;
  }
}

export function canRecord(): boolean {
  return getConfig() !== null && getConsent() !== 'not-granted';
}

/** The fields that mark the first event of a session, or null when this is not it. */
function sessionStartFields(event: EventData): EventData | null {
  const s = peekSession();
  if (!s || s.started || typeof event.session_id !== 'string' || event.session_id !== s.id) return null;
  const fields: EventData = { session_is_new: 1 };
  if (s.previousId) fields.session_previous_id = s.previousId;
  return fields;
}

/**
 * Runs beforeSend, and marks the event as the first of its session. The
 * start is claimed only when beforeSend keeps the event: claimed for an
 * event the app drops, the flag was never sent and the session was not
 * counted.
 */
function finishEvent(built: EventData): EventData | null {
  const start = sessionStartFields(built);
  if (start) Object.assign(built, start);
  const event = applyBeforeSend(built);
  if (!event) return null;
  if (start && claimSessionStart(String(built.session_id))) Object.assign(event, start);
  return event;
}

/** Builds an event on the current context and queues it. */
export function emit(data: EventData, activity = true) {
  if (!canRecord()) return;
  // Background work does not start a session after the last one ended.
  if (!activity && isSessionExpired()) return;
  if (!getSession(activity).sampled) return;
  if (isServerRateLimited('events')) return;
  const type = String(data.event_type ?? '');
  // A crash is the event a storm of errors leads to, and the one most
  // needed: it is never rate limited.
  if (RATE_LIMITED.has(type) && data.error_is_crash !== 1) {
    if (isServerRateLimited(type) || !tryConsume(type)) {
      incrTelemetry('events_rate_limited');
      return;
    }
  }
  incrementSessionCount(type);
  viewCounter?.(data);
  const built: EventData = { log_record_uid: uuid(), ...baseContext(activity), ...data };
  const event = finishEvent(built);
  if (event) enqueue(EVENTS_BATCH_KEY, event);
}

/** The session a view belongs to, and whether this update closes the view. */
export interface ViewOwner {
  sessionId: string;
  sampled: boolean;
  closing: boolean;
}

/**
 * Sends one update of a view. Readers keep the highest `view_update_seq`
 * per `view_id`, and count the view from its first update. Unsent
 * updates of one view collapse into the newest, which keeps the flags
 * that count the view and the session.
 *
 * An update goes out on the session of its view. Once that session has
 * ended, only the closing update goes out: readers take a view's vitals
 * from it, and without it the view stays open. It is not activity, so it
 * does not keep the session open or start one.
 */
export function emitViewUpdate(data: EventData, owner: ViewOwner) {
  if (!canRecord()) return;
  if (!owner.sampled) return;
  const live = !isSessionExpired() && peekSession()?.id === owner.sessionId;
  if (!live && !owner.closing) return;
  if (isServerRateLimited('events')) return;
  if (live && data.view_update_seq === 1) incrementSessionCount('view');
  const built: EventData = {
    log_record_uid: uuid(),
    ...baseContext(false),
    ...data,
    session_id: owner.sessionId,
  };
  if (data.view_update_seq === 1) built.view_is_new = 1;
  const event = finishEvent(built);
  if (!event) return;
  upsert(EVENTS_BATCH_KEY, `view:${String(data.view_id)}`, event, (prev, next) => {
    const merged = { ...next };
    if (prev.view_is_new === 1) merged.view_is_new = 1;
    if (prev.session_is_new === 1) merged.session_is_new = 1;
    if (prev.session_previous_id) merged.session_previous_id = prev.session_previous_id;
    return merged;
  });
}

/**
 * Queues an event that is already complete, such as a crash from the last
 * run. It keeps its own session and time and does not touch the live
 * session.
 */
export function emitRaw(event: EventData) {
  if (!canRecord()) return;
  const out = applyBeforeSend({ log_record_uid: uuid(), ...event });
  if (out) enqueue(EVENTS_BATCH_KEY, out);
}

/** Attributes go out as one JSON string, the same way as custom event properties. */
export function attributesJSON(attrs: Record<string, unknown> | undefined): string {
  if (!attrs || typeof attrs !== 'object') return '';
  try {
    const s = JSON.stringify(attrs);
    return s === '{}' ? '' : s;
  } catch {
    return '';
  }
}
