import { useEffect, useRef, useState } from "preact/hooks";
import { foldQuery, MIN_QUERY, type BookHit } from "../../core/text/find";
import { foldForSearch } from "../../core/text/hebrew";
import type { Side } from "../../state/store";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import "./book-find.css";

/*
 * The search box of a reader (v3 §6.5): opened with the magnifier in the reader's head or Ctrl+F
 * while the reader has focus. Typing searches the whole book in the worker (debounced); Enter /
 * Shift+Enter (or F3 / Shift+F3) move between hits, Escape closes. The hits are lines; the list
 * shows each with a snippet, and the matched words are painted in the rendered lines.
 */
const DEBOUNCE_MS = 250;

export function FindBar({ side, bookKey, focusSeq, onClose }: { side: Side; bookKey: string; focusSeq: number; onClose: () => void }) {
  const store = useStore();
  const find = store.find[side];
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(find.query.peek());
  const [listOpen, setListOpen] = useState(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusSeq]);

  // type → search, after a pause; the same query on another book (the reader changed book) searches again
  useEffect(() => {
    if (text === find.query.peek() && find.bookKey.peek() === bookKey) return;
    const t = setTimeout(() => void find.search(bookKey, text), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text, bookKey]);

  const searchNow = () => {
    if (text !== find.query.peek() || find.bookKey.peek() !== bookKey) {
      void find.search(bookKey, text);
      return true;
    }
    return false;
  };
  const close = () => {
    find.close();
    onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === "F3") {
      e.preventDefault();
      if (!searchNow()) find.step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  const r = find.result.value;
  const n = r?.hits.length ?? 0;
  const status = find.status.value;
  const prog = find.progress.value;
  const short = text.trim() !== "" && foldQuery(text).length < MIN_QUERY;
  const label =
    status === "searching" ? `מחפש…${prog && prog.total ? ` ${Math.floor((prog.done / prog.total) * 100)}%` : ""}`
    : status === "error" ? (find.error.value ?? "החיפוש נכשל.")
    : short ? "לפחות שתי אותיות"
    : !r ? ""
    : n === 0 ? "אין תוצאות"
    : `${(find.pos.value + 1).toLocaleString("he")} מתוך ${n.toLocaleString("he")}${r.truncated ? "+" : ""}`;

  return (
    <div class="find" role="search" aria-label="חיפוש בטקסט הספר">
      <div class="find-bar">
        <input
          ref={input}
          type="search"
          placeholder="חיפוש בטקסט הספר…"
          aria-label="חיפוש בטקסט הספר"
          aria-describedby={`find-count-${side}`}
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={onKey}
        />
        <span id={`find-count-${side}`} class={`find-count${status === "error" ? " error" : ""}`} role="status" aria-live="polite" title={label}>
          {label}
        </span>
        <button class="icon-btn" disabled={!n} onClick={() => find.step(-1)} title="התוצאה הקודמת (Shift+Enter)" aria-label="התוצאה הקודמת">
          <Icon name="fl_chevron_down" size={18} class="flip-v" />
        </button>
        <button class="icon-btn" disabled={!n} onClick={() => find.step(1)} title="התוצאה הבאה (Enter)" aria-label="התוצאה הבאה">
          <Icon name="fl_chevron_down" size={18} />
        </button>
        <button class="icon-btn" disabled={!n} aria-pressed={listOpen} aria-controls={`find-list-${side}`} onClick={() => setListOpen(!listOpen)} title="רשימת התוצאות" aria-label="רשימת התוצאות">
          <Icon name="oz_task_list" size={18} />
        </button>
        <button class="icon-btn" onClick={close} title="סגירת החיפוש (Esc)" aria-label="סגירת החיפוש">
          <Icon name="fl_dismiss" size={18} />
        </button>
      </div>
      {status === "searching" && <progress class="find-progress" max={prog?.total || 1} value={prog?.done ?? 0} aria-label="התקדמות החיפוש" />}
      {listOpen && n > 0 && (
        <ul class="find-list" id={`find-list-${side}`} aria-label="תוצאות החיפוש">
          {r!.hits.map((h, i) => (
            <li key={h.line}>
              <button class="find-hit-row" aria-current={i === find.pos.value ? "true" : undefined} onClick={() => find.goTo(i)}>
                <span class="no">{(h.line + 1).toLocaleString("he")}</span>
                <Snippet h={h} />
                {h.count > 1 && <span class="times" title={`${h.count} פעמים בשורה`}>×{h.count}</span>}
              </button>
            </li>
          ))}
          {r!.truncated && <li class="find-more muted">מוצגות {n.toLocaleString("he")} השורות הראשונות שנמצאו. דייקו את החיפוש כדי למצוא את השאר.</li>}
        </ul>
      )}
    </div>
  );
}

function Snippet({ h }: { h: BookHit }) {
  return (
    <span class="snip">
      {h.snippet.slice(0, h.start)}
      <mark>{h.snippet.slice(h.start, h.end)}</mark>
      {h.snippet.slice(h.end)}
    </span>
  );
}

/* ---- painting the matched words in the rendered lines (CSS Custom Highlight API, where supported) ---- */

interface HighlightApi {
  highlights: Map<string, unknown>;
}
declare const Highlight: { new (...ranges: Range[]): unknown } | undefined;

/** The highlight names a reader paints with (styled in book-find.css). */
export const highlightNames = (side: Side) => ({ all: `find-${side}`, current: `find-${side}-current` });

/**
 * Paints every occurrence of the query inside the given rendered lines. The DOM text of a line is
 * folded exactly like the worker folds the line, so what is painted is what was found. Lines that
 * are not rendered yet are painted when they are (the caller re-runs this as chunks arrive).
 */
export function paintMatches(root: HTMLElement | null, side: Side, query: string, lines: ReadonlySet<number>, current: number | null): void {
  const api = (globalThis as { CSS?: Partial<HighlightApi> }).CSS;
  if (!api?.highlights || typeof Highlight === "undefined") return;
  const names = highlightNames(side);
  const folded = foldQuery(query);
  const all: Range[] = [];
  const cur: Range[] = [];
  if (root && folded.length >= MIN_QUERY && lines.size) {
    for (const el of root.querySelectorAll<HTMLElement>(".ln.find-hit .tx")) {
      const i = Number(el.parentElement?.dataset.i);
      if (!lines.has(i)) continue;
      for (const range of rangesOf(el, folded)) (i === current ? cur : all).push(range);
    }
  }
  api.highlights.set(names.all, new Highlight(...all));
  api.highlights.set(names.current, new Highlight(...cur));
}

export function clearMatches(side: Side): void {
  const api = (globalThis as { CSS?: Partial<HighlightApi> }).CSS;
  if (!api?.highlights) return;
  const names = highlightNames(side);
  api.highlights.delete(names.all);
  api.highlights.delete(names.current);
}

function rangesOf(el: HTMLElement, folded: string): Range[] {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text);
    starts.push(text.length);
    text += (n as Text).data;
  }
  const f = foldForSearch(text);
  const out: Range[] = [];
  const locate = (at: number): [Text, number] => {
    let k = starts.length - 1;
    while (k > 0 && starts[k]! > at) k--;
    return [nodes[k]!, at - starts[k]!];
  };
  for (let at = f.text.indexOf(folded); at >= 0; at = f.text.indexOf(folded, at + folded.length)) {
    const [sn, so] = locate(f.map[at]!);
    const [en, eo] = locate(f.map[at + folded.length - 1]!);
    const range = document.createRange();
    range.setStart(sn, so);
    range.setEnd(en, eo + 1);
    out.push(range);
  }
  return out;
}
