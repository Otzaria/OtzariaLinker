import type { PersonalCsvBundle } from "../../state/personal-csv";
import { Icon } from "../icons/icon";

/*
 * The export dialog's "links.csv for a personal library" format (state/personal-csv.ts, formats/personal-csv): when to use it
 * instead of the _links.json files, the files that will be written, the links the format cannot say (each with its reason) and
 * what the importer's own check found. Nothing here writes: the dialog's download button saves the ZIP.
 */
const SHOWN = 200;
const n = (x: number) => x.toLocaleString("he");

export function PersonalCsvSection({ bundle }: { bundle: PersonalCsvBundle | null }) {
  return (
    <>
      <div class="personal-csv-about muted">
        <p style="margin:0">
          <b>מתי לבחור בזה?</b> קובצי <bdi dir="ltr">_links.json</bdi> הם הדרך הרגילה: קובץ לכל ספר, ובו הקישורים שלו. שולחים אותם לספריית אוצריא, או מייבאים לאוצריא שלכם. הקובץ{" "}
          <bdi dir="ltr">links.csv</bdi> מיועד רק למי שבונה ספרייה אישית (מסד אישי) מספרים משלו: שורה לכל שורה בספר שלכם, והיעד הוא ספר מהמאגר הרשמי, לפי כותרת המקום בו.
        </p>
        <p style="margin:4px 0 0">
          הוא כולל רק קישורים בין ספר שלכם לספר של המאגר הרשמי, ורק מהסוגים "פירוש" ו"תרגום". הכלי לא כותב לשום מסד: מקבלים קבצים, ובהם מתחילים את הבנייה. הפורמט נלקח מהתיעוד של בניית
          הספרייה האישית, ולא נבדק מול הבנייה עצמה.
        </p>
      </div>
      {!bundle && <p class="muted">קורא את הכותרות והשורות של הספרים…</p>}
      {bundle && !bundle.files.length && (
        <p role="status">
          אין קישורים בין ספר שלכם לספר של המאגר הרשמי שאפשר לכתוב ל־<bdi dir="ltr">links.csv</bdi>, ולכן אין קובץ להוריד.
          {bundle.skipped.length > 0 && " הסיבות לכל קישור שנשאר בחוץ כתובות למטה."}
        </p>
      )}
      {bundle && bundle.files.length > 0 && (
        <>
          <h3 style="margin:4px 0 0">הקבצים שייווצרו</h3>
          <ul class="files">
            {bundle.files.map((f) => (
              <li key={f.folder}>
                <Icon name="oz_document_links" size={18} />
                <span class="grow">
                  <bdi dir="ltr">{f.folder}/{f.name}</bdi>
                </span>
                <span class="muted">{f.rows === 1 ? "שורה אחת" : `${n(f.rows)} שורות`}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {bundle && bundle.skipped.length > 0 && (
        <details class="held" open={bundle.skipped.length <= 5}>
          <summary>
            {bundle.skipped.length === 1 ? "קישור אחד לא ייכלל" : `${n(bundle.skipped.length)} קישורים לא ייכללו`} ב־<bdi dir="ltr">links.csv</bdi>, ולמה
          </summary>
          <ul class="problems" style="margin-top:8px">
            {bundle.skipped.slice(0, SHOWN).map((s) => (
              <li key={s.link.id} class="warning">
                <span>
                  <b>{s.link.source.book.title} {s.link.source.line + 1} ↔ {s.link.target.book.title} {s.link.target.line + 1}</b>: {s.text}
                </span>
              </li>
            ))}
            {bundle.skipped.length > SHOWN && (
              <li class="warning">
                <span>ועוד {n(bundle.skipped.length - SHOWN)} קישורים שלא ייכללו, מאותן סיבות.</span>
              </li>
            )}
          </ul>
        </details>
      )}
      {bundle && bundle.files.length > 0 && (
        <>
          {bundle.problems.length > 0 ? (
            <details class="held" open>
              <summary>{bundle.problems.length === 1 ? "הבדיקה של הייבוא מצאה בעיה אחת" : `הבדיקה של הייבוא מצאה ${n(bundle.problems.length)} בעיות`}: אחת כזו גורמת לדחיית הקובץ כולו</summary>
              <ul class="problems" style="margin-top:8px">
                {bundle.problems.slice(0, SHOWN).map((p, i) => (
                  <li key={i} class="error">
                    <span>שורה {n(p.line)}: {p.text}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : (
            <p class="muted" style="margin:0" role="status">
              הבדיקה של הייבוא לא מצאה בעיות. היא בודקת את שם הספר ואת כותרת המקום מול הספרים שפתוחים עכשיו בלבד.
            </p>
          )}
        </>
      )}
    </>
  );
}

/** What to do with the ZIP, after it was saved. */
export function PersonalCsvNext() {
  return (
    <p class="muted" style="margin:0">
      בתוך ה־ZIP יש תיקייה <bdi dir="ltr">קישורים</bdi> עם תיקיות ממוספרות, ובכל אחת קובץ <bdi dir="ltr">links.csv</bdi>: מכניסים אותן לבנייה של הספרייה האישית לפי ההוראות שלה, לצד קבצי הספרים שלכם. הכלי לא כותב לשום מסד.
    </p>
  );
}
