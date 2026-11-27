import { chooseLayout, movePanel, type PanelId } from "../../state/preferences";
import { useStore } from "../context";
import { Icon } from "../icons/icon";

/**
 * A panel's drag handle, also for the keyboard (V7 §3.9): the arrows move the panel one place the way they point (in RTL the
 * left arrow moves it towards the end of the order). Dragging the header still swaps panels.
 */
export function Grip({ id, label, style, draggable }: { id: PanelId; label: string; style?: string; draggable?: boolean }) {
  const store = useStore();
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const rtl = getComputedStyle(e.currentTarget as Element).direction === "rtl";
    const delta = (e.key === "ArrowLeft") === rtl ? 1 : -1;
    const el = e.currentTarget as HTMLElement;
    chooseLayout(store.prefs, movePanel(store.prefs.layout.value, id, delta));
    // the panel is rendered again in its new place: its handle keeps the focus
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`.grip[data-grip="${id}"]`)?.focus() ?? el.focus());
  };
  return (
    <span class="grip" data-grip={id} tabIndex={0} role="button" style={style} aria-label={`הזזת ${label}: חץ ימינה או שמאלה`} aria-keyshortcuts="ArrowLeft ArrowRight" title="גררו כדי להזיז את הפאנל, או הזיזו אותו בחצים" draggable={draggable} onKeyDown={onKey}>
      <Icon name="fl_re_order_dots_vertical" size={16} />
    </span>
  );
}

/** Hides a panel; the layout menu (app bar) lists hidden panels and brings them back. */
export function HideButton({ id, label }: { id: PanelId; label: string }) {
  const store = useStore();
  const layout = store.prefs.layout.value;
  return (
    <button
      class="icon-btn"
      title={`הסתרת ${label} (מחזירים מתפריט הפריסה בסרגל העליון)`}
      aria-label={`הסתרת ${label}`}
      onClick={() => chooseLayout(store.prefs, { ...layout, hidden: [...layout.hidden, id] })}
    >
      <Icon name="fl_eye_off" size={18} />
    </button>
  );
}
