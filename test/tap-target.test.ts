import { describe, expect, it } from 'vitest';
import { collectText, componentName, resolveTapTarget, type FiberLike } from '../src/events/tap-target';

const opts = { actionNameAttribute: 'oodle-action-name', useAccessibilityLabel: true };

/** Builds a chain of fibers, outermost first, and links parents and children. */
function chain(...nodes: FiberLike[]): FiberLike[] {
  for (let i = 1; i < nodes.length; i++) {
    nodes[i].return = nodes[i - 1];
    nodes[i - 1].child = nodes[i];
  }
  return nodes;
}

function Header() {}
// React Native's shape: memo(forwardRef(fn)), with displayName on the memo.
const PressableInner = { $$typeof: 'forwardRef', render: function minified() {} };
const PressableMemo = { $$typeof: 'memo', type: PressableInner, displayName: 'Pressable' };
const noop = () => {};

/** The two fibers React makes for a memo(forwardRef) element. */
function pressable(props: Record<string, unknown>): FiberLike[] {
  return [
    { type: PressableMemo, memoizedProps: props },
    { type: PressableInner, memoizedProps: props },
  ];
}

describe('resolveTapTarget', () => {
  it('names a Pressable by its accessibility label', () => {
    const nodes = chain(
      { type: Header, memoizedProps: {} },
      ...pressable({ onPress: noop, accessibilityLabel: 'Notifications, 1 unread' }),
      { type: 'RCTView', memoizedProps: {} },
      { type: 'RCTView', memoizedProps: {} },
    );
    const host = nodes[nodes.length - 1];
    const t = resolveTapTarget(host, opts)!;
    expect(t.name).toBe('Pressable ("Notifications, 1 unread")');
    expect(t.component).toBe('Pressable');
    expect(t.path).toContain('Header');
  });

  it('uses the text inside the button when there is no label', () => {
    const textHost: FiberLike = { type: 'RCTText', memoizedProps: { children: 'Save' } };
    const textLeaf: FiberLike = { tag: 6, memoizedProps: 'Save draft' };
    const [, , view] = chain(
      { type: function TouchableOpacity() {}, memoizedProps: { onPress: noop } },
      { type: 'RCTView', memoizedProps: {} },
      textHost,
      textLeaf,
    );
    const t = resolveTapTarget(view, opts)!;
    expect(t.name).toBe('TouchableOpacity ("Save draft")');
  });

  it('prefers the action name attribute, even on a wrapper above', () => {
    const nodes = chain(
      { type: function Card() {}, memoizedProps: { 'oodle-action-name': 'Open order' } },
      ...pressable({ onPress: noop, accessibilityLabel: 'FW-1042' }),
      { type: 'RCTView', memoizedProps: {} },
    );
    const host = nodes[nodes.length - 1];
    expect(resolveTapTarget(host, opts)!.name).toBe('Open order');
  });

  it('skips the accessibility label when told to', () => {
    const nodes = chain(
      ...pressable({ onPress: noop, accessibilityLabel: 'secret' }),
      { type: 'RCTView', memoizedProps: {} },
    );
    const host = nodes[nodes.length - 1];
    expect(resolveTapTarget(host, { ...opts, useAccessibilityLabel: false })!.name).toBe('Pressable');
  });

  it('ignores taps on views that do not respond', () => {
    const [, host] = chain({ type: function Screen() {}, memoizedProps: {} }, { type: 'RCTView', memoizedProps: {} });
    expect(resolveTapTarget(host, opts)).toBeNull();
    expect(resolveTapTarget(null, opts)).toBeNull();
  });

  it('survives cycles and odd props', () => {
    const a: FiberLike = { type: 'RCTView', memoizedProps: null };
    a.return = a;
    expect(resolveTapTarget(a, opts)).toBeNull();
  });
});

describe('helpers', () => {
  it('reads component names from memo and forwardRef wrappers', () => {
    expect(componentName({ type: { render: function Inner() {} } })).toBe('Inner');
    expect(componentName({ displayName: 'Shown' })).toBe('Shown');
    expect(componentName(undefined)).toBe('');
  });

  it('limits collected text', () => {
    const root: FiberLike = {};
    let prev: FiberLike = root;
    for (let i = 0; i < 100; i++) {
      const leaf: FiberLike = { memoizedProps: 'word' + i };
      if (prev === root) root.child = leaf;
      else prev.sibling = leaf;
      prev = leaf;
    }
    expect(collectText(root).length).toBeLessThanOrEqual(100);
  });
});
