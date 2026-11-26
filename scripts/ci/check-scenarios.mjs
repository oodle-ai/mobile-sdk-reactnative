#!/usr/bin/env node
// Checks what the mock collector received during scripts/ci/scenarios.sh.
//
// For each crash scenario: the SDK reports exactly one crash, on the
// session that the crash ended, from the right source. A crash reported
// twice (by the JS handler and by native code, or from disk after a send
// that got through) doubles the crash count, and a crash on the wrong
// session hides what the user did before it. The reference SDK, installed
// next to Oodle, must report the crash too.
//
// For the offline scenario: each action made while offline arrives once,
// after the app was killed and started again.
//
// For the collector-garbage scenario: while the collector answered each
// upload with garbage, the app ran its walk to the end and still ran
// after it, and neither SDK reported a crash.
//
// Usage: check-scenarios.mjs --out <collector dir> --platform android|ios
import fs from 'node:fs';
import path from 'node:path';
import { check, checkCollectorFields, finish, opt, outDir, readNdjson } from './collector-lib.mjs';

const out = outDir();
const platform = opt('platform', 'android');

// Keep in sync with fixtures/fieldwork/src/scenario.ts.
const JS_FATAL_MESSAGE = 'Fixture JS fatal';
const OFFLINE_ACTIONS = 3;

const events = readNdjson(path.join(out, 'events.ndjson'));
const reference = readNdjson(path.join(out, 'reference.ndjson'));
const scenariosFile = path.join(out, 'scenarios.txt');
const ran = fs.existsSync(scenariosFile) ? fs.readFileSync(scenariosFile, 'utf8').split('\n').filter(Boolean) : [];

const GARBAGE = 'collector-garbage';
const required = ['js-fatal', 'offline', GARBAGE, platform === 'android' ? 'jvm-crash' : 'signal-crash'];
for (const name of required) check(ran.includes(name), `scenario ${name} ran`);

/** The session that a scenario ran in, from the action the app sent first. */
function scenarioSession(name) {
  const armed = events.filter((e) => e.event_type === 'action' && e.action_name === `scenario:${name}`);
  check(armed.length === 1, `scenario ${name}: the app sent scenario:${name} once (${armed.length})`);
  return armed[0]?.session_id;
}

/** Reference SDK uploads made during a scenario run and the start after it. */
const referenceBodies = (name) =>
  reference
    .filter((u) => u.scenario === name || u.scenario === `after-${name}`)
    .map((u) => u.body)
    .join('\n');

for (const name of ran.filter((n) => n !== 'offline' && n !== GARBAGE)) {
  const session = scenarioSession(name);
  if (!session) continue;
  const crashes = events.filter((e) => e.event_type === 'error' && e.error_is_crash === 1 && e.session_id === session);
  check(crashes.length === 1, `scenario ${name}: one crash on the session it ended (${crashes.length})`);
  const crash = crashes[0];
  if (name === 'js-fatal') {
    check(crash?.error_source === 'source', `scenario ${name}: the crash comes from JS (${crash?.error_source})`);
    check(
      String(crash?.exception_message ?? '').includes(JS_FATAL_MESSAGE),
      `scenario ${name}: the crash has the JS error message`,
    );
  } else {
    check(crash?.error_source === 'native', `scenario ${name}: the crash comes from native code (${crash?.error_source})`);
  }
  check(/"is_crash"\s*:\s*true/.test(referenceBodies(name)), `scenario ${name}: the reference SDK also reported the crash`);
}

if (ran.includes('offline')) {
  const session = scenarioSession('offline');
  for (let n = 1; n <= OFFLINE_ACTIONS; n++) {
    const sent = events.filter((e) => e.event_type === 'action' && e.action_name === `Offline action ${n}`);
    check(sent.length === 1, `scenario offline: "Offline action ${n}" arrived once (${sent.length})`);
    check(sent[0]?.session_id === session, `scenario offline: "Offline action ${n}" is on the offline session`);
  }
}

if (ran.includes(GARBAGE)) {
  const session = scenarioSession(GARBAGE);
  const done = events.filter((e) => e.event_type === 'action' && e.action_name === `soak:done:${GARBAGE}`);
  check(done.length === 1, `scenario ${GARBAGE}: the app ran its walk to the end (${done.length})`);
  const state = fs.readFileSync(path.join(out, `${GARBAGE}.txt`), 'utf8').trim();
  check(state === 'app-runs', `scenario ${GARBAGE}: the app still ran after the walk (${state})`);
  const crashes = events.filter((e) => e.error_is_crash === 1 && e.session_id === session);
  check(crashes.length === 0, `scenario ${GARBAGE}: no crash on its session (${crashes.length})`);
  check(!/"is_crash"\s*:\s*true/.test(referenceBodies(GARBAGE)), `scenario ${GARBAGE}: the reference SDK reported no crash`);
}

// The mock collector stores a body with the same batch id once, as the
// collector does. An event that arrives twice came in two bodies with
// different ids: the collector cannot drop the second, so it counts twice.
const uids = events.map((e) => e.log_record_uid);
const duplicates = uids.length - new Set(uids).size;
check(duplicates === 0, `no event arrived twice (${duplicates} duplicates)`);
// The crash and ANR events of the scenarios have fields of their own.
checkCollectorFields(out);

finish('scenario check');
