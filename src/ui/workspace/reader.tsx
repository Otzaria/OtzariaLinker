import { useComputed } from "@preact/signals";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SourceLine } from "../../core/books";
import type { Link } from "../../core/links/model";
import { sanitizeBookHtml } from "../../core/text/sanitize";
import { CONFIDENCE_LABELS, CONFIDENCE_ORDER, type Confidence } from "../../linking/automatic";
import { CHUNK } from "../../state/lines";
import type { Side } from "../../state/store";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { anchorFromSelection } from "./anchor-selection";
import { clearMatches, FindBar, paintMatches } from "./book-find";
import { BookInfo } from "./book-info";
import { BookList } from "./book-picker";
import { SourceBadge, useBookOrigin } from "./source-badge";
import { HideButton } from "./hide-button";
import { parseDraggedLine } from "./line-drag";
import { LineLinksPopover, type LineLinksAt } from "./line-links";
import { plainText } from "./plain-text";
import { ReopenSources } from "./reopen-sources";

/*
 * One book, read lazily. The book is split into chunks of CHUNK lines; a chunk is a placeholder
 * until it comes near the viewport, then its lines are fetched from the worker and rendered (and
 * stay rendered — `content-visibility: auto` keeps off-screen lines cheap). Picking:
 *   click = line · Shift+click = range · select words = anchor (source side) ·
 *   drag a line NUMBER from the source onto a target line = fill both ends of the builder.
 */
const DRAG_TYPE = "application/x-otzaria-line";
const SIDE_LABEL: Record<Side, string> = { source: "מקור", target: "יעד" };
const NO_HITS: ReadonlySet<number> = new Set();

