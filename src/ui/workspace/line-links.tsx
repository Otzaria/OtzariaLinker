import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { parseConnectionType, TYPE_LABELS } from "../../core/links/connection-type";
import type { Link, LinkSide } from "../../core/links/model";
import { useStore } from "../context";
import { plainText } from "./plain-text";

/*
 * The links of one reader line, opened from the count next to it (V5 UX audit, the owner's choice A
 * for "which line goes with which"): each link with the other side's book and line and the opening
 * words of that line; choosing one shows both ends and keeps them marked (store.revealLink).
 * Keyboard (docs/reviews/ACCESSIBILITY_AUDIT.md, ui/keyboard.ts): the count is a button — the picked
 * line's is a Tab stop, and Enter on the reader opens the picked line's links — Enter/Space opens,
 * focus moves to the first link, the arrows (and Home/End) move between links, Enter/Space chooses,
 * Escape closes and returns focus to the count, Tab closes and moves on from it, a click outside closes.
 */
const SHOWN = 30;
const KIND: Record<string, string> = { new: "חדש", edited: "ערוך", existing: "מקובץ", deleted: "יימחק", db: "במסד" };

export interface LineLinksAt {
  line: number;
  /** the count button that opened the list: placement, and where focus returns */
  anchor: HTMLElement;
}

/** The project's links and the open database's links that touch `line` of `bookKey`. */
export function useLineLinks(bookKey: string, line: number): Link[] {
  const store = useStore();
  const project = store.allLinks.value.filter((l) => [l.source, l.target].some((e) => store.sameBook(e.book, bookKey) && line >= e.line && line <= (e.end ?? e.line)));
  const db = (store.lines.existingAt(bookKey, line) ?? []).filter((l) => [l.source, l.target].some((e) => e.book.key === bookKey && e.line === line));
  return [...project, ...db];
}

export function LineLinksPopover({ bookKey, at, onClose }: { bookKey: string; at: LineLinksAt; onClose: (refocus: boolean) => void }) {
  const store = useStore();
  store.lines.tick.value; // the other lines' words arrive later
  const links = useLineLinks(bookKey, at.line);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  /** the end of a link that is not this line (a link inside one book: the other one) */
  const otherEnd = (l: Link): LinkSide => (store.sameBook(l.source.book, bookKey) && at.line >= l.source.line && at.line <= (l.source.end ?? l.source.line) ? l.target : l.source);
  const items = links.slice(0, SHOWN).map((l) => {
    const end = otherEnd(l);
    const book = store.bookOf(end.book);
    const html = book ? store.lines.peek(book.key, end.line)?.anchorText : undefined;
    return { l, end, book, text: html === undefined ? null : plainText(html).trim().slice(0, 80) };
  });

  // the opening words of the other lines
  useEffect(() => {
    for (const it of items) if (it.book && it.text === null) void store.lines.load(it.book.key, it.end.line, it.end.line);
  }, [links.length]);

  // placed under the count (above it when there is no room), inside the window
  useLayoutEffect(() => {
    const r = at.anchor.getBoundingClientRect();
    const box = ref.current?.getBoundingClientRect();
    const w = box?.width ?? 320;
    const h = box?.height ?? 200;
    const top = r.bottom + 4 + h > innerHeight - 8 ? Math.max(8, r.top - 4 - h) : r.bottom + 4;
    // the count sits at the line's left end (RTL): the list opens from there towards the text
    const left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
    setPos({ top, left });
  }, [at.anchor, links.length]);

  // focus moves in once it is placed (a hidden element does not take focus)
  const placed = pos !== null;
  useEffect(() => {
    if (placed) (ref.current?.querySelector<HTMLElement>("button.ll-item:not(:disabled)") ?? ref.current)?.focus();
  }, [placed]);

  useEffect(() => {
    const outside = (e: Event) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !at.anchor.contains(t)) onClose(false);
    };
    // the reader scrolled under it: it would point at another line
    const scrolled = (e: Event) => !ref.current?.contains(e.target as Node) && onClose(false);
    document.addEventListener("mousedown", outside);
    addEventListener("scroll", scrolled, true);
    return () => (document.removeEventListener("mousedown", outside), removeEventListener("scroll", scrolled, true));
  }, [at.anchor]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") return void (e.preventDefault(), e.stopPropagation(), onClose(true));
    // Tab leaves from the count, as from a menu
    if (e.key === "Tab") return void onClose(true);
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const all = [...(ref.current?.querySelectorAll<HTMLElement>("button.ll-item") ?? [])];
    const i = all.indexOf(document.activeElement as HTMLElement);
    const to = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length;
    all[to]?.focus();
  };

  const choose = (l: Link) => {
    store.revealLink(l);
    onClose(true);
  };

  return (
    <div class="line-links" ref={ref} tabIndex={-1} role="dialog" aria-label={`הקישורים של שורה ${at.line + 1}`} style={pos ? { top: `${pos.top}px`, left: `${pos.left}px` } : { visibility: "hidden" }} onKeyDown={onKeyDown}>
      <b class="ll-head">הקישורים של שורה {(at.line + 1).toLocaleString("he")} ({links.length.toLocaleString("he")})</b>
      <ul>
        {items.map(({ l, end, book, text }) => {
          const kind = l.provenance === "db" ? "db" : l.status;
          return (
            <li key={`${l.provenance}:${l.id}`}>
              <button class={`ll-item${l.status === "deleted" ? " deleted" : ""}`} onClick={() => choose(l)} disabled={!book}>
                <span class="ll-where">
                  <b>{end.book.title}</b> {end.end !== undefined && end.end > end.line ? `${end.line + 1}–${end.end + 1}` : end.line + 1}
                </span>
                <span class="ll-text">{book ? (text === null ? "…" : `${text}${text.length >= 80 ? "…" : ""}`) : "הספר לא פתוח"}</span>
                <span class="ll-kind">{TYPE_LABELS[parseConnectionType(l.declaredType).type].he} · {KIND[kind] ?? ""}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {links.length > SHOWN && <span class="muted">ועוד {(links.length - SHOWN).toLocaleString("he")} — כולם בטבלת הקישורים.</span>}
      <span class="muted ll-hint">לחיצה: מעבר, ושני הצדדים מסומנים · Esc: סגירה</span>
    </div>
  );
}
