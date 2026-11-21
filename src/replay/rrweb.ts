/**
 * Turns native wireframe snapshots into rrweb events, so the replay player
 * that plays browser sessions plays mobile sessions without change.
 *
 * Each wireframe becomes one absolutely positioned <div> under <body>, in
 * draw order. The picture of a vector drawing is a child <div> of its own,
 * so a drawing that moves changes only the style of its parent, and the
 * picture is sent again only when it changes. The first snapshot is an rrweb full snapshot. Later snapshots
 * are compared with the one before and sent as a mutation: removed views,
 * added views, changed styles and changed text.
 */
import type { TextAndInputPrivacy } from '../core/config';

/**
 * s: a painted box, t: text, i: an image, v: a vector drawing, in: an
 * input, p: a platform view, h: hidden, sw: a switch, wv: a web view.
 */
export type WireframeKind = 's' | 't' | 'i' | 'v' | 'in' | 'p' | 'h' | 'sw' | 'wv';

export interface Wireframe {
  /** Stable for the life of the native view. */
  id: number;
  k: WireframeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Insets (top, right, bottom, left) that a clipping parent hides. */
  c?: [number, number, number, number];
  bg?: string;
  bc?: string;
  bw?: number;
  r?: number;
  o?: number;
  tx?: string;
  /** Hint shown by an empty text input. */
  ph?: string;
  tc?: string;
  fs?: number;
  fw?: number;
  /** Letter spacing, in dp. */
  ls?: number;
  /** Line height, in dp. */
  lh?: number;
  /**
   * The text holds the device's line breaks: the replay draws those lines
   * and does not wrap them again, in a font that is not the device's.
   */
  ln?: boolean;
  ta?: 'left' | 'center' | 'right';
  /** The picture of a vector drawing, as a data URL. */
  img?: string;
  /** Switch state. */
  on?: boolean;
  /** Privacy override from an OodlePrivacy wrapper. */
  pv?: 'mask' | 'allow';
  /** Password, email, phone and similar inputs. */
  sen?: boolean;
}

export interface WireframeSnapshot {
  width: number;
  height: number;
  nodes: Wireframe[];
  /**
   * The walk stopped early (its time budget or the node limit), so the
   * views after the last node are missing, not removed.
   */
  truncated?: boolean;
}

// rrweb constants (rrweb 2.x, @rrweb/types).
export const EventType = { FullSnapshot: 2, IncrementalSnapshot: 3, Meta: 4 } as const;
export const IncrementalSource = {
  Mutation: 0,
  MouseMove: 1,
  MouseInteraction: 2,
  ViewportResize: 4,
  TouchMove: 6,
} as const;
export const MouseInteraction = { Click: 2, TouchStart: 7, TouchEnd: 9 } as const;
const NodeType = { Document: 0, DocumentType: 1, Element: 2, Text: 3 } as const;

export interface RRWebEvent {
  type: number;
  data: Record<string, unknown>;
  timestamp: number;
}

interface SerializedNode {
  type: number;
  id: number;
  tagName?: string;
  attributes?: Record<string, string>;
  childNodes?: SerializedNode[];
  textContent?: string;
  name?: string;
  publicId?: string;
  systemId?: string;
}

const DOCUMENT_ID = 1;
const DOCTYPE_ID = 2;
const HTML_ID = 3;
const HEAD_ID = 4;
export const BODY_ID = 5;
const FIRST_NODE_ID = 6;

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

export interface PrivacyOptions {
  textAndInputPrivacy: TextAndInputPrivacy;
}

interface Rendered {
  nid: number;
  kind: WireframeKind;
  style: string;
  text: string | null;
  /** The picture of a vector drawing, as a PNG data URL. */
  img: string | null;
}

interface Tracked extends Rendered {
  rid: number;
  tid: number | null;
  /** The id of the picture child. */
  pid: number | null;
}

const PNG_DATA_URL = 'data:image/png;base64,';