export function Reader({ side }: { side: Side }) {
  const store = useStore();
  const bookKey = store.view[side].value;
  const book = bookKey ? store.books.value.get(bookKey) : undefined;
  const [choosing, setChoosing] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [query, setQuery] = useState("");
  const find = store.find[side];
  /** bumps on every "open the search box" request, so a second Ctrl+F focuses it again */
  const [findSeq, setFindSeq] = useState(0);
  const reading = !!book && !choosing;
  const openFind = () => {
    find.open.value = true;
    setFindSeq((n) => n + 1);
  };
  // Ctrl+F while this reader has focus searches its book instead of the browser's find
  const onKeyDown = (e: KeyboardEvent) => {
    // Escape closes the book-info strip and keeps the focus on the name that opened it
    if (e.key === "Escape" && infoOpen) {
      setInfoOpen(false);
      (e.currentTarget as HTMLElement).querySelector<HTMLElement>(".panel-head h2 button")?.focus();
      return;
    }
    if (!reading || !(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "f") return;
    e.preventDefault();
    openFind();
  };

  return (
    <section class={`panel reader ${side}${book && isCommentaryTitle(book.title) ? " rashi" : ""}`} aria-label={`ספר ה${SIDE_LABEL[side]}`} onKeyDown={onKeyDown}>
      <ReaderHead side={side} bookKey={book?.key} title={book?.title} onChoose={() => setChoosing(!choosing)} onFind={reading ? () => (find.open.peek() ? find.close() : openFind()) : undefined} findOpen={reading && find.open.value} infoOpen={infoOpen && !!book} onInfo={() => setInfoOpen(!infoOpen)} infoId={`book-info-${side}`} />
      {infoOpen && book && <BookInfo id={`book-info-${side}`} bookKey={book.key} />}
      {choosing || !book ? (
        <div class="panel-body">
          <div class="book-search">
            <input type="search" placeholder={`חיפוש ספר ל${SIDE_LABEL[side]}…`} value={query} onInput={(e) => setQuery(e.currentTarget.value)} autoFocus={choosing} />
          </div>
          {store.books.value.size ? (
            <BookList query={query} onPick={(_s, key) => (store.showBook(side, key), setChoosing(false))} />
          ) : side === "source" && store.missingSources.value.length ? (
            <ReopenSources />
          ) : (
            <div class="empty">
              <Icon name="oz_book_open_medium_lines" size={40} />
              <span>עדיין לא נפתחו ספרים. "הוספת מקור" (בחלונית המקורות) פותחת תיקייה, קבצים או מסד — או גררו אותם לכאן.</span>
            </div>
          )}
        </div>
      ) : (
        <BookView key={book.key} side={side} bookKey={book.key} lineCount={book.lineCount} findSeq={findSeq} />
      )}
    </section>
  );
}

function ReaderHead({ side, bookKey, title, onChoose, onFind, findOpen, infoOpen, onInfo, infoId }: { side: Side; bookKey: string | undefined; title: string | undefined; onChoose: () => void; onFind: (() => void) | undefined; findOpen: boolean; infoOpen: boolean; onInfo: () => void; infoId: string }) {
  const store = useStore();
  // several sources open: which one this book comes from (with its name when another source has the same title)
  const origin = useBookOrigin()(bookKey);
  const showSource = !!origin.source && store.sources.value.length > 1;
  return (
    <div class="panel-head" data-panel={side} draggable>
      <span class="grip" title="גררו כדי להזיז את הפאנל">
        <Icon name="fl_re_order_dots_vertical" size={16} />
      </span>
      <span class={`side-badge ${side}`}>{SIDE_LABEL[side]}</span>
      <h2 class="grow book-title" title={title}>
        {title ? (
          <button type="button" class="title-btn" aria-expanded={infoOpen} aria-controls={infoOpen ? infoId : undefined} onClick={onInfo}>
            {title}
          </button>
        ) : (
          "לא נבחר ספר"
        )}
      </h2>
      {showSource && <SourceBadge source={origin.source!} name={origin.ambiguous} class={origin.ambiguous ? "twin" : undefined} />}
      {onFind && (
        <button class="icon-btn" onClick={onFind} aria-pressed={findOpen} title="חיפוש בטקסט הספר (Ctrl+F)" aria-label="חיפוש בטקסט הספר">
          <Icon name="oz_search" />
        </button>
      )}
      <button class="icon-btn" onClick={onChoose} title="בחירת ספר אחר" aria-label="בחירת ספר">
        <Icon name="oz_book_search" />
      </button>
      <HideButton id={side} label={`ספר ה${SIDE_LABEL[side]}`} />
    </div>
  );
}

function BookView({ side, bookKey, lineCount, findSeq }: { side: Side; bookKey: string; lineCount: number | undefined; findSeq: number }) {
  const store = useStore();
  const find = store.find[side];
  const findOpen = find.open.value;
  // hits of this book only: a result for the previous book must not mark lines of this one
  const hits = findOpen && find.bookKey.value === bookKey ? find.hitLines.value : NO_HITS;
  const currentHit = hits.size ? (find.current.value?.line ?? null) : null;
  const scroller = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<ReadonlySet<number>>(() => new Set([0]));
  store.lines.tick.value; // re-render when chunks arrive
  const count = lineCount ?? store.lines.count(bookKey);
  // unknown length (text file not read yet): show what is loaded plus one more chunk
  const chunks = count !== undefined ? Math.max(1, Math.ceil(count / CHUNK)) : Math.max(...active) + 2;

  // which chunks are near the viewport
  const io = useMemo(
    () =>
      new IntersectionObserver(
        (entries) => {
          const add = entries.filter((e) => e.isIntersecting).map((e) => Number((e.target as HTMLElement).dataset.chunk));
          if (add.length) setActive((prev) => (add.every((c) => prev.has(c)) ? prev : new Set([...prev, ...add])));
        },
        { root: null, rootMargin: "1500px 0px" },
      ),
    [],
  );
  useEffect(() => () => io.disconnect(), [io]);

  // scroll-to-line requests
  const focus = store.focus[side].value;
  useEffect(() => {
    if (!focus) return;
    const c = Math.floor(focus.line / CHUNK);
    setActive((prev) => (prev.has(c) ? prev : new Set([...prev, c])));
    void store.lines.load(bookKey, focus.line, focus.line).then(() =>
      requestAnimationFrame(() => {
        const el = scroller.current?.querySelector<HTMLElement>(`.ln[data-i="${focus.line}"]`);
        if (!el) return;
        el.scrollIntoView({ block: "center" });
        // one flashed line at a time: an earlier jump's class would otherwise stay on its line for good
        for (const old of scroller.current?.querySelectorAll(".ln.flash") ?? []) old.classList.remove("flash");
        void el.offsetWidth;
        el.classList.add("flash");
        el.addEventListener("animationend", () => el.classList.remove("flash"), { once: true });
      }),
    );
  }, [focus?.seq]);

  // paint the matched words in the rendered hit lines, again whenever more lines render
  const tick = store.lines.tick.value;
  useEffect(() => {
    const id = requestAnimationFrame(() => paintMatches(scroller.current, side, find.query.peek(), hits, currentHit));
    return () => cancelAnimationFrame(id);
  }, [hits, currentHit, tick, active]);
  useEffect(() => () => clearMatches(side), []);

  const marks = useLineMarks(side, bookKey);
  const pick = store.pick[side].value;
  const pickHere = pick && pick.bookKey === bookKey ? pick : null;
  /** the line whose links are open (its count was clicked) */
  const [linksAt, setLinksAt] = useState<LineLinksAt | null>(null);
  const openLinks = (line: number, anchor: HTMLElement) => setLinksAt((cur) => (cur?.line === line ? null : { line, anchor }));
  const closeLinks = (refocus: boolean) => {
    const anchor = linksAt?.anchor;
    setLinksAt(null);
    if (refocus && anchor?.isConnected) anchor.focus();
  };

  const onClick = (e: MouseEvent) => {
    const ln = (e.target as HTMLElement).closest<HTMLElement>(".ln");
    if (!ln || (e.target as HTMLElement).closest(".marks")) return;
    const i = Number(ln.dataset.i);
    const sel = getSelection();
    if (sel && !sel.isCollapsed) {
      const line = store.lines.peek(bookKey, i);
      const textEl = ln.querySelector<HTMLElement>(".tx");
      const a = line && textEl ? anchorFromSelection(textEl, line.anchorText, sel) : null;
      if (a && side === "source") return store.pickAnchor(side, bookKey, i, a);
      if (a) return; // words in the target are just selected text; anchors live on the source line
    }
    if (e.shiftKey) getSelection()?.removeAllRanges(); // a Shift-range is lines, not text
    store.pickLine(side, bookKey, i, e.shiftKey);
    if (side === "target" && store.prefs.createMode.value === "click" && store.pick.source.value) createNow();
  };

  const createNow = () => {
    const made = store.createFromDraft();
    if (made) store.notify("success", "הקישור נוצר (Ctrl+Z מבטל).");
    else if (store.draftProblems.value.length) {
      // the plain words; the file's field name only in the notice's details (audit F14)
      const p = store.draftProblems.value.find((x) => x.severity === "error");
      store.notify("error", `הקישור לא נוצר: ${p?.message ?? ""}`, p?.detail ? [p.detail] : undefined);
    }
  };

  const onKey = (e: KeyboardEvent) => {
    // Enter on the reader: the picked line's links (when it has any)
    if (e.key === "Enter" && e.target === e.currentTarget && pickHere) {
      const btn = scroller.current?.querySelector<HTMLElement>(`.ln[data-i="${pickHere.line}"] .marks-btn`);
      if (btn) (e.preventDefault(), openLinks(pickHere.line, btn));
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    // keyboard-only use: the first arrow picks the first line in view (UX review #6)
    if (!pickHere) {
      const top = scroller.current?.getBoundingClientRect().top ?? 0;
      const first = [...(scroller.current?.querySelectorAll<HTMLElement>(".ln") ?? [])].find((el) => el.getBoundingClientRect().bottom > top);
      store.pickLine(side, bookKey, first ? Number(first.dataset.i) : 0);
      return;
    }
    const edge = e.shiftKey ? (pickHere.end ?? pickHere.line) : pickHere.line;
    const next = Math.max(0, edge + (e.key === "ArrowDown" ? 1 : -1));
    if (count !== undefined && next >= count) return;
    store.pickLine(side, bookKey, next, e.shiftKey);
    store.reveal(side, bookKey, next);
  };

  const [dropLine, setDropLine] = useState<number | null>(null);
  const dnd =
    side === "source"
      ? {
          onDragStart: (e: DragEvent) => {
            const no = (e.target as HTMLElement).closest<HTMLElement>(".no");
            const ln = no?.closest<HTMLElement>(".ln");
            if (!ln || !e.dataTransfer) return;
            e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ bookKey, line: Number(ln.dataset.i) }));
            e.dataTransfer.effectAllowed = "link";
          },
        }
      : {
          onDragOver: (e: DragEvent) => {
            if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
            e.preventDefault();
            const ln = (e.target as HTMLElement).closest<HTMLElement>(".ln");
            setDropLine(ln ? Number(ln.dataset.i) : null);
          },
          onDragLeave: () => setDropLine(null),
          onDrop: (e: DragEvent) => {
            const raw = e.dataTransfer?.getData(DRAG_TYPE);
            const ln = (e.target as HTMLElement).closest<HTMLElement>(".ln");
            setDropLine(null);
            if (!raw || !ln) return;
            e.preventDefault();
            const from = parseDraggedLine(raw);
            if (!from) return;
            store.pickLine("source", from.bookKey, from.line);
            store.pickLine("target", bookKey, Number(ln.dataset.i));
            store.sideTab.value = "builder";
            if (store.prefs.createMode.value === "click") createNow();
          },
        };

  return (
    <>
      <ReaderTools side={side} bookKey={bookKey} count={count} />
      {findOpen && <FindBar side={side} bookKey={bookKey} focusSeq={findSeq} onClose={() => scroller.current?.focus()} />}
      {/* the arrows pick lines here (keyboard use); what was picked is said aloud, the eye sees the highlight */}
      <div class="panel-body" ref={scroller} tabIndex={0} onKeyDown={onKey} role="region" aria-label={`שורות ספר ה${SIDE_LABEL[side]} (החצים בוחרים שורה)`}>
        <div class="lines" onClick={onClick} {...dnd}>
          {Array.from({ length: chunks }, (_, c) => (
            <Chunk key={c} c={c} bookKey={bookKey} active={active.has(c)} io={io} count={count} marks={marks} pick={pickHere} dropLine={dropLine} draggableNo={side === "source"} hits={hits} currentHit={currentHit} linksOpen={linksAt?.line ?? null} onLinks={openLinks} />
          ))}
        </div>
      </div>
      {linksAt && <LineLinksPopover bookKey={bookKey} at={linksAt} onClose={closeLinks} />}
      <div class="sr-only" role="status">
        {pickHere ? pickedLineText(pickHere, store.lines.peek(bookKey, pickHere.line)?.anchorText) : ""}
      </div>
    </>
  );
}

