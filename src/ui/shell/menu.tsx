import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon, type IconName } from "../icons/icon";

/** A button that opens a small popup menu; closes on outside click and Escape. */
export function Menu({ icon, label, children }: { icon: IconName; label: string; children: (close: () => void) => ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div class="menu" ref={ref}>
      <button class="icon-btn" title={label} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={icon} />
      </button>
      {open && (
        <div class="menu-pop" role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon, children, checked, onSelect }: { icon?: IconName; children: ComponentChildren; checked?: boolean; onSelect: () => void }) {
  return (
    <button class="item" role={checked === undefined ? "menuitem" : "menuitemradio"} {...(checked !== undefined && { "aria-checked": checked })} onClick={onSelect}>
      {icon && <Icon name={icon} size={18} />}
      <span class="grow">{children}</span>
      {checked && <Icon name="oz_check" size={16} />}
    </button>
  );
}
