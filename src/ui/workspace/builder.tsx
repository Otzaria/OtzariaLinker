import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import type { ContinuePlan } from "../../linking/ranges";
import { problemText } from "../../core/links/validate";
import { parseConnectionType, TYPE_LABELS } from "../../core/links/connection-type";
import { storedForm } from "../../core/links/stored-form";
import { stripTags } from "../../core/text/html";
import { anchorLabelProblem } from "../../core/text/anchor-label";
import { linksCount } from "../../state/history";
import type { Pick, Side } from "../../state/store";
import { inRole } from "../../state/roles";
import { TypesHelpButton } from "../dialogs/types-help-dialog";
import { TYPE_CHOICES } from "../../state/store";
import { TypeOptions } from "./type-options";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { LinkItem } from "./link-item";
import { plainText } from "./plain-text";
import { SourceBadge, useBookOrigin } from "./source-badge";
import { visibleSlice } from "../../matching/hebrew-tokens";

/*
 * The link builder (ADR 0005 §3, option A): both ends, the type and the reference, checked live
 * against Otzaria's rules before anything is created. Ctrl+Enter creates. In advanced mode the
 * Sefaria refs and the raw type string are editable.
 */
export function Builder() {
  const store = useStore();
  const draft = store.draft.value;
  /** one link per line picked with Ctrl/Cmd (v3 F-061) */
  const many = store.drafts.value.length;
  const problems = store.draftProblems.value;
  const errors = problems.filter((p) => p.severity === "error");
  const advanced = store.prefs.advanced.value;
  const editing = store.editing.value;
  const s = store.pick.source.value;
  const t = store.pick.target.value;
  // the library's own classification (B6), or a database Sefaria book (a ref there is refused, and the field shows why)
  const sefariaSide = (key: string) => {
    const b = store.books.value.get(key);
    return !!b && (store.isSefariaOwned(b) || b.origin === "sefaria");
  };
  const srcSefaria = s && sefariaSide(s.bookKey);
  const tgtSefaria = t && sefariaSide(t.bookKey);
  // the ref the builder built from the line's heRef (B1): shown as the placeholder until the user types one
  const autoRef1 = !store.draftRef1.value.trim() ? store.draft.value?.ref1 : undefined;
  const autoRef2 = !store.draftRef2.value.trim() ? store.draft.value?.ref2 : undefined;
  // several lines picked on one side: each link gets its own line's place and Sefaria ref, so the fields of that side are
  // off — a value typed there would name one place for all the links (V7 round-2 review, finding 1)
  const manySource = !editing && !!s?.lines;
  const manyTarget = !editing && !!t?.lines;
  const perLine = (side: "source" | "target") => `נבחרו כמה שורות ${inRole(store.roles.value[side].name)}: לכל קישור ייקבע הערך של השורה שלו, ולכן אי אפשר לכתוב כאן ערך אחד.`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        // a blocked draft says why, instead of doing nothing (UX review suggestion 7)
        if (!store.createFromDraft() && store.draft.value) {
          const err = store.draftProblems.value.find((p) => p.severity === "error");
          if (err) store.notify("error", `הקישור לא נוצר: ${err.message}`);
        }
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [store]);

  const known = parseConnectionType(store.draftType.value).known;
  const roles = store.roles.value;

  return (
    <div class="builder">
      <End side="source" pick={s} />
      <div class="row" style="justify-content:center">
        <button class="btn text" onClick={() => swap(store)} disabled={!s && !t} title={`החלפת ${roles.source.short} ו${roles.target.short}`}>
          <Icon name="fl_arrow_swap" size={16} />
          החלפה
        </button>
      </div>
      <End side="target" pick={t} />

      <label class="field">
        סוג הקשר
        <select value={TYPE_CHOICES.includes(store.draftType.value) ? store.draftType.value : "__custom"} onChange={(e) => e.currentTarget.value !== "__custom" && ((store.draftType.value = e.currentTarget.value), (store.draftTypeTouched.value = true))}>
          <TypeOptions />
          {!TYPE_CHOICES.includes(store.draftType.value) && <option value="__custom">{store.draftType.value} (לא מוכר)</option>}
        </select>
        <span class="muted">{TYPE_LABELS[parseConnectionType(store.draftType.value).type].hint}</span>
      </label>
      <TypesHelpButton />
      {draft && <StoredAs />}
      {advanced && (
        <label class="field">
          מחרוזת הסוג כפי שתיכתב לקובץ
          <input type="text" dir="ltr" value={store.draftType.value} onInput={(e) => (store.draftType.value = e.currentTarget.value)} />
          {!known && <span>סוג לא מוכר — אוצריא תשמור אותו כ"אחר".</span>}
        </label>
      )}

      <label class="field">
        {/* the file's field names only in advanced mode (audit F14) */}
        {advanced ? `שם המקום ${inRole(store.roles.value.target.name)} (heRef_2)` : `שם המקום ${inRole(store.roles.value.target.name)}`}
        <input type="text" value={manyTarget ? "" : (draft?.heRef2 ?? "")} placeholder={manyTarget ? "לפי כל שורה" : `ייקבע לפי השורה ${inRole(store.roles.value.target.name)}`} onInput={(e) => (store.draftHeRef.value = e.currentTarget.value)} disabled={!t || manyTarget} />
        {manyTarget && <span class="muted">{perLine("target")}</span>}
        {store.draftHeRef.value !== null && t && !manyTarget && (
          <button class="adv-link" onClick={() => (store.draftHeRef.value = null)}>חזרה לשם האוטומטי</button>
        )}
      </label>

      {srcSefaria && (
        <label class="field">
          {advanced ? "ref_1 — ציון ספריא באנגלית של המקור" : "ציון ספריא של המקור (באנגלית)"}
          <input type="text" dir="ltr" placeholder={manySource ? "לפי כל שורה" : (autoRef1 ?? "Genesis 1:1")} title={autoRef1 && !manySource ? "נבנה אוטומטית משם המקום שבמסד; אפשר לכתוב ערך אחר" : undefined} value={manySource ? "" : store.draftRef1.value} onInput={(e) => (store.draftRef1.value = e.currentTarget.value)} disabled={manySource} />
          {manySource && <span class="muted">{perLine("source")}</span>}
        </label>
      )}
      {tgtSefaria && (
        <label class="field">
          {advanced ? "ref_2 — ציון ספריא באנגלית של היעד" : "ציון ספריא של היעד (באנגלית)"}
          <input type="text" dir="ltr" placeholder={manyTarget ? "לפי כל שורה" : (autoRef2 ?? "Genesis 1:1")} title={autoRef2 && !manyTarget ? "נבנה אוטומטית משם המקום שבמסד; אפשר לכתוב ערך אחר" : undefined} value={manyTarget ? "" : store.draftRef2.value} onInput={(e) => (store.draftRef2.value = e.currentTarget.value)} disabled={manyTarget} />
          {manyTarget && <span class="muted">{perLine("target")}</span>}
        </label>
      )}

      {problems.length > 0 && (
        <ul class="problems" aria-live="polite">
          {problems.map((p) => (
            <li key={`${p.code}\n${p.message}`} class={p.severity}>
              <Icon name={p.severity === "error" ? "fl_error_circle" : p.severity === "warning" ? "fl_warning" : "fl_info"} size={16} />
              {/* the file's field names only in advanced mode (audit F14) */}
              <span>{problemText(p, advanced)}</span>
            </li>
          ))}
        </ul>
      )}

      <div class="row">
        <button class="btn filled" disabled={!draft || errors.length > 0} onClick={() => store.createFromDraft()} title="Ctrl+Enter">
          <Icon name={editing ? "oz_link_edit" : "oz_link_add"} size={18} />
          {editing ? "שמירת השינויים" : many > 1 ? `יצירת ${linksCount(many)}` : "יצירת קישור"}
        </button>
        <kbd>Ctrl+Enter</kbd>
        {editing && (
          <button class="btn outlined" disabled={!draft || errors.length > 0} onClick={() => store.createFromDraft({ asNew: true })} title="הקישור שנערך נשאר כמו שהוא, ונוצר קישור נוסף לפי מה שבבונה: למשל אותו מקור עם יעד אחר">
            <Icon name="fl_copy" size={18} />
            שמירה כקישור נוסף
          </button>
        )}
        <span class="grow" />
        {(s || t || editing) && (
          <button class="btn text" onClick={() => store.clearPicks()}>
            {editing ? "ביטול עריכה" : "ניקוי"}
          </button>
        )}
      </div>
      {!advanced && (
        <button class="adv-link" onClick={() => (store.prefs.advanced.value = true)}>
          אפשרויות מתקדמות
        </button>
      )}
      <RangeSettings />

      <PickedLineLinks />
    </div>
  );
}

