/**
 * Finds what a tap hit by walking the React fiber tree from the touched
 * host view. React does not expose fibers as public API, so every field
 * read here is guarded, and a failure yields a generic name instead of an
 * exception.
 */

import { PRIVACY_NATIVE_ID_PREFIX, type PrivacyLevel } from '../core/privacy';

export interface FiberLike {
  tag?: number;
  type?: unknown;
  elementType?: unknown;
  memoizedProps?: unknown;
  return?: FiberLike | null;
  child?: FiberLike | null;
  sibling?: FiberLike | null;
}

export interface TapTarget {
  /** `Pressable ("Notifications, 1 unread")` */
  name: string;
  /** `Pressable` */
  component: string;
  /** `Notifications, 1 unread`, or empty */
  label: string;
  /** Component path above the target, outermost first. */
  path: string;
  /**
   * True when the target is inside a hidden or masked OodlePrivacy view.
   * The label is then empty, and the tap position must not be sent.
   */
  private: boolean;
}

export interface ResolveOptions {
  actionNameAttribute: string;
  useAccessibilityLabel: boolean;
  /**
   * The replay masks all text (`mask-all`). A label then comes only from
   * the action name attribute, as replay shows no text either.
   */
  maskText?: boolean;
}

const MAX_DEPTH = 40;
const MAX_TEXT_NODES = 40;
const MAX_LABEL_CHARS = 100;
/** An OodlePrivacy wrapper can be far above the button (a whole screen). */
const MAX_PRIVACY_DEPTH = 500;
const HANDLER_PROPS = ['onPress', 'onLongPress', 'onValueChange', 'onPressIn'];
const BUTTON_ROLES = new Set([
  'button',
  'link',
  'switch',
  'checkbox',
  'radio',
  'tab',
  'menuitem',
  'togglebutton',
  'imagebutton',
]);
/** Host component names that say nothing about what was tapped. */
const GENERIC_HOSTS = new Set(['RCTView', 'View', 'RCTText', 'Text', 'RCTScrollView', 'AndroidHorizontalScrollView']);

function props(f: FiberLike): Record<string, unknown> {
  const p = f.memoizedProps;
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
}

export function componentName(type: unknown): string {
  if (typeof type === 'string') return type;
  if (!type || (typeof type !== 'function' && typeof type !== 'object')) return '';
  const t = type as {
    displayName?: unknown;
    name?: unknown;
    render?: { displayName?: unknown; name?: unknown };
    type?: unknown;
  };
  if (typeof t.displayName === 'string' && t.displayName) return t.displayName;
  if (typeof t.name === 'string' && t.name) return t.name;
  if (t.render) {
    if (typeof t.render.displayName === 'string' && t.render.displayName) return t.render.displayName;
    if (typeof t.render.name === 'string' && t.render.name) return t.render.name;
  }
  if (t.type && t.type !== type) return componentName(t.type);
  return '';
}

function displayNameOf(type: unknown): string {
  if (!type || (typeof type !== 'function' && typeof type !== 'object')) return '';
  const d = (type as { displayName?: unknown }).displayName;
  return typeof d === 'string' ? d : '';
}

/**
 * Name of the component a fiber renders. `memo(forwardRef(Fn))` makes two
 * fibers that share one props object, and only the outer one may carry a
 * `displayName`. Release builds can rename functions, so a `displayName`
 * on any of the wrappers wins over a function name.
 */
export function fiberName(f: FiberLike): string {
  let fallback = '';
  let cur: FiberLike | null | undefined = f;
  for (let i = 0; cur && i < 4; i++) {
    const d = displayNameOf(cur.type) || displayNameOf(cur.elementType);
    if (d) return d;
    if (!fallback) fallback = componentName(cur.type) || componentName(cur.elementType);
    const parent: FiberLike | null | undefined = cur.return;
    if (!parent || parent.memoizedProps !== cur.memoizedProps) break;
    cur = parent;
  }
  return fallback;
}

function isPressable(f: FiberLike): boolean {
  const p = props(f);
  for (const h of HANDLER_PROPS) if (typeof p[h] === 'function') return true;
  const role = p.accessibilityRole ?? p.role;
  return typeof role === 'string' && BUTTON_ROLES.has(role) && typeof f.type !== 'string';
}

function hasHandler(f: FiberLike): boolean {
  const p = props(f);
  return HANDLER_PROPS.some((h) => typeof p[h] === 'function');
}

/**
 * The component that owns the press handler, from the fiber found
 * pressable up to a few levels above it: Pressable, TouchableOpacity,
 * Button, and so on, as the reference SDK names a tap. Pressable passes its role to
 * the View it renders, and that View is found first, so the name was
 * "View" for every Pressable.
 */
