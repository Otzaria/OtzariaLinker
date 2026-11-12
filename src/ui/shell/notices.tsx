import { useEffect, useState } from "preact/hooks";
import { noticeLifetimeMs, NOTICES_SHOWN } from "../../state/notice-policy";
import type { Notice } from "../../state/store";
import { useStore } from "../context";
import { Icon, type IconName } from "../icons/icon";
import { withFileNames } from "./file-name";

const ICON: Record<Notice["kind"], IconName> = { info: "fl_info", success: "fl_checkmark_circle", warning: "fl_warning", error: "fl_error_circle" };

/**
 * Short messages (state/notice-policy.ts): errors and notices with an action stay until closed;
 * warnings fade after a longer read, the rest after a short one. At most NOTICES_SHOWN at once — the
 * newest; older ones fold into "N more" (audit F16).
 */
export function Notices() {
  const store = useStore();
  const [all, setAll] = useState(false);
  const list = store.notices.value;
  const hidden = all ? 0 : Math.max(0, list.length - NOTICES_SHOWN);
  return (
    <div class="notices" aria-live="polite">
      {hidden > 0 && (
        <button class="btn text notices-more" onClick={() => setAll(true)}>
          {hidden === 1 ? "עוד הודעה אחת" : `עוד ${hidden.toLocaleString("he")} הודעות`}
        </button>
      )}
      {all && list.length > NOTICES_SHOWN && (
        <button class="btn text notices-more" onClick={() => setAll(false)}>
          רק ההודעות האחרונות
        </button>
      )}
      {list.slice(hidden).map((n) => (
        <NoticeView key={n.id} n={n} onClose={() => store.dismiss(n.id)} />
      ))}
    </div>
  );
}

function NoticeView({ n, onClose }: { n: Notice; onClose: () => void }) {
  /** pointer or focus on the notice, or its details open: the timer waits */
  const [held, setHeld] = useState(0);
  const hold = (d: number) => setHeld((h) => Math.max(0, h + d));
  useEffect(() => {
    const ms = noticeLifetimeMs(n);
    if (ms === null || held > 0) return;
    const t = setTimeout(onClose, ms);
    return () => clearTimeout(t);
  }, [n.id, held > 0]);
  return (
    <div
      class={`notice ${n.kind}`}
      role={n.kind === "error" ? "alert" : "status"}
      onPointerEnter={() => hold(1)}
      onPointerLeave={() => hold(-1)}
      onFocusIn={() => hold(1)}
      onFocusOut={() => hold(-1)}
    >
      <Icon name={ICON[n.kind]} size={18} />
      <div>
        {withFileNames(n.text)}
        {n.action && (
          <button class="btn text" onClick={() => (n.action!.run(), onClose())}>
            {n.action.label}
          </button>
        )}
      </div>
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
