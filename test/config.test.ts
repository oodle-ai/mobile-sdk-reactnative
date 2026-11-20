import { describe, expect, it } from 'vitest';
import { checkEndpoint, resolveConfig, toUrlTest, urlHost } from '../src/core/config';

const base = { instanceId: 'inst', apiKey: 'key', endpoint: 'https://x.collector.oodle.ai/', service: 'app' };

describe('resolveConfig', () => {
  it('applies defaults', () => {
    const { config } = resolveConfig(base, 'android');
    expect(config).toBeDefined();
    expect(config!.endpoint).toBe('https://x.collector.oodle.ai');
    expect(config!.trackingConsent).toBe('granted');
    expect(config!.replay).toMatchObject({
      enabled: true,
      sampleRate: 10,
      textAndInputPrivacy: 'mask-all-inputs',
      touchPrivacy: 'show',
      startRecordingImmediately: true,
    });
    expect(config!.anrThresholdMs).toBe(5000);
    expect(resolveConfig(base, 'ios').config!.anrThresholdMs).toBe(2000);
    expect(config!.longTaskThresholdMs).toBe(200);
  });

  it('requires the four identity fields', () => {
    for (const key of ['instanceId', 'apiKey', 'endpoint', 'service'] as const) {
      expect(resolveConfig({ ...base, [key]: '' }, 'android').error).toContain(key);
    }
  });

  it('clamps rates and stringifies tags', () => {
    const { config } = resolveConfig(
      { ...base, sessionSampleRate: 250, sessionReplay: { sampleRate: -3 }, tags: { a: 1, b: true } },
      'android',
    );
    expect(config!.sessionSampleRate).toBe(100);
    expect(config!.replay.sampleRate).toBe(0);
    expect(config!.tags).toEqual({ a: '1', b: 'true' });
  });

  it('turns replay off with false', () => {
    expect(resolveConfig({ ...base, sessionReplay: false }, 'android').config!.replay.enabled).toBe(false);
  });
});

describe('checkEndpoint', () => {
  it('accepts https and private http', () => {
    expect(checkEndpoint('https://a.oodle.ai')).toBeNull();
    expect(checkEndpoint('http://10.0.2.2:4318')).toBeNull();
    // A collector on a laptop in the same private network as a test phone.
    expect(checkEndpoint('http://192.168.0.10:4318')).toBeNull();
    expect(checkEndpoint('http://localhost:4318')).toBeNull();
  });
  it('rejects public http and non-URLs', () => {
    expect(checkEndpoint('http://a.oodle.ai')).toMatch(/https/);
    expect(checkEndpoint('a.oodle.ai')).toMatch(/http/);
  });
});

describe('tracing URL matchers', () => {
  it('matches a host and its subdomains', () => {
    const t = toUrlTest('api.example.com');
    expect(t('https://api.example.com/v1')).toBe(true);
    expect(t('https://eu.api.example.com/v1')).toBe(true);
    expect(t('https://notapi.example.com/v1')).toBe(false);
    expect(t('https://example.com/v1')).toBe(false);
  });
  it('matches URL prefixes, regexes and functions', () => {
    expect(toUrlTest('https://api.example.com:8443')('https://api.example.com:8443/api/trpc')).toBe(true);
    expect(toUrlTest('https://api.example.com:8443')('https://api.example.com/api/trpc')).toBe(false);
    expect(toUrlTest(/\/api\//)('http://h/api/x')).toBe(true);
    expect(toUrlTest(() => {
      throw new Error('x');
    })('http://h')).toBe(false);
  });
  it('parses hosts', () => {
    expect(urlHost('http://user@Host.Example:80/p?q')).toBe('host.example');
    expect(urlHost('http://[::1]:80/')).toBe('[::1]');
  });
});