/**
 * Characters of new pictures in one snapshot or mutation. The pictures
 * after the budget wait for the next capture, so one event does not carry
 * megabytes of pictures. One picture is always sent, whatever its size.
 */
export const PICTURE_BUDGET_CHARS = 256_000;

/** The picture of a wireframe, and only a PNG data URL. */
function pictureOf(w: Wireframe): string | null {
  return w.k === 'v' && typeof w.img === 'string' && w.img.startsWith(PNG_DATA_URL) ? w.img : null;
}

/** The style of the picture child, which fills its parent. */
export function pictureStyle(img: string): string {
  return [
    'width:100%',
    'height:100%',
    `background-image:url(${img})`,
    'background-size:100% 100%',
    'background-repeat:no-repeat',
  ].join(';');
}

function px(n: number): string {
  return `${Math.round(n * 10) / 10}px`;
}

function maskText(s: string): string {
  return s.replace(/[^\s]/g, 'x');
}

/** Applies the privacy level to the text a wireframe would show. */
export function visibleText(w: Wireframe, privacy: PrivacyOptions): string | null {
  const level = privacy.textAndInputPrivacy;
  if (w.k === 't') {
    const text = w.tx ?? '';
    if (!text) return null;
    const masked = w.pv === 'mask' || (level === 'mask-all' && w.pv !== 'allow');
    return masked ? maskText(text) : text;
  }
  if (w.k === 'in') {
    const value = w.tx ?? '';
    if (value) {
      // A sensitive field is masked at every level, allow included.
      const masked =
        w.sen === true ||
        w.pv === 'mask' ||
        (level !== 'mask-sensitive-inputs' && w.pv !== 'allow');
      return masked ? '***' : value;
    }
    const hint = w.ph ?? '';
    if (!hint) return null;
    const maskHint = w.pv === 'mask' || (level === 'mask-all' && w.pv !== 'allow');
    return maskHint ? maskText(hint) : hint;
  }
  if (w.k === 'h') return 'Hidden';
  if (w.k === 'wv') return 'Web view';
  return null;
}

export function styleFor(w: Wireframe): string {
  const parts = [
    'position:absolute',
    `left:${px(w.x)}`,
    `top:${px(w.y)}`,
    `width:${px(w.w)}`,
    `height:${px(w.h)}`,
    'box-sizing:border-box',
    'margin:0',
  ];
  if (w.o !== undefined && w.o < 1) parts.push(`opacity:${Math.round(w.o * 100) / 100}`);
  if (w.r) parts.push(`border-radius:${px(w.r)}`);
  if (w.c) {
    const [t, r, b, l] = w.c;
    parts.push(`clip-path:inset(${px(t)} ${px(r)} ${px(b)} ${px(l)})`);
  }
  switch (w.k) {
    case 'i':
      parts.push('background-color:rgba(127,127,127,0.25)');
      break;
    case 'v':
      // A child draws the picture (pictureStyle); without one, a placeholder.
      if (!pictureOf(w)) parts.push('background-color:rgba(127,127,127,0.25)');
      break;
    case 'p':
    case 'h':
    case 'wv':
      parts.push(
        'background-color:rgba(127,127,127,0.18)',
        'border:1px dashed rgba(127,127,127,0.6)',
        'color:rgba(80,80,80,0.9)',
        'font-size:11px',
        `font-family:${FONT}`,
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'overflow:hidden',
      );
      break;
    case 'sw':
      parts.push(
        `background-color:${w.on ? (w.bg ?? '#34c759') : '#c7c7cc'}`,
        `border-radius:${px(w.h / 2)}`,
      );
      break;
    default:
      if (w.bg) parts.push(`background-color:${w.bg}`);
  }
  if ((w.k === 's' || w.k === 't' || w.k === 'in') && w.bw && w.bw > 0) {
    parts.push(`border:${px(w.bw)} solid ${w.bc ?? 'transparent'}`);
  }
  if (w.k === 't' || w.k === 'in') {
    const align = w.ta ?? 'left';
    parts.push(
      `color:${w.tc ?? '#000000'}`,
      `font-size:${px(w.fs ?? 14)}`,
      `font-weight:${w.fw ?? 400}`,
      `font-family:${FONT}`,
      `text-align:${align}`,
      `line-height:${w.lh ? px(w.lh) : '1.2'}`,
    );
    if (w.ls) parts.push(`letter-spacing:${px(w.ls)}`);
    if (w.ln && w.k === 't') {
      // The device's lines, as it drew them. The browser's font is a
      // little wider or narrower, so a line may overhang its box; a clip
      // would cut its last letters ("Offic").
      parts.push('white-space:pre', 'overflow:visible');
    } else {
      parts.push('white-space:pre-wrap', 'overflow:hidden', 'word-break:break-word');
    }
    if (w.k === 'in') {
      parts.push(
        'display:flex',
        'align-items:center',
        `justify-content:${align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start'}`,
        'padding:0 4px',
      );
      if (!w.tx && w.ph) parts.push('opacity:0.6');
    }
  }
  return parts.join(';');
}

