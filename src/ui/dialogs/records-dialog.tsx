import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { parseConnectionType, TYPE_LABELS } from "../../core/links/connection-type";
import { mappingGaps, recordsToLinksFiles, type FieldOrFixed, type RecordsMapping, type RecordsTable } from "../../formats/records/records";
import { TYPE_CHOICES } from "../../state/store";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import "./records-dialog.css";

/*
 * Links in someone else's layout (a JSON file, JSON Lines, or a sheet with other column names): the
 * user says which field is what. The guess is preselected, a preview shows the first records as they
 * will be imported, and the import goes through the ordinary links-file parser and validation.
 */
export function RecordsDialog() {
  const store = useStore();
  const p = store.exchange.pendingRecords.value[0];
  return p ? <Mapper key={p.path} path={p.path} table={p.table} initial={p.mapping} /> : null;
}

const PREVIEW = 5;
const NONE = "";

function Mapper({ path, table, initial }: { path: string; table: RecordsTable; initial: RecordsMapping }) {
  const store = useStore();
  const ref = useRef<HTMLDialogElement>(null);
  const [m, setM] = useState<RecordsMapping>(initial);
  const advanced = store.prefs.advanced.value;
  useEffect(() => ref.current?.showModal(), []);

  const gaps = mappingGaps(m);
  const preview = useMemo(() => (gaps.length ? null : recordsToLinksFiles({ ...table, rows: table.rows.slice(0, PREVIEW) }, m, path)), [m, table]);
  const set = (patch: Partial<RecordsMapping>) => setM({ ...m, ...patch });

  const fieldSelect = (label: string, key: "sourceLine" | "sourceLineEnd" | "targetTitle" | "targetPath" | "targetLine" | "targetLineEnd" | "heRef2" | "start" | "end", required = false) => (
    <label class="field">
      {label}
      {required && <span class="req" aria-hidden="true"> *</span>}
      <select aria-required={required} value={m[key] ?? NONE} onChange={(e) => set({ [key]: e.currentTarget.value || undefined } as Partial<RecordsMapping>)}>
        <option value={NONE}>{required ? "בחרו שדה…" : "— אין —"}</option>
        {table.fields.map((f) => (
          <option key={f} value={f}>{f}</option>
        ))}
      </select>
    </label>
  );

  const sourceValue = "fromFileName" in m.source ? "\u0000file" : "fixed" in m.source ? "\u0000fixed" : m.source.field;
  const typeValue = "fixed" in m.type ? "\u0000fixed" : m.type.field;

  return (
    <dialog ref={ref} class="records-dialog" // closing after "ייבוא" must not skip the NEXT waiting file: only skip while this one is still first
      onClose={() => store.exchange.pendingRecords.value[0]?.path === path && store.exchange.skipRecords()} aria-labelledby="records-title">
      <div class="dlg">
        <header>
          <Icon name="oz_document_links" size={24} />
          <h2 id="records-title">ייבוא קישורים: {path.split(/[\\/]/).at(-1)}</h2>
        </header>
        <div class="body">
          <p class="muted" style="margin:0">
            בקובץ {table.rows.length.toLocaleString("he")} רשומות עם השדות: {table.fields.slice(0, 12).join(", ")}
            {table.fields.length > 12 ? "…" : ""}. בחרו איזה שדה הוא מה. מה שזוהה לבד כבר מסומן.
          </p>
          <div class="records-grid">
            <label class="field">
              ספר המקור
              <span class="req" aria-hidden="true"> *</span>
              <select
                aria-required="true"
                value={sourceValue}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  set({ source: v === "\u0000file" ? { fromFileName: true } : v === "\u0000fixed" ? { fixed: "" } : { field: v } });
                }}
              >
                <option value={"\u0000file"}>לפי שם הקובץ</option>
                <option value={"\u0000fixed"}>שם קבוע לכל הרשומות…</option>
                {table.fields.map((f) => (
                  <option key={f} value={f}>השדה {f}</option>
                ))}
              </select>
              {"fixed" in m.source && <input type="text" aria-label="שם ספר המקור" value={m.source.fixed} onInput={(e) => set({ source: { fixed: e.currentTarget.value } })} />}
            </label>
            {fieldSelect("שורה בספר המקור", "sourceLine", true)}
            {fieldSelect("ספר היעד (שם)", "targetTitle")}
            {fieldSelect("שורה בספר היעד", "targetLine", true)}
            <label class="field">
              סוג הקשר
              <select value={typeValue} onChange={(e) => set({ type: e.currentTarget.value === "\u0000fixed" ? { fixed: "reference" } : { field: e.currentTarget.value } })}>
                <option value={"\u0000fixed"}>סוג קבוע לכל הרשומות…</option>
                {table.fields.map((f) => (
                  <option key={f} value={f}>השדה {f}</option>
                ))}
              </select>
              {"fixed" in m.type && (
                <select aria-label="הסוג הקבוע" value={m.type.fixed} onChange={(e) => set({ type: { fixed: e.currentTarget.value } as FieldOrFixed })}>
                  {TYPE_CHOICES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              )}
            </label>
            <label class="field">
              מספור השורות בקובץ
              <select value={String(m.base)} onChange={(e) => set({ base: e.currentTarget.value === "0" ? 0 : 1 })}>
                <option value="1">מתחיל ב־1 (כמו בספרייה)</option>
                <option value="0">מתחיל ב־0</option>
              </select>
            </label>
            {advanced && (
              <>
                {fieldSelect("נתיב ספר היעד (path_2)", "targetPath")}
                {fieldSelect("שם המקום ביעד (heRef_2)", "heRef2")}
                {fieldSelect("סוף הטווח במקור", "sourceLineEnd")}
                {fieldSelect("סוף הטווח ביעד", "targetLineEnd")}
                {fieldSelect("תחילת העוגן (start)", "start")}
                {fieldSelect("סוף העוגן (end)", "end")}
              </>
            )}
          </div>
          {gaps.length > 0 ? (
            <p class="notice warning" role="status" style="margin:0">חסר: {gaps.join(", ")}.</p>
          ) : (
            preview && (
              <div class="table-wrap">
                <table class="sug-table" aria-label="תצוגה מקדימה">
                  <thead>
                    <tr><th>ספר מקור</th><th>שורה</th><th>ספר יעד</th><th>שורה</th><th>סוג</th></tr>
                  </thead>
                  <tbody>
                    {preview.files.flatMap((f) =>
                      (JSON.parse(f.text) as Record<string, unknown>[]).map((r, i) => (
                        <tr key={`${f.sourceTitle}:${i}`}>
                          <td>{f.sourceTitle}</td>
                          <td>{String(r.line_index_1)}</td>
                          <td>{String(r.path_2).replace(/\.txt$/i, "")}</td>
                          <td>{String(r.line_index_2)}</td>
                          {/* the type as the builder names it; the file's raw value only in advanced mode (audit F14) */}
                          <td>{advanced ? String(r["Conection Type"]) : TYPE_LABELS[parseConnectionType(String(r["Conection Type"] ?? "")).type].he}</td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
                {preview.problems.length > 0 && <p class="muted">בתצוגה המקדימה: {preview.problems[0]}</p>}
                <p class="muted" style="margin:4px 0 0">השורות מוצגות כפי שייכתבו לקובץ הקישורים (מ־1). אחרי הייבוא כל קישור נבדק כמו קישור מקובץ של הספרייה.</p>
              </div>
            )
          )}
        </div>
        <footer>
          <button class="btn text" onClick={() => ref.current?.close()}>דילוג על הקובץ</button>
          <button
            class="btn filled"
            disabled={gaps.length > 0}
            onClick={() => {
              store.exchange.importRecords(m);
              ref.current?.close();
            }}
          >
            ייבוא {table.rows.length.toLocaleString("he")} רשומות
          </button>
        </footer>
      </div>
    </dialog>
  );
}
