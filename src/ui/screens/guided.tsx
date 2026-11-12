import { useEffect, useState } from "preact/hooks";
import { ENGINES, type EngineId } from "../../linking/automatic";
import { GUIDED_STEPS, GUIDED_STEP_TITLES, ISSUE_ACTION_LABEL, durationText, nextStep, prevStep, stepSkipped } from "../../state/guided-flow";
import { remainingText } from "../../state/task-progress";
import { useStore } from "../context";
import { NextSteps } from "../dialogs/export-dialog";
import { fromDataTransfer, pickFiles } from "../files";
import { Icon } from "../icons/icon";
import { sourceNameText } from "../shell/file-name";
import { OtzariaDbHint, SOURCE_OPTIONS } from "../workspace/add-sources";
import { SourceBadge } from "../workspace/source-badge";
import { StepView } from "../workspace/suggestions-panel";

/*
 * The guided flow "link a folder (or several books) to Otzaria" (route "#/guided/<step>"): six
 * screens with "הבא" and "חזרה", over state/guided-flow.ts — which decides what comes next and what
 * the results mean — and the modules that do the work. Every step has a way out to the workspace for
 * manual work. Plain words only: no field of the links file is named here (simple mode).
 */
const ENGINE_TITLE = new Map(ENGINES.map((e) => [e.id, e.title]));
const BOOK_OPTIONS = SOURCE_OPTIONS.filter((o) => o.id === "folder" || o.id === "files" || o.id === "zip");
const DB_OPTION = SOURCE_OPTIONS.find((o) => o.id === "db")!;
const SHOWN = 50;
const n = (x: number) => x.toLocaleString("he");

export function GuidedScreen() {
  const store = useStore();
  const g = store.guided;
  const step = g.step.value;
  const f = g.facts.value;
  const busy = !!store.task.value || g.checking.value;
  const next = nextStep(step, f);
  const prev = prevStep(step, f);
  const at = GUIDED_STEPS.indexOf(step);

  return (
    <main class="guided" aria-labelledby="guided-title">
      <header class="guided-head">
        <Icon name="oz_search_in_folder" size={28} />
        <div class="grow">
          <h1 id="guided-title">קישור תיקייה לאוצריא</h1>
          <p class="muted">שלב אחרי שלב: הכלי מוצא מה קשור למה, מקשר, בודק ומכין את הקבצים. בכל שלב אפשר לעבור לעבודה ידנית.</p>
        </div>
      </header>
      <ol class="stepper" aria-label="השלבים">
        {GUIDED_STEPS.map((s, i) => {
          // the database step is "not needed" only while nothing besides the books is open: once a database
          // is open (in this step or in the first), it is a step that was done
          const skipped = stepSkipped(s, f) && !(s === "db" && g.otherSources.value.length > 0);
          const state = s === step ? "current" : i < at ? "done" : "todo";
          return (
            <li key={s} class={`${state}${skipped ? " skipped" : ""}`} aria-current={s === step ? "step" : undefined} title={skipped ? "לא נדרש" : undefined}>
              <span class="num" aria-hidden="true">{state === "done" && !skipped ? <Icon name="oz_check" size={14} /> : i + 1}</span>
              <span>{GUIDED_STEP_TITLES[s]}{skipped ? " (לא נדרש)" : ""}</span>
            </li>
          );
        })}
      </ol>
      <section class="guided-body" aria-label={GUIDED_STEP_TITLES[step]}>
        <h2>{GUIDED_STEP_TITLES[step]}</h2>
        {step === "files" && <FilesStep />}
        {step === "books" && <BooksStep />}
        {step === "db" && <DbStep />}
        {step === "plan" && <PlanStep />}
        {step === "run" && <RunStep />}
        {step === "finish" && <FinishStep />}
      </section>
      <footer class="guided-foot">
        {prev && (
          <button class="btn outlined" onClick={() => g.back()} disabled={busy}>
            חזרה
          </button>
        )}
        <button class="btn text" onClick={() => g.openWorkspace()} title="אותה עבודה בסביבת העבודה: ספרים, שורות ובחירה ידנית">
          <Icon name="oz_book_open_medium_lines" size={16} />
          פתיחה בסביבת העבודה
        </button>
        <span class="grow" />
        {step === "files" && g.resumeTo.value && f.books > 0 ? (
          <button class="btn filled" onClick={() => g.resume()}>
            המשך מהשלב "{GUIDED_STEP_TITLES[g.resumeTo.value]}"
          </button>
        ) : step === "plan" ? (
          <button class="btn filled" disabled={busy || !g.plan.value?.steps.length} onClick={() => void g.run()}>
            <Icon name="oz_links" size={18} />
            הפעלה
          </button>
        ) : (
          step !== "finish" && (
            <button class="btn filled" disabled={busy || !next} onClick={() => g.next()} title={next ? undefined : step === "run" ? "אשרו לפחות קישור אחד" : "בחרו קודם ספרים"}>
              הבא{next ? `: ${GUIDED_STEP_TITLES[next]}` : ""}
            </button>
          )
        )}
      </footer>
    </main>
  );
}

