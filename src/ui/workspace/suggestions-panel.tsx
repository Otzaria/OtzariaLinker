import { useEffect, useMemo, useState } from "preact/hooks";
import { CONFIDENCE_LABELS, ENGINES, SUGGESTION_SORTS, type Confidence, type EngineId, type MatchedSpan, type Suggestion, type SuggestionSort } from "../../linking/automatic";
import { pairByTitle } from "../../linking/batch";
import { plainText } from "./plain-text";
import { splitMatched } from "./matched-words";
import type { SuggestionsView } from "../../state/preferences";
import { placeText, type SuggestionState } from "../../state/suggestions";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { activatable, rovingKeys, rovingTabIndex } from "../keyboard";
import { sourceNameText } from "../shell/file-name";
import { defaultFormValues, toEngineOptions, type FormValues } from "../../linking/automatic/option-specs";
import { EngineOptions, EssentialOptions } from "./engine-options";
import { BulkApprove } from "./bulk-approve";
import { jobStateText, jobWantsAttention, MaxLinkJobView } from "./maxlink-job";
import { MaxLinkForm, MaxLinkReportView } from "./maxlink-panel";

/*
 * Review of automatic suggestions (ADR 0005 §4): one list, three views —
 *   table (default): filter by confidence, select, approve in bulk ("approve all certain");
 *   inline: step through suggestions on the two readers, keyboard A / R / arrows;
 *   card: one suggestion at a time with both texts, reasons and alternatives.
 * Nothing is linked without approval; approval is one undoable action.
 */
const STATE_LABEL: Record<SuggestionState, string> = { pending: "ממתינה", approved: "אושרה", rejected: "נדחתה", exists: "כבר קיים" };
const VIEW_LABEL: Record<SuggestionsView, string> = { table: "טבלה", inline: "בתוך הטקסט", card: "כרטיס" };

export function SuggestionsPanel() {
  const store = useStore();
  const run = store.suggestions.run.value;
  const [setup, setSetup] = useState(false);
  /** max-link's job card, merge notes and report, opened from the summary line ("דוח העבודה") */
  const [report, setReport] = useState(false);
  // the address "#/maxlink" asks for the max-link form even when the last run was of another kind
  const wantsMaxLink = store.suggestMode.value === "maxlink" && !run?.maxlink;
  if (!run || setup || wantsMaxLink)
    return (
      <>
        <MaxLinkJobView />
        <RunForm onDone={() => setSetup(false)} onCancel={run ? () => setSetup(false) : undefined} />
      </>
    );
  const c = store.suggestions.counts.value;
  const view = store.prefs.suggestionsView.value;
  const engine = ENGINES.find((e) => e.id === run.engine);
  return (
    <div style="display:flex;flex-direction:column;min-height:100%">
      <div class="sug-head">
        <div class="grow">
          <b>{run.maxlink ? "קישור מרבי" : engine?.title}</b>: {run.label}
          <div class="muted" style="font-size:var(--fs-sm)">
            {run.result.suggestions.length.toLocaleString("he")} הצעות · {c.pending.toLocaleString("he")} ממתינות · {c.approved.toLocaleString("he")} אושרו
            {run.result.unmatched.length > 0 && ` · ${run.result.unmatched.length.toLocaleString("he")} שורות בלי התאמה`}
            {run.maxlink && <MaxLinkSummary open={report} onToggle={() => setReport(!report)} />}
          </div>
        </div>
        <button class="btn text" onClick={() => setSetup(true)}>
          <Icon name="fl_arrow_sort" size={16} />
          הרצה חדשה
        </button>
      </div>
      <div class="filters" role="radiogroup" aria-label="תצוגת ההצעות" onKeyDown={rovingKeys}>
        {(["table", "inline", "card"] as const).map((v) => (
          <button key={v} class="chip" role="radio" aria-checked={view === v} tabIndex={rovingTabIndex(view === v)} onClick={() => (store.prefs.suggestionsView.value = v)}>
            {VIEW_LABEL[v]}
          </button>
        ))}
      </div>
      {/* after max-link the suggestions come first (V5 UX audit U15): its notes, job and report are in "דוח העבודה" */}
      {run.result.notes.length > 0 && (!run.maxlink || report) && (
        <ul class="problems" style="padding:0 6px 6px">
          {run.result.notes.map((n, i) => (
            <li key={i} class="info">
              <Icon name="fl_info" size={16} />
              <span>{n.text}</span>
            </li>
          ))}
        </ul>
      )}
      {run.dbLinksUnread?.length ? (
        <ul class="problems" style="padding:0 6px 6px">
          <li class="warning" role="alert">
            <Icon name="fl_warning" size={16} />
            <span class="grow">
              הקישורים שכבר יש במסד ל־{run.dbLinksUnread.map((u) => `"${u.title}"`).join(", ")} לא נקראו: הצעות שכבר קיימות בספרייה עלולות להופיע כממתינות, ולכן אישור של כמה הצעות יחד מושבת.
            </span>
            <button class="btn text" onClick={() => void store.suggestions.retryDbLinks()}>קריאה חוזרת</button>
          </li>
        </ul>
      ) : null}
      {run.maxlink ? (
        <div id="ml-work-report" hidden={!report && !jobWantsAttention(store.maxLink)}>
          {(report || jobWantsAttention(store.maxLink)) && <MaxLinkJobView />}
          {report && <MaxLinkReportView />}
        </div>
      ) : (
        <BatchSummary />
      )}
      {view === "table" ? <TableView /> : <StepView card={view === "card"} />}
    </div>
  );
}

