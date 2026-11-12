import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { describeMapping, mappingProblems, ROWID, type ColumnPreview, type DbMapping, type PendingDb, type TablePreview } from "../../core/db-mapping";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import "./db-mapping-dialog.css";

/*
 * The mapping wizard: a SQLite database that is not in Otzaria's schema was opened. The worker sent
 * its tables, columns and a few rows, and a guess. The basic path is one sentence ("this is what I
 * found") and one button; "שינוי המיפוי" shows the fields, and advanced mode adds indexes, sizes and
 * the optional links table. Nothing is read from the database until the user confirms.
 */
export function DbMappingDialog() {
  const store = useStore();
  const p = store.pendingDbs.value[0];
  return p ? <Wizard key={p.token} pending={p} /> : null;
}

const KIND_LABEL: Record<ColumnPreview["kind"], string> = {
  integer: "מספר",
  real: "מספר",
  text: "טקסט",
  html: "HTML",
  compressed: "טקסט דחוס",
  binary: "בינארי",
  empty: "ריק",
};

function Wizard({ pending }: { pending: PendingDb }) {
  const store = useStore();
  const ref = useRef<HTMLDialogElement>(null);
  const advanced = store.prefs.advanced.value;
  const tables = pending.preview.tables;
  const [m, setM] = useState<DbMapping>(() => pending.guess ?? blankMapping(tables));
  const [editing, setEditing] = useState(!pending.guess);
  const [busy, setBusy] = useState(false);
  const problems = useMemo(() => mappingProblems(pending.preview, m), [m, pending]);
  const blocked = problems.some((x) => x.level === "error");
  const task = store.task.value;
  const table = (name: string | undefined) => tables.find((t) => t.name === name);
  const lines = table(m.lines.table);
  const books = m.layout === "two-tables" ? table(m.books?.table) : undefined;

  useEffect(() => ref.current?.showModal(), []);

  const setLines = (patch: Partial<DbMapping["lines"]>) => setM({ ...m, lines: { ...m.lines, ...patch } });
  const setBooks = (patch: Partial<NonNullable<DbMapping["books"]>>) => setM({ ...m, books: { ...(m.books ?? { table: "", id: ROWID, title: "" }), ...patch } });
  const open = async () => {
    setBusy(true);
    const ok = await store.openMapped(pending, m);
    if (!ok) setBusy(false); // stays open with the error notice; on success the dialog goes away
  };

  return (
    <dialog ref={ref} class="db-map" onClose={() => store.pendingDbs.value.some((x) => x.token === pending.token) && store.dismissMapping(pending.token)} aria-labelledby="dbmap-title">
      <div class="dlg">
        <header>
          <Icon name="fl_database" size={24} />
          <h2 id="dbmap-title">איך לקרוא את המסד "{pending.label}"?</h2>
        </header>
        <div class="body">
          <p class="muted" style="margin:0">
            המסד אינו במבנה של אוצריא. יש בו {tables.length.toLocaleString("he")} טבלאות. כדי לפתוח אותו, צריך לומר לכלי איפה שמות הספרים ואיפה שורות הטקסט.
            {pending.guess ? " ניחשתי לפי השמות והתוכן — בדקו שזה נכון." : " לא מצאתי ניחוש סביר; בחרו בעצמכם."}
          </p>

          {!editing && (
            <div class="map-summary">
              <b>מה מצאתי:</b> {describeMapping(m)}
              <button class="btn text" onClick={() => setEditing(true)}>
                <Icon name="fl_settings" size={16} />
                שינוי המיפוי
              </button>
            </div>
          )}

          {editing && (
            <>
              <fieldset class="map-layout">
                <legend>איך הספרים בנויים</legend>
                <label>
                  <input type="radio" name="layout" checked={m.layout === "two-tables"} onChange={() => setM(toLayout(m, "two-tables", tables))} />
                  טבלת ספרים וטבלת שורות
                </label>
                <label>
                  <input type="radio" name="layout" checked={m.layout === "single-table"} onChange={() => setM(toLayout(m, "single-table", tables))} />
                  טבלה אחת: כל רשומה היא שורה, ועמודה בה היא שם הספר
                </label>
              </fieldset>

              {m.layout === "two-tables" && (
                <fieldset class="map-grid">
                  <legend>ספרים</legend>
                  <TableSelect label="טבלה" tables={tables} value={m.books?.table ?? ""} advanced={advanced} onChange={(t) => setBooks(retargetBooks(table(t)))} />
                  {books && (
                    <>
                      <ColumnSelect label="מזהה הספר" table={books} value={m.books!.id} rowid onChange={(v) => setBooks({ id: v! })} />
                      <ColumnSelect label="שם הספר" table={books} value={m.books!.title} onChange={(v) => setBooks({ title: v! })} />
                      <ColumnSelect label="קטגוריה (לא חובה)" table={books} value={m.books!.category} optional onChange={(v) => setBooks({ category: v })} />
                      {advanced && <ColumnSelect label="נתיב (לא חובה)" table={books} value={m.books!.path} optional onChange={(v) => setBooks({ path: v })} />}
                    </>
                  )}
                </fieldset>
              )}

              <fieldset class="map-grid">
                <legend>שורות</legend>
                <TableSelect label="טבלה" tables={tables} value={m.lines.table} advanced={advanced} onChange={(t) => setLines(retargetLines(table(t), m.layout))} />
                {lines && (
                  <>
                    <ColumnSelect label={m.layout === "two-tables" ? "הספר של השורה (מזהה)" : "שם הספר"} table={lines} value={m.lines.book} onChange={(v) => setLines({ book: v! })} />
                    <ColumnSelect label="סדר השורות" table={lines} value={m.lines.order} rowid onChange={(v) => setLines({ order: v! })} />
                    <ColumnSelect label="טקסט השורה" table={lines} value={m.lines.text} onChange={(v) => setLines({ text: v! })} />
                    <ColumnSelect label="רמת כותרת (לא חובה)" table={lines} value={m.lines.heading} optional onChange={(v) => setLines({ heading: v })} />
                    {m.layout === "single-table" && advanced && <ColumnSelect label="נתיב (לא חובה)" table={lines} value={m.lines.path} optional onChange={(v) => setLines({ path: v })} />}
                  </>
                )}
              </fieldset>

              {advanced && <LinksFields m={m} tables={tables} onChange={setM} />}
            </>
          )}

          {lines && <Sample title={`שורות לדוגמה מ"${lines.name}"`} table={lines} roles={lineRoles(m)} />}
          {editing && books && <Sample title={`ספרים לדוגמה מ"${books.name}"`} table={books} roles={bookRoles(m)} />}

          {problems.length > 0 && (
            <ul class="problems">
              {problems.map((x, i) => (
                <li key={i} class={x.level}>
                  <Icon name={x.level === "error" ? "fl_error_circle" : x.level === "warning" ? "fl_warning" : "fl_info"} size={16} />
                  <span>{x.message}</span>
                </li>
              ))}
            </ul>
          )}

          {(pending.preview.notes.length > 0 || advanced) && (
            <details class="held">
              <summary>עוד על המסד</summary>
              <ul class="map-notes">
                {pending.preview.notes.map((n, i) => <li key={i}>{n}</li>)}
                {advanced &&
                  tables.map((t) => (
                    <li key={t.name}>
                      <b>{t.name}</b>: {t.columns.length} עמודות, {t.pages.toLocaleString("he")} עמודי נתונים{t.withoutRowid ? ", WITHOUT ROWID" : ""}
                      {t.indexes.length > 0 ? `; אינדקסים: ${t.indexes.map((ix) => `${ix.name}(${ix.columns.join(", ")})${ix.seekable ? "" : " — לא שמיש"}`).join("; ")}` : "; אין אינדקסים"}
                    </li>
                  ))}
                {advanced && <li class="muted">טביעת המבנה: {pending.preview.fingerprint}. מיפוי נשמר בפרויקט לפי הטביעה, ומסד עם אותו מבנה ייפתח לפיו בלי לשאול.</li>}
              </ul>
            </details>
          )}
        </div>
        <footer>
          {busy && task ? (
            <div class="task grow" role="status">
              <span>{task.label}</span>
              {task.total > 0 && <progress max={task.total} value={task.done} />}
              <button class="btn text" onClick={task.cancel}>ביטול</button>
            </div>
          ) : (
            <>
              <button class="btn text" onClick={() => ref.current?.close()}>לא לפתוח</button>
              <button class="btn filled" disabled={blocked || busy} onClick={() => void open()}>
                <Icon name="oz_book_open_medium_lines" size={18} />
                פתיחה
              </button>
            </>
          )}
        </footer>
      </div>
    </dialog>
  );
}

