import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain JS module of the CI scripts.
import { apiHost, field, replayOfViews, serverVerdict } from '../scripts/ci/reference-replay-check.mjs';

// What scripts/ci/reference-replay-check.mjs reads from the RUM search API.
const view = (attrs: Record<string, unknown>) => ({ attributes: { attributes: attrs } });

describe('replay probe server check', () => {
  it('takes the API host with or without a scheme or path', () => {
    expect(apiHost('api.example.test')).toBe('api.example.test');
    expect(apiHost(' https://api.example.test/api/v2 ')).toBe('api.example.test');
    expect(apiHost(undefined)).toBe('');
  });

  it('reads a field of an event, nested or flat', () => {
    expect(field(view({ session: { id: 's1', has_replay: true } }), 'session.has_replay')).toBe(true);
    expect(field(view({ 'session.id': 's1' }), 'session.id')).toBe('s1');
    expect(field(view({}), '_dd.replay_stats.records_count')).toBeUndefined();
  });

  it('sums the replay records of the views of a session', () => {
    const none = [view({ session: { has_replay: false }, _dd: { replay_stats: { records_count: 0 } } })];
    expect(replayOfViews(none)).toEqual({ views: 1, hasReplay: false, records: 0 });
    const some = [
      view({ session: { has_replay: false }, _dd: { replay_stats: { records_count: 0 } } }),
      view({ session: { has_replay: true }, _dd: { replay_stats: { records_count: 12 } } }),
      view({ session: { has_replay: true } }),
    ];
    expect(replayOfViews(some)).toEqual({ views: 3, hasReplay: true, records: 12 });
    // The search API does not always return the record count.
    expect(replayOfViews([view({ session: { has_replay: true } })])).toEqual({ views: 1, hasReplay: true, records: null });
  });

  it('gives the verdict when the device log showed no upload', () => {
    expect(serverVerdict({ views: 6, hasReplay: true, records: null })).toBe('recorded (from the servers)');
    expect(serverVerdict({ views: 6, hasReplay: false, records: null })).toBe('not recorded (from the servers)');
    expect(serverVerdict(undefined)).toMatch(/^probe broken/);
  });
});
