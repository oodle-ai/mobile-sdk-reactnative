// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Replayer } from 'rrweb';
import {
  BODY_ID,
  EventType,
  IncrementalSource,
  WireframeRecorder,
  styleFor,
  visibleText,
  type RRWebEvent,
  type Wireframe,
  type WireframeSnapshot,
} from '../src/replay/rrweb';

const W = 400;
const H = 800;

function snap(nodes: Wireframe[], width = W, height = H): WireframeSnapshot {
  return { width, height, nodes };
}

const root: Wireframe = { id: 1, k: 's', x: 0, y: 0, w: W, h: H, bg: '#ffffffff' };
const header: Wireframe = { id: 2, k: 's', x: 0, y: 0, w: W, h: 60, bg: '#1e3a5fff' };
const title: Wireframe = { id: 3, k: 't', x: 16, y: 16, w: 200, h: 24, tx: 'Inbox', tc: '#ffffffff', fs: 18, fw: 700 };
const input: Wireframe = { id: 4, k: 'in', x: 16, y: 100, w: 300, h: 40, tx: 'secret note', bg: '#eeeeeeff' };
const image: Wireframe = { id: 5, k: 'i', x: 16, y: 200, w: 100, h: 100 };

/** Plays the events with rrweb's own replayer and returns the body markup. */
function play(events: RRWebEvent[]): string {
  // jsdom does not implement scrolling, and rrweb scrolls the replay
  // iframe on every full snapshot; jsdom reports that through console.error.
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
  const container = document.createElement('div');
  document.body.appendChild(container);
  // jsdom has no iframe.sandbox, so rrweb's sandbox check cannot pass here.
  // UNSAFE_replayCanvas turns that check off; a browser does not need it.
  const replayer = new Replayer(events as never, {
    root: container,
    showWarning: false,
    mouseTail: false,
    UNSAFE_replayCanvas: true,
  });
  replayer.pause(events[events.length - 1].timestamp - events[0].timestamp + 1);
  const doc = replayer.iframe.contentDocument!;
  const html = doc.body.innerHTML;
  replayer.destroy();
  container.remove();
  quiet.mockRestore();
  return html;
}

function fullOnly(nodes: Wireframe[]): RRWebEvent[] {
  const r = new WireframeRecorder({ textAndInputPrivacy: 'mask-all-inputs' });
  return r.apply(snap(nodes), 1000, 'app://demo/Home').events;
}

/** Strips rrweb ids so two renders of the same screen compare equal. */
function normalize(html: string): string {
  return html.replace(/\s*rr_\w+="[^"]*"/g, '');
}

