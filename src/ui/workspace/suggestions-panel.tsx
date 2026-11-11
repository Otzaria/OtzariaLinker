import { useEffect, useMemo, useState } from "preact/hooks";
import { CONFIDENCE_LABELS, ENGINES, type Confidence, type EngineId, type Suggestion } from "../../linking/automatic";
import { stripTags } from "../../core/text/html";
import { pairByTitle } from "../../linking/batch";
import { plainText } from "./plain-text";
import type { SuggestionsView } from "../../state/preferences";
import type { SuggestionState } from "../../state/store";
import { useStore } from "../context";
import { Icon } from "../icons/icon";

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
  const run = store.run.value;
  const [setup, setSetup] = useState(false);
  if (!run || setup) return <RunForm onDone={() => setSetup(false)} onCancel={run ? () => setSetup(false) : undefined} />;
  const c = store.suggestionCounts.value;
  const view = store.prefs.suggestionsView.value;
  const engine = ENGINES.find((e) => e.id === run.engine);
  return (
    <div style="display:flex;flex-direction:column;min-height:100%">
      <div class="sug-head">
        <div class="grow">
          <b>{engine?.title}</b>: {run.label}
          <div class="muted" style="font-size:var(--fs-sm)">
            {run.result.suggestions.length.toLocaleString("he")} הצעות · {c.pending.toLocaleString("he")} ממתינות · {c.approved.toLocaleString("he")} אושרו
            {run.result.unmatched.length > 0 && ` · ${run.result.unmatched.length.toLocaleString("he")} שורות בלי התאמה`}
          </div>
        </div>
        <button class="btn text" onClick={() => setSetup(true)}>
          <Icon name="fl_arrow_sort" size={16} />
          הרצה חדשה
        </button>
      </div>
      <div class="filters" role="radiogroup" aria-label="תצוגת ההצעות">
        {(["table", "inline", "card"] as const).map((v) => (
          <button key={v} class="chip" role="radio" aria-checked={view === v} aria-pressed={view === v} onClick={() => (store.prefs.suggestionsView.value = v)}>
            {VIEW_LABEL[v]}
          </button>
        ))}
      </div>
      {run.result.notes.length > 0 && (
        <ul class="problems" style="padding:0 6px 6px">
          {run.result.notes.map((n, i) => (
            <li key={i} class="info">
              <Icon name="fl_info" size={16} />
              <span>{n.text}</span>
            </li>
          ))}
        </ul>
      )}
      <BatchSummary />
      {view === "table" ? <TableView /> : <StepView card={view === "card"} />}
    </div>
  );
}