/* ---------------- 1. the books ---------------- */

function FilesStep() {
  const store = useStore();
  const g = store.guided;
  const [over, setOver] = useState(false);
  const ids = g.bookSources.value;
  const mine = store.sources.value.filter((s) => ids.includes(s.info.id));
  const saved = g.saved.value;
  const add = async (files: Awaited<ReturnType<typeof pickFiles>>) => {
    if (files.length) await g.addBooks(files);
  };
  return (
    <>
      {saved && mine.length === 0 && (
        <div class="guided-card warn" role="status">
          <b>{g.resumeTo.value ? "ממשיכים מהפעם הקודמת" : "יש עבודה שלא הסתיימה"} (הגעתם לשלב "{GUIDED_STEP_TITLES[g.resumeTo.value ?? saved.step]}")</b>
          <span>הדפדפן לא פותח קבצים מעצמו. פתחו שוב את אותם ספרים, והכלי ימשיך משם:</span>
          <ul class="guided-books">
            {saved.sources.map((s) => (
              <li key={s.label}>
                <b>{sourceNameText(s.label)}</b> · {n(s.books)} ספרים
                {s.files && s.files.length > 0 && <div class="muted">{s.files.slice(0, 5).join(" · ")}{s.files.length > 5 ? " …" : ""}</div>}
              </li>
            ))}
          </ul>
          {!g.resumeTo.value && (
            <div class="row">
              <button class="btn filled" onClick={() => g.continueSaved()}>המשך מאיפה שהפסקתי</button>
              <button class="btn text" onClick={() => g.dismissSaved()}>התחלה מחדש</button>
            </div>
          )}
        </div>
      )}
      <p class="lede">בחרו את התיקייה עם הספרים שלכם, או כמה ספרים. הכלי סורק גם תתי־תיקיות ומזהה לבד מה ספר ומה לא.</p>
      <div
        class={`drop-strip guided-drop${over ? " over" : ""}`}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={async (e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          if (e.dataTransfer) await add(await fromDataTransfer(e.dataTransfer));
        }}
      >
        <Icon name="fl_arrow_upload" size={32} />
        <b>גררו לכאן תיקייה או ספרים</b>
        <div class="actions">
          {BOOK_OPTIONS.map((o) => (
            <button key={o.id} class="btn outlined" onClick={async () => add(await pickFiles(o.pick))} title={o.hint} aria-label={`הספרים: ${o.label}`}>
              <Icon name={o.icon} size={16} />
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {mine.length > 0 && (
        <ul class="guided-books" aria-label="נבחרו">
          {mine.map((s) => (
            <li key={s.info.id} class="opened">
              <Icon name="fl_checkmark_circle" size={16} />
              <SourceBadge source={s} name /> · {n(s.books.length)} ספרים
              <button class="icon-btn" onClick={() => g.removeBooks(s.info.id)} aria-label={`הסרת ${s.info.label}`} title="לא לקשר את הספרים האלה">
                <Icon name="fl_dismiss" size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p class="muted small">
        מעדיפים את המסלול הקודם, עם גיליון המשימה?{" "}
        <button class="adv-link" onClick={() => ((store.startTask.value = "folder-otzaria"), (store.dialog.value = "start"))}>
          לגיליון "תיקייה מול אוצריא"
        </button>
      </p>
    </>
  );
}

/* ---------------- 2. what was found ---------------- */

function BooksStep() {
  const store = useStore();
  const g = store.guided;
  const groups = g.groups.value;
  const f = g.facts.value;
  return (
    <>
      <p class="lede" role="status">
        נמצאו {n(f.books)} ספרים. כך הכלי מבין אותם:
      </p>
      <ul class="guided-groups">
        {groups.map((gr) => (
          <li key={gr.id} class={`guided-card ${gr.tone}`}>
            <span class="row-line">
              <Icon name={gr.tone === "warn" ? "fl_warning" : gr.tone === "ok" ? "oz_link" : "fl_info"} size={18} />
              <b>{gr.text}</b>
            </span>
            {(gr.books.length > 1 || gr.books.some((b) => b.why)) && (
              <details open={gr.id === "none" && gr.books.length <= 5}>
                <summary>{gr.id === "none" ? "הסיבה לכל ספר" : `הספרים (${n(gr.books.length)})`}</summary>
                <ul class="guided-books">
                  {gr.books.slice(0, SHOWN).map((b) => (
                    <li key={b.title}>
                      {b.title}
                      {b.why && <div class="muted">{b.why}</div>}
                    </li>
                  ))}
                  {gr.books.length > SHOWN && <li class="muted">ועוד {n(gr.books.length - SHOWN)}.</li>}
                </ul>
              </details>
            )}
          </li>
        ))}
      </ul>
      {f.missingBases === 0 && f.baseChoices === 0 && f.books > 0 && <p class="muted">לא צריך את מסד אוצריא: כל ספרי הבסיס שהספרים האלה כתובים עליהם כבר כאן.</p>}
      {f.missingBases > 0 && <p class="muted">בשלב הבא: מסד אוצריא, בשביל ספרי הבסיס שחסרים.</p>}
    </>
  );
}

/* ---------------- 3. the Otzaria database, only when needed ---------------- */

function DbStep() {
  const store = useStore();
  const g = store.guided;
  const missing = g.missing.value;
  const others = g.otherSources.value;
  const plan = g.plan.value;
  const choices = plan?.baseSources ?? [];
  const labelOf = (id: string) => sourceNameText(store.sources.value.find((s) => s.info.id === id)?.info.label ?? id);
  const mineIds = g.bookSources.value;
  const open = async () => {
    const files = await pickFiles(DB_OPTION.pick);
    if (files.length) await g.addBases(files);
  };
  return (
    <>
      {missing.length > 0 && (
        <div class="guided-card warn" role="status">
          <b>{others.length ? "גם במה שנפתח לא נמצאו:" : "צריך את מסד אוצריא בשביל:"} {missing.map((m) => `"${m.title}"`).join(", ")}</b>
          <span>
            {missing.map((m) => `"${m.title}" — ${m.books.length === 1 ? `בשביל "${m.books[0]}"` : `בשביל ${n(m.books.length)} ספרים`}`).join(" · ")}
          </span>
          {others.length > 0 && <span class="muted">אפשר להמשיך בלעדיהם: הספרים האלה פשוט לא יקושרו לבסיס שלהם.</span>}
        </div>
      )}
      {missing.length === 0 && others.length > 0 && (
        <p class="guided-card ok" role="status">
          <span class="row-line"><Icon name="fl_checkmark_circle" size={18} /><b>כל ספרי הבסיס נמצאו.</b></span>
        </p>
      )}
      <div class="row">
        <button class="btn outlined" onClick={() => void open()} aria-label="מסד אוצריא: מסד נתונים">
          <Icon name={DB_OPTION.icon} size={16} />
          {others.length ? "מסד נוסף" : "בחירת מסד אוצריא"}
        </button>
      </div>
      {others.map((s) => (
        <div key={s.info.id} class="opened">
          <Icon name="fl_checkmark_circle" size={16} /> <SourceBadge source={s} name /> · {n(s.books.length)} ספרים
        </div>
      ))}
      {others.length === 0 && <OtzariaDbHint />}
      {choices.length > 0 && (
        <div class="guided-card info">
          <b>
            {choices.length === 1 ? `"${choices[0]!.title}" פתוח פעמיים` : `${n(choices.length)} ספרי בסיס פתוחים פעמיים (${choices.slice(0, 3).map((c) => `"${c.title}"`).join(", ")})`}: {choices[0]!.sources.map(labelOf).join(" וגם ב־")}.
          </b>
          <label class="field">
            איזו מהדורה תשמש בסיס?
            <select value={g.preferSource.value} onChange={(e) => g.setPreferSource(e.currentTarget.value)} aria-label="איזו מהדורה תשמש בסיס">
              <option value="">אוטומטי: מאותו מקום כמו הפירוש{mineIds.some((id) => choices.some((c) => c.sources.includes(id))) ? ` (כאן: ${labelOf(mineIds.find((id) => choices.some((c) => c.sources.includes(id)))!)})` : ""}</option>
              {[...new Set(choices.flatMap((c) => c.sources))].map((id) => (
                <option key={id} value={id}>מתוך {labelOf(id)}</option>
              ))}
            </select>
          </label>
          <span class="muted">הקישורים יצביעו על השורות של המהדורה שתבחרו. מהדורה מהספרייה (מסד אוצריא) מתאימה לשליחה לספרייה.</span>
        </div>
      )}
    </>
  );
}

/* ---------------- 4. the plan ---------------- */

function PlanStep() {
  const store = useStore();
  const g = store.guided;
  const plan = g.plan.value;
  const purpose = store.exportPurpose.value;
  if (!plan) return null;
  const engines = (Object.keys(plan.perEngine) as EngineId[]).filter((e) => plan.perEngine[e]);
  const issues = g.preflight.value;
  const skipped = plan.books.filter((b) => b.skipped).length;
  return (
    <>
      <div class="stats" role="status" aria-label="התוכנית">
        <Stat value={n(plan.books.length)} label="ספרים" />
        <Stat value={n(plan.identified)} label="נמצא להם קשר" />
        <Stat value={n(engines.length)} label={engines.length === 1 ? "שיטה" : "שיטות"} />
        <Stat value={n(plan.steps.length)} label="הרצות" />
        <Stat value={durationText(g.estimateMs.value)} label="זמן משוער" text />
      </div>
      <ul class="guided-books">
        {engines.map((e) => (
          <li key={e}>
            <b>{ENGINE_TITLE.get(e) ?? e}</b> — {n(plan.perEngine[e]!)} {plan.perEngine[e] === 1 ? "הרצה" : "הרצות"}
            {store.prefs.advanced.value && <div class="muted">{ENGINES.find((x) => x.id === e)?.description}</div>}
          </li>
        ))}
      </ul>
      {skipped > 0 && <p class="muted">{skipped === 1 ? "ספר אחד לא יקושר" : `${n(skipped)} ספרים לא יקושרו`} — הסיבה בשלב "{GUIDED_STEP_TITLES.books}".</p>}
      <fieldset class="guided-purpose">
        <legend>בשביל מה הקישורים?</legend>
        <label class="check">
          <input type="radio" name="purpose" checked={purpose === "submission"} onChange={() => g.setPurpose("submission")} />
          <span>
            <b>לשלוח לספריית אוצריא</b> (מומלץ) — כדי שכולם יראו אותם. הכלי בודק לפי הכללים של הספרייה.
          </span>
        </label>
        <label class="check">
          <input type="radio" name="purpose" checked={purpose === "private"} onChange={() => g.setPurpose("private")} />
          <span>
            <b>לשימוש שלי בלבד</b> — לאוצריא שלכם. כללי הספרייה לא עוצרים קישורים.
          </span>
        </label>
      </fieldset>
      {issues.length > 0 ? (
        <div class="guided-card warn" role="status">
          <b>ידוע כבר עכשיו, לפני ההרצה:</b>
          <ul class="guided-books">
            {issues.map((i) => (
              <li key={i.code + i.text}>
                {i.text}
                <div class="muted">{i.books.length === 1 ? `נוגע ל"${i.books[0]}"` : `נוגע ל־${n(i.books.length)} ספרים`}</div>
                {i.fix === "private" && purpose !== "private" && (
                  <button class="btn text small" onClick={() => g.setPurpose("private")}>
                    {ISSUE_ACTION_LABEL.private}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p class="muted">לא ידועה מראש אף בעיה שתעצור את הייצוא. הבדיקה המלאה רצה אחרי ההרצה.</p>
      )}
      <p class="muted small">הכלי רק מציע: שום קישור לא נוצר בלי אישור שלכם.</p>
    </>
  );
}

/* ---------------- 5. run and review ---------------- */

function RunStep() {
  const store = useStore();
  const g = store.guided;
  const task = store.task.value;
  const rep = store.maxLink.report.value;
  const [reviewing, setReviewing] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!task) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [task]);

  if (task) {
    const eta = remainingText(task.startedAt, task.done, task.total, Date.now());
    return (
      <div class="guided-card info" role="status" aria-live="polite">
        <b>{task.label}</b>
        {task.total > 0 && <progress max={task.total} value={task.done} />}
        <span>
          {task.count ?? "מתחיל…"}
          {eta && ` · ${eta}`}
        </span>
        <div class="row">
          <button class="btn text" onClick={task.cancel}>ביטול</button>
        </div>
      </div>
    );
  }
  if (!g.ran.value || !rep) {
    return (
      <>
        <p class="lede">ההרצה עוד לא נעשתה{g.facts.value.links ? `, אבל בפרויקט כבר ${n(g.facts.value.links)} קישורים שאישרתם` : ""}.</p>
        <div class="row">
          <button class="btn filled" disabled={!g.plan.value?.steps.length} onClick={() => void g.run()}>
            <Icon name="oz_links" size={18} />
            הפעלה
          </button>
        </div>
      </>
    );
  }
  const o = rep.overall;
  const certain = store.suggestions.pendingAtLeast("certain").length;
  const review = g.toReview();
  return (
    <>
      <p class="lede" role="status">
        נמצאו {n(o.links)} הצעות{o.existing ? `, מהן ${n(o.existing)} כבר קיימות באוצריא` : ""}. {o.approved ? `אושרו ${n(o.approved)}.` : ""}
      </p>
      <div class="guided-actions">
        <div class="guided-card ok">
          <b>{n(certain)} ודאיות</b>
          <span class="muted">הכלי בטוח בהן לגמרי.</span>
          <button class="btn filled" disabled={!certain} onClick={() => g.approveCertain()}>
            <Icon name="oz_link_check" size={18} />
            {certain ? `אישור כל ${n(certain)} הוודאיות` : "כל הוודאיות אושרו"}
          </button>
        </div>
        <div class="guided-card info">
          <b>{n(review.length)} לבדיקה</b>
          <span class="muted">הכלי לא בטוח בהן: עוברים עליהן אחת אחת, ומאשרים או דוחים.</span>
          <button
            class="btn outlined"
            disabled={!review.length}
            onClick={() => {
              store.suggestions.show(review[0]!);
              setReviewing(true);
            }}
          >
            {review.length ? "מעבר עליהן" : "אין מה לבדוק"}
          </button>
        </div>
      </div>
      {reviewing && review.length > 0 && (
        <section class="guided-review" aria-label="ההצעות לבדיקה">
          <StepView card standalone />
        </section>
      )}
      <p class="muted small">מה שלא אושר לא ייוצא. אפשר להמשיך גם בלי לעבור על כל ההצעות.</p>
    </>
  );
}

/* ---------------- 6. check and download ---------------- */

function FinishStep() {
  const store = useStore();
  const g = store.guided;
  const stale = g.stale.value;
  const checking = g.checking.value;
  const busy = !!store.task.value;
  useEffect(() => {
    if (stale && !checking && !busy) void g.check();
  }, [stale, checking, busy]);
  const b = g.bundle.value;
  const issues = g.issues.value;
  const purpose = store.exportPurpose.value;
  const done = g.downloaded.value;

  if (!b || (stale && !done)) return <p class="lede" role="status">בודק את כל הקישורים מול הספרים, לפי הכללים של {purpose === "private" ? "אוצריא" : "ספריית אוצריא"}…</p>;
  const c = b.counts;
  const files = b.files.length + b.altToc.files.length;
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return (
    <>
      {issues.length === 0 ? (
        <p class="guided-card ok" role="status">
          <span class="row-line"><Icon name="fl_checkmark_circle" size={18} /><b>הכול תקין.</b></span>
          <span>{n(c.new + c.edited)} קישורים ייכתבו ל־{n(files)} {files === 1 ? "קובץ" : "קבצים"}.</span>
        </p>
      ) : (
        <div class="guided-card warn" role="status">
          <b>
            {errors.length ? `${n(c.heldBack)} קישורים לא ייוצאו` : "הכול ייוצא"}
            {warnings.length ? `${errors.length ? "; " : ", "}${n(warnings.reduce((s, w) => s + w.count, 0))} עם הערה` : ""}. מה לעשות:
          </b>
          <ul class="guided-issues">
            {issues.map((i) => (
              <li key={`${i.severity}|${i.category}`} class={i.severity}>
                <Icon name={i.severity === "error" ? "fl_error_circle" : "fl_warning"} size={16} />
                <span class="grow">
                  {i.text}: {n(i.count)} {i.severity === "error" ? "(לא ייוצאו)" : "(ייוצאו)"}
                </span>
                <button class="btn text small" disabled={busy || checking} onClick={() => void g.remedy(i)}>
                  {ISSUE_ACTION_LABEL[i.action]}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div class="row">
        <span class="muted">
          {purpose === "private" ? "הקבצים לשימוש שלכם בלבד." : "הקבצים מיועדים לספריית אוצריא."}{" "}
          <button class="adv-link" onClick={() => g.setPurpose(purpose === "private" ? "submission" : "private")}>
            {purpose === "private" ? "לשליחה לספרייה" : "לשימוש שלי בלבד"}
          </button>
        </span>
      </div>
      {done ? (
        <>
          <p class="saved-note" role="status">
            <Icon name="fl_checkmark_circle" size={18} />
            <span>{done}</span>
          </p>
          <h3 style="margin:0">מה עכשיו?</h3>
          <NextSteps routes={store.exchange.nextSteps(b)} open />
          <div class="row">
            <button class="btn text" onClick={() => store.exchange.saveReport(b)}>הורדת הדוח</button>
            <button class="btn outlined" onClick={() => (store.screen.value = "home")}>למסך הפתיחה</button>
          </div>
        </>
      ) : (
        <div class="row">
          <button class="btn filled" disabled={!files || busy || checking} onClick={() => g.download()}>
            <Icon name="fl_arrow_download" size={18} />
            {files > 1 ? `הורדת ${n(files)} הקבצים (ZIP)` : "הורדת הקובץ"}
          </button>
          {!files && <span class="muted">אין קובץ להוריד: כל הקישורים נעצרו. הסיבות למעלה.</span>}
        </div>
      )}
    </>
  );
}

function Stat({ value, label, text }: { value: string; label: string; text?: boolean }) {
  return (
    <div class={`stat${text ? " text" : ""}`}>
      <b>{value}</b>
      <span class="muted">{label}</span>
    </div>
  );
}
