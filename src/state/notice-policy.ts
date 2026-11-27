import type { Notice } from "./store";

/*
 * How long a notice stays on screen (audit F16: warnings piled up over the reader and never left).
 * An error, and a notice that offers an action, stay until the user closes or uses them; a warning
 * or a notice with details fades after a longer read; anything else after a short one. The screen
 * holds the timer while the pointer or focus is on the notice, or its details are open.
 */
export const NOTICE_SHORT_MS = 5_000;
export const NOTICE_LONG_MS = 15_000;
/** notices shown at once: the newest, on one line (V5 UX audit U18); older ones fold into "N more" */
export const NOTICES_SHOWN = 1;

/** `sticky`: stays until closed although it is not an error — the reason a file did not open must not fade before it is read (#41 B24) */
export function noticeLifetimeMs(n: Pick<Notice, "kind" | "details" | "action" | "sticky">): number | null {
  if (n.kind === "error" || n.action || n.sticky) return null;
  return n.kind === "warning" || n.details ? NOTICE_LONG_MS : NOTICE_SHORT_MS;
}
