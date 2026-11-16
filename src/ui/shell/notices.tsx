import { useEffect, useRef, useState } from "preact/hooks";
import { noticeLifetimeMs, NOTICES_SHOWN } from "../../state/notice-policy";
import type { Notice } from "../../state/store";
import { useStore } from "../context";
import { Icon, type IconName } from "../icons/icon";
import { withFileNames } from "./file-name";

const ICON: Record<Notice["kind"], IconName> = { info: "fl_info", success: "fl_checkmark_circle", warning: "fl_warning", error: "fl_error_circle" };

/**
 * Short messages (state/notice-policy.ts), the owner's choice A for V5 UX audit U18: only the newest
 * notice, on one line; the rest fold into "עוד N" (which says when an error is among them). A long
 * notice is read by opening it — a click on its text, the pointer over it, or focus inside it (its
 * close button is a Tab stop) — and its details then show. Errors and notices with an action stay
 * until closed; the others fade on their own clock whether shown or folded, so a folded one does not
 * come back later as if it were new. The pointer or focus on a notice, or its details open, holds it.
 * A screen reader hears every notice as it arrives: each is a status (an error an alert) inside a
 * live region, whether or not a newer one replaces it on screen a moment later.
 */
export function Notices() {
  const store = useStore();
  const [all, setAll] = useState(false);
  const [held, setHeld] = useState<ReadonlySet<number>>(new Set());
  /** when each notice's clock started: its arrival, or the moment the user let go of it */
  const since = useRef(new Map<number, number>());
  const list = store.notices.value;
  useEffect(() => {
    const now = Date.now();
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const id of since.current.keys()) if (!list.some((n) => n.id === id)) since.current.delete(id);
    for (const n of list) {
      if (!since.current.has(n.id)) since.current.set(n.id, now);
      const ms = noticeLifetimeMs(n);
      if (ms === null || held.has(n.id)) continue;
      timers.push(setTimeout(() => store.dismiss(n.id), Math.max(0, since.current.get(n.id)! + ms - now)));
    }
    return () => timers.forEach(clearTimeout);
  }, [list, held]);
  useEffect(() => {
    if (list.length <= NOTICES_SHOWN) setAll(false);
  }, [list.length]);
  const hold = (id: number, on: boolean) => {
    if (!on) since.current.set(id, Date.now());
    setHeld((prev) => {
      if (prev.has(id) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const hidden = all ? 0 : Math.max(0, list.length - NOTICES_SHOWN);
  const errors = list.slice(0, hidden).filter((n) => n.kind === "error").length;
  return (
    <div class="notices" aria-live="polite">
      {hidden > 0 && (
        <button class={`btn text notices-more${errors ? " has-error" : ""}`} onClick={() => setAll(true)}>
          {errors > 0 && <Icon name="fl_error_circle" size={16} />}
          {hidden === 1 ? "עוד הודעה אחת" : `עוד ${hidden.toLocaleString("he")} הודעות`}
          {errors > 0 && ` · ${errors === hidden ? (hidden === 1 ? "שגיאה" : "כולן שגיאות") : errors === 1 ? "אחת מהן שגיאה" : `${errors.toLocaleString("he")} מהן שגיאות`}`}
        </button>
      )}
      {all && list.length > NOTICES_SHOWN && (
        <button class="btn text notices-more" onClick={() => setAll(false)}>
          רק ההודעה האחרונה
        </button>
      )}
      {list.slice(hidden).map((n) => (
        <NoticeView key={n.id} n={n} onClose={() => store.dismiss(n.id)} onHold={(on) => hold(n.id, on)} />
      ))}
    </div>
  );
}

function NoticeView({ n, onClose, onHold }: { n: Notice; onClose: () => void; onHold: (on: boolean) => void }) {
  /** pointer or focus on the notice, or its details open: the timer waits */
  const [held, setHeld] = useState(0);
  /** opened by a click on its text: the whole text and its details, until clicked again */
  const [open, setOpen] = useState(false);
  const hold = (d: number) => setHeld((h) => Math.max(0, h + d));
  const isHeld = held > 0 || open;
  // only changes are reported: a folded notice that comes into view keeps its clock
  const was = useRef(false);
  useEffect(() => {
    if (was.current !== isHeld) (was.current = isHeld), onHold(isHeld);
  }, [isHeld]);
  useEffect(() => () => void (was.current && onHold(false)), []);
  return (
    <div
      class={`notice ${n.kind}${open ? " open" : ""}`}
      role={n.kind === "error" ? "alert" : "status"}
      onPointerEnter={() => hold(1)}
      onPointerLeave={() => hold(-1)}
      onFocusIn={() => hold(1)}
      onFocusOut={() => hold(-1)}
    >
      <Icon name={ICON[n.kind]} size={18} />
      <div class="notice-text" onClick={() => setOpen(!open)}>
        {withFileNames(n.text)}
      </div>
      {n.action ? (
        <button class="btn text" onClick={() => (n.action!.run(), onClose())}>
          {n.action.label}
        </button>
      ) : (
        <span />
      )}
      <button class="icon-btn" onClick={onClose} aria-label="סגירה">
        <Icon name="fl_dismiss" size={16} />
      </button>
      {n.details && (
        <details onToggle={(e) => hold((e.currentTarget as HTMLDetailsElement).open ? 1 : -1)}>
          <summary>פרטים ({n.details.length})</summary>
          <ul>
            {n.details.map((d, i) => (
              <li key={i}>{withFileNames(d)}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