export function bodyStyle(width: number, height: number): string {
  return [
    'margin:0',
    'padding:0',
    'position:relative',
    'overflow:hidden',
    `width:${px(width)}`,
    `height:${px(height)}`,
    'background-color:#ffffff',
  ].join(';');
}

/** The wireframes that draw, each id once. */
function drawn(snapshot: WireframeSnapshot): Wireframe[] {
  const out: Wireframe[] = [];
  const seen = new Set<number>();
  for (const w of snapshot.nodes) {
    if (!w || typeof w.id !== 'number' || seen.has(w.id)) continue;
    if (!(w.w > 0 && w.h > 0)) continue;
    seen.add(w.id);
    out.push(w);
  }
  return out;
}

function pictureNode(id: number, img: string): SerializedNode {
  return {
    type: NodeType.Element,
    tagName: 'div',
    attributes: { style: pictureStyle(img) },
    childNodes: [],
    id,
  };
}

export interface DiffResult {
  /** True when the result is a full snapshot rather than a mutation. */
  full: boolean;
  events: RRWebEvent[];
}

export class WireframeRecorder {
  private nextId = FIRST_NODE_ID;
  private tracked = new Map<number, Tracked>();
  private order: number[] = [];
  private width = 0;
  private height = 0;
  private hasFull = false;
  private deferred = false;

  constructor(private privacy: PrivacyOptions) {}

  /**
   * True when the last snapshot left pictures for later (PICTURE_BUDGET_CHARS).
   * The next capture must then not skip an unchanged screen.
   */
  get hasDeferredPictures(): boolean {
    return this.deferred;
  }

  setPrivacy(p: PrivacyOptions) {
    this.privacy = p;
  }

  /** Forgets the screen so the next snapshot is a full one. */
  reset() {
    this.tracked.clear();
    this.order = [];
    this.hasFull = false;
  }

  get initialized(): boolean {
    return this.hasFull;
  }

  private alloc(): number {
    return this.nextId++;
  }

  /**
   * The element of a view and its children. A full snapshot nests the
   * children in the element. A mutation must add each child on its own:
   * rrweb builds an added node without its childNodes.
   */
  private serialize(r: Rendered): { node: SerializedNode; children: SerializedNode[]; tracked: Tracked } {
    const rid = this.alloc();
    const pid = r.img !== null ? this.alloc() : null;
    const tid = r.text !== null ? this.alloc() : null;
    const children: SerializedNode[] = [];
    if (pid !== null) children.push(pictureNode(pid, r.img ?? ''));
    if (tid !== null) children.push({ type: NodeType.Text, textContent: r.text ?? '', id: tid });
    const node: SerializedNode = {
      type: NodeType.Element,
      tagName: 'div',
      attributes: { style: r.style },
      childNodes: [],
      id: rid,
    };
    return { node, children, tracked: { ...r, rid, tid, pid } };
  }

