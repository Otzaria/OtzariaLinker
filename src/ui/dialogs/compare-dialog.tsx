import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { canonicalTypeString, parseConnectionType, TYPE_LABELS } from "../../core/links/connection-type";
import { diffGroup, type LinkDiffGroup, type LinkDiffRow } from "../../core/links/link-diff";
import type { Link, LinkSide } from "../../core/links/model";
import { DIFF_KIND_LABELS, detailsText, diffGroupLabels } from "../../formats/report/link-diff-report";
import { PROJECT_SET } from "../../state/link-compare";
import { useStore } from "../context";
import { pickFiles } from "../files";
import { Icon } from "../icons/icon";
import { ltr } from "../shell/file-name";

/*
 * Comparing a book's links between the database, the project and `_links.json` files, and merging
 * several files of one book (V5 P1-9; the rules: core/links/link-diff.ts, state/link-compare.ts).
 * Files picked here are only read for the comparison; a merge is applied to the project as ONE
 * undoable action, after its preview.
 */
const GROUPS: readonly LinkDiffGroup[] = ["conflict", "details", "overlap", "onlyA", "onlyB", "identical"];
const PAGE = 100;

export function CompareDialog({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const c = store.compare;
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  const reader = store.view.source.value;
  const titles = [...new Set([...c.titles(), ...(reader ? [store.refOf(reader).title] : [])])];
  c.sets.value; // re-render when sets load
  const [title, setTitle] = useState(titles[0] ?? "");
  const t = titles.includes(title) ? title : (titles[0] ?? "");
  const sets = c.setsOf(t);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const aId = sets.some((s) => s.id === a) ? a : (sets.find((s) => s.kind !== "project")?.id ?? sets[0]?.id ?? "");
  const bId = sets.some((s) => s.id === b) && b !== aId ? b : (sets.find((s) => s.id !== aId)?.id ?? "");
  const r = c.result.value;
  const fresh = r && r.a.title === t ? r : null;
  const canDb = store.booksByTitle.value.has(t) && !sets.some((s) => s.kind === "db");

  const pick = (label: string, v: string, put: (x: string) => void) => (
    <label class="field">
      {label}
      <select value={v} onChange={(e) => put(e.currentTarget.value)}>
        {sets.map((s) => (
          <option key={s.id} value={s.id}>{fname(s.name)}</option>
        ))}
      </select>
    </label>
  );
  const addFiles = async () => {
    const files = await pickFiles({ accept: ".json" });
    const got = c.addFiles(await Promise.all(files.map(async (f) => ({ path: f.path, text: await f.blob.text() }))));
    if (got[0]) setTitle(got[0]);
  };

  return (
    <dialog ref={ref} class="cmp" onClose={onClose} aria-labelledby="cmp-title">
      <div class="dlg">
        <header>
          <Icon name="oz_text_compare" size={24} />
          <h2 id="cmp-title">השוואה ומיזוג של קישורים</h2>
        </header>
        <div class="body">
          <p class="muted" style="margin:0">
            השוואה לפי מה שאוצריא שומרת (לא לפי הטקסט של הקובץ): זהים, סותרים, טווחים חופפים, ומה שיש רק בצד אחד. קבצים שנבחרים כאן רק נקראים להשוואה; שום דבר לא נכנס לפרויקט בלי מיזוג.
          </p>
          <div class="row">
            <button class="btn tonal" onClick={() => void addFiles()}>
              <Icon name="oz_document_links" size={18} />
              הוספת קובצי ‎_links.json…
            </button>
            {titles.length > 0 && (
              <label class="field">
                הספר
                <select value={t} onChange={(e) => setTitle(e.currentTarget.value)}>
                  {titles.map((x) => (
                    <option key={x} value={x}>{x}</option>
                  ))}
                </select>
              </label>
            )}
            {canDb && (
              <button class="btn text" disabled={!!store.task.value} onClick={() => void c.loadDb(t)}>
                <Icon name="oz_library_link" size={18} />
                קריאת הקישורים מהמסד
              </button>
            )}
          </div>
          {sets.length > 0 && (
            <ul class="cmp-sets">
              {sets.map((s) => (
                <li key={s.id}>
                  <b>{fname(s.name)}</b> <span class="muted">{s.links.length.toLocaleString("he")} קישורים{s.skipped ? ` (ועוד ${s.skipped.toLocaleString("he")} שאינם יכולים להיות בקובץ: זיהוי אוטומטי וספריא)` : ""}</span>
                  {s.id !== PROJECT_SET && (
                    <button class="icon-btn" title="הסרה מההשוואה" aria-label={`הסרת ${s.name}`} onClick={() => c.forget(s.id)}>
                      <Icon name="fl_dismiss" size={16} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {sets.length >= 2 && (
            <div class="row">
              {pick("לפני (א)", aId, setA)}
              {pick("אחרי (ב)", bId, setB)}
              <button class="btn filled" disabled={!aId || !bId || aId === bId} onClick={() => c.compare(t, aId, bId)}>
                השוואה
              </button>
            </div>
          )}
          {fresh && <DiffView key={`${fresh.a.id}|${fresh.b.id}|${fresh.ms}`} />}
          {sets.filter((s) => s.id.startsWith("file:") || s.id === PROJECT_SET).length >= 2 && <MergePanel title={t} />}
        </div>
        <footer>
          <button class="btn text" onClick={() => ref.current?.close()}>סגירה</button>
        </footer>
      </div>
    </dialog>
  );
}

/** a file name as one left-to-right unit in the Hebrew line ("המסד" and "הפרויקט" as they are) */
const fname = (name: string) => (name.includes(".") ? ltr(name) : name);
const place = (s: LinkSide) => `${s.book.title} ${s.line + 1}${s.end !== undefined && s.end > s.line ? `–${s.end + 1}` : ""}`;
/**
 * The type in Hebrew ("פירוש", not "commentary": audit V5, simple mode names no field value of the file);
 * the string as written when it is not the canonical one — a difference of spelling is a difference
 * here — and always in advanced mode.
 */
const typeText = (raw: string, advanced: boolean) => {
  const t = parseConnectionType(raw);
  const he = TYPE_LABELS[t.type].he;
  return advanced || !t.known || raw !== canonicalTypeString(t.type) ? `${he} (${raw || "—"})` : he;
};
const linkText = (l: Link | undefined, advanced: boolean) => (l ? `${place(l.source)} ← ${place(l.target)} · ${typeText(l.declaredType, advanced)}${l.anchor ? ` · עוגן ${l.anchor.rawStart}` : ""}` : "—");

/** a link in a table cell; a "details" row adds the fields that differ — otherwise both columns read the same (#15) */
function Cell({ l, advanced, kind, a, b, side }: { l: Link | undefined; advanced: boolean; kind: string; a?: Link; b?: Link; side: "a" | "b" }) {
  const extra = kind === "details" ? detailsText(a, b, side) : "";
  return (
    <td>
      {linkText(l, advanced)}
      {extra && <div class="muted">{extra}</div>}
    </td>
  );
}

function DiffView() {
  const store = useStore();
  const r = store.compare.result.value!;
  const advanced = store.prefs.advanced.value;
  const labels = diffGroupLabels(fname(r.a.name), fname(r.b.name));
  const counts = useMemo(() => {
    const n = Object.fromEntries(GROUPS.map((g) => [g, 0])) as Record<LinkDiffGroup, number>;
    for (const x of r.diff.rows) n[diffGroup(x)]++;
    return n;
  }, [r]);
  const [group, setGroup] = useState<LinkDiffGroup>(GROUPS.find((g) => counts[g]) ?? "identical");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  const rows = useMemo(() => r.diff.rows.filter((x) => diffGroup(x) === group && (!q || linkText(x.a, advanced).includes(q) || linkText(x.b, advanced).includes(q))), [r, group, q, advanced]);
  return (
    <section class="cmp-diff" aria-label="תוצאת ההשוואה">
      <div class="filters" style="padding:0">
        {GROUPS.filter((g) => g !== "details" || counts[g] > 0).map((g) => (
          <button key={g} class="chip" aria-pressed={group === g} onClick={() => (setGroup(g), setShown(PAGE))}>
            {labels[g]} <span class="count">{counts[g].toLocaleString("he")}</span>
          </button>
        ))}
        <input type="search" placeholder="סינון לפי ספר או שורה…" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
        <button class="btn text" onClick={() => store.compare.saveReport()}>
          <Icon name="fl_arrow_download" size={18} />
          שמירת דוח (CSV)
        </button>
      </div>
      {r.diff.loose && <p class="muted" style="margin:0">מול המסד לא מושווים שם המקום ביעד, ציוני ספריא ועוגנים: המסד לא שומר אותם כמו בקובץ.</p>}
      <table class="cmp-table">
        <thead>
          <tr><th>שינוי</th><th>{fname(r.a.name)}</th><th>{fname(r.b.name)}</th></tr>
        </thead>
        <tbody>
          {rows.slice(0, shown).map((x: LinkDiffRow, i) => (
            <tr key={i} class={`k-${x.kind}`}>
              <td>{DIFF_KIND_LABELS[x.kind]}</td>
              <Cell l={x.a} advanced={advanced} kind={x.kind} a={x.a} b={x.b} side="a" />
              <Cell l={x.b} advanced={advanced} kind={x.kind} a={x.a} b={x.b} side="b" />
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown && <button class="btn outlined" onClick={() => setShown(shown + PAGE * 5)}>הצגת עוד ({(rows.length - shown).toLocaleString("he")})</button>}
      <p class="muted cmp-time" style="margin:0">ההשוואה נמשכה {r.ms.toLocaleString("he")} אלפיות שנייה.</p>
    </section>
  );
}

/** Merging several links files of the book: which take part, which one is preferred, and the preview. */
function MergePanel({ title }: { title: string }) {
  const store = useStore();
  const c = store.compare;
  const advanced = store.prefs.advanced.value;
  const sets = c.setsOf(title).filter((s) => s.kind !== "db");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(sets.map((s) => s.id)));
  const [pref, setPref] = useState(sets[0]?.id ?? "");
  const [keep, setKeep] = useState(false);
  const ids = sets.map((s) => s.id).filter((id) => chosen.has(id));
  // the project's links are already in it: when they take part they are the preferred source
  const preferred = ids.includes(PROJECT_SET) ? PROJECT_SET : ids.includes(pref) ? pref : (ids[0] ?? "");
  const plan = useMemo(() => c.planMerge(title, ids, preferred, keep), [title, ids.join("|"), preferred, keep, c.sets.value, store.allLinks.value]);
  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (!next.delete(id)) next.add(id);
    setChosen(next);
  };
  return (
    <details class="held cmp-merge" open>
      <summary>מיזוג הקבצים של "{title}"</summary>
      <p class="muted">הגרסה המועדפת נשמרת כמו שהיא. מה שיש רק בגרסאות האחרות נוסף כקישורים חדשים שזוכרים מאיזה קובץ באו; כפילויות מתאחדות; סתירות לא נוספות אלא אם תבחרו בזה.</p>
      <ul class="cmp-sets">
        {sets.map((s) => (
          <li key={s.id}>
            <label class="check">
              <input type="checkbox" checked={chosen.has(s.id)} onChange={() => toggle(s.id)} />
              <span>{fname(s.name)}</span>
            </label>
            <label class="check">
              <input type="radio" name="cmp-pref" checked={preferred === s.id} disabled={!chosen.has(s.id) || (ids.includes(PROJECT_SET) && s.id !== PROJECT_SET)} onChange={() => setPref(s.id)} />
              <span>מועדף</span>
            </label>
          </li>
        ))}
      </ul>
      <label class="check">
        <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.currentTarget.checked)} />
        <span>להוסיף גם קישורים סותרים (שניהם יישארו, לבדיקה בטבלת הקישורים)</span>
      </label>
      {plan ? (
        <>
          <div class="stats">
            <div class="stat"><b>{plan.merge.entries.filter((e) => e.base).length.toLocaleString("he")}</b><span class="muted">מהגרסה המועדפת</span></div>
            <div class="stat"><b>{plan.preview.counts.added.toLocaleString("he")}</b><span class="muted">יתווספו</span></div>
            <div class="stat"><b>{plan.merge.duplicates.toLocaleString("he")}</b><span class="muted">כפילויות</span></div>
            <div class={`stat${plan.merge.conflicts.length ? " bad" : ""}`}><b>{plan.merge.conflicts.length.toLocaleString("he")}</b><span class="muted">סתירות</span></div>
          </div>
          {plan.merge.conflicts.length > 0 && (
            <table class="cmp-table">
              <thead>
                <tr><th>סתירה</th><th>נשמר</th><th>מ־</th><th>אומר אחרת</th></tr>
              </thead>
              <tbody>
                {plan.merge.conflicts.slice(0, 200).map((x, i) => (
                  <tr key={i}>
                    <td>{DIFF_KIND_LABELS[x.kind]}</td>
                    <Cell l={x.kept} advanced={advanced} kind={x.kind} a={x.kept} b={x.other} side="a" />
                    <td>{fname(x.origin)}</td>
                    <Cell l={x.other} advanced={advanced} kind={x.kind} a={x.kept} b={x.other} side="b" />
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div class="row">
            <button class="btn filled" onClick={() => c.applyMerge(title, ids, preferred, keep)}>
              <Icon name="oz_link_check" size={18} />
              מיזוג לפרויקט
            </button>
          </div>
        </>
      ) : (
        <p class="muted">בחרו לפחות שתי גרסאות.</p>
      )}
    </details>
  );
}
