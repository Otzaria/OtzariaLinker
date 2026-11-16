import { useMemo, useState } from "preact/hooks";
import { ROW_KIND_LABEL, rowCounts, type EditionRow, type EditionRowKind } from "../../linking/edition-map";
import { wordDiff, type WordSpan } from "../../matching/line-diff";
import { useStore } from "../context";
import { plainText } from "../workspace/plain-text";
import "./edition-diff.css";

/*
 * The two editions side by side, line by line (stages 11 and 15), inside the relink dialog. A book
 * can have 50K lines, so the view pages through the aligned rows (linking/edition-map.ts) and loads
 * only the lines of the page shown, through the shared LineStore; by default it shows the changes
 * only. An edited line shows which words changed (wordDiff).
 */
const PAGE = 50;

export function EditionDiffView({ oldKey, newKey, rows }: { oldKey: string; newKey: string; rows: readonly EditionRow[] }) {
  const store = useStore();
  const [all, setAll] = useState(false);
  const [page, setPage] = useState(0);
  const counts = useMemo(() => rowCounts(rows), [rows]);
  const shown = useMemo(() => (all ? rows : rows.filter((r) => r.kind !== "same")), [rows, all]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const p = Math.min(page, pages - 1);
  const slice = shown.slice(p * PAGE, (p + 1) * PAGE);
  void store.lines.tick.value; // re-render as the page's lines arrive
  const text = (key: string, i: number): string | undefined => {
    const l = i >= 0 ? store.lines.line(key, i) : undefined;
    return l ? plainText(l.text) : undefined;
  };
  const pick = (v: boolean) => (setAll(v), setPage(0));

  return (
    <div class="ediff">
      <div class="filters" style="padding:0">
        <button class="chip" aria-pressed={!all} onClick={() => pick(false)}>
          השינויים בלבד <span class="count">{(rows.length - counts.same).toLocaleString("he")}</span>
        </button>
        <button class="chip" aria-pressed={all} onClick={() => pick(true)}>
          כל השורות <span class="count">{rows.length.toLocaleString("he")}</span>
        </button>
        <span class="ediff-legend muted">
          {(["changed", "moved", "deleted", "inserted"] as const).map((k) => (
            <span key={k} class={`ediff-key k-${k}`}>{ROW_KIND_LABEL[k]} {counts[k].toLocaleString("he")}</span>
          ))}
        </span>
      </div>
      {shown.length === 0 ? (
        <p class="muted">אין הבדלים בין שתי המהדורות.</p>
      ) : (
        <>
          <div class="ediff-scroll">
            <table class="ediff-table" aria-label="השוואת השורות">
              <thead>
                <tr><th>ישנה</th><th>הטקסט במהדורה הישנה</th><th>חדשה</th><th>הטקסט במהדורה החדשה</th><th>מצב</th></tr>
              </thead>
              <tbody>
                {slice.map((r) => (
                  <DiffRow key={`${r.kind}:${r.old}:${r.new}`} row={r} oldText={r.kind === "moved-in" ? undefined : text(oldKey, r.old)} newText={r.kind === "moved" ? undefined : text(newKey, r.new)} />
                ))}
              </tbody>
            </table>
          </div>
          <div class="ediff-pager">
            <button class="btn text" disabled={p === 0} onClick={() => setPage(p - 1)}>הקודם</button>
            <span class="muted">
              {(p * PAGE + 1).toLocaleString("he")}–{Math.min((p + 1) * PAGE, shown.length).toLocaleString("he")} מתוך {shown.length.toLocaleString("he")}
            </span>
            <button class="btn text" disabled={p >= pages - 1} onClick={() => setPage(p + 1)}>הבא</button>
          </div>
        </>
      )}
    </div>
  );
}

const num = (i: number) => (i >= 0 ? (i + 1).toLocaleString("he") : "");

function DiffRow({ row, oldText, newText }: { row: EditionRow; oldText: string | undefined; newText: string | undefined }) {
  const kind: EditionRowKind = row.kind;
  const words = kind === "changed" && oldText !== undefined && newText !== undefined ? wordDiff(oldText, newText) : null;
  const status = kind === "moved" ? `${ROW_KIND_LABEL.moved} לשורה ${num(row.new)}` : kind === "moved-in" ? `הוזזה משורה ${num(row.old)}` : ROW_KIND_LABEL[kind];
  return (
    <tr class={`k-${kind}`}>
      <td class="ln">{kind === "moved-in" ? "" : num(row.old)}</td>
      <td class="tx">{kind === "moved-in" || row.old < 0 ? "" : words ? <Spans spans={words.old} tag="del" /> : <Line text={oldText} />}</td>
      <td class="ln">{kind === "moved" ? "" : num(row.new)}</td>
      <td class="tx">{kind === "moved" || row.new < 0 ? "" : words ? <Spans spans={words.new} tag="ins" /> : <Line text={newText} />}</td>
      <td class="st">{status}</td>
    </tr>
  );
}

const Line = ({ text }: { text: string | undefined }) => (text === undefined ? <span class="muted">…</span> : <>{text}</>);

function Spans({ spans, tag: Tag }: { spans: readonly WordSpan[]; tag: "del" | "ins" }) {
  return <>{spans.map((s, k) => (s.changed ? <Tag key={k}>{s.text}</Tag> : s.text))}</>;
}