/** "שורה 12: בראשית ברא…" — the picked line (or range) for the screen reader's live region. */
function pickedLineText(pick: { line: number; end?: number; anchor?: { text: string } }, html: string | undefined): string {
  const where = pick.end !== undefined && pick.end > pick.line ? `שורות ${pick.line + 1}–${pick.end + 1}` : `שורה ${pick.line + 1}`;
  const text = pick.anchor ? `המילים "${pick.anchor.text}"` : html ? plainText(html).slice(0, 120) : "";
  return `נבחרה ${where}${text ? `: ${text}` : ""}`;
}

interface Marks {
  project: Map<number, { new: number; file: number; deleted: number }>;
  /** best confidence of a PENDING suggestion touching the line */
  suggested: Map<number, Confidence>;
}

/** Per-line counts of the project's links touching this book on this side's role. */
function useLineMarks(side: Side, bookKey: string): Marks {
  const store = useStore();
  const project = useComputed(() => {
    const m = new Map<number, { new: number; file: number; deleted: number }>();
    for (const l of store.allLinks.value) {
      for (const end of [l.source, l.target]) {
        if (!store.sameBook(end.book, bookKey)) continue;
        for (let i = end.line; i <= (end.end ?? end.line) && i < end.line + 500; i++) {
          const x = m.get(i) ?? { new: 0, file: 0, deleted: 0 };
          if (l.status === "deleted") x.deleted++;
          else if (l.provenance === "file" && l.status === "existing") x.file++;
          else x.new++;
          m.set(i, x);
        }
      }
    }
    return m;
  });
  const suggested = useComputed(() => {
    const m = new Map<number, Confidence>();
    const run = store.suggestions.run.value;
    if (!run) return m;
    const st = store.suggestions.state.value;
    for (const sg of run.result.suggestions) {
      if (st.get(sg.id) !== "pending") continue;
      const end = sg.source.book.key === bookKey ? sg.source : sg.target.book.key === bookKey ? sg.target : null;
      if (!end) continue;
      for (let i = end.line; i <= (end.end ?? end.line) && i < end.line + 500; i++) {
        const cur = m.get(i);
        if (!cur || CONFIDENCE_ORDER.indexOf(sg.confidence) < CONFIDENCE_ORDER.indexOf(cur)) m.set(i, sg.confidence);
      }
    }
    return m;
  });
  void side;
  return { project: project.value, suggested: suggested.value };
}

