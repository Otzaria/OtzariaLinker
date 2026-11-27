import { LinkerError } from "../core/errors";
import { CONFIDENCE_ORDER, ENGINES, type Confidence, type EngineId } from "../linking/automatic";
import { reportText, runRepository, type RunOptions } from "./run";

/*
 * `node dist-cli/linker.mjs --repo <folder|zip> [--db <seforim.db>] (--out <empty folder> | --dry-run) [options]`
 * (npm run build:cli → vite.cli.config.ts; docs/HEADLESS.md). Exit codes: 0 done, 1 failed, 2 wrong arguments — so a batch script
 * can tell a mistake in its own call from a failed run. --json prints the machine report on stdout instead of the text.
 */
export const USAGE = `שימוש:
  node dist-cli/linker.mjs --repo <תיקייה או ZIP> [--db <seforim.db>] (--out <תיקייה ריקה> | --dry-run) [אפשרויות]

  --repo <נתיב>          המאגר: עותק git מקומי או ZIP. נקרא בלבד.
  --db <נתיב>            seforim.db של אוצריא, לקישור אל הספרייה הרשמית. נקרא בלבד. בלעדיו: רק קישורים בתוך המאגר.
  --out <תיקייה>         לשם נכתבים קובצי הקישורים (באותם נתיבים כמו במאגר) והדוח. ריקה או חדשה; לא בתוך המאגר.
  --dry-run              בלי לכתוב קובצי קישורים: רק הדוח (ב־--out, או על המסך).
  --include <תבנית>      רק ספרים שמתאימים (אפשר כמה): נתיב עם * ו־**, או מילים מהשם.
  --exclude <תבנית>      בלי ספרים שמתאימים (אפשר כמה).
  --limit <מספר>         לכל היותר כך וכך ספרים (לפי סדר הנתיבים).
  --min-confidence <רמה> certain (ברירת מחדל) | high | possible.
  --methods <רשימה>      מנועי הזוגות במקום כל המתאימים: headings,dibur-hamatchil.
  --purpose <מטרה>       private (ברירת מחדל) | submission (כללי הסנכרון של הספרייה הם שגיאות).
  --json                 הדוח כ־JSON על המסך.
  --help                 העזרה הזו.

קודי יציאה: 0 הסתיים, 1 נכשל, 2 ארגומנטים שגויים.
`;

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

/** Parses the arguments; a LinkerError "repo/bad-args" for anything it does not know. */
export function parseArgs(argv: readonly string[]): (RunOptions & { json: boolean }) | "help" {
  const o: RunOptions & { json: boolean; include: string[]; exclude: string[] } = { repo: "", json: false, include: [], exclude: [] };
  const bad = (m: string) => new LinkerError("repo/bad-args", m);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw bad(`חסר ערך אחרי ${a}.`);
      return v;
    };
    switch (a) {
      case "--help":
      case "-h":
        return "help";
      case "--repo": o.repo = value(); break;
      case "--db": o.db = value(); break;
      case "--out": o.out = value(); break;
      case "--dry-run": o.dryRun = true; break;
      case "--json": o.json = true; break;
      case "--include": o.include.push(value()); break;
      case "--exclude": o.exclude.push(value()); break;
      case "--limit": {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1) throw bad("--limit צריך להיות מספר שלם חיובי.");
        o.limit = n;
        break;
      }
      case "--min-confidence": {
        const v = value() as Confidence;
        if (!["certain", "high", "possible"].includes(v) || !CONFIDENCE_ORDER.includes(v)) throw bad(`--min-confidence: certain, high או possible (לא "${v}").`);
        o.minConfidence = v;
        break;
      }
      case "--methods": {
        const list = value().split(",").map((s) => s.trim()).filter(Boolean) as EngineId[];
        const pair = ["headings", "dibur-hamatchil"];
        const wrong = list.filter((m) => !pair.includes(m) || !ENGINES.some((e) => e.id === m));
        if (!list.length || wrong.length) throw bad(`--methods: ${pair.join(", ")} (לא "${wrong.join(", ")}").`);
        o.methods = list;
        break;
      }
      case "--purpose": {
        const v = value();
        if (v !== "private" && v !== "submission") throw bad(`--purpose: private או submission (לא "${v}").`);
        o.purpose = v;
        break;
      }
      default:
        throw bad(`ארגומנט לא מוכר: ${a}. ראו --help.`);
    }
  }
  if (!o.repo) throw bad("חסר --repo: התיקייה או קובץ ה־ZIP של המאגר.");
  if (!o.out && !o.dryRun) throw bad("חסר --out (תיקייה ריקה לפלט), או --dry-run להרצה בלי כתיבה.");
  return o;
}

/** The whole command: returns the exit code. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.err(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args === "help") {
    io.out(USAGE);
    return 0;
  }
  try {
    const { report } = await runRepository(args);
    io.out(args.json ? `${JSON.stringify(report, null, 2)}\n` : reportText(report));
    return 0;
  } catch (err) {
    const e = err as Error;
    io.err(`${e instanceof LinkerError ? e.message : `שגיאה: ${e?.message ?? String(e)}`}\n`);
    return e instanceof LinkerError && e.code === "repo/bad-args" ? 2 : 1;
  }
}
