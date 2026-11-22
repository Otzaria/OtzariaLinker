import { useEffect, useState } from "preact/hooks";
import type { BookRef } from "../../core/links/model";
import { ENGINES } from "../../linking/automatic";
import { pairMethodKey, type PairEngineId, type PlanStep } from "../../linking/plan";
import type { TitleFitReport, TitleFitVerdict } from "../../linking/title-fit";
import { useStore } from "../context";

/*
 * The pairs of the guided plan (issues 21 and 26): for each commentary and the book it is written on, whether the titles
 * fit (the headings method is right only then: linking/title-fit.ts, the reasons with the numbers behind them), the method
 * of that pair on request, and "force dibur-hamatchil for all pairs". Naming a method the books do not fit is allowed — an
 * explicit decision — and says what will go wrong. Folded in simple mode (the plan already skips headings where titles do
 * not fit, and says so); advanced mode opens it. Over GuidedFlowState.setMethods / setPairMethods; nothing here plans.
 *
 * Not offered (no data layer for it yet): switching one pair off, a link type or a confidence threshold per pair.
 */
type Choice = "" | "headings" | "dh" | "both";
const CHOICES: Record<Choice, { label: string; methods: readonly PairEngineId[] | null }> = {
  "": { label: "ברירת המחדל של הכלי", methods: null },
  headings: { label: "רק לפי כותרות", methods: ["headings"] },
  dh: { label: "רק לפי דיבור המתחיל", methods: ["dibur-hamatchil"] },
  both: { label: "כותרות ודיבור המתחיל, בלי בדיקת התאמה", methods: ["headings", "dibur-hamatchil"] },
};
const VERDICT: Record<TitleFitVerdict, string> = { fit: "הכותרות מתאימות", partial: "הכותרות מתאימות חלקית", unfit: "הכותרות לא מתאימות" };
const MAX_AUTO = 12;
/** the verdicts are kept per pair of BOOKS (a same-titled book from another source is another pair) */
const fitKey = (p: { dependant: BookRef; base: BookRef }): string => `${p.dependant.key}>${p.base.key}`;

interface Pair {
  dependant: BookRef;
  base: BookRef;
  notes: boolean;
}

function pairsOf(steps: readonly PlanStep[]): Pair[] {
  const seen = new Map<string, Pair>();
  for (const s of steps) {
    if (s.kind !== "pair") continue;
    const { dependant, base, kind } = s.relation;
    const k = pairMethodKey(dependant.title, base.title);
    if (!seen.has(k)) seen.set(k, { dependant, base, notes: kind === "notes" });
  }
  return [...seen.values()];
}

export function PairChoices() {
  const store = useStore();
  const g = store.guided;
  const plan = g.plan.value;
  const advanced = store.prefs.advanced.value;
  const chosen = g.pairMethods.value;
  const forced = g.methods.value;
  const [fits, setFits] = useState<Record<string, TitleFitReport | null | "loading">>({});
  const pairs = plan ? pairsOf(plan.steps) : [];
  const forceDh = !!forced && forced.size === 1 && forced.has("dibur-hamatchil");

  const check = async (p: Pair) => {
    const k = fitKey(p);
    if (fits[k]) return;
    setFits((f) => ({ ...f, [k]: "loading" }));
    const report = await store.maxLink.titleFit(p.dependant.key, p.base.key).catch(() => null);
    setFits((f) => ({ ...f, [k]: report }));
  };
  // a few pairs are checked at once; a long list is checked a pair at a time, on request
  useEffect(() => {
    if (pairs.length && pairs.length <= MAX_AUTO) for (const p of pairs.filter((x) => !x.notes)) void check(p);
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
        {forceDh && (
          <p class="pair-force-note warn-text" role="status">
            דיבור המתחיל ירוץ במקום שיטת הכותרות בכל הזוגות, גם היכן שהכותרות מתאימות; הערות שוליים ומראי מקומות ממשיכים לרוץ כרגיל. הוא איטי יותר, ושורות בלי ד"ה ברור יקבלו הצעות חלשות. בדקו את ההצעות בקפידה.
          </p>
        )}
        <ul class="pair-list">
          {pairs.map((p) => {
            const k = pairMethodKey(p.dependant.title, p.base.title);
            const fit = fits[fitKey(p)];
            const choice = choiceOf(k);
            const risky = (choice === "headings" || choice === "both") && fit && fit !== "loading" && fit.verdict === "unfit";
            return (
              <li key={k} class="pair-row" data-pair={k}>
                <div class="pair-names">
                  <b class="pair-dep">{p.dependant.title}</b>
                  <span aria-hidden="true"> ← </span>
                  <span class="sr-only">על </span>
                  <span class="pair-base">{p.base.title}</span>
                </div>
                {p.notes ? (
                  <div class="muted">ספר הערות: תרוץ שיטת הערות השוליים.</div>
                ) : (
                  <>
                    <div class="pair-fit">
                      {fit === "loading" ? (
                        <span class="muted">בודק את הכותרות…</span>
                      ) : fit ? (
                        <>
                          <span class={`fit-badge fit-${fit.verdict}`}>{VERDICT[fit.verdict]}</span>
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
                        <button class="btn text small" onClick={() => void check(p)}>בדיקת התאמת הכותרות</button>
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
                    {risky && (
                      <p class="pair-warn warn-text" role="status">
                        הכותרות של הפירוש אינן של ספר הבסיס, ושיטת הכותרות תקשר שורות למקום שגוי. בחרתם בה במפורש, ולכן היא תרוץ בלי הבדיקה. בדקו את ההצעות שלה בקפידה.
                      </p>
                    )}
                  </>
                )}
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
