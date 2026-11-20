import { stringifyTags, type TagValue } from './config';

let tags: Record<string, string> = {};

/**
 * Config tags are the base, not a reset: shared code can call setTags()
 * before init() runs, and an explicit setTags() wins on a key both set.
 */
export function initTags(base: Record<string, string>) {
  tags = { ...base, ...tags };
}

export function setTags(next: Record<string, TagValue>) {
  tags = { ...tags, ...stringifyTags(next) };
}

export function removeTag(key: string) {
  if (!(key in tags)) return;
  const copy = { ...tags };
  delete copy[key];
  tags = copy;
}

export function getTags(): Record<string, string> {
  return tags;
}

export function resetTags() {
  tags = {};
}
