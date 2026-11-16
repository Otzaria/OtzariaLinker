import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  describeMapping,
  mappingProblems,
  ROWID,
  UNIT_LABEL,
  type ColumnPreview,
  type DbMapping,
  type MappingTest,
  type PendingDb,
  type TablePreview,
  type TextCandidate,
  type TextUnit,
} from "../../core/db-mapping";
import { stripTags } from "../../core/text/html";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { TaskAnnouncer } from "../shell/app-bar";
import "./db-mapping-dialog.css";

/*
 * The mapping wizard: a SQLite database that is not in Otzaria's schema was opened. The worker sent
 * its tables, columns and a few rows, and an explained guess (core/db-guess.ts). The basic path is
 * one sentence ("this is what I found"), the reasons, and one button; "שינוי המיפוי" shows the
 * fields, and advanced mode adds indexes, sizes and the optional links table. When nothing looks
 * like book text the wizard says so ("לא נמצאו ספרים") instead of proposing a table; manual mapping
 * stays one click away. What the tool cannot read (views, virtual tables, encodings) is listed
 * honestly. "בדיקת המיפוי" reads the first lines of the first books before anything is opened.
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

type TestState = MappingTest | { error: string } | "running" | null;

function Wizard({ pending }: { pending: PendingDb }) {
  const store = useStore();
  const ref = useRef<HTMLDialogElement>(null);
  const advanced = store.prefs.advanced.value;
  const tables = pending.preview.tables;
  const analysis = pending.analysis;
  const noBooks = !pending.guess && !!analysis?.noBooks;
  const [m, setM] = useState<DbMapping>(() => pending.guess ?? blankMapping(tables));
  // no guess: the fields at once — unless the analysis found no books, which is said first
  const [editing, setEditing] = useState(!pending.guess && !noBooks);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<TestState>(null);
  const problems = useMemo(() => mappingProblems(pending.preview, m), [m, pending]);
  const manual = editing || !noBooks;
  const blocked = problems.some((x) => x.level === "error") || !manual;
  const task = store.task.value;
  const table = (name: string | undefined) => tables.find((t) => t.name === name);
  const lines = table(m.lines.table);
  const books = m.layout === "two-tables" ? table(m.books?.table) : undefined;
  const chosen = analysis?.candidates.find((c) => c.table === m.lines.table && c.column === m.lines.text);

  useEffect(() => ref.current?.showModal(), []);
  useEffect(() => setTest(null), [m]); // a result is about the mapping it was made with

  const setLines = (patch: Partial<DbMapping["lines"]>) => setM({ ...m, lines: clean({ ...m.lines, ...patch }) });
  const setBooks = (patch: Partial<NonNullable<DbMapping["books"]>>) => setM({ ...m, books: { ...(m.books ?? { table: "", id: ROWID, title: "" }), ...patch } });
  const runTest = async () => {
    setTest("running");
    setTest(await store.testMapping(pending, m));
  };
  const open = async () => {
    setBusy(true);
    const ok = await store.openMapped(pending, m);
    if (!ok) setBusy(false); // stays open with the error notice; on success the dialog goes away
  };

  return (
    <dialog ref={ref} class="db-map" onClose={() => store.pendingDbs.value.some((x) => x.token === pending.token) && store.dismissMapping(pending.token)} aria-labelledby="dbmap-title">
      <div class="dlg">
        <TaskAnnouncer />
        <header>
          <Icon name="fl_database" size={24} />
          <h2 id="dbmap-title">איך לקרוא את המסד "{pending.label}"?</h2>
        </header>
        <div class="body">
          <p class="muted" style="margin:0">
            המסד אינו במבנה של אוצריא. יש בו {tables.length.toLocaleString("he")} טבלאות. כדי לפתוח אותו, צריך לומר לכלי איפה שמות הספרים ואיפה שורות הטקסט.
            {pending.guess ? " ניחשתי לפי השמות והתוכן — בדקו שזה נכון." : noBooks ? "" : " לא מצאתי ניחוש סביר; בחרו בעצמכם."}
          </p>

          {noBooks && (
            <div class="map-nobooks" role="status">
              <Icon name="fl_dismiss_circle" size={20} />
              <div>
                <b>לא נמצאו ספרים במסד הזה.</b> {analysis!.summary.replace(/^לא נמצאו ספרים במסד הזה:\s*/, "")}
                {!editing && (
                  <div>
                    <button class="btn text" onClick={() => setEditing(true)}>
                      <Icon name="fl_settings" size={16} />
                      מיפוי ידני בכל זאת
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {analysis && analysis.limitations.length > 0 && (
            <div class="map-limits">
              <b>מה הכלי אינו קורא במסד הזה</b>
              <ul>
                {analysis.limitations.map((x, i) => <li key={i}>{x}</li>)}
              </ul>
            </div>
          )}

          {!editing && !noBooks && (
            <div class="map-summary">
              <b>מה מצאתי:</b> {describeMapping(m)}
              <button class="btn text" onClick={() => setEditing(true)}>
                <Icon name="fl_settings" size={16} />
                שינוי המיפוי
              </button>
            </div>
          )}

          {analysis && analysis.candidates.length > 0 && (
            <Candidates
              chosen={chosen}
              candidates={analysis.candidates}
              current={m}
              noBooks={noBooks}
              onUse={(x) => {
                setM(x);
                setEditing(true);
              }}
            />
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
                  טבלה אחת: כל רשומה היא שורה (או ספר שלם), ועמודה בה היא שם הספר
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
                    <ColumnSelect label={m.layout === "two-tables" ? (m.via ? "הפרק או המהדורה של השורה (מזהה)" : "הספר של השורה (מזהה)") : "שם הספר"} table={lines} value={m.lines.book} onChange={(v) => setLines({ book: v! })} />
                    <ColumnSelect label="סדר השורות" table={lines} value={m.lines.order} rowid onChange={(v) => setLines({ order: v! })} />
                    <ColumnSelect label="סדר משני (לא חובה)" table={lines} value={m.lines.orderThen?.[0]} optional onChange={(v) => setLines({ orderThen: v ? [v] : undefined })} />
                    <ColumnSelect label="טקסט השורה" table={lines} value={m.lines.text} onChange={(v) => setLines({ text: v! })} />
                    <label class="field">
                      יחידת הטקסט
                      <select value={m.lines.unit ?? "line"} onChange={(e) => setLines({ unit: e.currentTarget.value === "line" ? undefined : (e.currentTarget.value as TextUnit) })}>
                        {(Object.keys(UNIT_LABEL) as TextUnit[]).map((u) => (
                          <option key={u} value={u}>
                            {UNIT_LABEL[u]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <ColumnSelect label="רמת כותרת (לא חובה)" table={lines} value={m.lines.heading} optional onChange={(v) => setLines({ heading: v })} />
                    {m.layout === "single-table" && advanced && <ColumnSelect label="נתיב (לא חובה)" table={lines} value={m.lines.path} optional onChange={(v) => setLines({ path: v })} />}
                  </>
                )}
              </fieldset>

              {m.layout === "two-tables" && (advanced || m.via) && <ViaFields m={m} tables={tables} onChange={setM} />}
              {advanced && <LinksFields m={m} tables={tables} onChange={setM} />}
            </>
          )}

          {manual && lines && <Sample title={`שורות לדוגמה מ"${lines.name}"`} table={lines} roles={lineRoles(m)} />}
          {editing && books && <Sample title={`ספרים לדוגמה מ"${books.name}"`} table={books} roles={bookRoles(m)} />}

          {chosen && chosen.warnings.length > 0 && (
            <ul class="problems">
              {chosen.warnings.map((w, i) => (
                <li key={i} class="warning">
                  <Icon name="fl_warning" size={16} />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          )}

          {manual && problems.length > 0 && (
            <ul class="problems">
              {problems.map((x, i) => (
                <li key={i} class={x.level}>
                  <Icon name={x.level === "error" ? "fl_error_circle" : x.level === "warning" ? "fl_warning" : "fl_info"} size={16} />
                  <span>{x.message}</span>
                </li>
              ))}
            </ul>
          )}

          {manual && <TestResult test={test} />}

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
            <div class="task grow">
              <span>{task.label}</span>
              {task.total > 0 && <progress max={task.total} value={task.done} />}
              <button class="btn text" onClick={task.cancel}>ביטול</button>
            </div>
          ) : (
            <>
              <button class="btn text" onClick={() => ref.current?.close()}>לא לפתוח</button>
              {manual && (
                <button class="btn outlined" disabled={blocked || busy || test === "running"} onClick={() => void runTest()}>
                  <Icon name="fl_checkmark_circle" size={18} />
                  בדיקת המיפוי
                </button>
              )}
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

/** Why this guess: the reasons of the chosen candidate, and the other candidates with their verdicts. */
function Candidates(props: { chosen: TextCandidate | undefined; candidates: TextCandidate[]; current: DbMapping; noBooks: boolean; onUse: (m: DbMapping) => void }) {
  const { candidates, current, noBooks, onUse } = props;
  // with no books, every candidate is listed under its own name (the fields' default is not a choice)
  const chosen = noBooks ? undefined : props.chosen;
  const others = noBooks ? candidates.slice(0, 5) : candidates.filter((c) => c !== chosen);
  return (
    <details class="held map-why" open={noBooks}>
      <summary>{noBooks ? "מה בדקתי, ולמה כל עמודה נפסלה" : "למה ניחשתי כך"}</summary>
      {chosen && <Reasons c={chosen} />}
      {others.length > 0 && (
        <ul class="map-cands">
          {!noBooks && <li class="muted">עמודות אחרות שבדקתי:</li>}
          {others.map((c) => (
            <li key={`${c.table}.${c.column}`}>
              <div class="map-cand-head">
                <b dir="ltr">
                  {c.table}.{c.column}
                </b>
                <span class={`map-verdict ${c.verdict}`}>{c.verdict === "books" ? "טקסט של ספרים" : c.verdict === "weak" ? "מועמד חלש" : "נפסל"}</span>
                {c.mapping && c.verdict !== "rejected" && JSON.stringify(c.mapping) !== JSON.stringify(current) && (
                  <button class="btn text" onClick={() => onUse(c.mapping!)}>
                    להשתמש בזה
                  </button>
                )}
              </div>
              <Reasons c={c} />
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function Reasons({ c }: { c: TextCandidate }) {
  return (
    <ul class="map-reasons" aria-label={`הסיבות: ${c.table}.${c.column}`}>
      {c.reasons.map((r, i) => (
        <li key={i} class={r.weight > 0 ? "plus" : r.weight < 0 ? "minus" : "fact"}>
          <span aria-hidden="true">{r.weight > 0 ? "+" : r.weight < 0 ? "−" : "·"}</span> {r.text}
        </li>
      ))}
    </ul>
  );
}

/** The first lines of the first books, as "בדיקת המיפוי" read them. */
function TestResult({ test }: { test: TestState }) {
  if (!test) return null;
  if (test === "running") return <p class="muted map-test">בודק את המיפוי…</p>;
  if ("error" in test)
    return (
      <div class="map-test" role="status">
        <Icon name="fl_error_circle" size={16} /> הבדיקה נכשלה: {test.error}
      </div>
    );
  return (
    <div class="map-test" role="status" aria-label="תוצאת בדיקת המיפוי">
      <p style="margin:0">
        <b>{test.books ? `נמצאו ${test.books.toLocaleString("he")} ספרים${test.partial ? " בתחילת המסד (נבדק רק חלק ממנו)" : ""}.` : "לפי המיפוי הזה אין במסד אף ספר."}</b>
        {test.undecodable > 0 && ` ${test.undecodable.toLocaleString("he")} שורות לא פוענחו.`}
      </p>
      {test.sample.map((b, i) => (
        <div key={i} class="map-test-book">
          <div>
            <b>{b.title}</b>
            {b.lineCount !== null && <span class="muted"> · {b.lineCount.toLocaleString("he")} שורות</span>}
          </div>
          {b.lines.length ? (
            <ol>
              {b.lines.map((l, j) => (
                <li key={j} dir="auto" class={l.heading ? "heading" : ""}>
                  {stripTags(l.text) || <span class="muted">(שורה ריקה)</span>}
                </li>
              ))}
            </ol>
          ) : (
            <p class="muted" style="margin:0">
              אין בספר שורות.
            </p>
          )}
        </div>
      ))}
      {test.warnings.map((w, i) => (
        <p key={i} class="muted" style="margin:0">
          <Icon name="fl_warning" size={14} /> {w}
        </p>
      ))}
    </div>
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

/** Optional: a chapters or versions table between the lines and the books. */
function ViaFields({ m, tables, onChange }: { m: DbMapping; tables: TablePreview[]; onChange: (m: DbMapping) => void }) {
  const t = tables.find((x) => x.name === m.via?.table);
  const set = (patch: Partial<NonNullable<DbMapping["via"]>>) => onChange({ ...m, via: clean({ ...(m.via ?? { table: "", id: ROWID, book: "", kind: "part" as const }), ...patch }) });
  return (
    <fieldset class="map-grid">
      <legend>פרקים או מהדורות בין השורות לספרים (לא חובה)</legend>
      <label class="field">
        טבלה
        <select
          value={m.via?.table ?? ""}
          onChange={(e) => {
            const v = e.currentTarget.value;
            if (!v) {
              const { via: _drop, ...rest } = m;
              onChange(rest);
            } else set({ table: v, id: tables.find((x) => x.name === v)?.columns.find((c) => c.rowidAlias)?.name ?? ROWID, book: "", order: undefined, title: undefined });
          }}
        >
          <option value="">— השורות מפנות ישר לספר —</option>
          {tables.map((x) => (
            <option key={x.name} value={x.name}>
              {x.name}
            </option>
          ))}
        </select>
      </label>
      {t && (
        <>
          <ColumnSelect label="מזהה הפרק או המהדורה" table={t} value={m.via!.id} rowid onChange={(v) => set({ id: v ?? "" })} />
          <ColumnSelect label="הספר שלו (מזהה)" table={t} value={m.via!.book} onChange={(v) => set({ book: v ?? "" })} />
          <ColumnSelect label="סדר (לא חובה)" table={t} value={m.via!.order} rowid optional onChange={(v) => set({ order: v })} />
          <ColumnSelect label="שם (לא חובה)" table={t} value={m.via!.title} optional onChange={(v) => set({ title: v })} />
          <label class="field">
            כל רשומה בה היא
            <select value={m.via!.kind} onChange={(e) => set({ kind: e.currentTarget.value as "part" | "edition" })}>
              <option value="part">פרק (השורות מצטרפות לספר אחד)</option>
              <option value="edition">מהדורה (כל מהדורה היא ספר נפרד)</option>
            </select>
          </label>
          <p class="muted map-wide">עם טבלה כזאת, "הספר של השורה" בטבלת השורות הוא מזהה הפרק או המהדורה.</p>
        </>
      )}
    </fieldset>
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
  add(m.lines.book, m.layout === "two-tables" ? (m.via ? "פרק/מהדורה" : "ספר") : "שם הספר");
  add(m.lines.order, "סדר");
  for (const c of m.lines.orderThen ?? []) add(c, "סדר משני");
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

/** Drops the keys a select set to undefined, so a mapping compares and saves like a parsed one. */
function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
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
    const { books: _b, via: _v, ...rest } = m;
    return { ...rest, layout, lines };
  }
  const { path: _p, ...ln } = lines;
  return { ...m, layout, lines: ln, books: retargetBooks(tables.find((t) => t.name !== m.lines.table && t.columns.some(textual))) };
}

function blankMapping(tables: TablePreview[]): DbMapping {
  const withText = [...tables].sort((a, b) => b.pages - a.pages).find((t) => t.columns.some(textual));
  return { layout: "single-table", lines: retargetLines(withText, "single-table") };
}