/** What Otzaria will actually store and where it will show it — the user sees the result, not the file shape. */
function StoredAs() {
  const store = useStore();
  const d = store.draft.value!;
  const f = storedForm(d);
  if (f.skipped) return null;
  const panel = f.panel === "commentaries" ? "בפאנל המפרשים" : "בפאנל הקישורים";
  return (
    <p class="stored-as">
      <Icon name="fl_info" size={16} />
      <span>
        באוצריא: <b>{f.storedTarget.book.title}</b> יופיע {panel} של <b>{f.storedSource.book.title}</b>
        {f.stored !== f.declared && ` (כ"${TYPE_LABELS[f.stored].he}")`}.
      </span>
    </p>
  );
}

function End({ side, pick }: { side: Side; pick: Pick | null }) {
  const store = useStore();
  const role = store.roles.value[side];
  const label = role.short;
  const origin = useBookOrigin()(pick?.bookKey);
  if (!pick)
    return (
      <div class={`end ${side}`} data-side={side}>
        <span class={`side-badge ${side}`} title={role.hint}>{label}</span>
        <span class="muted">
          {side === "source" ? `לחצו על שורה ${inRole(role.name)} (Shift לטווח, Ctrl לכמה שורות, סימון מילים לעוגן)` : `לחצו על שורה ${inRole(role.name)}, או גררו אליה מספר שורה ${store.roles.value.source.from}`}
        </span>
      </div>
    );
  store.lines.tick.value;
  const title = store.refOf(pick.bookKey).title;
  const line = store.lines.peek(pick.bookKey, pick.line);
  const where = pick.lines
    ? `${pick.lines.length} שורות: ${pick.lines.slice(0, 12).map((i) => i + 1).join(", ")}${pick.lines.length > 12 ? "…" : ""}`
    : pick.end !== undefined ? `שורות ${pick.line + 1}–${pick.end + 1}` : `שורה ${pick.line + 1}`;
  return (
    <div class={`end ${side} set`} data-side={side}>
      <span class={`side-badge ${side}`} title={role.hint}>{label}</span>
      <button class="what adv-link" style="text-decoration:none;color:inherit" onClick={() => store.reveal(side, pick.bookKey, pick.line)} title={`${title} — הצגה בספר`}>
        {title} · {where}
      </button>
      {/* the same title is open from two sources: say which copy this link is made from */}
      {origin.ambiguous && origin.source && (
        <span style="grid-column:1/-1">
          <SourceBadge source={origin.source} name />
        </span>
      )}
      {pick.anchor && (
        <span style="grid-column:1/-1" class="muted">
          עוגן: <mark class="anchor-hl">{pick.anchor.text || (line ? visibleSlice(line.anchorText, pick.anchor.rawStart, pick.anchor.rawEnd ?? pick.anchor.rawStart + 1) : "…")}</mark>{" "}
          <button class="adv-link" onClick={() => store.pickLine(side, pick.bookKey, pick.line)}>הסרת העוגן</button>
        </span>
      )}
      {pick.anchor && side === "source" && <AnchorLabel />}
      {pick.lines && <span style="grid-column:1/-1" class="muted">מכל שורה ייווצר קישור משלה. Ctrl+לחיצה מוסיפה שורה או מסירה אותה.</span>}
      {!pick.anchor && !pick.lines && <RangeRow side={side} pick={pick} />}
      {!pick.anchor && !pick.lines && pick.end === undefined && !store.editing.value && <ContinuePrevious side={side} pick={pick} />}
      {line && <span class="snip">{plainText(line.anchorText)}</span>}
    </div>
  );
}

