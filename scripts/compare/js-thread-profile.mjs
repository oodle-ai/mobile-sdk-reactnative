#!/usr/bin/env node
// Summarizes the time on the React Native JS thread from macOS `sample`
// files of the iOS app (scripts/compare/soak.sh SAMPLE_DIR), per SDK. The
// cost run gives only the CPU time of the JS thread; this shows which
// native code runs on it. Hermes runs the JS itself, so its frames do not
// name the JS functions, but a synchronous call to native code (an SDK's
// module, a file write) shows with its name.
//
// Usage: js-thread-profile.mjs --dir <sample dir> [--top 12]
// The files are named <scenario name>.txt, as soak-<provider>-<replay>-r<round>-<n>.txt.
// Prints a Markdown section.
import fs from 'node:fs';
import path from 'node:path';

const JS_THREAD = /: com\.facebook\.react\.(runtime\.)?JavaScript\s*$/;
const THREAD = /^\s{4}\d+ Thread_/;
// "    +   ! 1718 __CFRunLoopServiceMachPort  (in CoreFoundation) + 156  [0x...]"
const NODE = /^(\s{4}[ +!:|]*)(\d+) (.+?)  \(in ([^)]+)\)/;
// The JS thread waits for work here.
const IDLE = new Set(['__CFRunLoopServiceMachPort']);

/** The nodes of the JS thread of one sample file: {depth, count, symbol, image}. */
export function jsThreadNodes(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => THREAD.test(l) && JS_THREAD.test(l));
  if (start < 0) return null;
  const total = Number(lines[start].trim().split(' ')[0]);
  const nodes = [];
  for (let i = start + 1; i < lines.length && !THREAD.test(lines[i]); i++) {
    const m = NODE.exec(lines[i]);
    if (m) nodes.push({ depth: m[1].length, count: Number(m[2]), symbol: m[3].trim(), image: m[4] });
  }
  return { total, nodes };
}

/**
 * Busy samples and the samples of each frame, a frame counted once on a
 * path (recursion). A frame's samples include the frames it calls.
 */
export function summarize({ total, nodes }) {
  let idle = 0;
  const frames = new Map();
  const stack = [];
  for (const n of nodes) {
    while (stack.length && stack[stack.length - 1].depth >= n.depth) stack.pop();
    const onPath = stack.some((s) => s.symbol === n.symbol);
    stack.push(n);
    if (IDLE.has(n.symbol)) idle += n.count;
    if (onPath) continue;
    const key = `${n.symbol} (${n.image})`;
    frames.set(key, (frames.get(key) ?? 0) + n.count);
  }
  return { total, busy: total - idle, frames };
}

function providerOf(file) {
  return /^soak-([a-z]+)-/.exec(path.basename(file))?.[1] ?? 'unknown';
}

export function report(dir, top = 12) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort() : [];
  const byProvider = new Map();
  for (const f of files) {
    const parsed = jsThreadNodes(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!parsed) continue;
    const s = summarize(parsed);
    if (s.busy <= 0) continue;
    const p = byProvider.get(providerOf(f)) ?? { files: 0, shares: new Map() };
    p.files += 1;
    // The share of each frame in the busy samples of this launch. The
    // real rate of `sample` changes (in one run, 8378 and 135081 samples
    // in the same 19 s), so a launch gives shares, not times, and each
    // launch has the same weight.
    for (const [k, v] of s.frames) {
      if (v >= s.total) continue;
      p.shares.set(k, (p.shares.get(k) ?? 0) + Math.min(v, s.busy) / s.busy);
    }
    byProvider.set(providerOf(f), p);
  }
  const out = ['### JS thread samples (iOS)', ''];
  if (byProvider.size === 0) {
    out.push('No sample of the JS thread.');
    return out.join('\n') + '\n';
  }
  out.push(
    'From macOS `sample` during the walk, in a pass of its own after the cost rounds: the sampler slows the app, so these launches are not in the table above. The real rate of `sample` changes from launch to launch, so this section names the native code on the JS thread but does not measure its time: the CPU time of the JS thread is in the table above. Each row gives the mean share of a frame in the busy samples of a launch (samples not waiting for work); a frame includes the frames that it calls. Only frames of the app binary are listed: it includes the native code of the SDKs. The walk blocks the JS thread for 400 ms in `Date.now()` for the forced long task, with each SDK.',
  );
  const app = /^(OodleExample)$/;
  for (const [p, s] of byProvider) {
    const rows = [...s.shares]
      .filter(([k, v]) => v > 0 && app.test(/\(([^()]+)\)$/.exec(k)?.[1] ?? ''))
      .map(([k, v]) => [k, v / s.files])
      .sort((a, b) => b[1] - a[1])
      .slice(0, top);
    out.push('', `**${p}** (${s.files} launches): the frames of the app binary with the most samples`, '');
    if (rows.length === 0) {
      out.push('None.');
      continue;
    }
    out.push('| Share of busy | Frame |', '|---|---|');
    for (const [k, v] of rows) {
      const share = v * 100 >= 0.1 ? `${(v * 100).toFixed(1)}%` : '<0.1%';
      out.push(`| ${share} | \`${k.replace(/ \([^()]+\)$/, '').replace(/\|/g, '\\|').slice(0, 160)}\` |`);
    }
  }
  return out.join('\n') + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  process.stdout.write(report(arg('dir', '.'), Number(arg('top', 12))));
}