function TableSelect({ label, tables, value, advanced, onChange }: { label: string; tables: TablePreview[]; value: string; advanced: boolean; onChange: (t: string) => void }) {
  return (
    <label class="field">
      {label}
      <select value={value} onChange={(e) => onChange(e.currentTarget.value)}>
        <option value="">בחרו טבלה…</option>
        {tables.map((t) => (
          <option key={t.name} value={t.name}>
            {t.name} ({t.columns.length} עמודות{advanced ? `, ${t.pages.toLocaleString("he")} עמודים` : ""})
          </option>
        ))}
      </select>
    </label>
  );
}

function ColumnSelect(props: { label: string; table: TablePreview; value: string | undefined; rowid?: boolean; optional?: boolean; onChange: (v: string | undefined) => void }) {
  const { label, table, value, rowid, optional, onChange } = props;
  return (
    <label class="field">
      {label}
      <select value={value ?? ""} onChange={(e) => onChange(e.currentTarget.value || undefined)}>
        <option value="">{optional ? "— אין —" : "בחרו עמודה…"}</option>
        {rowid && !table.withoutRowid && <option value={ROWID}>סדר הרשומות במסד (rowid)</option>}
        {table.columns.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name} · {KIND_LABEL[c.kind]}
          </option>
        ))}
      </select>
    </label>
  );
}

