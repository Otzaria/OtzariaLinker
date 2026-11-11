import { useEffect } from "preact/hooks";
import type { Notice } from "../../state/store";
import { useStore } from "../context";
import { Icon, type IconName } from "../icons/icon";

const ICON: Record<Notice["kind"], IconName> = { info: "fl_info", success: "fl_checkmark_circle", warning: "fl_warning", error: "fl_error_circle" };

/** Short messages; success/info fade by themselves, warnings and errors stay until dismissed. */
export function Notices() {
  const store = useStore();
  return (
    <div class="notices" aria-live="polite">
      {store.notices.value.map((n) => (
        <NoticeView key={n.id} n={n} onClose={() => store.dismiss(n.id)} />
      ))}
    </div>
  );
}

function NoticeView({ n, onClose }: { n: Notice; onClose: () => void }) {
  useEffect(() => {
    // a notice that offers an action stays until used or closed (UX review #4)
    if (n.kind === "warning" || n.kind === "error" || n.details || n.action) return;
    const t = setTimeout(onClose, 5000);
    return () => clearTimeout(t);
  }, [n.id]);
  return (
    <div class={`notice ${n.kind}`} role={n.kind === "error" ? "alert" : "status"}>
      <Icon name={ICON[n.kind]} size={18} />
      <div>
        {n.text}
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
        <details>
          <summary>פרטים ({n.details.length})</summary>
          <ul>
            {n.details.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