describe('WireframeRecorder', () => {
  it('starts with Meta and a full snapshot', () => {
    const r = new WireframeRecorder({ textAndInputPrivacy: 'mask-all-inputs' });
    const out = r.apply(snap([root, header, title]), 1000, 'app://demo/Home');
    expect(out.full).toBe(true);
    expect(out.events.map((e) => e.type)).toEqual([EventType.Meta, EventType.FullSnapshot]);
    expect(out.events[0].data).toEqual({ href: 'app://demo/Home', width: W, height: H });
  });

  it('sends nothing when the screen did not change', () => {
    const r = new WireframeRecorder({ textAndInputPrivacy: 'mask-all-inputs' });
    r.apply(snap([root, header, title]), 1000, 'h');
    expect(r.apply(snap([root, header, title]), 2000, 'h').events).toEqual([]);
  });

  it('sends a mutation for added, removed, restyled and retexted views', () => {
    const r = new WireframeRecorder({ textAndInputPrivacy: 'mask-all-inputs' });
    r.apply(snap([root, header, title, image]), 1000, 'h');
    const next = [
      root,
      { ...header, bg: '#000000ff' },
      { ...title, tx: 'Orders' },
      { id: 9, k: 's', x: 10, y: 10, w: 5, h: 5, bg: '#ff0000ff' } as Wireframe,
    ];
    const out = r.apply(snap(next), 2000, 'h');
    expect(out.full).toBe(false);
    expect(out.events).toHaveLength(1);
    const data = out.events[0].data as Record<string, unknown[]>;
    expect(data.source).toBe(IncrementalSource.Mutation);
    expect(data.removes).toHaveLength(1);
    expect(data.adds).toHaveLength(1);
    expect(data.attributes).toHaveLength(1);
    expect(data.texts).toEqual([expect.objectContaining({ value: 'Orders' })]);
    expect((data.adds[0] as { parentId: number }).parentId).toBe(BODY_ID);
  });

  it('replays a mutation chain to the same DOM as a fresh full snapshot', () => {
    const r = new WireframeRecorder({ textAndInputPrivacy: 'mask-all-inputs' });
    const steps: Wireframe[][] = [
      [root, header, title, input, image],
      [root, header, { ...title, tx: 'Orders (2)' }, input],
      [
        root,
        { ...header, bg: '#000000ff' },
        { ...title, tx: 'Orders (2)' },
        { id: 7, k: 't', x: 16, y: 300, w: 200, h: 20, tx: 'New row' },
        input,
        { id: 8, k: 'sw', x: 300, y: 300, w: 50, h: 30, on: true },
      ],
      [root, header, { id: 10, k: 't', x: 1, y: 1, w: 10, h: 10 }, { ...input, tx: '' , ph: 'Search' }],
    ];
    const events: RRWebEvent[] = [];
    steps.forEach((nodes, i) => events.push(...r.apply(snap(nodes), 1000 + i * 1000, 'h').events));
    expect(events.filter((e) => e.type === EventType.FullSnapshot)).toHaveLength(1);
    const replayed = normalize(play(events));
    const expected = normalize(play(fullOnly(steps[steps.length - 1])));
    expect(replayed).toContain('Search');
    expect(replayed.match(/<div/g)?.length).toBe(4);
    expect(replayed).toBe(expected);
  });

  // rrweb builds an added node without its childNodes.
  it('replays the text of a view added after the full snapshot', () => {
    const r = new WireframeRecorder({ textAndInputPrivacy: 'mask-all-inputs' });
    const row: Wireframe = { id: 12, k: 't', x: 16, y: 300, w: 200, h: 20, tx: 'New row' };
    const events = [
      ...r.apply(snap([root, header, title]), 1000, 'h').events,
      ...r.apply(snap([root, header, row, title]), 2000, 'h').events,
    ];
    const replayed = normalize(play(events));
    expect(replayed).toContain('New row');
    expect(replayed).toBe(normalize(play(fullOnly([root, header, row, title]))));
  });

  // A walk that ran out of time returns the first views in draw order only.
  it('keeps the views a truncated walk did not reach', () => {
    const r = new WireframeRecorder({ textAndInputPrivacy: 'mask-all-inputs' });
    const added: Wireframe = { id: 11, k: 't', x: 16, y: 70, w: 100, h: 20, tx: 'Added' };
    const steps: WireframeSnapshot[] = [
      snap([root, header, title, input, image]),
      // Changed views at the start; the rest was not reached.
      { ...snap([root, { ...header, bg: '#000000ff' }]), truncated: true },
      // A new view before the views that were not reached.
      { ...snap([root, header, added]), truncated: true },
      // The walk reached the input: the title before it is gone. The
      // image after it was not reached.
      { ...snap([root, header, added, { ...input, x: 20 }]), truncated: true },
    ];
    const events: RRWebEvent[] = [];
    steps.forEach((s, i) => events.push(...r.apply(s, 1000 + i * 1000, 'h').events));
    expect(events.filter((e) => e.type === EventType.FullSnapshot)).toHaveLength(1);
    const mutations = events.filter((e) => e.type === EventType.IncrementalSnapshot);
    const removes = mutations.map((e) => (e.data as { removes: unknown[] }).removes.length);
    // Only the title is removed, by the last snapshot.
    expect(removes).toEqual([0, 0, 1]);
    const replayed = normalize(play(events));
    const expected = normalize(play(fullOnly([root, header, added, { ...input, x: 20 }, image])));
    expect(replayed).toBe(expected);
    // A full walk removes what it does not find.
    const out = r.apply(snap([root, header]), 5000, 'h');
    expect((out.events[0].data as { removes: unknown[] }).removes).toHaveLength(3);
  });

  it('takes a new full snapshot when the screen is resized or reordered', () => {
    const r = new WireframeRecorder({ textAndInputPrivacy: 'mask-all-inputs' });
    r.apply(snap([root, header, title]), 1000, 'h');
    const resized = r.apply(snap([root, header, title], 800, 400), 2000, 'h');
    expect(resized.full).toBe(true);
    expect((resized.events[0].data as { source: number }).source).toBe(IncrementalSource.ViewportResize);
    const reordered = r.apply(snap([root, title, header], 800, 400), 3000, 'h');
    expect(reordered.full).toBe(true);
  });
});

