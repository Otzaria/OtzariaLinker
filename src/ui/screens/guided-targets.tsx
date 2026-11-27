import { useState } from "preact/hooks";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { BookChecklist } from "../workspace/book-checklist";
import type { GuidedTarget } from "../../state/guided-flow";

/*
 * The target books of each commentary in the guided plan (V7 §3.7, issues #26 and #45): a commentary may be aimed at more than
 * one book (the Shulchan Aruch and its ש"ך). Here the user adds target books (search, filter by file or database, copies told
 * apart, a count — BookChecklist), sees which one is primary and in what order the others are searched, changes both, removes an
 * added book in one click, and chooses what happens to a line that names no target. Over GuidedFlowState.setExtraTargets /
 * setTargetHierarchy / removeTarget: the engine's TargetHierarchy (PlanChoices.targets) does the work; nothing is planned here.
 * The methods of each pair (one per target) stay in "שיטה לכל זוג" above.
 */
const SHOWN = 30;
const ROLE: Record<GuidedTarget["role"], string> = { primary: "ראשי", secondary: "משני", equal: "" };

export function GuidedTargets() {
  const store = useStore();
  const g = store.guided;
  const extras = g.extraTargets.value;
  // opened at first in advanced mode or when targets were added (a continued flow); afterwards it is the user's: a removed target must not fold it
  const [open] = useState(store.prefs.advanced.peek() || Object.keys(extras).length > 0);
  const plan = g.plan.value;
  if (!plan) return null;
  // the commentaries of the plan: a dependant with a commentary relation (a notes book has its one main book)
  const deps = [...new Set(plan.steps.flatMap((s) => (s.kind === "pair" && s.relation.kind === "commentary" ? [s.relation.dependant.title] : [])))];
  if (!deps.length) return null;
  const many = deps.filter((d) => g.targetsOf(d).length > 1).length;
  return (
    <details class="guided-targets" open={open || undefined}>
      <summary>הספרים שכל פירוש כתוב עליהם (לא חובה){many > 0 && ` · ${many.toLocaleString("he")} על כמה ספרים`}</summary>
      <div class="pairs-body">
        <p class="muted small">
          פירוש שמתייחס לכמה ספרים — למשל לשולחן ערוך ולש"ך — מקושר לספר הראשי, ולספרים האחרים רק בשורות שמזכירות אותם בשם. הוסיפו ספר,
          וקבעו איזה ספר ראשי ובאיזה סדר מחפשים בשאר.
        </p>
        <ul class="pair-list">
          {deps.slice(0, SHOWN).map((dep) => (
            <DependantTargets key={dep} dep={dep} />
          ))}
        </ul>
        {deps.length > SHOWN && <p class="muted small">מוצגים {SHOWN} פירושים מתוך {deps.length.toLocaleString("he")}. לשאר: "פתיחה בסביבת העבודה".</p>}
      </div>
    </details>
  );
}

function DependantTargets({ dep }: { dep: string }) {
  const store = useStore();
  const g = store.guided;
  const list = g.targetsOf(dep);
  const h = g.targets.value[dep];
  const added = g.extraTargets.value[dep] ?? [];
  const keyOf = (title: string) => store.booksByTitle.value.get(title)?.[0]?.key;
  const ordered = (titles: string[]) => {
    const [primary, ...secondary] = titles;
    if (primary) g.setTargetHierarchy(dep, { primary, secondary, ...(h?.fallback && { fallback: h.fallback }) });
  };
  const titles = list.map((t) => t.title);
  const depKey = keyOf(dep);
  // the added books as ticked: the copy chosen for each title, else (bound by title) its first copy
  const selected = added.flatMap((t) => g.addedTargetKey(dep, t) ?? keyOf(t) ?? []);
  return (
    <li class="pair-row" data-dependant={dep}>
      <div class="pair-names">
        <b class="pair-dep">{dep}</b>
        <span class="muted"> · {list.length === 1 ? "כתוב על ספר אחד" : `כתוב על ${list.length.toLocaleString("he")} ספרים`}</span>
      </div>
      <ol class="target-list" aria-label={`הספרים ש־${dep} כתוב עליהם`}>
        {list.map((t, i) => (
          <li key={t.key} data-role={t.role}>
            <span class="grow">
              {t.title}
              {ROLE[t.role] && <span class={`chip target-role ${t.role}`}>{ROLE[t.role]}{t.role === "secondary" && list.length > 2 ? ` ${i}` : ""}</span>}
            </span>
            {list.length > 1 && t.role !== "primary" && (
              <button class="btn text small" onClick={() => ordered([t.title, ...titles.filter((x) => x !== t.title)])} aria-label={`"${t.title}" הספר הראשי של ${dep}`}>
                לראשי
              </button>
            )}
            {t.role === "secondary" && i > 1 && (
              <button class="btn text small" onClick={() => ordered([...titles.slice(0, i - 1), t.title, titles[i - 1]!, ...titles.slice(i + 1)])} aria-label={`העלאת "${t.title}" בסדר העדיפות`}>
                העלאה בעדיפות
              </button>
            )}
            {t.added && (
              <button class="icon-btn" onClick={() => g.removeTarget(dep, t.title)} aria-label={`הסרת "${t.title}" מהספרים של ${dep}`} title="הסרה">
                <Icon name="fl_dismiss" size={16} />
              </button>
            )}
          </li>
        ))}
      </ol>
      {list.length > 1 && (
        <label class="check">
          <input
            type="checkbox"
            checked={(h?.fallback ?? "primary") === "review"}
            // the order as shown becomes the user's, with the fallback chosen here
            onChange={(e) => g.setTargetHierarchy(dep, { primary: titles[0]!, secondary: titles.slice(1), fallback: e.currentTarget.checked ? "review" : "primary" })}
          />
          <span>שורה שלא מזכירה אף ספר: לקשר לספר הראשי רק כהצעה לבדיקה</span>
        </label>
      )}
      <details class="add-targets">
        <summary>הוספת ספר{added.length > 0 && ` · נוספו ${added.length.toLocaleString("he")}`}</summary>
        <BookChecklist
          label={`ספרים נוספים ש"${dep}" כתוב עליהם`}
          selected={selected}
          onChange={(keys) => {
            // the very copy ticked: a title open in two sources is bound to that book, not to its first copy (review finding 4).
            // One copy per title (the plan has one pair per commentary and title): a copy ticked now replaces the one ticked before.
            const chosen = new Map<string, string>();
            for (const k of keys) {
              const t = store.books.value.get(k)?.title;
              if (t && (!chosen.has(t) || !selected.includes(k))) chosen.set(t, k);
            }
            g.setExtraTargets(dep, [...chosen.keys()], Object.fromEntries(chosen));
          }}
          exclude={[depKey, ...list.filter((t) => !t.added).map((t) => t.key)]}
          ordered
        />
      </details>
    </li>
  );
}
