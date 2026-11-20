#!/usr/bin/env node
// Uploads the files Oodle needs to turn release stack traces back into
// source locations: the JS source map of the Hermes bundle, and the R8
// mapping of the Android build. Run it after each release build, with the
// same service, version and build that the app sends.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';

const USAGE = `Usage:
  oodle-rum-upload --service <name> --version <version> [--build <build>]
                   (--sourcemap <file.map> --bundle <bundle name> | --r8-mapping <mapping.txt>)

Connection (flags or environment variables):
  --api-url   OODLE_API_URL    Oodle API URL, for example https://<instance>.api.oodle.ai
  --instance  OODLE_INSTANCE   Oodle instance ID
  --api-key   OODLE_API_KEY    API key that can write RUM settings (not the RUM ingest key)

Bundle names: index.android.bundle (Android), main.jsbundle (iOS).`;

function fail(message) {
  console.error(`oodle-rum-upload: ${message}\n\n${USAGE}`);
  process.exit(2);
}

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      'api-url': { type: 'string' },
      instance: { type: 'string' },
      'api-key': { type: 'string' },
      service: { type: 'string' },
      version: { type: 'string' },
      build: { type: 'string' },
      sourcemap: { type: 'string' },
      bundle: { type: 'string' },
      'r8-mapping': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (e) {
  fail(e.message);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const apiUrl = (args['api-url'] ?? process.env.OODLE_API_URL ?? '').replace(/\/+$/, '');
const instance = args.instance ?? process.env.OODLE_INSTANCE ?? '';
const apiKey = args['api-key'] ?? process.env.OODLE_API_KEY ?? '';
if (!apiUrl || !instance || !apiKey) fail('--api-url, --instance and --api-key are required');
if (!args.service || !args.version) fail('--service and --version are required');
if (!args.sourcemap === !args['r8-mapping']) fail('give either --sourcemap or --r8-mapping');

async function upload({ kind, fileName, minifiedUrl, data }) {
  const form = new FormData();
  form.set('service', args.service);
  form.set('version', args.version);
  if (args.build) form.set('build', args.build);
  form.set('kind', kind);
  form.set('minified_url', minifiedUrl);
  form.set('file', new Blob([data]), fileName);
  const url = `${apiUrl}/v1/api/instance/${encodeURIComponent(instance)}/rum/source-maps`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'X-OODLE-INSTANCE': instance },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`oodle-rum-upload: HTTP ${res.status}: ${text.slice(0, 500)}`);
    process.exit(1);
  }
  console.log(`Uploaded ${fileName} (${kind}) for ${args.service} ${args.version}${args.build ? ` build ${args.build}` : ''}`);
}

if (args.sourcemap) {
  if (!args.bundle) fail('--bundle is required with --sourcemap');
  let map;
  try {
    map = JSON.parse(await readFile(args.sourcemap, 'utf8'));
  } catch (e) {
    fail(`cannot read the source map: ${e.message}`);
  }
  if (map.version !== 3 || typeof map.mappings !== 'string') fail('the file is not a version 3 source map');
  // Stack frames name the bundle file, so the map must name it too.
  map.file = args.bundle;
  await upload({
    kind: 'sourcemap',
    fileName: `${basename(args.bundle)}.map`,
    minifiedUrl: args.bundle,
    data: JSON.stringify(map),
  });
} else {
  let data;
  try {
    data = await readFile(args['r8-mapping']);
  } catch (e) {
    fail(`cannot read the mapping file: ${e.message}`);
  }
  await upload({ kind: 'r8-mapping', fileName: 'mapping.txt', minifiedUrl: 'mapping.txt', data });
}