/**
 * The range of one side (v3 F-054/F-055): the last line typed ("עד שורה"), "until the next" — one line before the next
 * link or heading of this side, or what the range settings say (rangeEndBasis, F-079) — "until the end of the book",
 * or no range. An end past the book, or a book whose length is still unknown, gives a notice (AppStore.setRangeEnd/untilNext).
 */
function RangeRow({ side, pick }: { side: Side; pick: Pick }) {
  const store = useStore();
  const shown = pick.end !== undefined ? String(pick.end + 1) : "";
  const [text, setText] = useState(shown);
  // A layout effect: the field takes the new pick's value as the pick renders. A plain effect ran after paint, through a
  // timer, and on a busy machine a number typed in between was wiped (CI flake on Dependabot #36, builder-selection.spec).
  useLayoutEffect(() => setText(shown), [pick.bookKey, pick.line, pick.end]);
  const count = store.books.value.get(pick.bookKey)?.lineCount ?? store.lines.count(pick.bookKey);
  const basis = store.prefs.rangeEndBasis.value;
  const commit = () => {
    const n = Number.parseInt(text, 10);
    if (!text.trim()) store.setRangeEnd(side, null);
    else if (Number.isFinite(n)) store.setRangeEnd(side, n - 1);
    // what the pick holds now: a refused or reversed end shows the range as it is
    const cur = store.pick[side].peek();
    setText(cur?.end !== undefined ? String(cur.end + 1) : "");
  };
  const name = inRole(store.roles.value[side].name);
  return (
    <span style="grid-column:1/-1" class="row range-row">
      <label class="range-end">
        עד שורה
        <input
          type="number"
          inputMode="numeric"
          min={pick.line + 1}
          max={count}
          value={text}
          placeholder="—"
          aria-label={`סוף הטווח ${name}: מספר השורה האחרונה (ריק: שורה אחת)`}
          onInput={(e) => setText(e.currentTarget.value)}
          onChange={commit}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), commit())}
        />
      </label>
      {basis !== "book" && (
        <button class="adv-link" onClick={() => void store.untilNext(side)} title={basis === "links" ? "הטווח נמשך עד שורה אחת לפני הקישור הבא בצד הזה" : basis === "headings" ? "הטווח נמשך עד שורה אחת לפני הכותרת הבאה" : "הטווח נמשך עד שורה אחת לפני הקישור או הכותרת הבאים בצד הזה"}>
          {basis === "headings" ? "טווח עד הכותרת הבאה" : "טווח עד הקישור הבא"}
        </button>
      )}
      <button class="adv-link" onClick={() => void store.rangeToEnd(side)} title="הטווח נמשך עד השורה האחרונה בספר">
        עד סוף הספר
      </button>
      {pick.end !== undefined && (
        <button class="adv-link" onClick={() => store.setRangeEnd(side, null)}>בלי טווח</button>
      )}
    </span>
  );
}