  /**
   * Returns the events for this snapshot: a Meta event and a full snapshot
   * when `forceFull` is set, nothing is recorded yet, or the screen size or
   * draw order changed; otherwise one mutation, or none when nothing changed.
   *
   * A truncated snapshot holds the first views in draw order only. Views
   * that it does not reach stay as they are: they are not removed, or the
   * replay would show them gone and back again on the next snapshot.
   */
  apply(
    snapshot: WireframeSnapshot,
    timestamp: number,
    href: string,
    forceFull = false,
  ): DiffResult {
    const partial = snapshot.truncated === true;
    const nodes = drawn(snapshot);
    const sizeChanged = snapshot.width !== this.width || snapshot.height !== this.height;
    const full = forceFull || !this.hasFull || sizeChanged || this.orderChanged(nodes);
    const rendered = this.render(nodes, full);
    if (full) {
      const events: RRWebEvent[] = [];
      if (this.hasFull && sizeChanged) {
        events.push({
          type: EventType.IncrementalSnapshot,
          data: {
            source: IncrementalSource.ViewportResize,
            width: snapshot.width,
            height: snapshot.height,
          },
          timestamp,
        });
      }
      events.push(...this.full(snapshot, rendered, timestamp, href));
      return { full: true, events };
    }
    const mutation = this.diff(rendered, partial);
    if (!mutation) return { full: false, events: [] };
    return {
      full: false,
      events: [
        {
          type: EventType.IncrementalSnapshot,
          data: { source: IncrementalSource.Mutation, ...mutation },
          timestamp,
        },
      ],
    };
  }

  /**
   * Applies the privacy level and the picture budget. A picture over the
   * budget is left for the next capture: the view keeps the picture it
   * has in the replay, or none.
   */
  private render(nodes: Wireframe[], full: boolean): Rendered[] {
    let spent = 0;
    this.deferred = false;
    return nodes.map((w) => {
      let img = pictureOf(w);
      const before = full ? null : (this.tracked.get(w.id)?.img ?? null);
      if (img !== null && img !== before) {
        if (spent > 0 && spent + img.length > PICTURE_BUDGET_CHARS) {
          img = before;
          this.deferred = true;
        } else {
          spent += img.length;
        }
      }
      const shown = img === pictureOf(w) ? w : { ...w, img: img ?? undefined };
      return { nid: w.id, kind: w.k, style: styleFor(shown), text: visibleText(w, this.privacy), img };
    });
  }

  private orderChanged(next: Wireframe[]): boolean {
    const nextIds = new Set(next.map((w) => w.id));
    const prevCommon = this.order.filter((id) => nextIds.has(id));
    let i = 0;
    for (const w of next) {
      if (!this.tracked.has(w.id)) continue;
      if (prevCommon[i] !== w.id) return true;
      i++;
    }
    return false;
  }

  private full(
    snapshot: WireframeSnapshot,
    rendered: Rendered[],
    timestamp: number,
    href: string,
  ): RRWebEvent[] {
    this.tracked.clear();
    this.order = [];
    const children: SerializedNode[] = [];
    for (const r of rendered) {
      const { node, children: own, tracked } = this.serialize(r);
      node.childNodes = own;
      children.push(node);
      this.tracked.set(r.nid, tracked);
      this.order.push(r.nid);
    }
    this.width = snapshot.width;
    this.height = snapshot.height;
    this.hasFull = true;
    const doc: SerializedNode = {
      type: NodeType.Document,
      id: DOCUMENT_ID,
      childNodes: [
        { type: NodeType.DocumentType, name: 'html', publicId: '', systemId: '', id: DOCTYPE_ID },
        {
          type: NodeType.Element,
          tagName: 'html',
          attributes: {},
          id: HTML_ID,
          childNodes: [
            { type: NodeType.Element, tagName: 'head', attributes: {}, childNodes: [], id: HEAD_ID },
            {
              type: NodeType.Element,
              tagName: 'body',
              attributes: { style: bodyStyle(snapshot.width, snapshot.height) },
              childNodes: children,
              id: BODY_ID,
            },
          ],
        },
      ],
    };
    return [
      {
        type: EventType.Meta,
        data: { href, width: Math.round(snapshot.width), height: Math.round(snapshot.height) },
        timestamp,
      },
      {
        type: EventType.FullSnapshot,
        data: { node: doc, initialOffset: { top: 0, left: 0 } },
        timestamp,
      },
    ];
  }

