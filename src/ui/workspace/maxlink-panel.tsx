import { useEffect, useMemo, useState } from "preact/hooks";
import { ENGINES, type EngineId } from "../../linking/automatic";
import { defaultFormValues, toEngineOptions, type FormValues, type OptionsCheck } from "../../linking/automatic/option-specs";
import type { ReportCounts, ReportRow } from "../../linking/maxlink-report";
import { AUTO_EVIDENCE_BOOKS, EVIDENCE_BOOKS, type MaxLinkScope } from "../../state/maxlink";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { sourceNameText } from "../shell/file-name";
import { EngineOptions } from "./engine-options";
import "./maxlink.css";

/*
 * Max-link ("קישור מרבי") in the suggestions tab: choose what to link (this book, one source or
 * folder, everything open), review the plan — which engine runs on which book and why — untick
 * engines, run. The result is an ordinary suggestions run; MaxLinkReportView sits above its table.
 * Simple by default: the per-book reasons are in a details section, the step list in advanced mode.
 * In advanced mode every engine of the plan has its settings (the same forms as a single run); they
 * reach the worker as MaxLinkRunOptions.engineOptions, and an invalid one blocks the run.
 */
type ScopeKind = Exclude<MaxLinkScope["kind"], "sources">;
const SCOPE_LABEL: Record<ScopeKind, string> = { book: "הספר הנוכחי", source: "מקור או תיקייה", all: "כל הספרים הפתוחים" };
const ENGINE_TITLE = new Map(ENGINES.map((e) => [e.id, e.title]));
const SHOWN_BOOKS = 200;