/** After max-link, one line instead of four summaries: how many books, the job's state, and the report on request. */
function MaxLinkSummary({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const store = useStore();
  const job = store.maxLink.job.value;
  const state = jobStateText(store.maxLink);
  return (
    <>
      {job && ` · ${job.books.length.toLocaleString("he")} ספרים · ${state}`}
      {" · "}
      <button class="link-btn" aria-expanded={open} aria-controls="ml-work-report" onClick={onToggle}>
        דוח העבודה {open ? "▾" : "◂"}
      </button>
    </>
  );
}

function RunForm({ onDone, onCancel }: { onDone: () => void; onCancel: (() => void) | undefined }) {
  const store = useStore();
  const intent = store.intent.value;
  const [engine, setEngine] = useState<EngineId>(intent?.engine ?? "headings");
  // the sides are named by the job (state/roles.ts): the form says which job this is
  // (not in max-link, whose job mixes engines, and not after the form is gone)
  useEffect(() => {
    store.suggestions.formEngine.value = store.suggestMode.value === "maxlink" ? null : engine;
    return () => void (store.suggestions.formEngine.value = null);
  }, [engine, store.suggestMode.value]);
  // in the store, not here: the route names it (#/maxlink), and a guided task starts in it
  const mode = store.suggestMode.value;
  const setMode = (m: typeof mode) => (store.suggestMode.value = m);
  const sources = store.sources.value;
  const [batchSource, setBatchSource] = useState<string>(() => (intent?.sourceId && sources.some((x) => x.info.id === intent.sourceId) ? intent.sourceId : (sources.find((x) => x.info.kind === "text-files")?.info.id ?? sources[0]?.info.id ?? "")));
  const info = ENGINES.find((e) => e.id === engine)!;
  const s = store.view.source.value;
  const t = store.view.target.value;
  // a single-book engine (citations) needs only the source; its targets are all the open books
  const single = info.singleBook === true;
  const ready = single ? !!s : mode === "pair" ? !!s && !!t && s !== t : !!batchSource;
  const preview = useMemo(() => {
    const src = sources.find((x) => x.info.id === batchSource);
    if (mode !== "batch" || !src) return [];
    return pairByTitle(src.books.map((b) => store.refOf(b.key)), [...store.books.value.values()].map((b) => store.refOf(b.key)));
  }, [mode, batchSource, sources]);
  const paired = preview.filter((p) => p.target).length;
  const advanced = store.prefs.advanced.value;
  /** settings per engine, kept while the form is open so switching engines does not lose them */
  const [formValues, setFormValues] = useState<Partial<Record<EngineId, FormValues>>>({});
  const values = formValues[engine] ?? defaultFormValues(engine);
  // outside advanced mode only the essential options (a pattern) count; the rest run at their defaults
  const check = useMemo(() => toEngineOptions(engine, values, advanced ? "all" : "essential"), [engine, values, advanced]);
  const invalid = Object.keys(check.errors).length > 0;
  const onOption = (key: string, v: string | number | boolean) => setFormValues((all) => ({ ...all, [engine]: { ...(all[engine] ?? values), [key]: v } }));

  const start = async () => {
    const options = check.options;
    const ok = single ? await store.suggestions.runCitations(s!, options) : mode === "pair" ? await store.suggestions.runEngine(engine, s!, t!, options) : await store.suggestions.runBatch(engine, batchSource, options);
    if (ok) onDone();
  };
  return (
    <div class="builder">
      <h3 style="margin:0">קישור אוטומטי</h3>
      <div class="filters" style="padding:0" role="radiogroup" aria-label="מה לקשר" onKeyDown={rovingKeys}>
        <button class="chip" role="radio" aria-checked={mode === "pair"} tabIndex={rovingTabIndex(mode === "pair")} onClick={() => setMode("pair")}>שני ספרים</button>
        <button class="chip" role="radio" aria-checked={mode === "batch"} tabIndex={rovingTabIndex(mode === "batch")} onClick={() => (setMode("batch"), (info.noBatch || single) && setEngine("headings"))} title="אצווה מתאימה לפירושים ('X על Y'); הערות שוליים ותבנית מקשרים זוג אחד בכל פעם">ספרים רבים (אצווה)</button>
        <button class="chip" role="radio" aria-checked={mode === "maxlink"} tabIndex={rovingTabIndex(mode === "maxlink")} onClick={() => setMode("maxlink")} title="כל השיטות המתאימות על כל הספרים שבחרתם, בתוצאה אחת">קישור מרבי</button>
      </div>
      {mode === "maxlink" ? <MaxLinkForm onDone={onDone} onCancel={onCancel} /> : <>
      <label class="field">
        שיטה
        <select value={engine} onChange={(e) => setEngine(e.currentTarget.value as EngineId)}>
          {ENGINES.filter((e) => mode === "pair" || (!e.noBatch && !e.singleBook)).map((e) => (
            <option key={e.id} value={e.id}>{e.title}</option>
          ))}
        </select>
        <span class="muted">{info.description}</span>
      </label>
      {mode === "pair" ? (
        <>
          <div class={`end source${s ? " set" : ""}`}>
            <span class="side-badge source">{info.sourceRole}</span>
            <span>{s ? store.refOf(s).title : "בחרו ספר בחלונית המקור"}</span>
          </div>
          {single ? (
            <div class="end target set">
              <span class="side-badge target">{info.targetRole}</span>
              <span>{`${store.books.value.size.toLocaleString("he")} ספרים פתוחים — לא צריך לבחור יעד`}</span>
            </div>
          ) : (
            <div class={`end target${t ? " set" : ""}`}>
              <span class="side-badge target">{info.targetRole}</span>
              <span>{t ? store.refOf(t).title : "בחרו ספר בחלונית היעד"}</span>
            </div>
          )}
        </>
      ) : (
        <>
          <label class="field">
            המקור שבו נמצאים הפירושים
            <select value={batchSource} onChange={(e) => setBatchSource(e.currentTarget.value)}>
              {sources.map((x) => (
                <option key={x.info.id} value={x.info.id}>{sourceNameText(x.info.label)} ({x.books.length} ספרים)</option>
              ))}
            </select>
            <span class="muted">כל ספר מקושר לספר שבשמו ("… על בראשית" ← בראשית), מבין כל הספרים הפתוחים.</span>
          </label>
          {preview.length > 0 && (
            <details class="held" open={preview.length <= 12}>
              <summary>זוהו {paired} מתוך {preview.length} ספרים</summary>
              <ul class="problems" style="margin-top:6px">
                {preview.map((p) => (
                  <li key={p.source.key} class={p.target ? "info" : "warning"}>
                    <span>{p.source.title} {p.target ? `← ${p.target.title}` : `— ${p.reason}`}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      <EssentialOptions engine={engine} values={values} check={check} onChange={onOption} />
      {advanced ? (
        <EngineOptions
          engine={engine}
          values={values}
          check={check}
          onChange={onOption}
          onReset={() => setFormValues((all) => ({ ...all, [engine]: defaultFormValues(engine) }))}
        />
      ) : (
        <button class="adv-link" onClick={() => (store.prefs.advanced.value = true)}>הגדרות השיטה (מצב מתקדם)</button>
      )}
      <p class="muted" style="margin:0;font-size:var(--fs-sm)">
        הכלי רק מציע. שום קישור לא נוצר בלי אישור שלכם, וכל אישור אפשר לבטל.
      </p>
      <div class="row">
        <button class="btn filled" disabled={!ready || invalid || !!store.task.value || (mode === "batch" && !paired)} onClick={start} title={invalid ? "יש הגדרה לא תקינה בהגדרות השיטה" : undefined}>
          <Icon name="oz_link_search" size={18} />
          חיפוש התאמות
        </button>
        {onCancel && <button class="btn text" onClick={onCancel}>ביטול</button>}
      </div>
      </>}
    </div>
  );
}

function BatchSummary() {
  const store = useStore();
  const rows = store.suggestions.run.value?.batch;
  if (!rows) return null;
  return (
    <details class="held" style="margin:0 6px 6px">
      <summary>סיכום לפי ספר ({rows.length})</summary>
      <table class="sug-table" style="margin-top:6px" aria-label="סיכום לפי ספר">
        <thead>
          <tr><th>ספר</th><th>הצעות</th><th>ודאיות</th><th>גבוהות</th><th>לבדיקה</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.source.key} title={r.problem ?? (r.target ? `← ${r.target.title}` : "")}>
              <td>{r.source.title}{r.problem && <div class="muted">{r.problem}</div>}</td>
              <td>{r.suggestions.toLocaleString("he")}</td>
              <td>{r.certain.toLocaleString("he")}</td>
              <td>{r.high.toLocaleString("he")}</td>
              <td>{r.review.toLocaleString("he")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/* ---------------- table ---------------- */

const PAGE = 300;

function TableView() {
  const store = useStore();
  const run = store.suggestions.run.value!;
  const st = store.suggestions.state.value;
  const c = store.suggestions.counts.value;
  const [conf, setConf] = useState<Confidence | "all">("all");
  const [state, setState] = useState<SuggestionState | "all">("pending");
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState(PAGE);
  const ordered = store.suggestions.ordered.value;
  const sortOrder = store.suggestions.sortOrder.value;
  const rows = useMemo(
    () => ordered.filter((s) => (conf === "all" || s.confidence === conf) && (state === "all" || st.get(s.id) === state)),
    [ordered, conf, state, st],
  );
  useEffect(() => setSel(new Set()), [conf, state, run, sortOrder]);
  // the lines of the shown rows, for the start of each line's text (audit F17)
  useEffect(() => void store.suggestions.loadPreviews(rows.slice(0, shown)), [rows, shown]);
  const certain = c.pending ? store.suggestions.pendingAtLeast("certain").length : 0;
  // the database's links were not read: what is "pending" may exist in the library (review C13)
  const unread = !!run.dbLinksUnread?.length;

  return (
    <>
      <div class="filters">
        {(["all", "certain", "high", "possible", "ambiguous"] as const).map((k) =>
          k === "all" || c[k] ? (
            <button key={k} class={`chip${k !== "all" ? ` conf-${k}` : ""}`} aria-pressed={conf === k} onClick={() => (setConf(k), setShown(PAGE))}>
              {k === "all" ? "כל הוודאויות" : CONFIDENCE_LABELS[k]} {k !== "all" && <span class="count">{c[k].toLocaleString("he")}</span>}
            </button>
          ) : null,
        )}
      </div>
      <div class="filters" style="padding-top:0">
        {(["pending", "approved", "rejected", "exists", "all"] as const).map((k) =>
          k === "all" || c[k] ? (
            <button key={k} class="chip" aria-pressed={state === k} onClick={() => (setState(k), setShown(PAGE))}>
              {k === "all" ? "הכול" : STATE_LABEL[k]} {k !== "all" && <span class="count">{c[k].toLocaleString("he")}</span>}
            </button>
          ) : null,
        )}
        <SortSelect onChange={() => setShown(PAGE)} />
      </div>
      <div class="row bulk">
        <button class="btn filled" disabled={!certain || unread} onClick={() => store.suggestions.approve(store.suggestions.pendingAtLeast("certain"))} title={unread ? "מושבת: הקישורים שכבר יש במסד לא נקראו (קריאה חוזרת למעלה)" : "מאשר רק הצעות שהכלי בטוח בהן לגמרי"}>
          <Icon name="oz_link_check" size={18} />
          אישור כל הוודאיות ({certain.toLocaleString("he")})
        </button>
        {sel.size > 0 && (
          <>
            <button class="btn tonal" onClick={() => (store.suggestions.approve([...sel]), setSel(new Set()))}>אישור {sel.size}</button>
            <button class="btn text danger" onClick={() => (store.suggestions.reject([...sel]), setSel(new Set()))}>דחייה</button>
          </>
        )}
      </div>
      <BulkApprove />
      <table class="sug-table" aria-label="הצעות">
        <thead>
          <tr>
            <th>
              <label class="hit">
                <input type="checkbox" aria-label="בחירת הכול בעמוד" checked={rows.length > 0 && rows.slice(0, shown).every((r) => sel.has(r.id))} onChange={(e) => setSel(e.currentTarget.checked ? new Set(rows.slice(0, shown).map((r) => r.id)) : new Set())} />
              </label>
            </th>
            <th>שורה</th>
            <th>אל</th>
            <th>ודאות</th>
            <th><span class="sr-only">החלטה</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, shown).map((s) => (
            <SugRow key={s.id} s={s} state={st.get(s.id)!} showScore={sortOrder === "worst" || sortOrder === "best"} checked={sel.has(s.id)} onCheck={(on) => setSel((p) => { const n = new Set(p); on ? n.add(s.id) : n.delete(s.id); return n; })} />
          ))}
        </tbody>
      </table>
      {rows.length > shown && (
        <div style="padding:8px;text-align:center">
          <button class="btn outlined" onClick={() => setShown(shown + PAGE)}>הצגת עוד ({(rows.length - shown).toLocaleString("he")})</button>
        </div>
      )}
      {!rows.length && <p class="empty">אין הצעות שמתאימות לסינון.</p>}
    </>
  );
}

function SugRow({ s, state, checked, onCheck, showScore }: { s: Suggestion; state: SuggestionState; checked: boolean; onCheck: (on: boolean) => void; showScore: boolean }) {
  const store = useStore();
  const end = (l: number, e?: number) => (e !== undefined && e > l ? `${l + 1}–${e + 1}` : `${l + 1}`);
  store.lines.tick.value; // re-render when the previews load
  // read from the user's book (audit F18), with the start of the target line's text (audit F17)
  const v = store.suggestions.display(s);
  const snippet = store.suggestions.snippet(v.to);
  // the target's line number: the place name alone repeats down a chapter of a book without verse headings (issue 12);
  // a cited span belongs to the record's own target, which is the displayed one unless the row is shown reversed
  const place = placeText(v.to, v.reversed ? undefined : s);
  return (
    <tr
      class={`st-${state}`}
      tabIndex={0}
      onClick={() => store.suggestions.show(s.id)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && (e.preventDefault(), store.suggestions.show(s.id))}
      title={[`ציון ${scorePercent(s)}`, ...s.reasons.map((r) => r.text)].join(" · ")}
    >
      <td onClick={(e) => e.stopPropagation()}>
        {/* the label is the hit area: the bare checkbox is 13px (WCAG 2.5.8 asks 24) */}
        <label class="hit">
          <input type="checkbox" checked={checked} onChange={(e) => onCheck(e.currentTarget.checked)} aria-label={`בחירת ההצעה לשורה ${v.from.line + 1}: ${v.toLabel}, ${place}`} />
        </label>
      </td>
      <td>{(store.suggestions.run.value?.batch || store.suggestions.run.value?.maxlink) && <span class="muted">{v.from.book.title} </span>}{end(v.from.line, v.from.end)}</td>
      <td>
        <div>{v.toLabel}</div>
        <div class="where muted">{place}</div>
        {snippet && <div class="snippet muted">{snippet}</div>}
      </td>
      <td>
        <span class={`conf conf-${s.confidence}`}>{CONFIDENCE_LABELS[s.confidence]}</span>
        {/* the numeric score, when the list is sorted by it: inside a level the order is by this number */}
        {showScore && <span class="muted score"> {scorePercent(s)}</span>}
        {s.warnings.length > 0 && <Icon name="fl_warning" size={14} label={s.warnings.map((w) => w.text).join(" ")} />}
        {/* the row's decision, which the eye reads from its colour */}
        {state !== "pending" && <span class="sr-only">, {STATE_LABEL[state]}</span>}
      </td>
      <td onClick={(e) => e.stopPropagation()} class="acts">
        <Decide s={s} state={state} what={`ההצעה לשורה ${end(v.from.line, v.from.end)}`} />
      </td>
    </tr>
  );
}

/** Approve / reject on a table row. `what` names the suggestion: every row has the same two buttons. */
function Decide({ s, state, what }: { s: Suggestion; state: SuggestionState; what: string }) {
  const store = useStore();
  if (state === "exists") return <span class="muted">{STATE_LABEL.exists}</span>;
  /**
   * A decided row leaves the "pending" filter, and its button with it: focus goes on to the same
   * button of the next row, so the keyboard user decides the next one without finding the table again.
   */
  const decide = (e: MouseEvent, act: () => void) => {
    const btn = e.currentTarget as HTMLElement;
    const row = btn.closest("tr");
    const next = (row?.nextElementSibling ?? row?.previousElementSibling) as HTMLElement | null;
    act();
    requestAnimationFrame(() => {
      if (!row || row.isConnected || !next?.isConnected) return;
      (next.querySelector<HTMLElement>(`[data-decide="${btn.dataset.decide}"]`) ?? next).focus();
    });
  };
  return (
    <span class="decide">
      <button class="icon-btn" data-decide="approve" aria-pressed={state === "approved"} onClick={(e) => decide(e, () => (state === "approved" ? store.suggestions.reject([s.id]) : store.suggestions.approve([s.id])))} title="אישור" aria-label={`אישור ${what}`}>
        <Icon name="oz_check" size={18} />
      </button>
      <button class="icon-btn" data-decide="reject" aria-pressed={state === "rejected"} onClick={(e) => decide(e, () => (state === "rejected" ? store.suggestions.reset([s.id]) : store.suggestions.reject([s.id])))} title="דחייה" aria-label={`דחיית ${what}`}>
        <Icon name="oz_cross" size={18} />
      </button>
    </span>
  );
}

/* ---------------- inline / card ---------------- */

/** One suggestion at a time; `standalone` = outside the workspace (the guided flow), where no reader shows its two ends. */
export function StepView({ card, standalone }: { card: boolean; standalone?: boolean }) {
  const store = useStore();
  const run = store.suggestions.run.value!;
  const st = store.suggestions.state.value;
  const list = store.suggestions.ordered.value;
  const curId = store.suggestions.current.value;
  const idx = Math.max(0, list.findIndex((s) => s.id === curId));
  const s = list[idx];

  // the neighbour in the SORTED list (the sort order of the table applies here too)
  const go = (dir: 1 | -1, pendingOnly = false) => {
    const id = store.suggestions.neighbour(dir, pendingOnly);
    if (id) store.suggestions.show(id);
  };
  useEffect(() => {
    if (s) store.suggestions.show(s.id);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // keys act only when no control has focus: Enter on a focused button must press THAT button (UX review #1)
      if ((e.target as HTMLElement).closest?.("input, textarea, select, button, a, [role=tab], [contenteditable]") || e.ctrlKey || e.metaKey || e.altKey || !s) return;
      const k = e.key.toLowerCase();
      if (k === "a" || k === "ש") (e.preventDefault(), store.suggestions.approve([s.id]), go(1, true));
      else if (k === "r" || k === "delete" || k === "ר") (e.preventDefault(), store.suggestions.reject([s.id]), go(1, true));
      else if (k === "arrowleft" || k === "j") (e.preventDefault(), go(1));
      else if (k === "arrowright" || k === "k") (e.preventDefault(), go(-1));
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });
  if (!s) return <p class="empty">אין הצעות.</p>;
  const state = st.get(s.id)!;

  return (
    <div class="builder">
      <div class="row">
        <button class="icon-btn" onClick={() => go(-1)} disabled={idx === 0} aria-label="הקודמת" title="הקודמת (→)">
          <Icon name="fl_chevron_down" size={18} class="rot-left" />
        </button>
        <span class="grow" style="text-align:center">
          {(idx + 1).toLocaleString("he")} מתוך {list.length.toLocaleString("he")} · <span class={`conf conf-${s.confidence}`}>{CONFIDENCE_LABELS[s.confidence]}</span> <span class="muted">({scorePercent(s)})</span> · {STATE_LABEL[state]}
        </span>
        <button class="icon-btn" onClick={() => go(1)} disabled={idx === list.length - 1} aria-label="הבאה" title="הבאה (←)">
          <Icon name="fl_chevron_down" size={18} class="rot-right" />
        </button>
      </div>
      <SortSelect />
      {card && <CardTexts s={s} />}
      {!card && (
        <div class="end source set">
          <span class="side-badge source">{placeText(s.source)}</span>
          <span>← {s.heRef2} · {placeText(s.target, s)}</span>
        </div>
      )}
      <ul class="problems">
        {s.reasons.map((r) => (
          <li key={r.code} class="info"><Icon name="oz_check" size={16} /><span>{r.text}</span></li>
        ))}
        {s.warnings.map((r) => (
          <li key={r.code} class="warning"><Icon name="fl_warning" size={16} /><span>{r.text}</span></li>
        ))}
      </ul>
      {card && s.alternatives.length > 0 && (
        <details class="held">
          <summary>מועמדים חלופיים ({s.alternatives.length})</summary>
          <ul class="link-list" style="padding:6px 0 0">
            {s.alternatives.map((a, i) => (
              <li key={i} class="link-item" {...activatable(() => store.reveal("target", a.target.book.key, a.target.line))}>
                <span>שורה {a.target.line + 1}{a.target.end !== undefined ? `–${a.target.end + 1}` : ""} · ציון {Math.round(a.score * 100)}</span>
                <span class="muted" style="grid-column:1/-1">{a.reasons.map((r) => r.text).join(" · ")}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div class="row">
        <button class="btn filled" onClick={() => (store.suggestions.approve([s.id]), go(1, true))} disabled={state === "approved" || state === "exists"}>
          <Icon name="oz_check" size={18} />
          אישור <kbd>A</kbd>
        </button>
        <button class="btn outlined" onClick={() => (store.suggestions.reject([s.id]), go(1, true))} disabled={state === "rejected"}>
          <Icon name="oz_cross" size={18} />
          דחייה <kbd>R</kbd>
        </button>
        <span class="grow" />
        <button class="btn text" onClick={() => go(1, true)}>לממתינה הבאה</button>
      </div>
      {!standalone && <p class="muted" style="margin:0;font-size:var(--fs-sm)">שני צדי ההצעה מוצגים ומסומנים בחלוניות הספרים.</p>}
    </div>
  );
}

/** The sort order of the suggestions (issue 8): one choice for the table and the one-at-a-time views. */
function SortSelect({ onChange }: { onChange?: () => void }) {
  const store = useStore();
  return (
    <label class="sort-select">
      <span>מיון</span>
      <select aria-label="מיון ההצעות" value={store.suggestions.sortOrder.value} onChange={(e) => (store.suggestions.setSort(e.currentTarget.value as SuggestionSort), onChange?.())}>
        {SUGGESTION_SORTS.map((o) => (
          <option key={o.id} value={o.id}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

/** The engine's score (0..1) as the percent the reviewer reasons in. */
const scorePercent = (s: Suggestion): string => `${Math.round(s.score * 100)}%`;

/**
 * A line's text for the card, with the words the engine matched marked: underlined and tinted (never colour alone), and
 * announced ("מילים שהותאמו") for a screen reader. A line with no known words is shown as it was.
 */
function LineText({ book, line, span }: { book: string; line: number; span: MatchedSpan | undefined }) {
  const store = useStore();
  store.lines.tick.value;
  const l = store.lines.line(book, line);
  if (!l) return <>…</>;
  const p = splitMatched(l.anchorText, span);
  if (!p) return <>{plainText(l.anchorText)}</>;
  return (
    <>
      {p.clippedBefore && "… "}
      {p.before}
      <span class="sr-only">מילים שהותאמו: </span>
      <mark class="match-hl">{p.match}</mark>
      {p.after}
      {p.clippedAfter && " …"}
    </>
  );
}

function CardTexts({ s }: { s: Suggestion }) {
  return (
    <>
      <div class="end source set">
        <span class="side-badge source">{s.source.book.title} · {placeText(s.source)}</span>
        <span class="snip" style="-webkit-line-clamp:6"><LineText book={s.source.book.key} line={s.source.line} span={s.matched?.source} /></span>
      </div>
      <div class="end target set">
        <span class="side-badge target">{s.heRef2} · {placeText(s.target, s)}</span>
        <span class="snip" style="-webkit-line-clamp:6"><LineText book={s.target.book.key} line={s.target.line} span={s.matched?.target} /></span>
      </div>
      {(s.matched?.source || s.matched?.target) && (
        <p class="muted match-legend">
          <span class="match-hl">מסומן</span> = המילים שהכלי התאים בין שתי השורות
        </p>
      )}
    </>
  );
}
