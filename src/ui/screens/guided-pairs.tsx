import { useEffect, useState } from "preact/hooks";
import type { BookRef } from "../../core/links/model";
import { ENGINES } from "../../linking/automatic";
import { CONFIDENCE_LABELS, type SourceFilter } from "../../linking/automatic";
import { LINE_FILTER_CHOICES } from "../../linking/automatic/option-specs";
import { notesBaseTitle, pairMethodKey, type PairControl, type PairEngineId, type PlanStep, type PlanUnsuitable } from "../../linking/plan";
import { durationText } from "../../state/guided-flow";
import { SourceFilterPreviewBox } from "../workspace/source-filter-preview";
import { TypeOptions } from "../workspace/type-options";
import type { TitleFitReport } from "../../linking/title-fit";
import { useStore } from "../context";
import { fitBadge, fitKey, forcedHeadingsWarning, pairsToAutoCheck } from "./pair-fit";

/*
 * The pairs of the guided plan (issues 21 and 26): for each commentary and the book it is written on, whether the titles
 * fit (the headings method is right only then: linking/title-fit.ts, the reasons with the numbers behind them), the method
 * of that pair on request, and "force dibur-hamatchil for all pairs". Naming a method the books do not fit is allowed — an
 * explicit decision — and says what will go wrong. Folded in simple mode (the plan already skips headings where titles do
 * not fit, and says so); advanced mode opens it. Over GuidedFlowState.setMethods / setPairMethods; nothing here plans.
 *
 * Per pair, too (V6 3.4, over setPairControl): whether the pair runs at all, the type its links are written with, the lowest
 * confidence of its suggestions, the plan's reasons for the methods it does not run, and what the pair is expected to cost.
 * The simple mode shows only "include this pair"; the advanced mode shows the rest, as a row on a wide screen and a card on a
 * phone. Every control starts on "chosen by the tool" and never locks anything: a pair nobody touched stays automatic.
 */
const THRESHOLDS: ReadonlyArray<{ value: NonNullable<PairControl["minConfidence"]> | ""; label: string }> = [
  { value: "", label: "כל ההצעות" },
  { value: "possible", label: `${CONFIDENCE_LABELS.possible} ומעלה` },
  { value: "high", label: `${CONFIDENCE_LABELS.high} ומעלה` },
  { value: "certain", label: `${CONFIDENCE_LABELS.certain} בלבד` },
];
const engineTitle = (id: string): string => ENGINES.find((e) => e.id === id)?.title ?? id;
type Choice = "" | "headings" | "dh" | "both";
const CHOICES: Record<Choice, { label: string; methods: readonly PairEngineId[] | null }> = {
  "": { label: "ברירת המחדל של הכלי", methods: null },
  headings: { label: "רק לפי כותרות", methods: ["headings"] },
  dh: { label: "רק לפי דיבור המתחיל", methods: ["dibur-hamatchil"] },
  both: { label: "כותרות ודיבור המתחיל, בלי בדיקת התאמה", methods: ["headings", "dibur-hamatchil"] },
};

interface Pair {
  dependant: BookRef;
  base: BookRef;
  notes: boolean;
}

/** The plan's pairs, and the ones the user switched off (they have no steps, but must stay on the list to be switched back on). */
function pairsOf(steps: readonly PlanStep[], unsuitable: readonly PlanUnsuitable[]): Pair[] {
  const seen = new Map<string, Pair>();
  for (const s of steps) {
    if (s.kind !== "pair") continue;
    const { dependant, base, kind } = s.relation;
    const k = pairMethodKey(dependant.title, base.title);
    if (!seen.has(k)) seen.set(k, { dependant, base, notes: kind === "notes" });
  }
  for (const u of unsuitable) {
    if (u.reason !== "disabled") continue;
    const k = pairMethodKey(u.dependant.title, u.base.title);
    if (!seen.has(k)) seen.set(k, { dependant: u.dependant, base: u.base, notes: notesBaseTitle(u.dependant.title) !== null });
  }
  return [...seen.values()];
}

/** What a pair is expected to cost: the sum of its steps' estimates, or null when one of them cannot be estimated. */
function costOf(steps: readonly PlanStep[], p: Pair): number | null {
  let ms = 0;
  for (const s of steps) {
    if (s.kind !== "pair" || s.relation.dependant.title !== p.dependant.title || s.relation.base.title !== p.base.title) continue;
    if (!s.estimate) return null;
    ms += s.estimate.ms;
  }
  return ms;
}

