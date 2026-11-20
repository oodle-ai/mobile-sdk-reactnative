import type { TagValue } from './config';
import { removeTag, setTags } from './tags';

export interface UserInfo {
  id: string;
  name?: string;
  email?: string;
  /** Other user attributes. They are sent as `usr.<key>` tags. */
  [key: string]: TagValue | undefined;
}

let user: UserInfo | null = null;
let extraKeys: string[] = [];

export function setUser(next: UserInfo) {
  clearUser();
  user = { ...next };
  const extra: Record<string, TagValue> = {};
  for (const [k, v] of Object.entries(next)) {
    if (k === 'id' || k === 'name' || k === 'email') continue;
    if (v === undefined || v === null) continue;
    extra[`usr.${k}`] = v;
  }
  extraKeys = Object.keys(extra);
  setTags(extra);
}

export function clearUser() {
  user = null;
  for (const k of extraKeys) removeTag(k);
  extraKeys = [];
}

export function getUser(): UserInfo | null {
  return user;
}

export function userFields(): Record<string, string> {
  return {
    user_id: user?.id ? String(user.id) : '',
    user_name: user?.name ? String(user.name) : '',
    user_email: user?.email ? String(user.email) : '',
    user_status: user ? 'identified' : 'anonymous',
  };
}
