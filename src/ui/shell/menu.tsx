import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon, type IconName } from "../icons/icon";

const ITEM = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';
/** the menu's items that are shown, in order */
const items = (menu: HTMLElement | null): HTMLElement[] => [...(menu?.querySelectorAll<HTMLElement>(`.menu-pop :is(${ITEM})`) ?? [])].filter((el) => el.getClientRects().length > 0);

/**
 * A button that opens a small popup menu (WAI-ARIA menu button). Opening moves focus to the first
 * item; the arrows, Home and End move between items (only the focused item takes focus — items are
 * not Tab stops); Escape closes and returns focus to the button; Tab closes and moves on from the
 * button; a click outside closes.
 */
export function Menu({ icon, label, badge, badgeLabel, children }: { icon: IconName; label: string; badge?: number; badgeLabel?: string; children: (close: () => void) => ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  /** closes; focus goes back to the button when it was inside the menu (an item that closes the menu removes itself) */
  const close = () => {
    const inside = !!ref.current?.querySelector(".menu-pop")?.contains(document.activeElement);
    setOpen(false);
    if (inside || !document.activeElement || document.activeElement === document.body) trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    // keyboard: focus moves into the menu; arrows move between items (UX review #6)
    // (the first one shown: the settings menu starts with an item that exists only on a phone)
    items(ref.current)[0]?.focus();
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div class="menu" ref={ref}>
      <button ref={trigger} class="icon-btn" title={badge ? `${label} (${badgeLabel})` : label} aria-label={badge ? `${label} (${badgeLabel})` : label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={icon} />
        {/* something the menu brings back (a hidden panel): a count on the button, so it is not forgotten */}
        {badge ? <span class="menu-badge" aria-hidden="true">{badge.toLocaleString("he")}</span> : null}
      </button>
      {open && (
        <div
          class="menu-pop"
          role="menu"
          aria-label={label}
          onKeyDown={(e) => {
            if (e.key === "Tab") {
              // the button takes focus back, and Tab moves on from there
              setOpen(false);
              trigger.current?.focus();
              return;
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
            e.preventDefault();
            const all = items(ref.current);
            const at = all.indexOf(document.activeElement as HTMLElement);
            const to = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length;
            all[to]?.focus();
          }}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon, children, checked, onSelect, class: cls }: { icon?: IconName; children: ComponentChildren; checked?: boolean; onSelect: () => void; class?: string }) {
  return (
    <button class={`item${cls ? ` ${cls}` : ""}`} tabIndex={-1} role={checked === undefined ? "menuitem" : "menuitemradio"} {...(checked !== undefined && { "aria-checked": checked })} onClick={onSelect}>
      {icon && <Icon name={icon} size={18} />}
      <span class="grow">{children}</span>
      {checked && <Icon name="oz_check" size={16} />}
    </button>
  );
}

/** Items under a heading inside a menu ("ערכת צבעים"): the heading names the group for a screen reader. */
export function MenuGroup({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="menu-group" role="group" aria-label={label}>
      <div class="label" aria-hidden="true">{label}</div>
      {children}
    </div>
  );
}
