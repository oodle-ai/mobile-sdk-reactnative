/** The screen on display. Kept apart from views.ts so the event context can read it without an import cycle. */
export interface ViewInfo {
  id: string;
  key: string;
  name: string;
  url: string;
  path: string;
}

let current: ViewInfo | null = null;
let previousName = '';

export function setCurrentViewInfo(next: ViewInfo | null) {
  if (current && next && current.id !== next.id) previousName = current.name;
  current = next;
}

export function getCurrentViewInfo(): ViewInfo | null {
  return current;
}

/** The screen shown before the current one (`app.screen.previous.name`). */
export function getPreviousScreenName(): string {
  return previousName;
}

export function resetViewInfo() {
  current = null;
  previousName = '';
}