function RunForm({ onDone, onCancel }: { onDone: () => void; onCancel: (() => void) | undefined }) {
  const store = useStore();
  const intent = store.intent.value;
  const [engine, setEngine] = useState<EngineId>(intent?.engine ?? "headings");
  const [mode, setMode] = useState<"pair" | "batch">(intent?.batch ? "batch" : "pair");
  const sources = store.sources.value;
  const [batchSource, setBatchSource] = useState<string>(() => sources.find((x) => x.info.kind === "text-files")?.info.id ?? sources[0]?.info.id ?? "");
  const info = ENGINES.find((e) => e.id === engine)!;
  const s = store.view.source.value;
  const t = store.view.target.value;
  const ready = mode === "pair" ? !!s && !!t && s !== t : !!batchSource;
  const preview = useMemo(() => {
    const src = sources.find((x) => x.info.id === batchSource);
    if (mode !== "batch" || !src) return [];
    return pairByTitle(src.books.map((b) => store.refOf(b.key)), [...store.books.value.values()].map((b) => store.refOf(b.key)));
  }, [mode, batchSource, sources]);
  const paired = preview.filter((p) => p.target).length;

  const start = async () => {
    const ok = mode === "pair" ? await store.runEngine(engine, s!, t!) : await store.runBatch(engine, batchSource);
    if (ok) onDone();
  };
  return (
    <div class="builder">
      <h3 style="margin:0">קישור אוטומטי</h3>
      <div class="filters" style="padding:0" role="radiogroup" aria-label="מה לקשר">
        <button class="chip" role="radio" aria-checked={mode === "pair"} aria-pressed={mode === "pair"} onClick={() => setMode("pair")}>שני ספרים</button>
        <button class="chip" role="radio" aria-checked={mode === "batch"} aria-pressed={mode === "batch"} onClick={() => (setMode("batch"), engine === "footnotes" && setEngine("headings"))} title="אצווה מתאימה לפירושים ('X על Y'); הערות שוליים מקשרים זוג אחד בכל פעם">ספרים רבים (אצווה)</button>
      </div>
      <label class="field">
        שיטה
        <select value={engine} onChange={(e) => setEngine(e.currentTarget.value as EngineId)}>
          {ENGINES.filter((e) => mode === "pair" || e.id !== "footnotes").map((e) => (
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
          <div class={`end target${t ? " set" : ""}`}>
            <span class="side-badge target">{info.targetRole}</span>
            <span>{t ? store.refOf(t).title : "בחרו ספר בחלונית היעד"}</span>
          </div>
        </>
      ) : (
        <>
          <label class="field">
            המקור שבו נמצאים הפירושים
            <select value={batchSource} onChange={(e) => setBatchSource(e.currentTarget.value)}>
              {sources.map((x) => (
                <option key={x.info.id} value={x.info.id}>{x.info.label} ({x.books.length} ספרים)</option>
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
      <p class="muted" style="margin:0;font-size:var(--fs-sm)">
        הכלי רק מציע. שום קישור לא נוצר בלי אישור שלכם, וכל אישור אפשר לבטל.
      </p>
      <div class="row">
        <button class="btn filled" disabled={!ready || !!store.task.value || (mode === "batch" && !paired)} onClick={start}>
          <Icon name="oz_link_search" size={18} />
          חיפוש התאמות
        </button>
        {onCancel && <button class="btn text" onClick={onCancel}>ביטול</button>}
      </div>
    </div>
  );
}

function BatchSummary() {
  const store = useStore();
  const rows = store.run.value?.batch;
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
  const run = store.run.value!;
  const st = store.suggestionState.value;
  const c = store.suggestionCounts.value;
  const [conf, setConf] = useState<Confidence | "all">("all");
  const [state, setState] = useState<SuggestionState | "all">("pending");
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState(PAGE);
  const rows = useMemo(
    () => run.result.suggestions.filter((s) => (conf === "all" || s.confidence === conf) && (state === "all" || st.get(s.id) === state)),
    [run, conf, state, st],
  );
  useEffect(() => setSel(new Set()), [conf, state, run]);
  const certain = c.pending ? store.pendingAtLeast("certain").length : 0;

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
      </div>
      <div class="row bulk">
        <button class="btn filled" disabled={!certain} onClick={() => store.approveSuggestions(store.pendingAtLeast("certain"))} title="מאשר רק הצעות שהמנוע בטוח בהן לגמרי">
          <Icon name="oz_link_check" size={18} />
          אישור כל הוודאיות ({certain.toLocaleString("he")})
        </button>
        {sel.size > 0 && (
          <>
            <button class="btn tonal" onClick={() => (store.approveSuggestions([...sel]), setSel(new Set()))}>אישור {sel.size}</button>
            <button class="btn text danger" onClick={() => (store.rejectSuggestions([...sel]), setSel(new Set()))}>דחייה</button>
          </>
        )}
      </div>
      <table class="sug-table" aria-label="הצעות">
        <thead>
          <tr>
            <th>
              <input type="checkbox" aria-label="בחירת הכול בעמוד" checked={rows.length > 0 && rows.slice(0, shown).every((r) => sel.has(r.id))} onChange={(e) => setSel(e.currentTarget.checked ? new Set(rows.slice(0, shown).map((r) => r.id)) : new Set())} />
            </th>
            <th>שורה</th>
            <th>אל</th>
            <th>ודאות</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, shown).map((s) => (
            <SugRow key={s.id} s={s} state={st.get(s.id)!} checked={sel.has(s.id)} onCheck={(on) => setSel((p) => { const n = new Set(p); on ? n.add(s.id) : n.delete(s.id); return n; })} />
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

function SugRow({ s, state, checked, onCheck }: { s: Suggestion; state: SuggestionState; checked: boolean; onCheck: (on: boolean) => void }) {
  const store = useStore();
  const end = (l: number, e?: number) => (e !== undefined && e > l ? `${l + 1}–${e + 1}` : `${l + 1}`);
  return (
    <tr
      class={`st-${state}`}
      tabIndex={0}
      onClick={() => store.showSuggestion(s.id)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && (e.preventDefault(), store.showSuggestion(s.id))}
      title={s.reasons.map((r) => r.text).join(" · ")}
    >
      <td onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={checked} onChange={(e) => onCheck(e.currentTarget.checked)} aria-label={`בחירת ההצעה לשורה ${s.source.line + 1}: ${s.heRef2}`} />
      </td>
      <td>{store.run.value?.batch && <span class="muted">{s.source.book.title} </span>}{end(s.source.line, s.source.end)}</td>
      <td>{s.heRef2}</td>
      <td>
        <span class={`conf conf-${s.confidence}`}>{CONFIDENCE_LABELS[s.confidence]}</span>
        {s.warnings.length > 0 && <Icon name="fl_warning" size={14} label={s.warnings.map((w) => w.text).join(" ")} />}
      </td>
      <td onClick={(e) => e.stopPropagation()} class="acts">
        <Decide s={s} state={state} />
      </td>
    </tr>
  );
}

function Decide({ s, state }: { s: Suggestion; state: SuggestionState }) {
  const store = useStore();
  if (state === "exists") return <span class="muted">{STATE_LABEL.exists}</span>;
  return (
    <span class="decide">
      <button class="icon-btn" aria-pressed={state === "approved"} onClick={() => (state === "approved" ? store.rejectSuggestions([s.id]) : store.approveSuggestions([s.id]))} title="אישור" aria-label="אישור">
        <Icon name="oz_check" size={18} />
      </button>
      <button class="icon-btn" aria-pressed={state === "rejected"} onClick={() => (state === "rejected" ? store.resetSuggestions([s.id]) : store.rejectSuggestions([s.id]))} title="דחייה" aria-label="דחייה">
        <Icon name="oz_cross" size={18} />
      </button>
    </span>
  );
}

/* ---------------- inline / card ---------------- */

function StepView({ card }: { card: boolean }) {
  const store = useStore();
  const run = store.run.value!;
  const st = store.suggestionState.value;
  const list = run.result.suggestions;
  const curId = store.currentSuggestion.value;
  const idx = Math.max(0, list.findIndex((s) => s.id === curId));
  const s = list[idx];

  const go = (dir: 1 | -1, pendingOnly = false) => {
    for (let i = idx + dir; i >= 0 && i < list.length; i += dir)
      if (!pendingOnly || st.get(list[i]!.id) === "pending") return store.showSuggestion(list[i]!.id);
  };
  useEffect(() => {
    if (s) store.showSuggestion(s.id);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // keys act only when no control has focus: Enter on a focused button must press THAT button (UX review #1)
      if ((e.target as HTMLElement).closest?.("input, textarea, select, button, a, [role=tab], [contenteditable]") || e.ctrlKey || e.metaKey || e.altKey || !s) return;
      const k = e.key.toLowerCase();
      if (k === "a" || k === "ש") (e.preventDefault(), store.approveSuggestions([s.id]), go(1, true));
      else if (k === "r" || k === "delete" || k === "ר") (e.preventDefault(), store.rejectSuggestions([s.id]), go(1, true));
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
          {(idx + 1).toLocaleString("he")} מתוך {list.length.toLocaleString("he")} · <span class={`conf conf-${s.confidence}`}>{CONFIDENCE_LABELS[s.confidence]}</span> · {STATE_LABEL[state]}
        </span>
        <button class="icon-btn" onClick={() => go(1)} disabled={idx === list.length - 1} aria-label="הבאה" title="הבאה (←)">
          <Icon name="fl_chevron_down" size={18} class="rot-right" />
        </button>
      </div>
      {card && <CardTexts s={s} />}
      {!card && (
        <div class="end source set">
          <span class="side-badge source">שורה {s.source.line + 1}</span>
          <span>← {s.heRef2}</span>
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
              <li key={i} class="link-item" onClick={() => store.reveal("target", a.target.book.key, a.target.line)}>
                <span>שורה {a.target.line + 1}{a.target.end !== undefined ? `–${a.target.end + 1}` : ""} · ציון {Math.round(a.score * 100)}</span>
                <span class="muted" style="grid-column:1/-1">{a.reasons.map((r) => r.text).join(" · ")}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div class="row">
        <button class="btn filled" onClick={() => (store.approveSuggestions([s.id]), go(1, true))} disabled={state === "approved" || state === "exists"}>
          <Icon name="oz_check" size={18} />
          אישור <kbd>A</kbd>
        </button>
        <button class="btn outlined" onClick={() => (store.rejectSuggestions([s.id]), go(1, true))} disabled={state === "rejected"}>
          <Icon name="oz_cross" size={18} />
          דחייה <kbd>R</kbd>
        </button>
        <span class="grow" />
        <button class="btn text" onClick={() => go(1, true)}>לממתינה הבאה</button>
      </div>
      <p class="muted" style="margin:0;font-size:var(--fs-sm)">שני צדי ההצעה מוצגים ומסומנים בחלוניות הספרים.</p>
    </div>
  );
}

function CardTexts({ s }: { s: Suggestion }) {
  const store = useStore();
  store.lines.tick.value;
  const text = (key: string, line: number) => {
    const l = store.lines.line(key, line);
    return l ? plainText(l.anchorText) : "…";
  };
  return (
    <>
      <div class="end source set">
        <span class="side-badge source">{s.source.book.title} {s.source.line + 1}</span>
        <span class="snip" style="-webkit-line-clamp:6">{text(s.source.book.key, s.source.line)}</span>
      </div>
      <div class="end target set">
        <span class="side-badge target">{s.heRef2}</span>
        <span class="snip" style="-webkit-line-clamp:6">{text(s.target.book.key, s.target.line)}</span>
      </div>
    </>
  );
}