/**
 * The anchor's label (v3's "סמן" dialog, F-075): the letter Otzaria shows in the text where the words were marked. It is
 * written as " אות X" at the end of the place name, where the generator reads it; a label it would not read is refused here.
 */
function AnchorLabel() {
  const store = useStore();
  const label = store.draft.value?.anchor?.label ?? store.pick.source.value?.anchor?.label ?? "";
  const [text, setText] = useState(label);
  const [error, setError] = useState<string | null>(null);
  // a layout effect, as the range end's: a plain effect ran after paint and wiped a label typed in between
  useLayoutEffect(() => (setText(label), setError(null)), [label]);
  const commit = () => {
    const why = anchorLabelProblem(text.trim());
    setError(why);
    if (!why) store.setAnchorLabel(text);
  };
  return (
    <label class="field anchor-label" style="grid-column:1/-1">
      תווית העוגן (האות שאוצריא מציגה במקום שסימנתם)
      <input
        type="text"
        value={text}
        maxLength={6}
        placeholder="למשל: ג"
        aria-label="תווית העוגן"
        aria-invalid={!!error}
        aria-describedby="anchor-label-hint"
        onInput={(e) => setText(e.currentTarget.value)}
        onChange={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), commit())}
      />
      <span id="anchor-label-hint" class={error ? "error-text" : "muted"} role={error ? "alert" : undefined}>
        {error ?? 'נשמרת בסוף שם המקום, כמו "אות ג". ריק: עוגן בלי תווית.'}
      </span>
    </label>
  );
}

