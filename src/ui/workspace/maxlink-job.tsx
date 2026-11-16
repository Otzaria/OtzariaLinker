import { jobTotals, STATUS_TEXT, type JobBook, type JobBookStatus } from "../../linking/batch-job";
import { useStore } from "../context";
import { Icon } from "../icons/icon";
import "./maxlink.css";

/*
 * The max-link job (V5 P1-8): how far a run of many books got — per book and per engine — with pause,
 * stop, continue (also after a reload, once the books are open again), "run only the failed ones", "run
 * again what changed", and the per-book report. Shown above the suggestions and in the guided flow's run
 * step; the work itself is state/maxlink.ts.
 */
const SHOWN = 200;
const ORDER: readonly JobBookStatus[] = ["failed", "pending", "done", "no-match", "unchanged", "not-planned"];
const n = (x: number) => x.toLocaleString("he");

export function MaxLinkJobView() {
  const store = useStore();
  const ml = store.maxLink;
  const job = ml.job.value;
  if (!job) return null;
  const running = ml.running.value;
  const restored = ml.jobRestored.value;
  const busy = !!store.task.value && !running;
  const t = jobTotals(job);
  const missing = running ? [] : ml.missingTitles();
  const pending = t.byStatus.pending;
  const failed = t.byStatus.failed;
  const state = running ? "רץ" : job.state === "paused" ? "מושהה" : job.state === "cancelled" ? "נעצר" : "הסתיים";
  const rows = [...job.books].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  return (
    <section class="ml-job" aria-label="עבודת הקישור המרבי">
      <div role="status">
        <b>{restored ? "קישור מרבי שלא הסתיים" : `קישור מרבי: ${state}`}</b> — {job.scope} · {n(t.settled)} מתוך {n(t.runnable)} ספרים
      </div>
      <progress max={t.runnable || 1} value={t.settled} />
      <ul class="ml-job-counts">
        {ORDER.filter((s) => t.byStatus[s]).map((s) => (
          <li key={s} class={`st-${s}`}>{STATUS_TEXT[s]}: {n(t.byStatus[s])}</li>
        ))}
      </ul>
      <ul class="ml-job-counts" aria-label="לפי שיטה">
        {t.engines.map((e) => (
          <li key={e.engine}>{e.title}: {n(e.done)}/{n(e.planned)}{e.failed ? ` (${n(e.failed)} נכשלו)` : ""}</li>
        ))}
      </ul>
      {missing.length > 0 && (pending > 0 || restored) && (
        <p class="why-not">
          <Icon name="fl_warning" size={14} /> {n(missing.length)} מספרי העבודה אינם פתוחים. כדי להמשיך, פתחו שוב את {job.sources.map((l) => `"${l}"`).join(", ")}.
        </p>
      )}
      <div class="row">
        {running ? (
          <>
            <button class="btn outlined" onClick={() => ml.pause()}>השהיה</button>
            <button class="btn text" onClick={() => ml.cancel()}>עצירה</button>
          </>
        ) : (
          <>
            {pending > 0 && (
              <button class="btn filled" disabled={busy || missing.length === job.books.length} onClick={() => void ml.resume()}>
                <Icon name="oz_links" size={16} />
                המשך ({n(pending)} ספרים)
              </button>
            )}
            {failed > 0 && <button class="btn outlined" disabled={busy} onClick={() => void ml.retryFailed()}>הרצה חוזרת של {n(failed)} שנכשלו</button>}
            {!pending && <button class="btn outlined" disabled={busy} onClick={() => void ml.rerunChanged()} title="ספרים שלא השתנו מאז שקושרו מדולגים; מה שאישרתם או דחיתם נשמר">הרצה מחדש של מה שהשתנה</button>}
          </>
        )}
        <button class="btn text" onClick={() => ml.saveJobReport()}>
          <Icon name="fl_arrow_download" size={16} />
          דוח הספרים
        </button>
        {!running && <button class="btn text" onClick={() => ml.discardJob()}>סגירת העבודה</button>}
      </div>
      <details class="held">
        <summary>לפי ספר ({n(job.books.length)})</summary>
        <ul class="ml-books">
          {rows.slice(0, SHOWN).map((b) => <BookRow key={b.title} b={b} />)}
          {rows.length > SHOWN && <li class="muted">ועוד {n(rows.length - SHOWN)} ספרים — כולם בדוח הספרים.</li>}
        </ul>
      </details>
    </section>
  );
}

function BookRow({ b }: { b: JobBook }) {
  return (
    <li class={b.status === "failed" ? "skipped" : ""}>
      <b>{b.title}</b>
      <span>
        {STATUS_TEXT[b.status]}
        {b.status === "done" && ` · ${n(b.suggestions)} הצעות`}
      </span>
      {b.why && <span class="why-not">{b.why}</span>}
      {b.status === "pending" && b.partial ? <span class="why-not">נעצר באמצע: {n(b.partial)} הצעות חלקיות מוצגות. ירוץ שוב מההתחלה.</span> : null}
      {b.changedDecisions ? <span class="why-not">הספר השתנה מאז ההרצה הקודמת: {n(b.changedDecisions)} החלטות שלכם עליו נשמרו כמו שהן — בדקו אותן.</span> : null}
    </li>
  );
}