describe('privacy', () => {
  const opts = (level: 'mask-sensitive-inputs' | 'mask-all-inputs' | 'mask-all') => ({ textAndInputPrivacy: level });

  it('masks input values by default and text only under mask-all', () => {
    expect(visibleText(input, opts('mask-all-inputs'))).toBe('***');
    expect(visibleText(title, opts('mask-all-inputs'))).toBe('Inbox');
    expect(visibleText(title, opts('mask-all'))).toBe('xxxxx');
    expect(visibleText(input, opts('mask-sensitive-inputs'))).toBe('secret note');
  });

  it('always masks sensitive inputs', () => {
    expect(visibleText({ ...input, sen: true }, opts('mask-sensitive-inputs'))).toBe('***');
    expect(visibleText({ ...input, sen: true, pv: 'allow' }, opts('mask-sensitive-inputs'))).toBe('***');
  });

  it('honours OodlePrivacy overrides', () => {
    expect(visibleText({ ...title, pv: 'allow' }, opts('mask-all'))).toBe('Inbox');
    expect(visibleText({ ...title, pv: 'mask' }, opts('mask-sensitive-inputs'))).toBe('xxxxx');
    expect(visibleText({ ...input, pv: 'allow' }, opts('mask-all-inputs'))).toBe('secret note');
  });

  it('never puts masked text into the events', () => {
    const r = new WireframeRecorder({ textAndInputPrivacy: 'mask-all' });
    const json = JSON.stringify(r.apply(snap([root, title, input]), 1, 'h').events);
    expect(json).not.toContain('Inbox');
    expect(json).not.toContain('secret');
  });
});

describe('styleFor', () => {
  const base = { id: 1, x: 0, y: 0, w: 40, h: 20 };

  it('draws the device lines of a text without wrapping or clipping them', () => {
    const style = styleFor({ ...base, k: 't', tx: 'Office', ln: true, lh: 21, ls: -0.8, fw: 600 });
    expect(style).toContain('white-space:pre');
    expect(style).toContain('overflow:visible');
    expect(style).toContain('line-height:21px');
    expect(style).toContain('letter-spacing:-0.8px');
    expect(style).toContain('font-weight:600');
    expect(style).not.toContain('pre-wrap');
  });

  it('wraps a text without device lines, as before', () => {
    const style = styleFor({ ...base, k: 't', tx: 'Office' });
    expect(style).toContain('white-space:pre-wrap');
    expect(style).toContain('overflow:hidden');
    expect(style).toContain('line-height:1.2');
  });

  it('draws the picture of a vector drawing, and only a PNG data URL', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(styleFor({ ...base, k: 'v', img: png })).toContain(`background-image:url(${png})`);
    expect(styleFor({ ...base, k: 'v', img: 'https://example.com/x.png' })).not.toContain('background-image');
    expect(styleFor({ ...base, k: 'v' })).toContain('background-color:rgba(127,127,127,0.25)');
  });
});
