import { useComputed } from "@preact/signals";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SourceLine } from "../../core/books";
import type { Link } from "../../core/links/model";
import { sanitizeBookHtml } from "../../core/text/sanitize";
import { CHUNK } from "../../state/lines";
import type { Side } from "../../state/store";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { anchorFromSelection } from "./anchor-selection";
import { BookList } from "./book-picker";

/*
 * One book, read lazily. The book is split into chunks of CHUNK lines; a chunk is a placeholder
 * until it comes near the viewport, then its lines are fetched from the worker and rendered (and
 * stay rendered — `content-visibility: auto` keeps off-screen lines cheap). Picking:
 *   click = line · Shift+click = range · select words = anchor (source side) ·
 *   drag a line NUMBER from the source onto a target line = fill both ends of the builder.
 */
const DRAG_TYPE = "application/x-otzaria-line";
const SIDE_LABEL: Record<Side, string> = { source: "מקור", target: "יעד" };

export function Reader({ side }: { side: Side }) {
  const store = useStore();
  const bookKey = store.view[side].value;
  const book = bookKey ? store.books.value.get(bookKey) : undefined;
  const [choosing, setChoosing] = useState(false);
  const [query, setQuery] = useState("");

  return (
    <section class={`panel reader ${side}${book && /\sעל\s/.test(book.title) ? " rashi" : ""}`} aria-label={`ספר ה${SIDE_LABEL[side]}`}>
      <ReaderHead side={side} title={book?.title} onChoose={() => setChoosing(!choosing)} />
      {choosing || !book ? (
        <div class="panel-body">
          <div class="book-search">
            <input type="search" placeholder={`חיפוש ספר ל${SIDE_LABEL[side]}…`} value={query} onInput={(e) => setQuery(e.currentTarget.value)} autoFocus={choosing} />
          </div>
          {store.books.value.size ? (
            <BookList query={query} onPick={(_s, key) => (store.showBook(side, key), setChoosing(false))} />
          ) : (
            <div class="empty">
              <Icon name="oz_book_open_medium_lines" size={40} />
              <span>עדיין לא נפתחו ספרים. גררו לכאן ספר או מסד, או פתחו מהמסך הראשי.</span>
            </div>
          )}
        </div>
      ) : (
        <BookView key={book.key} side={side} bookKey={book.key} lineCount={book.lineCount} />
      )}
    </section>
  );
}

function ReaderHead({ side, title, onChoose }: { side: Side; title: string | undefined; onChoose: () => void }) {
  return (
    <div class="panel-head" data-panel={side}>
      <span class="grip" title="גררו כדי להזיז את הפאנל">
        <Icon name="fl_re_order_dots_vertical" size={16} />
      </span>
      <span class={`side-badge ${side}`}>{SIDE_LABEL[side]}</span>
      <h2 class="grow" title={title}>{title ?? "לא נבחר ספר"}</h2>
      <button class="icon-btn" onClick={onChoose} title="בחירת ספר אחר" aria-label="בחירת ספר">
        <Icon name="oz_book_search" />
      </button>
    </div>
  );
}

function BookView({ side, bookKey, lineCount }: { side: Side; bookKey: string; lineCount: number | undefined }) {
  const store = useStore();
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
        el.classList.remove("flash");
        void el.offsetWidth;
        el.classList.add("flash");
      }),
    );
  }, [focus?.seq]);

  const marks = useLineMarks(side, bookKey);
  const pick = store.pick[side].value;
  const pickHere = pick && pick.bookKey === bookKey ? pick : null;

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
    store.pickLine(side, bookKey, i, e.shiftKey);
    if (side === "target" && store.prefs.createMode.value === "click" && store.pick.source.value) createNow();
  };

  const createNow = () => {
    const made = store.createFromDraft();
    if (made) store.notify("success", "הקישור נוצר.", undefined, { label: "ביטול", run: () => store.undo() });
    else if (store.draftProblems.value.length) store.notify("error", `הקישור לא נוצר: ${store.draftProblems.value.find((p) => p.severity === "error")?.message ?? ""}`);
  };

  const onKey = (e: KeyboardEvent) => {
    if (!pickHere || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
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
            const from = JSON.parse(raw) as { bookKey: string; line: number };
            store.pickLine("source", from.bookKey, from.line);
            store.pickLine("target", bookKey, Number(ln.dataset.i));
            store.sideTab.value = "builder";
            if (store.prefs.createMode.value === "click") createNow();
          },
        };

  return (
    <>
      <ReaderTools side={side} bookKey={bookKey} count={count} />
      <div class="panel-body" ref={scroller} tabIndex={0} onKeyDown={onKey} aria-label="שורות הספר">
        <div class="lines" onClick={onClick} {...dnd}>
          {Array.from({ length: chunks }, (_, c) => (
            <Chunk key={c} c={c} bookKey={bookKey} active={active.has(c)} io={io} count={count} marks={marks} pick={pickHere} dropLine={dropLine} draggableNo={side === "source"} />
          ))}
        </div>
      </div>
    </>
  );
}

interface Marks {
  project: Map<number, { new: number; file: number; deleted: number }>;
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
  void side;
  return { project: project.value };
}

function Chunk(props: { c: number; bookKey: string; active: boolean; io: IntersectionObserver; count: number | undefined; marks: Marks; pick: { line: number; end?: number; anchor?: { text: string } } | null; dropLine: number | null; draggableNo: boolean }) {
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
        return <Line key={i} l={l} picked={!!props.pick && i >= props.pick.line && i <= (props.pick.end ?? props.pick.line)} mark={props.marks.project.get(i)} db={dbCount.get(i) ?? 0} dropOver={props.dropLine === i} draggableNo={props.draggableNo} />;
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

function Line({ l, picked, mark, db, dropOver, draggableNo }: { l: SourceLine; picked: boolean; mark: { new: number; file: number; deleted: number } | undefined; db: number; dropOver: boolean; draggableNo: boolean }) {
  const html = useMemo(() => sanitizeBookHtml(l.anchorText), [l.anchorText]);
  const cls = `ln${l.heading !== null ? " heading" : ""}${picked ? " picked" : ""}${dropOver ? " drop-over" : ""}`;
  return (
    <div class={cls} data-i={l.index} title={l.heading !== null ? "שורת כותרת — אוצריא לא יוצרת קישור אל כותרת או ממנה" : undefined}>
      <span class="no" draggable={draggableNo} title={draggableNo ? "גררו את המספר אל שורה בספר היעד" : undefined}>{l.index + 1}</span>
      <span class="tx" dangerouslySetInnerHTML={{ __html: html }} />
      <span class="marks">
        {mark?.new ? <span class="mark new" title={`${mark.new} קישורים חדשים או ערוכים`}>{mark.new}</span> : null}
        {mark?.file ? <span class="mark file" title={`${mark.file} קישורים מקובץ שיובא`}>{mark.file}</span> : null}
        {mark?.deleted ? <span class="mark deleted" title={`${mark.deleted} קישורים שיימחקו`}>{mark.deleted}</span> : null}
        {db ? <span class="mark db" title={`${db} קישורים קיימים במסד`}>{db}</span> : null}
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
