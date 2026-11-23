// The fields that the Oodle collector stores (collector-fields.json). The
// collector drops a field that its schema does not name, so the SDK must
// send no other field. The mock collector (mock-collector.mjs) records
// the other fields of each upload, the device checks (scripts/ci/) fail
// on them, and test/sdk.test.ts checks the uploads of its run.
import fs from 'node:fs';

/**
 * The field names of each part of an upload: `header` (the first line),
 * `section` (the line before each section), and one list for each
 * section type (`events`, `replay`, `sdk_telemetry`).
 */
export const collectorFields = JSON.parse(fs.readFileSync(new URL('./collector-fields.json', import.meta.url), 'utf8'));

/** The keys of `objects` that `allowed` does not name, with how often each one occurs. */
export function unknownFields(objects, allowed) {
  const known = new Set(allowed);
  const found = {};
  for (const o of objects) {
    for (const key of Object.keys(o ?? {})) if (!known.has(key)) found[key] = (found[key] ?? 0) + 1;
  }
  return found;
}

/**
 * The fields of one Oodle upload that the collector does not store, by
 * part: { header: { field: count }, events: { ... }, ... }. Parts with no
 * such field are left out, so an empty object means a good upload.
 *
 * @param header the envelope header
 * @param sections [{ type, items, head? }]: `head` is the section line ({ type, count })
 */
export function unknownUploadFields(header, sections) {
  const found = {};
  const add = (part, fields) => {
    if (Object.keys(fields).length) found[part] = { ...found[part], ...fields };
  };
  add('header', unknownFields([header], collectorFields.header));
  for (const s of sections) {
    if (s.head) add('section', unknownFields([s.head], collectorFields.section));
    // A section type that the list does not name is dropped as a whole.
    if (Array.isArray(collectorFields[s.type]) && !['$comment', 'header', 'section'].includes(s.type)) {
      add(s.type, unknownFields(s.items, collectorFields[s.type]));
    } else {
      add('section', { [`type ${s.type}`]: 1 });
    }
  }
  return found;
}

/** One line for a report: "events.foo (3), header.bar (1)". */
export function describeUnknown(found) {
  return Object.entries(found)
    .flatMap(([part, fields]) => Object.entries(fields).map(([f, n]) => `${part}.${f} (${n})`))
    .join(', ');
}