function handlerOwner(from: FiberLike): FiberLike {
  let f: FiberLike | null | undefined = from;
  for (let i = 0; f && i < 6; i++, f = f.return) {
    if (typeof f.type === 'string' || !hasHandler(f)) continue;
    const n = fiberName(f);
    if (n && !GENERIC_HOSTS.has(n)) return f;
  }
  return from;
}

/**
 * The level of the nearest OodlePrivacy view above a fiber, or null.
 * The nearest one wins, as in the native walkers.
 */
export function privacyLevelOf(start: FiberLike | null | undefined): PrivacyLevel | null {
  let f = start;
  for (let i = 0; f && i < MAX_PRIVACY_DEPTH; i++, f = f.return) {
    const id = props(f).nativeID;
    if (typeof id === 'string' && id.startsWith(PRIVACY_NATIVE_ID_PREFIX)) {
      const level = id.slice(PRIVACY_NATIVE_ID_PREFIX.length);
      if (level === 'hidden' || level === 'mask' || level === 'allow') return level;
    }
  }
  return null;
}

function stringProp(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

function clipLabel(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > MAX_LABEL_CHARS ? one.slice(0, MAX_LABEL_CHARS - 1) + '…' : one;
}

/** Text rendered under a fiber, in order, for a button without a label. */
export function collectText(root: FiberLike | null | undefined): string {
  if (!root) return '';
  const parts: string[] = [];
  const stack: FiberLike[] = root.child ? [root.child] : [];
  let visited = 0;
  while (stack.length > 0 && parts.length < MAX_TEXT_NODES && visited < 500) {
    const f = stack.pop()!;
    visited++;
    if (f.sibling) stack.push(f.sibling);
    const p = f.memoizedProps;
    // Host text fibers keep the string itself as their props.
    if (typeof p === 'string' || typeof p === 'number') {
      if (String(p).trim()) parts.push(String(p));
      continue;
    }
    if (f.child) stack.push(f.child);
  }
  return clipLabel(parts.join(' '));
}

export function resolveTapTarget(
  start: FiberLike | null | undefined,
  opts: ResolveOptions,
): TapTarget | null {
  if (!start) return null;
  let pressable: FiberLike | null = null;
  let explicitName = '';
  let a11yLabel = '';
  const names: string[] = [];
  // Levels walked above the button. The name attribute may sit on a
  // wrapper a little higher up, so the walk goes on for a few levels.
  let above = 0;
  let f: FiberLike | null | undefined = start;
  for (let depth = 0; f && depth < MAX_DEPTH; depth++, f = f.return) {
    const p = props(f);
    if (!explicitName) explicitName = stringProp(p, opts.actionNameAttribute);
    if (!pressable && opts.useAccessibilityLabel && !a11yLabel) {
      a11yLabel = stringProp(p, 'accessibilityLabel') || stringProp(p, 'aria-label');
    }
    if (!pressable && isPressable(f)) {
      pressable = f;
      // A button's own label beats one found on a child below it.
      if (opts.useAccessibilityLabel) {
        a11yLabel =
          stringProp(p, 'accessibilityLabel') || stringProp(p, 'aria-label') || a11yLabel;
      }
    }
    if (typeof f.type !== 'string') {
      const n = componentName(f.type);
      if (n && names.length < 6 && names[names.length - 1] !== n) names.push(n);
    }
    if (pressable && (explicitName || ++above > 3)) break;
  }

  const target = pressable ?? start;
  let component = fiberName(pressable ? handlerOwner(pressable) : target);
  if (!component || GENERIC_HOSTS.has(component)) {
    component = pressable ? component || 'Touchable' : 'View';
  }
  // A tap on something that does not respond to taps is not an action.
  if (!pressable && !explicitName) return null;
  const level = privacyLevelOf(target);
  const isPrivate = level === 'hidden' || level === 'mask';
  // Text the replay masks is not sent in the action name either. The
  // action name attribute is set by the app developer, so it is kept.
  const masked = isPrivate || (opts.maskText === true && level !== 'allow');
  const tp = props(target);
  const label = clipLabel(
    explicitName ||
      (masked
        ? ''
        : a11yLabel ||
          stringProp(tp, 'title') ||
          stringProp(tp, 'label') ||
          collectText(target)),
  );
  return {
    name: explicitName ? explicitName : label ? `${component} ("${label}")` : component,
    component,
    label,
    path: names.slice().reverse().join(' > '),
    private: isPrivate,
  };
}

/** Gets the fiber of the touched view from a React Native touch event. */
export function fiberFromEvent(event: unknown): FiberLike | null {
  if (!event || typeof event !== 'object') return null;
  const e = event as {
    _targetInst?: FiberLike;
    target?: { __internalInstanceHandle?: FiberLike; _internalFiberInstanceHandleDEV?: FiberLike };
  };
  if (e._targetInst) return e._targetInst;
  const t = e.target;
  if (t && typeof t === 'object') {
    return t.__internalInstanceHandle ?? t._internalFiberInstanceHandleDEV ?? null;
  }
  return null;
}
