import { useEffect } from "preact/hooks";

/*
 * Keyboard and focus helpers shared by the screens (docs/reviews/ACCESSIBILITY_AUDIT.md).
 */

/**
 * Arrow keys inside a radio group or a tab list made of buttons (WAI-ARIA APG): the arrows move to
 * the previous/next enabled item and choose it, Home/End to the first/last. One item is in the Tab
 * order — the chosen one (`rovingTabIndex`). Put it on the group's `onKeyDown`.
 */
export function rovingKeys(e: KeyboardEvent): void {
  const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
  if (!keys.includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
  const group = e.currentTarget as HTMLElement;
  const items = [...group.querySelectorAll<HTMLElement>('[role="radio"], [role="tab"]')].filter((el) => el.closest('[role="radiogroup"], [role="tablist"]') === group && !(el as HTMLButtonElement).disabled);
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (!items.length || at < 0) return;
  e.preventDefault();
  // the row runs right to left: ArrowLeft is "next", as the eye reads it
  const rtl = getComputedStyle(group).direction === "rtl";
  const forward = e.key === "ArrowDown" || e.key === (rtl ? "ArrowLeft" : "ArrowRight");
  const to = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (at + (forward ? 1 : -1) + items.length) % items.length;
  items[to]!.focus();
  items[to]!.click();
}

/** The chosen item of a roving group is the one Tab stops on; the others are reached with the arrows. */
export const rovingTabIndex = (chosen: boolean): number => (chosen ? 0 : -1);

/**
 * A list row that does something when clicked (shows the link's two ends) and is not a button: the
 * same with Enter or Space, and in the Tab order. Keys pressed on a button inside the row are that
 * button's.
 */
export function activatable(run: () => void): { tabIndex: number; onClick: () => void; onKeyDown: (e: KeyboardEvent) => void } {
  return {
    tabIndex: 0,
    onClick: run,
    onKeyDown: (e: KeyboardEvent) => {
      if ((e.key !== "Enter" && e.key !== " ") || e.target !== e.currentTarget) return;
      e.preventDefault();
      run();
    },
  };
}

/** Focus was dropped: the focused element left the page (its screen or row was replaced). */
export const focusLost = (): boolean => !document.activeElement || document.activeElement === document.body;

/**
 * When this element appears in place of what had focus, focus moves to it instead of falling to the
 * top of the page (a keyboard user would otherwise Tab through the whole app bar and panels again).
 */
export function useFocusOnMount(ref: { current: HTMLElement | null }, when = focusLost): void {
  useEffect(() => {
    if (ref.current && when()) ref.current.focus({ preventScroll: false });
  }, []);
}

const TABBABLE = 'button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';
const shown = (el: Element) => el.getClientRects().length > 0 && !el.closest("[inert], dialog:not([open])");

/**
 * Focus that falls with its element stays where the user was. When the focused element leaves the
 * page — the row approved out of the "pending" filter, the run form replaced by its results, the
 * check button by the report — focus would drop to the top of the page, and a keyboard user would
 * Tab through the app bar and every panel again. Instead it moves to the nearest place that is still
 * there: the closest remaining ancestor, or the first control inside it — unless the new screen
 * placed focus itself (`useFocusOnMount`). A click on empty space (focus leaves, the element stays)
 * is left alone. Returns the uninstaller.
 */
export function installFocusRescue(root: HTMLElement): () => void {
  /** the focused element and its ancestors, nearest first */
  let chain: Element[] = [];
  const onIn = (e: FocusEvent) => {
    chain = [];
    for (let n = e.target as Element | null; n; n = n.parentElement) chain.push(n);
  };
  const rescue = () => {
    if (!chain.length || chain[0]!.isConnected || !focusLost()) return;
    for (const n of chain.slice(1)) {
      if (!n.isConnected) continue;
      const target = n.matches(TABBABLE) && shown(n) ? n : [...n.querySelectorAll(TABBABLE)].find(shown);
      if (target) return (target as HTMLElement).focus();
    }
  };
  // after the screens' own effects (Preact runs them a frame later): a screen that places focus itself wins
  let queued = false;
  const later = () => {
    if (queued || !chain.length || chain[0]!.isConnected) return;
    queued = true;
    requestAnimationFrame(() => setTimeout(() => setTimeout(() => ((queued = false), rescue()))));
  };
  const mo = new MutationObserver(later);
  document.addEventListener("focusin", onIn);
  mo.observe(root, { childList: true, subtree: true });
  return () => (document.removeEventListener("focusin", onIn), mo.disconnect());
}
