import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon, type IconName } from "../icons/icon";

/** A button that opens a small popup menu; closes on outside click and Escape. */
export function Menu({ icon, label, children }: { icon: IconName; label: string; children: (close: () => void) => ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    // keyboard: focus moves into the menu; arrows move between items (UX review #6)
    ref.current?.querySelector<HTMLElement>(".menu-pop .item")?.focus();
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
        <div
          class="menu-pop"
          role="menu"
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            const items = [...(ref.current?.querySelectorAll<HTMLElement>(".menu-pop .item") ?? [])];
            const at = items.indexOf(document.activeElement as HTMLElement);
            items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
          }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon, children, checked, onSelect, class: cls }: { icon?: IconName; children: ComponentChildren; checked?: boolean; onSelect: () => void; class?: string }) {
  return (
    <button class={`item${cls ? ` ${cls}` : ""}`} role={checked === undefined ? "menuitem" : "menuitemradio"} {...(checked !== undefined && { "aria-checked": checked })} onClick={onSelect}>
      {icon && <Icon name={icon} size={18} />}
      <span class="grow">{children}</span>
      {checked && <Icon name="oz_check" size={16} />}
    </button>
  );
}