export function PairChoices() {
  const store = useStore();
  const g = store.guided;
  const plan = g.plan.value;
  const advanced = store.prefs.advanced.value;
  const chosen = g.pairMethods.value;
  const forced = g.methods.value;
  const [fits, setFits] = useState<Record<string, TitleFitReport | null | "loading">>({});
  const controls = g.pairControls.value;
  const pairs = plan ? pairsOf(plan.steps, plan.unsuitable) : [];
  const control = (k: string, p: Pair, change: Partial<Record<keyof PairControl, string | boolean | undefined>>) =>
    g.setPairControl(p.dependant.title, p.base.title, { ...controls[k], ...change } as PairControl);
  const forceDh = !!forced && forced.size === 1 && forced.has("dibur-hamatchil");

  const check = async (p: Pair, again = false) => {
    const k = fitKey(p);
    if (!again && fits[k]) return;
    setFits((f) => ({ ...f, [k]: "loading" }));
    const report = await store.maxLink.titleFit(p.dependant.key, p.base.key).catch(() => null);
    setFits((f) => ({ ...f, [k]: report }));
  };
  // a few pairs are checked at once; a long list is checked a pair at a time, on request
  useEffect(() => {
    for (const p of pairsToAutoCheck(pairs, fits)) void check(p);
  }, [plan]);

  if (!plan || !pairs.length) return null;
  const choiceOf = (k: string): Choice => {
    const m = chosen[k];
    if (!m?.length) return "";
    return m.length === 2 ? "both" : m[0] === "headings" ? "headings" : "dh";
  };

  return (
    <details class="guided-pairs" open={advanced || undefined}>
      <summary>שיטה לכל זוג (לא חובה)</summary>
      <div class="pairs-body">
        <label class="check">
          <input
            type="checkbox"
            checked={forceDh}
            onChange={(e) => {
              // a pair with methods of its own would bypass the forced set (plan.ts), so forcing starts from the defaults
              if (e.currentTarget.checked) for (const p of pairs) g.setPairMethods(p.dependant.title, p.base.title, null);
              g.setMethods(e.currentTarget.checked ? new Set(["dibur-hamatchil"]) : null);
            }}
          />
          <span>
            <b>לכפות דיבור המתחיל לכל הזוגות</b>
            <span class="muted"> — במקום שיטת הכותרות.</span>
          </span>
        </label>
        <label class="field">
          אילו שורות של הספרים מקושרות
          {/* the run's line filter (issue #27, findings #40 A1): every method of every pair obeys it; a regular expression of the user's is in the workspace form */}
          <select
            value={g.lineFilter.value && "preset" in g.lineFilter.value.prefix ? g.lineFilter.value.prefix.preset : ""}
            onChange={(e) => {
              const v = e.currentTarget.value;
              g.setLineFilter(v ? ({ prefix: { preset: v } } as SourceFilter) : null);
            }}
          >
            {LINE_FILTER_CHOICES.filter(([v]) => v !== "regex").map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
          <span class="muted">הסינון חל על כל השיטות ועל כל הזוגות: שורה שאינו כולל לא תקבל הצעה.</span>
        </label>
        {/* #42 C16: the same preview as in the pair, batch and max-link forms — which lines of a book the filter lets in, before the run */}
        <SourceFilterPreviewBox engine={forceDh ? "dibur-hamatchil" : "headings"} books={[...new Set(pairs.map((p) => p.dependant.key))]} filter={g.lineFilter.value} />
        {forceDh && (
          <p class="pair-force-note warn-text" role="status">
            דיבור המתחיל ירוץ במקום שיטת הכותרות בכל הזוגות, גם היכן שהכותרות מתאימות; הערות שוליים ומראי מקומות ממשיכים לרוץ כרגיל. הוא איטי יותר, ושורות בלי ד"ה ברור יקבלו הצעות חלשות. בדקו את ההצעות בקפידה.
          </p>
        )}
        <ul class={`pair-list${advanced ? " adv" : ""}`}>
          {pairs.map((p) => {
            const k = pairMethodKey(p.dependant.title, p.base.title);
            const fit = fits[fitKey(p)];
            const choice = choiceOf(k);
            const ctl = controls[k] ?? {};
            const off = ctl.enabled === false;
            const cost = off ? 0 : costOf(plan.steps, p);
            const skipped = plan.unsuitable.filter((u) => u.reason !== "disabled" && u.dependant.title === p.dependant.title && u.base.title === p.base.title);
            const doubt = (choice === "headings" || choice === "both") && fit && fit !== "loading" ? forcedHeadingsWarning(fit) : null;
            return (
              <li key={k} class={`pair-row${off ? " off" : ""}`} data-pair={k}>
                <div class="pair-names">
                  <b class="pair-dep">{p.dependant.title}</b>
                  <span aria-hidden="true"> ← </span>
                  <span class="sr-only">על </span>
                  <span class="pair-base">{p.base.title}</span>
                </div>
                <div class="pair-main">
                {off ? (
                  <p class="muted pair-off">הזוג הושבת, ולכן שום שיטה לא תרוץ עליו. סמנו "לכלול את הזוג" כדי להחזיר אותו.</p>
                ) : p.notes ? (
                  <div class="muted">ספר הערות: תרוץ שיטת הערות השוליים.</div>
                ) : (
                  <>
                    <div class="pair-fit">
                      {fit === "loading" ? (
                        <span class="muted">בודק את הכותרות…</span>
                      ) : fit ? (
                        <>
                          <span class={`fit-badge ${fitBadge(fit.verdict).cls}`}>{fitBadge(fit.verdict).text}</span>
                          {(advanced || fit.verdict !== "fit") && (
                            <ul class="pair-reasons">
                              {fit.reasons.map((r) => (
                                <li key={r.code} class={r.ok ? "ok" : "no"}>
                                  <span class="sign" aria-hidden="true">{r.ok ? "✓" : "✕"}</span>
                                  <span class="sr-only">{r.ok ? "מתקיים: " : "לא מתקיים: "}</span>
                                  {r.text}
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      ) : (
                        <button class="btn text small" onClick={() => void check(p, true)}>בדיקת התאמת הכותרות</button>
                      )}
                    </div>
                    <label class="field">
                      <span class="sr-only">שיטה לזוג: {p.dependant.title} ← {p.base.title}</span>
                      <select
                        aria-label={`שיטה לזוג: ${p.dependant.title} ← ${p.base.title}`}
                        value={choice}
                        disabled={forceDh}
                        onChange={(e) => g.setPairMethods(p.dependant.title, p.base.title, CHOICES[e.currentTarget.value as Choice].methods)}
                      >
                        {(Object.keys(CHOICES) as Choice[]).map((c) => (
                          <option key={c} value={c}>{CHOICES[c].label}</option>
                        ))}
                      </select>
                    </label>
                    {doubt && (
                      <p class="pair-warn warn-text" role="status">
                        {doubt}
                      </p>
                    )}
                  </>
                )}
                </div>
                <div class="pair-ctl">
                  <label class="check">
                    <input type="checkbox" checked={!off} onChange={(e) => control(k, p, { enabled: e.currentTarget.checked ? undefined : false })} />
                    <span>לכלול את הזוג{advanced ? "" : " בריצה"}<span class="sr-only">: {p.dependant.title} ← {p.base.title}</span></span>
                  </label>
                  {advanced && !off && (
                    <>
                      <label class="field">
                        <span>סוג הקישור</span>
                        <select aria-label={`סוג הקישור לזוג: ${p.dependant.title} ← ${p.base.title}`} value={ctl.connectionType ?? ""} onChange={(e) => control(k, p, { connectionType: e.currentTarget.value || undefined })}>
                          <option value="">לפי בחירת הכלי</option>
                          <TypeOptions />
                        </select>
                      </label>
                      <label class="field">
                        <span>הצעות מרמת ביטחון</span>
                        <select aria-label={`הצעות מרמת ביטחון, לזוג: ${p.dependant.title} ← ${p.base.title}`} value={ctl.minConfidence ?? ""} onChange={(e) => control(k, p, { minConfidence: e.currentTarget.value || undefined })}>
                          {THRESHOLDS.map((t) => (
                            <option key={t.value} value={t.value}>{t.label}</option>
                          ))}
                        </select>
                      </label>
                      <p class="pair-cost muted small">
                        {cost === null ? <span title="אורך אחד הספרים של הזוג עוד לא נקרא, ולכן אי אפשר להעריך כמה זמן ייקח.">זמן משוער: עדיין לא ידוע.</span> : `זמן משוער לזוג: ${durationText(cost)}.`}
                      </p>
                      {skipped.length > 0 && (
                        <div class="pair-skipped small">
                          <b>שיטות שלא ירוצו על הזוג:</b>
                          <ul>
                            {skipped.map((u) => (
                              <li key={u.engine}>
                                {engineTitle(u.engine)} — {u.why}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <p class="muted small">
          {ENGINES.filter((e) => e.id === "headings" || e.id === "dibur-hamatchil").map((e) => e.title).join(" ו")} — הכלי בוחר שיטה לפי התאמת הכותרות, לא לפי כמה קישורים יוצאים.
        </p>
      </div>
    </details>
  );
}