/** v3's range settings (F-055 rangeAutoEnd, F-079 rangeEndBasis, F-083 rangeTrimPrevious), kept as preferences. */
function RangeSettings() {
  const store = useStore();
  const { rangeEndBasis, rangeAutoEnd, rangeTrimPrevious } = store.prefs;
  const roles = store.roles.value;
  const auto = rangeAutoEnd.value;
  return (
    <details class="range-settings">
      <summary>הגדרות טווחים</summary>
      <div class="body">
      <label class="field">
        "טווח עד הקישור הבא" עוצר לפני
        <select value={rangeEndBasis.value} onChange={(e) => (rangeEndBasis.value = e.currentTarget.value as typeof rangeEndBasis.value)}>
          <option value="auto">קישור או כותרת (מומלץ)</option>
          <option value="links">קישור בלבד</option>
          <option value="headings">כותרת בלבד</option>
          <option value="book">סוף הספר</option>
        </select>
      </label>
      {(["source", "target"] as const).map((side) => (
        <label class="check" key={side}>
          <input type="checkbox" checked={auto[side]} onChange={(e) => (rangeAutoEnd.value = { ...rangeAutoEnd.value, [side]: e.currentTarget.checked })} />
          <span>טווח אוטומטי {inRole(roles[side].name)}</span>
          <span class="muted">כל שורה שתבחרו שם תימשך לבד עד השורה שלפני הסימן הבא.</span>
        </label>
      ))}
      <label class="check">
        <input type="checkbox" checked={rangeTrimPrevious.value} onChange={(e) => (rangeTrimPrevious.value = e.currentTarget.checked)} />
        <span>קיצור הטווח הקודם</span>
        <span class="muted">קישור חדש בתוך טווח של קישור קודם מקצר את הטווח ההוא, כדי שלא יבלע אותו (באותו צעד ביטול).</span>
      </label>
      </div>
    </details>
  );
}

/**
 * "This passage continues the previous one" (V7 §2.13, issue #44): the picked line inherits the link(s) of the passage
 * before it — the range extended over it, or an independent link where the export needs one. A preview first (what
 * will be extended, copied or skipped), then one undoable step; a heading between the two needs its own confirmation.
 */
