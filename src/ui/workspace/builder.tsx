import { useEffect } from "preact/hooks";
import { parseConnectionType, TYPE_LABELS } from "../../core/links/connection-type";
import { storedForm } from "../../core/links/stored-form";
import { stripTags } from "../../core/text/html";
import type { Pick, Side } from "../../state/store";
import { TYPE_CHOICES } from "../../state/store";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import { LinkItem } from "./links-panel";
import { plainText } from "./plain-text";
import { visibleSlice } from "../../matching/hebrew-tokens";

/*
 * The link builder (ADR 0005 §3, option A): both ends, the type and the reference, checked live
 * against Otzaria's rules before anything is created. Ctrl+Enter creates. In advanced mode the
 * Sefaria refs and the raw type string are editable.
 */
export function Builder() {
  const store = useStore();
  const draft = store.draft.value;
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

  return (
    <div class="builder">
      <End side="source" pick={s} />
      <div class="row" style="justify-content:center">
        <button class="btn text" onClick={() => swap(store)} disabled={!s && !t} title="החלפת מקור ויעד">
          <Icon name="fl_arrow_swap" size={16} />
          החלפה
        </button>
      </div>
      <End side="target" pick={t} />

      <label class="field">
        סוג הקשר
        <select value={TYPE_CHOICES.includes(store.draftType.value) ? store.draftType.value : "__custom"} onChange={(e) => e.currentTarget.value !== "__custom" && ((store.draftType.value = e.currentTarget.value), (store.draftTypeTouched.value = true))}>
          {TYPE_CHOICES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t.toUpperCase() as keyof typeof TYPE_LABELS]?.he ?? t}
            </option>
          ))}
          {!TYPE_CHOICES.includes(store.draftType.value) && <option value="__custom">{store.draftType.value} (לא מוכר)</option>}
        </select>
        <span class="muted">{TYPE_LABELS[parseConnectionType(store.draftType.value).type].hint}</span>
      </label>
      {draft && <StoredAs />}
      {advanced && (
        <label class="field">
          מחרוזת הסוג כפי שתיכתב לקובץ
          <input type="text" dir="ltr" value={store.draftType.value} onInput={(e) => (store.draftType.value = e.currentTarget.value)} />
          {!known && <span>סוג לא מוכר — אוצריא תשמור אותו כ"אחר".</span>}
        </label>
      )}

      <label class="field">
        שם המקום ביעד (heRef_2)
        <input type="text" value={draft?.heRef2 ?? ""} placeholder="ייקבע לפי שורת היעד" onInput={(e) => (store.draftHeRef.value = e.currentTarget.value)} disabled={!t} />
        {store.draftHeRef.value !== null && t && (
          <button class="adv-link" onClick={() => (store.draftHeRef.value = null)}>חזרה לשם האוטומטי</button>
        )}
      </label>

      {srcSefaria && (
        <label class="field">
          ref_1 — ציון ספריא באנגלית של המקור
          <input type="text" dir="ltr" placeholder={autoRef1 ?? "Genesis 1:1"} title={autoRef1 ? "נבנה אוטומטית משם המקום שבמסד; אפשר לכתוב ערך אחר" : undefined} value={store.draftRef1.value} onInput={(e) => (store.draftRef1.value = e.currentTarget.value)} />
        </label>
      )}
      {tgtSefaria && (
        <label class="field">
          ref_2 — ציון ספריא באנגלית של היעד
          <input type="text" dir="ltr" placeholder={autoRef2 ?? "Genesis 1:1"} title={autoRef2 ? "נבנה אוטומטית משם המקום שבמסד; אפשר לכתוב ערך אחר" : undefined} value={store.draftRef2.value} onInput={(e) => (store.draftRef2.value = e.currentTarget.value)} />
        </label>
      )}

      {problems.length > 0 && (
        <ul class="problems" aria-live="polite">
          {problems.map((p) => (
            <li key={p.code} class={p.severity}>
              <Icon name={p.severity === "error" ? "fl_error_circle" : p.severity === "warning" ? "fl_warning" : "fl_info"} size={16} />
              <span>{p.message}</span>
            </li>
          ))}
        </ul>
      )}

      <div class="row">
        <button class="btn filled" disabled={!draft || errors.length > 0} onClick={() => store.createFromDraft()} title="Ctrl+Enter">
          <Icon name={editing ? "oz_link_edit" : "oz_link_add"} size={18} />
          {editing ? "שמירת השינויים" : "יצירת קישור"}
        </button>
        <kbd>Ctrl+Enter</kbd>
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
  const label = side === "source" ? "מקור" : "יעד";
  if (!pick)
    return (
      <div class={`end ${side}`}>
        <span class={`side-badge ${side}`}>{label}</span>
        <span class="muted">
          {side === "source" ? "לחצו על שורה בספר המקור (Shift לטווח, סימון מילים לעוגן)" : "לחצו על שורה בספר היעד, או גררו אליה מספר שורה מהמקור"}
        </span>
      </div>
    );
  store.lines.tick.value;
  const title = store.refOf(pick.bookKey).title;
  const line = store.lines.peek(pick.bookKey, pick.line);
  const where = pick.end !== undefined ? `שורות ${pick.line + 1}–${pick.end + 1}` : `שורה ${pick.line + 1}`;
  return (
    <div class={`end ${side} set`}>
      <span class={`side-badge ${side}`}>{label}</span>
      <button class="what adv-link" style="text-decoration:none;color:inherit" onClick={() => store.reveal(side, pick.bookKey, pick.line)} title="הצגה בספר">
        {title} · {where}
      </button>
      {pick.anchor && (
        <span style="grid-column:1/-1" class="muted">
          עוגן: <mark class="anchor-hl">{pick.anchor.text || (line ? visibleSlice(line.anchorText, pick.anchor.rawStart, pick.anchor.rawEnd ?? pick.anchor.rawStart + 1) : "…")}</mark>{" "}
          <button class="adv-link" onClick={() => store.pickLine(side, pick.bookKey, pick.line)}>הסרת העוגן</button>
        </span>
      )}
      {line && <span class="snip">{plainText(line.anchorText)}</span>}
    </div>
  );
}

function swap(store: ReturnType<typeof useStore>) {
  const s = store.pick.source.value;
  const t = store.pick.target.value;
  const vs = store.view.source.value;
  store.pick.source.value = t ? { bookKey: t.bookKey, line: t.line, ...(t.end !== undefined && { end: t.end }) } : null;
  store.pick.target.value = s ? { bookKey: s.bookKey, line: s.line, ...(s.end !== undefined && { end: s.end }) } : null;
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
