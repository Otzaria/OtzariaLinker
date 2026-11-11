import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { entriesFromHeadings, numberInGematria } from "../../core/alt-toc/edit";
import { validateAltToc, type AltTocEntry, type AltTocOrigin, type AltTocStructure, type LibraryAltTocStructure } from "../../core/alt-toc/model";
import { useStore } from "../context";
import { Icon } from "../icons/icon";

/*
 * The alt_toc editor (version 3's "מבני כותרות אלטרנטיביים", legacy/OtzariaLinker-v3.html
 * `Dialogs.altToc`): a second table of contents for one book — parashot and aliyot, study days,
 * topics. The user edits a working copy; "שמירה" puts it into the project as ONE undoable action,
 * and the export writes it as alt_toc/<book>_alt_toc.json. A book with no structures in the
 * project starts from what its open database already has.
 */
const PAGE = 300;

export function AltTocDialog({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const ref = useRef<HTMLDialogElement>(null);
  const viewKey = store.view.source.value;
  const titles = useMemo(() => {
    const t = new Set<string>();
    if (viewKey) t.add(store.refOf(viewKey).title);
    for (const b of store.altToc.list.value) t.add(b.title);
    for (const b of store.books.value.values()) t.add(b.title);
    return [...t];
  }, []);
  const [title, setTitle] = useState(titles[0] ?? "");
  const [structs, setStructs] = useState<AltTocStructure[]>([]);
  const [cur, setCur] = useState(0);
  const [origin, setOrigin] = useState<AltTocOrigin>("user");
  const [library, setLibrary] = useState<{ automatic: LibraryAltTocStructure[]; skipped: number } | null>(null);
  const [newKey, setNewKey] = useState("");
  const [base, setBase] = useState("עליה");
  const [shown, setShown] = useState(PAGE);
  const [loading, setLoading] = useState(false);

  useEffect(() => ref.current?.showModal(), []);

  const book = title ? store.altToc.bookOf(title) : undefined;
  const inProject = title ? store.altToc.of(title) : undefined;

  // a different book: its structures from the project, else from its database
  useEffect(() => {
    let live = true;
    setCur(0);
    setShown(PAGE);
    setLibrary(null);
    if (!title) return;
    if (inProject) {
      setStructs([...inProject.structures]);
      setOrigin(inProject.origin);
      return;
    }
    setStructs([]);
    setOrigin("user");
    if (!book) return;
    setLoading(true);
    void store.altToc.fromLibrary(book.key).then((lib) => {
      if (!live) return;
      setLoading(false);
      if (!lib) return;
      setStructs(lib.editable.map(({ skipped: _s, ...s }) => s));
      if (lib.editable.length) setOrigin("db");
      setLibrary({ automatic: lib.automatic, skipped: [...lib.editable, ...lib.automatic].reduce((n, s) => n + s.skipped, 0) });
    });
    return () => void (live = false);
  }, [title]);

  const s = structs[cur];
  const ctx = title ? store.altToc.context(title) : {};
  const problems = useMemo(() => validateAltToc(structs, ctx), [structs, title, store.lines.tick.value]);
  const errors = problems.filter((p) => p.severity === "error");
  const sefaria = ctx.sefaria === true;

  const patch = (i: number, p: Partial<AltTocStructure>) => setStructs(structs.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const setEntries = (entries: AltTocEntry[]) => s && patch(cur, { entries });
  const patchEntry = (i: number, p: Partial<AltTocEntry>) => s && setEntries(s.entries.map((e, j) => (j === i ? { ...e, ...p } : e)));

  const addStructure = () => {
    const key = newKey.trim();
    if (!key) return;
    setStructs([...structs, { key, entries: [] }]);
    setCur(structs.length);
    setNewKey("");
  };
  const addEntry = () => {
    if (!s) return;
    const pick = store.pick.source.value;
    const picked = pick && book && pick.bookKey === book.key ? pick.line + 1 : undefined;
    const last = s.entries.at(-1);
    setEntries([...s.entries, { heTitle: "", line: picked ?? last?.line ?? 1, level: last?.level ?? 0 }]);
    setShown(Math.max(shown, s.entries.length + 1));
  };
  const fillFromHeadings = async () => {
    if (!book || !s) return;
    const hs = await store.altToc.headings(book.key);
    if (!hs) return;
    if (!hs.length) return void store.notify("warning", `בספר "${title}" אין שורות כותרת.`);
    setEntries(entriesFromHeadings(hs));
    store.notify("info", `מולאו ${hs.length.toLocaleString("he")} צמתים מכותרות הספר. מחקו את מה שאינו שייך לחלוקה הזו.`);
  };
  const number = () => {
    if (!s) return;
    const r = numberInGematria(s.entries, base);
    setEntries(r.entries);
    store.notify(r.changed ? "info" : "warning", r.changed ? `מוספרו ${r.changed} צמתים.` : "אין צמתים מתחת לרמה 0 למספור.");
  };
  const save = () => {
    const clean = structs.map((x): AltTocStructure => {
      const t = x.title?.trim();
      const h = x.heTitle?.trim();
      return { key: x.key.trim(), ...(t && { title: t }), ...(h && { heTitle: h }), entries: x.entries.map((e) => ({ ...e, heTitle: e.heTitle.trim() })) };
    });
    if (!inProject && !clean.length) return ref.current?.close();
    store.altToc.set(title, clean, { origin });
    const n = validateAltToc(clean, ctx).filter((p) => p.severity === "error").length;
    if (n) store.notify("warning", `מבני הכותרות של "${title}" נשמרו בפרויקט עם ${n} שגיאות. הספר לא ייוצא עד שיתוקנו.`);
    else store.notify("success", `מבני הכותרות של "${title}" נשמרו בפרויקט (${clean.length} מבנים). הם ייכתבו בייצוא.`);
    ref.current?.close();
  };

  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="alttoc-title" class="alt-toc" style="width:min(900px, calc(100vw - 32px))">
      <div class="dlg">
        <header>
          <Icon name="oz_text_bullet_list_tree" size={24} />
          <h2 id="alttoc-title">מבני כותרות אלטרנטיביים</h2>
        </header>
        <div class="body">
          <p class="muted" style="margin:0">
            חלוקה שנייה של ספר, לצד תוכן העניינים הרגיל: פרשות ועליות, ימי לימוד, נושאים. כל מבנה ייכתב לקובץ <code dir="ltr">alt_toc/{title || "…"}_alt_toc.json</code>, שמחליף בספרייה את כל מבני הכותרות של הספר.
          </p>
          <label class="field">
            הספר
            <select value={title} onChange={(e) => setTitle(e.currentTarget.value)} aria-label="הספר">
              {titles.map((t) => (
                <option key={t} value={t}>
                  {t}
                  {store.altToc.of(t) ? " ✓" : ""}
                </option>
              ))}
            </select>
          </label>
          {!titles.length && <p>פתחו קודם ספר.</p>}
          {loading && <p class="muted">קורא את המבנים שכבר יש במסד…</p>}
          {sefaria && (
            <ul class="problems">
              <li class="warning">הספר הזה מגיע מספריא. אוצריא מתעלמת מקובץ alt_toc של ספר ספריא, ולכן מה שתכתבו כאן לא ייכנס לספרייה.</li>
            </ul>
          )}
          {!inProject && origin === "db" && <p class="muted" style="margin:0">נטענו המבנים שכבר יש לספר במסד. עריכה ושמירה יחליפו אותם בייצוא.</p>}
          {library && library.automatic.length > 0 && (
            <ul class="problems">
              <li class="info">
                <span class="grow">
                  במסד יש לספר גם מבנים שאוצריא יוצרת בעצמה ({library.automatic.map((x) => x.key).join(", ")}). הם לא נטענו: קובץ alt_toc לא אמור לשכפל אותם, וכל קובץ alt_toc מונע את יצירת המבנה Chapters לספר.
                </span>
                <button class="btn text" onClick={() => (setStructs([...structs, ...library.automatic.map(({ skipped: _s, ...x }) => x)]), setLibrary({ ...library, automatic: [] }))}>
                  טעינה בכל זאת
                </button>
              </li>
            </ul>
          )}
          {library && library.skipped > 0 && <p class="muted" style="margin:0">{library.skipped} צמתים במסד אינם מצביעים על שורה, ולכן לא נטענו.</p>}

          {title && (
            <div class="row">
              <select value={String(cur)} onChange={(e) => setCur(Number(e.currentTarget.value))} aria-label="המבנה" disabled={!structs.length} class="grow">
                {!structs.length && <option value="0">— אין מבנים —</option>}
                {structs.map((x, i) => (
                  <option key={i} value={String(i)}>
                    {x.heTitle || x.key || `מבנה ${i + 1}`} ({x.key || "בלי מפתח"}, {x.entries.length} צמתים)
                  </option>
                ))}
              </select>
              <input type="text" dir="ltr" placeholder="Parasha" value={newKey} onInput={(e) => setNewKey(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && addStructure()} aria-label="מפתח המבנה החדש (באנגלית)" style="width:140px" />
              <button class="btn tonal" onClick={addStructure} disabled={!newKey.trim()}>
                <Icon name="fl_add" size={18} />
                מבנה חדש
              </button>
              {s && (
                <button class="btn text danger" onClick={() => (setStructs(structs.filter((_, i) => i !== cur)), setCur(0))}>
                  <Icon name="fl_delete" size={18} />
                  מחיקת המבנה
                </button>
              )}
            </div>
          )}
          {title && !structs.length && !loading && <p class="empty">אין עדיין מבנה. כתבו מפתח באנגלית (למשל Parasha) ולחצו "מבנה חדש".</p>}

          {s && (
            <>
              <div class="row">
                <label class="field grow">
                  מפתח (key, באנגלית, קבוע)
                  <input type="text" dir="ltr" value={s.key} onInput={(e) => patch(cur, { key: e.currentTarget.value })} aria-label="מפתח המבנה" />
                </label>
                <label class="field grow">
                  שם תצוגה (heTitle)
                  <input type="text" value={s.heTitle ?? ""} placeholder="לדוגמה: פרשה" onInput={(e) => patch(cur, { heTitle: e.currentTarget.value })} aria-label="שם התצוגה של המבנה" />
                </label>
                <label class="field grow">
                  שם באנגלית (title, רשות)
                  <input type="text" dir="ltr" value={s.title ?? ""} onInput={(e) => patch(cur, { title: e.currentTarget.value })} aria-label="שם המבנה באנגלית" />
                </label>
              </div>
              <div class="row">
                <button class="btn outlined" onClick={addEntry} title="צומת חדש בסוף הרשימה; אם סימנתם שורה בקורא של הספר הזה, הוא יתחיל בה">
                  <Icon name="fl_add" size={18} />
                  הוספת צומת
                </button>
                <button class="btn outlined" onClick={() => void fillFromHeadings()} disabled={!book || !!store.task.value} title="מחליף את הצמתים של המבנה בשורות הכותרת של הספר">
                  <Icon name="oz_text_bullet_list_tree" size={18} />
                  מילוי מכותרות הספר
                </button>
                <span class="grow" />
                <input type="text" value={base} onInput={(e) => setBase(e.currentTarget.value)} aria-label="מילת הבסיס למספור" style="width:90px" />
                <button class="btn outlined" onClick={number} disabled={!base.trim()} title='כל צומת מרמה 1 ומטה יקבל את המילה ואחריה אות רצה: "עליה א", "עליה ב"… המונה מתחיל מחדש תחת כל צומת. צמתים ברמה 0 לא משתנים.'>
                  מספור בגימטריה
                </button>
              </div>
              <p class="muted" style="margin:0">רמה 0 היא הרמה העליונה (פרשה), רמה 1 מה שתחתיה (עליה), וכן הלאה. מספר השורה הוא כמו בקורא: השורה הראשונה היא 1.</p>
              <div class="alt-rows" role="table" aria-label="צמתי המבנה">
                {s.entries.slice(0, shown).map((e, i) => {
                  const bad = problems.some((p) => p.structure === cur && p.entry === i && p.severity === "error");
                  const name = e.heTitle || `צומת ${i + 1}`;
                  return (
                    <div key={i} class={`alt-row${bad ? " bad" : ""}`} role="row">
                      <input type="number" min="0" value={e.level} onChange={(ev) => patchEntry(i, { level: Math.max(0, parseInt(ev.currentTarget.value, 10) || 0) })} aria-label={`רמה של ${name}`} title="רמה" />
                      <input type="text" value={e.heTitle} placeholder="כותרת הצומת" onInput={(ev) => patchEntry(i, { heTitle: ev.currentTarget.value })} aria-label={`כותרת צומת ${i + 1}`} style={`margin-inline-start:${Math.min(e.level, 8) * 16}px`} />
                      <input type="number" min="1" value={e.line} onChange={(ev) => patchEntry(i, { line: parseInt(ev.currentTarget.value, 10) || 1 })} aria-label={`שורה של ${name}`} title="שורה" />
                      <button class="icon-btn" disabled={!book} onClick={() => book && store.reveal("source", book.key, e.line - 1)} title="הצגת השורה בקורא" aria-label={`הצגת השורה של ${name}`}>
                        <Icon name="oz_document_text" size={18} />
                      </button>
                      <button class="icon-btn" onClick={() => setEntries(s.entries.filter((_, j) => j !== i))} title="מחיקת הצומת" aria-label={`מחיקת ${name}`}>
                        <Icon name="fl_dismiss" size={18} />
                      </button>
                    </div>
                  );
                })}
                {!s.entries.length && <p class="muted">אין צמתים.</p>}
              </div>
              {s.entries.length > shown && (
                <button class="btn outlined" onClick={() => setShown(shown + PAGE)}>
                  הצגת עוד ({(s.entries.length - shown).toLocaleString("he")} נותרו)
                </button>
              )}
            </>
          )}

          {problems.length > 0 && (
            <details class="held" open={errors.length > 0}>
              <summary>
                {errors.length ? `${errors.length} שגיאות` : ""}
                {errors.length && problems.length > errors.length ? " ו־" : ""}
                {problems.length > errors.length ? `${problems.length - errors.length} הערות` : ""}
              </summary>
              <ul class="problems" style="margin-top:8px">
                {problems.slice(0, 100).map((p, i) => (
                  <li key={i} class={p.severity} style={p.structure !== undefined ? "cursor:pointer" : ""} onClick={() => p.structure !== undefined && (setCur(p.structure), p.entry !== undefined && setShown(Math.max(shown, p.entry + 1)))}>
                    {p.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
        <footer>
          {inProject && (
            <button class="btn text danger" style="margin-inline-end:auto" onClick={() => (store.altToc.drop(title), ref.current?.close())} title="בייצוא לא ייכתב קובץ alt_toc לספר הזה">
              הסרה מהפרויקט
            </button>
          )}
          <button class="btn text" onClick={() => ref.current?.close()}>ביטול</button>
          <button class="btn filled" onClick={save} disabled={!title}>
            <Icon name="fl_save" size={18} />
            שמירה
          </button>
        </footer>
      </div>
    </dialog>
  );
}