  private diff(next: Rendered[], partial: boolean): Record<string, unknown[]> | null {
    const removes: Array<{ parentId: number; id: number }> = [];
    const adds: Array<{ parentId: number; nextId: number | null; node: SerializedNode }> = [];
    const attributes: Array<{ id: number; attributes: Record<string, string> }> = [];
    const texts: Array<{ id: number; value: string }> = [];

    const nextIds = new Set(next.map((r) => r.nid));
    // A truncated walk reached the views up to the last one it shares
    // with the screen before. A view before that one that it did not
    // find is gone. Views after it were not reached, and are kept.
    let reached = this.order.length - 1;
    if (partial) {
      reached = -1;
      this.order.forEach((id, i) => {
        if (nextIds.has(id)) reached = i;
      });
    }
    const kept: number[] = [];
    this.order.forEach((id, i) => {
      if (nextIds.has(id)) return;
      if (i > reached) {
        kept.push(id);
        return;
      }
      const t = this.tracked.get(id)!;
      removes.push({ parentId: BODY_ID, id: t.rid });
      this.tracked.delete(id);
    });
    // Kept views are after all views of this snapshot in the DOM.
    const firstKept = kept.length > 0 ? this.tracked.get(kept[0])!.rid : null;

    // A view whose kind changed is replaced, not edited.
    for (const r of next) {
      const t = this.tracked.get(r.nid);
      if (t && t.kind !== r.kind) {
        removes.push({ parentId: BODY_ID, id: t.rid });
        this.tracked.delete(r.nid);
      }
    }

    // Adds go last to first, so each one's next sibling is already in place.
    for (let i = next.length - 1; i >= 0; i--) {
      const r = next[i];
      if (this.tracked.has(r.nid)) continue;
      const following = i + 1 < next.length ? this.tracked.get(next[i + 1].nid) : undefined;
      const { node, children, tracked } = this.serialize(r);
      adds.push({ parentId: BODY_ID, nextId: following ? following.rid : firstKept, node });
      for (const child of children) adds.push({ parentId: tracked.rid, nextId: null, node: child });
      this.tracked.set(r.nid, tracked);
    }

    for (const r of next) {
      const t = this.tracked.get(r.nid)!;
      if (t.style !== r.style) {
        attributes.push({ id: t.rid, attributes: { style: r.style } });
        t.style = r.style;
      }
      if (t.text === r.text) continue;
      if (t.tid !== null && r.text !== null) {
        texts.push({ id: t.tid, value: r.text });
      } else if (t.tid !== null) {
        removes.push({ parentId: t.rid, id: t.tid });
        t.tid = null;
      } else if (r.text !== null) {
        const tid = this.alloc();
        adds.push({
          parentId: t.rid,
          nextId: null,
          node: { type: NodeType.Text, textContent: r.text, id: tid },
        });
        t.tid = tid;
      }
      t.text = r.text;
    }

    for (const r of next) {
      const t = this.tracked.get(r.nid)!;
      if (t.img === r.img) continue;
      if (t.pid !== null && r.img !== null) {
        attributes.push({ id: t.pid, attributes: { style: pictureStyle(r.img) } });
      } else if (t.pid !== null) {
        removes.push({ parentId: t.rid, id: t.pid });
        t.pid = null;
      } else if (r.img !== null) {
        // The picture goes before the text, as in a full snapshot.
        const pid = this.alloc();
        adds.push({ parentId: t.rid, nextId: t.tid, node: pictureNode(pid, r.img) });
        t.pid = pid;
      }
      t.img = r.img;
    }

    this.order = next.map((r) => r.nid).concat(kept);
    if (!removes.length && !adds.length && !attributes.length && !texts.length) return null;
    return { texts, attributes, removes, adds };
  }
}
