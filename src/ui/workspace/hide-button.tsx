import type { PanelId } from "../../state/preferences";
import { useStore } from "../context";
import { Icon } from "../icons/icon";

/** Hides a panel; the layout menu (app bar) lists hidden panels and brings them back. */
export function HideButton({ id, label }: { id: PanelId; label: string }) {
  const store = useStore();
  const layout = store.prefs.layout.value;
  return (
    <button
      class="icon-btn"
      title={`הסתרת ${label} (מחזירים מתפריט הפריסה בסרגל העליון)`}
      aria-label={`הסתרת ${label}`}
      onClick={() => (store.prefs.layout.value = { ...layout, hidden: [...layout.hidden, id] })}
    >
      <Icon name="fl_eye_off" size={18} />
    </button>
  );
}