function ContinuePrevious({ side, pick }: { side: Side; pick: Pick }) {
  const store = useStore();
  const [plan, setPlan] = useState<ContinuePlan | null>(null);
  const [copy, setCopy] = useState(false);
  const preview = async (asCopy = copy) => {
    const p = await store.ranges.planContinue(pick.bookKey, side, pick.line, asCopy ? "copy" : "extend");
    const cur = store.pick[side].value;
    // the pick may have moved while the headings were read
    if (!p || !cur || cur.bookKey !== pick.bookKey || cur.line !== pick.line) return;
    if (p.refused) return void store.ranges.applyContinue(p); // says why
    setPlan(p);
  };
  // a new pick closes an old preview
  useEffect(() => setPlan(null), [pick.bookKey, pick.line, side]);
  if (!plan)
    return (
      <span style="grid-column:1/-1" class="row">
        <button class="adv-link" style="display:inline-flex;align-items:center;gap:4px" onClick={() => preview()} title="השורה הזו ממשיכה את הקטע שלפניה: היא תקבל את הקישורים שלו (הרחבת הטווח שלהם, או קישור נפרד כשהייצוא דורש). תוצג תצוגה מקדימה לפני השינוי.">
          <Icon name="fl_arrow_upload" size={14} /> המשך לקטע הקודם
        </button>
      </span>
    );
  const n = (a: string) => plan.items.filter((i) => i.action === a).length;
  const apply = (crossHeading: boolean) => {
    if (store.ranges.applyContinue(plan, { crossHeading }) !== null) setPlan(null);
  };
  return (
    <div style="grid-column:1/-1" class="continue-preview" role="group" aria-label="תצוגה מקדימה: המשך לקטע הקודם">
      <p>
        המשך של שורה {plan.fromLine! + 1}:{" "}
        {[n("extend") && `${n("extend")} טווחים יורחבו`, n("copy") && `${n("copy")} קישורים נפרדים ייווצרו`, n("skip") && `${n("skip")} ידולגו`].filter(Boolean).join(" · ") || "אין מה לשנות"}
      </p>
      <ul class="muted" style="margin:0;padding-inline-start:16px">
        {plan.items.map((i) => (
          <li key={i.prev.id}>
            {side === "source" ? i.prev.heRef2 || i.prev.target.book.title : i.prev.source.book.title}
            {": "}
            {i.action === "extend" ? `הטווח יורחב עד שורה ${plan.line + 1}` : i.action === "copy" ? (i.why === "range-refused" ? `קישור נפרד (טווח אינו מתקבל: ${i.detail})` : "קישור נפרד") : i.why === "covered" ? "כבר מגיע לשורה הזו" : "קישור כזה כבר קיים"}
          </li>
        ))}
      </ul>
      {plan.headings.length > 0 && (
        <p class="continue-warning" role="alert">
          <Icon name="fl_warning" size={16} /> בין שורה {plan.fromLine! + 1} לשורה {plan.line + 1} יש כותרת (שורה {plan.headings.map((h) => h + 1).join(", ")}): זו יחידה אחרת.
        </p>
      )}
      <label class="row">
        <input type="checkbox" checked={copy} onChange={(e) => (setCopy(e.currentTarget.checked), void preview(e.currentTarget.checked))} />
        קישורים נפרדים במקום הרחבת טווח
      </label>
      <span class="row">
        <button class="btn filled" disabled={!n("extend") && !n("copy")} onClick={() => apply(plan.headings.length > 0)}>
          {plan.headings.length ? "המשך למרות הכותרת" : "אישור"}
        </button>
        <button class="btn text" onClick={() => setPlan(null)}>ביטול</button>
      </span>
    </div>
  );
}

function swap(store: ReturnType<typeof useStore>) {
  const s = store.pick.source.value;
  const t = store.pick.target.value;
  const vs = store.view.source.value;
  // (an anchor stays behind: it belongs to the source line; several Ctrl-picked lines go with their side)
  const moved = (p: Pick): Pick => ({ bookKey: p.bookKey, line: p.line, ...(p.end !== undefined && { end: p.end }), ...(p.lines && { lines: p.lines }) });
  store.pick.source.value = t ? moved(t) : null;
  store.pick.target.value = s ? moved(s) : null;
  store.view.source.value = store.view.target.value;
  store.view.target.value = vs;
  store.draftHeRef.value = null;
}

/** The project's links on the picked source line — what is already there before adding more. */
function PickedLineLinks() {
  const store = useStore();
  const s = store.pick.source.value;
  if (!s) return null;
  const here = store.linksOfBook(s.bookKey).filter((l) => store.sameBook(l.source.book, s.bookKey) && s.line >= l.source.line && s.line <= (l.source.end ?? l.source.line));
  if (!here.length) return null;
  return (
    <section>
      <h3 style="font-size:var(--fs-md);margin:8px 0 4px">קישורים קיימים בשורה הזו ({here.length})</h3>
      <ul class="link-list" style="padding:0">
        {here.map((l) => (
          <LinkItem key={l.id} l={l} />
        ))}
      </ul>
    </section>
  );
}