function Chunk(props: { c: number; bookKey: string; active: boolean; io: IntersectionObserver; count: number | undefined; marks: Marks; pick: { line: number; end?: number; anchor?: { text: string } } | null; dropLine: number | null; draggableNo: boolean; hits: ReadonlySet<number>; currentHit: number | null; linksOpen: number | null; onLinks: (line: number, anchor: HTMLElement) => void }) {
  const { c, bookKey, active, io, count } = props;
  const store = useStore();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    io.observe(el);
    return () => io.unobserve(el);
  }, [io]);

  const from = c * CHUNK;
  const n = count !== undefined ? Math.min(CHUNK, count - from) : CHUNK;
  if (!active) return <div ref={ref} data-chunk={c} class="chunk-ph" style={{ height: `${n * 1.9}em` }} />;

  const lines: (SourceLine | undefined)[] = [];
  for (let i = from; i < from + n; i++) lines.push(store.lines.line(bookKey, i));
  const error = store.lines.errorAt(bookKey, from);
  const existing = store.lines.existingAt(bookKey, from);
  const dbCount = countDb(existing, bookKey, from, n);
  if (error) return <div ref={ref} data-chunk={c} class="chunk-ph">שגיאה בטעינת שורות {from + 1}–{from + n}: {error}</div>;
  if (lines.every((l) => !l) && count === undefined && c > 0) return <div ref={ref} data-chunk={c} />;

  return (
    <div ref={ref} data-chunk={c}>
      {lines.map((l, k) => {
        const i = from + k;
        if (!l) return <div key={i} class="ln" data-i={i}><span class="no">{i + 1}</span><span class="tx muted">…</span></div>;
        return <Line key={i} l={l} picked={!!props.pick && i >= props.pick.line && i <= (props.pick.end ?? props.pick.line)} mark={props.marks.project.get(i)} sug={props.marks.suggested.get(i)} db={dbCount.get(i) ?? 0} dropOver={props.dropLine === i} draggableNo={props.draggableNo} found={props.hits.has(i) ? (props.currentHit === i ? "current" : "hit") : null} linksOpen={props.linksOpen === i} onLinks={props.onLinks} />;
      })}
    </div>
  );
}

