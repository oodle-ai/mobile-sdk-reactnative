// Helpers shared by the scripts that check what the mock collector wrote
// (check-collector.mjs, check-scenarios.mjs), so both read the files and
// report results the same way.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

/** The value after `--<name>` on the command line, or `fallback`. */
export const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);

export const flag = (name) => args.includes(`--${name}`);

/** The collector output directory, from `--out`. */
export const outDir = () => path.resolve(opt('out', '.collector'));

/** The lines of an NDJSON file as objects; an empty list when it does not exist. */
export function readNdjson(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const failures = [];

/** Prints one result line and remembers a failure for `finish()`. */
export function check(ok, message) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
}

/** Ends the process with status 1 when a check failed. */
export function finish(what = 'check') {
  if (failures.length) {
    console.error(`\n${failures.length} ${what}(s) failed`);
    process.exit(1);
  }
  console.log(`\nall ${what}s passed`);
}