function LinksFields({ m, tables, onChange }: { m: DbMapping; tables: TablePreview[]; onChange: (m: DbMapping) => void }) {
  const t = tables.find((x) => x.name === m.links?.table);
  const set = (patch: Partial<NonNullable<DbMapping["links"]>>) => onChange({ ...m, links: { ...(m.links ?? { table: "", source: "", target: "" }), ...patch } });
  return (
    <fieldset class="map-grid">
      <legend>קישורים קיימים (לא חובה)</legend>
      <label class="field">
        טבלה
        <select
          value={m.links?.table ?? ""}
          onChange={(e) => {
            const v = e.currentTarget.value;
            if (!v) {
              const { links: _drop, ...rest } = m;
              onChange(rest);
            } else set({ table: v, source: "", target: "" });
          }}
        >
          <option value="">— בלי קישורים —</option>
          {tables.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
        </select>
      </label>
      {t && (
        <>
          <ColumnSelect label="שורת המקור (מזהה שורה)" table={t} value={m.links!.source} onChange={(v) => set({ source: v ?? "" })} />
          <ColumnSelect label="שורת היעד (מזהה שורה)" table={t} value={m.links!.target} onChange={(v) => set({ target: v ?? "" })} />
          <ColumnSelect label="סוג הקישור (לא חובה)" table={t} value={m.links!.type} optional onChange={(v) => set({ type: v })} />
          <p class="muted map-wide">מזהה שורה = ה־rowid של טבלת השורות. קישורים מהמסד מוצגים ונבדקים, אבל לא מיוצאים.</p>
        </>
      )}
    </fieldset>
  );
}

/** A few rows of a table, with the mapped columns marked by their role. */
function Sample({ title, table, roles }: { title: string; table: TablePreview; roles: Record<string, string> }) {
  if (!table.samples.length) return <p class="muted" style="margin:0">{title}: הטבלה ריקה.</p>;
  return (
    <div class="map-sample">
      <div class="muted">{title}</div>
      <div class="map-scroll">
        <table class="sug-table">
          <thead>
            <tr>
              {roles[ROWID] && <th class="mapped">rowid<span class="map-role">{roles[ROWID]}</span></th>}
              {table.columns.map((c) => (
                <th key={c.name} class={roles[c.name] ? "mapped" : ""}>
                  {c.name}
                  {roles[c.name] && <span class="map-role">{roles[c.name]}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.samples.map((row, i) => (
              <tr key={i}>
                {roles[ROWID] && <td class="mapped muted">—</td>}
                {row.map((v, j) => (
                  <td key={j} dir="auto" class={roles[table.columns[j]!.name] ? "mapped" : ""} title={v}>{v || <span class="muted">—</span>}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function lineRoles(m: DbMapping): Record<string, string> {
  const r: Record<string, string> = {};
  const add = (col: string | undefined, role: string) => col && (r[col] = r[col] ? `${r[col]}, ${role}` : role);
  add(m.lines.book, m.layout === "two-tables" ? "ספר" : "שם הספר");
  add(m.lines.order, "סדר");
  add(m.lines.text, "טקסט");
  add(m.lines.heading, "כותרת");
  add(m.lines.path, "נתיב");
  return r;
}

function bookRoles(m: DbMapping): Record<string, string> {
  const r: Record<string, string> = {};
  const add = (col: string | undefined, role: string) => col && (r[col] = role);
  add(m.books?.id, "מזהה");
  add(m.books?.title, "שם");
  add(m.books?.category, "קטגוריה");
  add(m.books?.path, "נתיב");
  return r;
}

const textual = (c: ColumnPreview) => c.kind === "text" || c.kind === "html" || c.kind === "compressed";
const longest = (t: TablePreview | undefined) => t?.columns.filter(textual).sort((a, b) => b.avgLength - a.avgLength)[0]?.name ?? "";

/** Sensible defaults when the user picks another lines table. */
function retargetLines(t: TablePreview | undefined, layout: DbMapping["layout"]): DbMapping["lines"] {
  if (!t) return { table: "", book: "", order: ROWID, text: "" };
  const text = longest(t);
  const book = layout === "single-table" ? (t.columns.find((c) => textual(c) && c.name !== text)?.name ?? "") : (t.columns.find((c) => /book|sefer|work|ספר/i.test(c.name))?.name ?? "");
  return { table: t.name, book, order: t.withoutRowid ? (t.primaryKey[1] ?? "") : ROWID, text };
}

function retargetBooks(t: TablePreview | undefined): NonNullable<DbMapping["books"]> {
  if (!t) return { table: "", id: ROWID, title: "" };
  const id = t.columns.find((c) => c.rowidAlias)?.name ?? (t.withoutRowid ? (t.primaryKey[0] ?? "") : ROWID);
  const title = t.columns.filter(textual).sort((a, b) => a.avgLength - b.avgLength)[0]?.name ?? "";
  return { table: t.name, id, title };
}

function toLayout(m: DbMapping, layout: DbMapping["layout"], tables: TablePreview[]): DbMapping {
  if (m.layout === layout) return m;
  const lines = { ...m.lines, book: "" };
  if (layout === "single-table") {
    const { books: _b, ...rest } = m;
    return { ...rest, layout, lines };
  }
  const { path: _p, ...ln } = lines;
  return { ...m, layout, lines: ln, books: retargetBooks(tables.find((t) => t.name !== m.lines.table && t.columns.some(textual))) };
}

function blankMapping(tables: TablePreview[]): DbMapping {
  const withText = [...tables].sort((a, b) => b.pages - a.pages).find((t) => t.columns.some(textual));
  return { layout: "single-table", lines: retargetLines(withText, "single-table") };
}