function countDb(links: Link[] | undefined, bookKey: string, from: number, n: number): Map<number, number> {
  const m = new Map<number, number>();
  for (const l of links ?? [])
    for (const end of [l.source, l.target])
      if (end.book.key === bookKey && end.line >= from && end.line < from + n) m.set(end.line, (m.get(end.line) ?? 0) + 1);
  return m;
}

function Line({ l, picked, mark, sug, db, dropOver, draggableNo, found, linksOpen, onLinks }: { l: SourceLine; picked: boolean; mark: { new: number; file: number; deleted: number } | undefined; sug: Confidence | undefined; db: number; dropOver: boolean; draggableNo: boolean; found: "hit" | "current" | null; linksOpen: boolean; onLinks: (line: number, anchor: HTMLElement) => void }) {
  const html = useMemo(() => sanitizeBookHtml(l.anchorText), [l.anchorText]);
  const total = (mark?.new ?? 0) + (mark?.file ?? 0) + (mark?.deleted ?? 0) + db;
  const cls = `ln${l.heading !== null ? " heading" : ""}${picked ? " picked" : ""}${dropOver ? " drop-over" : ""}${found ? " find-hit" : ""}${found === "current" ? " find-current" : ""}`;
  return (
    <div class={cls} data-i={l.index} title={l.heading !== null ? "שורת כותרת — אוצריא לא יוצרת קישור אל כותרת או ממנה" : undefined}>
      <span class="no" draggable={draggableNo} title={draggableNo ? "גררו את המספר אל שורה בספר היעד" : undefined}>{l.index + 1}</span>
      <span class="tx" dangerouslySetInnerHTML={{ __html: html }} />
      <span class="marks">
        {/* the counts open the line's links (line-links.tsx); only the picked line's is a Tab stop */}
        {total > 0 && (
          <button
            class="marks-btn"
            tabIndex={picked ? 0 : -1}
            aria-haspopup="dialog"
            aria-expanded={linksOpen}
            aria-label={`הקישורים של שורה ${l.index + 1} (${total})`}
            title="הקישורים של השורה"
            onClick={(e) => onLinks(l.index, e.currentTarget)}
          >
            {mark?.new ? <span class="mark new" title={`${mark.new} קישורים חדשים או ערוכים`}>{mark.new}</span> : null}
            {mark?.file ? <span class="mark file" title={`${mark.file} קישורים מקובץ שיובא`}>{mark.file}</span> : null}
            {mark?.deleted ? <span class="mark deleted" title={`${mark.deleted} קישורים שיימחקו`}>{mark.deleted}</span> : null}
            {db ? <span class="mark db" title={`${db} קישורים קיימים במסד`}>{db}</span> : null}
          </button>
        )}
        {sug ? <span class={`mark sug conf-${sug}`} title={`הצעה ממתינה, ודאות ${CONFIDENCE_LABELS[sug]}`}>•</span> : null}
      </span>
    </div>
  );
}

function ReaderTools({ side, bookKey, count }: { side: Side; bookKey: string; count: number | undefined }) {
  const store = useStore();
  const [go, setGo] = useState("");
  return (
    <div class="reader-tools">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number.parseInt(go, 10);
          if (n >= 1 && (count === undefined || n <= count)) store.reveal(side, bookKey, n - 1);
        }}
      >
        <input class="goto" type="number" min={1} max={count} placeholder="לשורה…" value={go} onInput={(e) => setGo(e.currentTarget.value)} aria-label="מעבר לשורה" />
      </form>
      <span class="muted grow">{count !== undefined ? `${count.toLocaleString("he")} שורות` : ""}</span>
    </div>
  );
}

/** Commentaries are shown in Rashi script, as in the app's commentary panel; translations are not commentaries. */
function isCommentaryTitle(title: string): boolean {
  return /\sעל\s/.test(title) && !/^תרגום/.test(title);
}