export function MaxLinkForm({ onDone, onCancel }: { onDone: () => void; onCancel: (() => void) | undefined }) {
  const store = useStore();
  const sources = store.sources.value;
  const current = store.view[store.activeSide.value].value ?? store.view.source.value;
  // a guided task names the source to link (the folder against the Otzaria database, a personal database)
  const asked = store.intent.value?.sourceId;
  const askedSource = asked && sources.some((s) => s.info.id === asked) ? asked : undefined;
  const [kind, setKind] = useState<ScopeKind>(() => (store.intent.value?.allBooks ? "all" : askedSource || sources.some((s) => s.info.kind === "text-files") || !current ? (sources.length > 1 ? "source" : "all") : "book"));
  const [sourceId, setSourceId] = useState<string>(() => askedSource ?? sources.find((s) => s.info.kind === "text-files")?.info.id ?? sources.at(-1)?.info.id ?? "");
  const [off, setOff] = useState<ReadonlySet<EngineId>>(new Set());
  /** the source whose books are the bases when a base is open in several sources ("" = automatic) */
  const [prefer, setPrefer] = useState("");
  const scope: MaxLinkScope | null = kind === "book" ? (current ? { kind, key: current } : null) : kind === "source" ? (sourceId ? { kind, id: sourceId } : null) : { kind };
  const books = store.books.value;

  // the database's own links pair commentaries the titles do not (linking/plan.ts); read before planning
  // (by itself for a few books; a whole database waits for a click — it reads every selected book's links)
  const checkedCount = store.maxLink.checkedCount.value;
  const pending = useMemo(() => (scope ? store.maxLink.evidencePending(scope).length : 0), [kind, current, sourceId, books, checkedCount]);
  useEffect(() => {
    if (scope && pending > 0 && pending <= AUTO_EVIDENCE_BOOKS) void store.maxLink.gatherEvidence(scope);
  }, [kind, current, sourceId, books]);
  const evidence = store.maxLink.evidence.value;
  const unchecked = store.maxLink.unchecked.value;
  const full = useMemo(() => (scope ? store.maxLink.plan(scope, undefined, prefer || undefined) : null), [kind, current, sourceId, books, evidence, prefer]);
  const enabled = useMemo(() => new Set((Object.keys(full?.perEngine ?? {}) as EngineId[]).filter((e) => !off.has(e))), [full, off]);
  const plan = useMemo(() => (scope && full ? (off.size ? store.maxLink.plan(scope, enabled, prefer || undefined) : full) : null), [full, enabled]);
  const unpaired = plan?.books.filter((b) => b.unpaired).length ?? 0;
  const baseSources = full?.baseSources ?? [];
  const labelOf = (id: string) => sources.find((s) => s.info.id === id)?.info.label ?? id;
  const engines = ENGINES.filter((e) => full?.perEngine[e.id]);
  const skipped = plan?.books.filter((b) => b.skipped).length ?? 0;
  const advanced = store.prefs.advanced.value;
  /** per-engine settings, kept while the form is open */
  const [formValues, setFormValues] = useState<Partial<Record<EngineId, FormValues>>>({});
  const checks = useMemo(() => {
    const out = new Map<EngineId, OptionsCheck>();
    if (advanced) for (const e of engines) if (!off.has(e.id)) out.set(e.id, toEngineOptions(e.id, formValues[e.id] ?? defaultFormValues(e.id)));
    return out;
  }, [advanced, engines.map((e) => e.id).join(), off, formValues]);
  const invalid = [...checks.values()].some((c) => Object.keys(c.errors).length > 0);

  const start = async () => {
    if (!plan || !scope) return;
    const engineOptions: Partial<Record<EngineId, Record<string, unknown>>> = {};
    for (const [e, c] of checks) if (Object.keys(c.options).length) engineOptions[e] = c.options;
    if (await store.maxLink.run(plan, store.maxLink.scopeLabel(scope), { engineOptions })) onDone();
  };

  return (
    <>
      <p class="muted" style="margin:0;font-size:var(--fs-sm)">
        הכלי מזהה לבד אילו ספרים קשורים זה לזה — פירוש וספר הבסיס שלו, ספר הערות והספר שעליו נכתב — מריץ על כל אחד את כל השיטות שמתאימות לו, ומאחד את התוצאות לרשימה אחת בלי כפילויות.
      </p>
      <div class="filters" style="padding:0" role="radiogroup" aria-label="אילו ספרים לקשר">
        {(["book", "source", "all"] as const).map((k) => (
          <button key={k} class="chip" role="radio" aria-checked={kind === k} aria-pressed={kind === k} disabled={k === "book" && !current} onClick={() => setKind(k)}>
            {SCOPE_LABEL[k]}
          </button>
        ))}
      </div>
      {kind === "book" && current && (
        <div class="end source set">
          <span class="side-badge source">הספר</span>
          <span>{store.refOf(current).title}</span>
        </div>
      )}
      {kind === "source" && (
        <label class="field">
          המקור
          <select value={sourceId} onChange={(e) => setSourceId(e.currentTarget.value)}>
            {sources.map((x) => (
              <option key={x.info.id} value={x.info.id}>{sourceNameText(x.info.label)} ({x.books.length.toLocaleString("he")} ספרים)</option>
            ))}
          </select>
        </label>
      )}
      {plan && (
        <section class="ml-plan" aria-label="התוכנית">
          <p class="ml-plan-line" role="status">
            {plan.books.length.toLocaleString("he")} ספרים נבחרו · ל־{plan.identified.toLocaleString("he")} נמצא קשר · {plan.steps.length.toLocaleString("he")} הרצות
            {skipped > 0 && ` · ${skipped.toLocaleString("he")} בלי קישור אוטומטי`}
            {unpaired > 0 && ` · ${unpaired.toLocaleString("he")} בלי ספר הבסיס שלהם`}
          </p>
          {baseSources.length > 0 && (
            <label class="field">
              ספרי הבסיס כשהם פתוחים בכמה מקורות ({baseSources.slice(0, 3).map((b) => `"${b.title}"`).join(", ")}{baseSources.length > 3 ? "…" : ""})
              <select value={prefer} onChange={(e) => setPrefer(e.currentTarget.value)}>
                <option value="">אוטומטי: מאותו מקור כמו הפירוש</option>
                {[...new Set(baseSources.flatMap((b) => b.sources))].map((id) => (
                  <option key={id} value={id}>מתוך "{labelOf(id)}"</option>
                ))}
              </select>
            </label>
          )}
          {pending > AUTO_EVIDENCE_BOOKS && scope && (
            <p class="muted" style="margin:0;font-size:var(--fs-sm)">
              {unchecked > 0 ? `הקישורים שכבר יש במסד נבדקו לחלק מהספרים; ל־${pending.toLocaleString("he")} ספרים` : `ל־${pending.toLocaleString("he")} ספרים מהמסד`} הקשר נקבע עכשיו לפי ההצהרה במסד והשם בלבד. בדיקת הקישורים הקיימים מוצאת עוד פירושים ובסיסים (למשל "בית יוסף" על "טור").{" "}
              <button class="btn small" onClick={() => void store.maxLink.gatherEvidence(scope)}>
                בדיקת הקישורים הקיימים ({Math.min(pending, EVIDENCE_BOOKS).toLocaleString("he")} ספרים)
              </button>
            </p>
          )}
          {engines.length > 0 && (
            <fieldset class="ml-engines">
              <legend>השיטות שירוצו</legend>
              {engines.map((e) => (
                <label key={e.id} class="check" title={e.description}>
                  <input type="checkbox" checked={!off.has(e.id)} onChange={(ev) => setOff((p) => { const n = new Set(p); ev.currentTarget.checked ? n.delete(e.id) : n.add(e.id); return n; })} />
                  <span>{e.title} <span class="count">{(full?.perEngine[e.id] ?? 0).toLocaleString("he")}</span></span>
                </label>
              ))}
            </fieldset>
          )}
          {advanced &&
            engines
              .filter((e) => !off.has(e.id))
              .map((e) => (
                <section key={e.id} aria-label={`הגדרות: ${e.title}`}>
                  <b style="font-size:var(--fs-sm)">{e.title}</b>
                  <EngineOptions
                    engine={e.id}
                    values={formValues[e.id] ?? defaultFormValues(e.id)}
                    check={checks.get(e.id)!}
                    onChange={(key, v) => setFormValues((all) => ({ ...all, [e.id]: { ...(all[e.id] ?? defaultFormValues(e.id)), [key]: v } }))}
                    onReset={() => setFormValues((all) => ({ ...all, [e.id]: defaultFormValues(e.id) }))}
                  />
                </section>
              ))}
          <details class="held" open={(advanced || unpaired > 0) && plan.books.length <= 12}>
            <summary>למה כל ספר ({plan.books.length.toLocaleString("he")})</summary>
            <ul class="ml-books">
              {plan.books.slice(0, SHOWN_BOOKS).map((b) => (
                <li key={b.book.key} class={b.skipped || b.unpaired ? "skipped" : ""}>
                  <b>{b.book.title}</b>
                  {b.decisions.map((d, i) => <span key={i}>{d}</span>)}
                  {b.skipped && (
                    <span class="why-not"><Icon name="fl_warning" size={14} /> {b.skipped}</span>
                  )}
                  {b.unpaired && (
                    <span class="why-not"><Icon name="fl_warning" size={14} /> לא קושר לספר הבסיס שלו: {b.unpaired}</span>
                  )}
                </li>
              ))}
              {plan.books.length > SHOWN_BOOKS && <li class="muted">ועוד {(plan.books.length - SHOWN_BOOKS).toLocaleString("he")} ספרים.</li>}
            </ul>
          </details>
          {advanced && plan.steps.length > 0 && (
            <details class="held">
              <summary>ההרצות ({plan.steps.length.toLocaleString("he")})</summary>
              <ol class="ml-steps">
                {plan.steps.slice(0, SHOWN_BOOKS).map((s) => (
                  <li key={s.id}>
                    <b>{ENGINE_TITLE.get(s.engine) ?? s.engine}</b>: {s.source.title}{s.kind === "pair" ? ` ← ${s.target.title}` : ""}
                    <div class="muted">{s.why}</div>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </section>
      )}
      <p class="muted" style="margin:0;font-size:var(--fs-sm)">
        הכלי רק מציע. שום קישור לא נוצר בלי אישור שלכם, ו"אישור כל הוודאיות" מאשר רק הצעות ודאיות.
      </p>
      <div class="row">
        <button class="btn filled" disabled={!plan?.steps.length || !!store.task.value || invalid} onClick={start} title={invalid ? "יש הגדרה לא תקינה בהגדרות השיטות" : undefined}>
          <Icon name="oz_links" size={18} />
          הפעלת קישור מרבי
        </button>
        {onCancel && <button class="btn text" onClick={onCancel}>ביטול</button>}
      </div>
    </>
  );
}

const TILES: readonly [keyof ReportCounts | "booksChecked" | "booksIdentified", string][] = [
  ["booksChecked", "ספרים נבדקו"],
  ["booksIdentified", "זוהה קשר"],
  ["links", "הצעות"],
  ["certain", "ודאיות"],
  ["review", "לבדיקה"],
  ["approved", "אושרו"],
  ["rejected", "נדחו"],
  ["existing", "כבר קיימים"],
  ["duplicates", "כפילויות שאוחדו"],
  ["agreements", "הסכמה בין שיטות"],
  ["conflicts", "סתירות"],
  ["errors", "שגיאות"],
];

/** The max-link report above the suggestions: overall tiles, per book and per engine, CSV. */
export function MaxLinkReportView() {
  const store = useStore();
  const rep = store.maxLink.report.value;
  const info = store.suggestions.run.value?.maxlink;
  if (!rep || !info) return null;
  const o = rep.overall;
  return (
    <details class="held ml-report" open>
      <summary>דוח הקישור המרבי — {info.scope}</summary>
      <dl class="ml-tiles">
        {TILES.map(([k, label]) => (
          <div key={k} class={`tile tile-${k}${o[k] ? "" : " zero"}`}>
            <dt>{label}</dt>
            <dd>{o[k].toLocaleString("he")}</dd>
          </div>
        ))}
      </dl>
      <details class="held">
        <summary>לפי ספר ({rep.perBook.length.toLocaleString("he")})</summary>
        <ReportTable rows={rep.perBook} label="דוח לפי ספר" first="ספר" />
      </details>
      <details class="held">
        <summary>לפי שיטה ({rep.perEngine.length.toLocaleString("he")})</summary>
        <ReportTable rows={rep.perEngine} label="דוח לפי שיטה" first="שיטה" />
      </details>
      {store.prefs.advanced.value && (
        <details class="held">
          <summary>ההרצות ({info.steps.length.toLocaleString("he")}, {(info.ms / 1000).toLocaleString("he", { maximumFractionDigits: 1 })} שניות)</summary>
          <ol class="ml-steps">
            {info.steps.slice(0, SHOWN_BOOKS).map((s) => (
              <li key={s.id} class={s.error ? "failed" : ""}>
                <b>{ENGINE_TITLE.get(s.engine) ?? s.engine}</b>: {s.source.title}{s.target ? ` ← ${s.target.title}` : ""} · {s.raw.toLocaleString("he")} הצעות · {s.ms.toLocaleString("he")} ms
                {s.error && <div class="why-not"><Icon name="fl_error_circle" size={14} /> {s.error}</div>}
                {s.notes.slice(0, 3).map((n, i) => <div key={i} class="muted">{n.text}</div>)}
              </li>
            ))}
          </ol>
        </details>
      )}
      <div class="row">
        <button class="btn outlined" onClick={() => store.maxLink.saveReport()}>
          <Icon name="fl_arrow_download" size={16} />
          ייצוא הדוח (CSV)
        </button>
      </div>
    </details>
  );
}

function ReportTable({ rows, label, first }: { rows: readonly ReportRow[]; label: string; first: string }) {
  return (
    <div class="ml-table-wrap">
      <table class="sug-table ml-table" aria-label={label}>
        <thead>
          <tr><th>{first}</th><th>הצעות</th><th>ודאיות</th><th>לבדיקה</th><th>אושרו</th><th>נדחו</th><th>קיימים</th><th>סתירות</th><th>שגיאות</th></tr>
        </thead>
        <tbody>
          {rows.slice(0, SHOWN_BOOKS).map((r) => (
            <tr key={r.key}>
              <td>{r.label}{r.note && <div class="muted">{r.note}</div>}</td>
              <td>{r.links.toLocaleString("he")}</td>
              <td>{r.certain.toLocaleString("he")}</td>
              <td>{r.review.toLocaleString("he")}</td>
              <td>{r.approved.toLocaleString("he")}</td>
              <td>{r.rejected.toLocaleString("he")}</td>
              <td>{r.existing.toLocaleString("he")}</td>
              <td>{r.conflicts.toLocaleString("he")}</td>
              <td>{r.errors.toLocaleString("he")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
