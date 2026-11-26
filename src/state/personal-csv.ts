import { sourceIdOfBookKey, type BookHeading, type SourceBook } from "../core/books";
import type { BookRef, Link } from "../core/links/model";
import { stripTags } from "../core/text/html";
import { zipBundle } from "../formats/links-json/export";
import { personalLinkRows, validatePersonalRows, writePersonalLinksCsv, type PersonalCsvFile, type PersonalCsvProblem, type PersonalSkip } from "../formats/personal-csv";
import type { BooksService, CallOptions, Saver } from "./services";
import type { NoticeKind } from "./store";

/*
 * Export of a personal book's links to the OFFICIAL library, as the `links.csv` of the personal-database build (formats/personal-csv):
 * the project's links between a book of a personal source and a book of the official database, one row per line of the personal book.
 * The place of the target is the target book's own nearest heading above the line (what the importer matches by its table of
 * contents; offline there is nothing to check it against, so it is the book's heading text, not a confirmed tocEntry — the
 * problems list says what could not be placed). Nothing is written to any database (AGENTS.md §2.3): the result is files.
 */
export interface PersonalCsvHost {
  readonly allLinks: { readonly value: Link[] };
  bookOf(ref: BookRef): SourceBook | undefined;
  isLibrarySource(sourceId: string): boolean;
  notify(kind: NoticeKind, text: string, details?: string[]): void;
  runTask<T>(label: string, run: (opts: CallOptions) => Promise<T>): Promise<T | null>;
}

export interface PersonalCsvBundle {
  files: PersonalCsvFile[];
  rows: number;
  /** links the format cannot say, each with its reason */
  skipped: PersonalSkip[];
  /** problems the import would refuse the file for (empty when the files are clean) */
  problems: PersonalCsvProblem[];
}

export class PersonalCsvState {
  constructor(
    private readonly host: PersonalCsvHost,
    private readonly service: Pick<BooksService, "headings" | "lines">,
    private readonly saver: Saver,
  ) {}

  /** The files for the project's links between personal books and the official library; null when cancelled or there is nothing to say. */
  async prepare(only?: ReadonlySet<string>): Promise<PersonalCsvBundle | null> {
    // `only`: these links' ids, not the whole project (the folder-repository runner writes only the links its run made: src/cli/run.ts)
    const links = this.host.allLinks.value.filter((l) => l.provenance !== "db" && (!only || only.has(l.id)));
    const personal = (b: BookRef) => {
      const sb = this.host.bookOf(b);
      return !!sb && !this.host.isLibrarySource(sourceIdOfBookKey(sb.key));
    };
    const official = (b: BookRef) => {
      const sb = this.host.bookOf(b);
      return !!sb && this.host.isLibrarySource(sourceIdOfBookKey(sb.key));
    };
    // the headings of the official targets and the content lines of the personal sources, read once each
    const targets = new Map<string, BookHeading[]>();
    const content = new Map<string, Set<number>>();
    const lengths = new Map<string, number>();
    const ok = await this.host.runTask("קורא את הכותרות והשורות של הספרים…", async (opts) => {
      for (const l of links)
        for (const [mine, other] of [[l.source, l.target], [l.target, l.source]] as const) {
          if (!personal(mine.book) || !official(other.book)) continue;
          if (!targets.has(other.book.key)) targets.set(other.book.key, await this.service.headings(other.book.key, opts));
          if (!content.has(mine.book.key)) {
            const lines = await this.service.lines(mine.book.key, 0, Number.MAX_SAFE_INTEGER, opts);
            lengths.set(mine.book.key, lines.reduce((m, x) => Math.max(m, x.index + 1), 0));
            content.set(mine.book.key, new Set(lines.filter((x) => x.heading === null && stripTags(x.text).trim() !== "").map((x) => x.index)));
          }
        }
      return true;
    });
    if (ok === null) return null;
    // each target book's headings of level 2+ in line order, once; a place is memoised per (book, line)
    const ordered = new Map<string, BookHeading[]>();
    const sorted = (bookKey: string): BookHeading[] | null => {
      let list = ordered.get(bookKey);
      if (!list) {
        const hs = targets.get(bookKey);
        if (!hs) return null;
        list = hs.filter((h) => h.level > 1).sort((a, b) => a.line - b.line);
        ordered.set(bookKey, list);
      }
      return list;
    };
    const placed = new Map<string, string | null>();
    const { rows, skipped } = personalLinkRows(links, {
      isPersonal: personal,
      isOfficial: official,
      contentLine: (b, line) => content.get(b.key)?.has(line) ?? false,
      // the lines read are the book's length: a range end of a hostile file never walks past them
      lineCount: (b) => lengths.get(b.key),
      positionOf: (side) => {
        const key = `${side.book.key}\u0000${side.line}`;
        if (placed.has(key)) return placed.get(key)!;
        const hs = sorted(side.book.key);
        let found: string | null = null;
        if (hs) {
          // the last heading (of level 2+) at or before the line; of several on one line the later one, as the scan chose
          let lo = 0;
          let hi = hs.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (hs[mid]!.line <= side.line) lo = mid + 1;
            else hi = mid;
          }
          const best = lo > 0 ? hs[lo - 1] : undefined;
          found = (best ? stripTags(best.text).trim() : "") || null;
        }
        placed.set(key, found);
        return found;
      },
    });
    const headingTexts = new Map<string, Set<string>>();
    for (const b of [...this.host.allLinks.value.flatMap((l) => [l.source.book, l.target.book])]) {
      const hs = targets.get(b.key);
      if (hs && !headingTexts.has(b.title)) headingTexts.set(b.title, new Set(hs.map((h) => stripTags(h.text).trim())));
    }
    const problems = validatePersonalRows(rows, { targetExists: (t) => headingTexts.has(t), positionExists: (t, p) => headingTexts.get(t)?.has(p) ?? false });
    return { files: writePersonalLinksCsv(rows).files, rows: rows.length, skipped, problems };
  }

  /** Saves the files: one links.csv as it is, several as one ZIP with the folders the personal-database build expects. */
  save(bundle: PersonalCsvBundle): void {
    if (!bundle.files.length) return void this.host.notify("warning", "אין קישורים בין ספר אישי לספר של המאגר הרשמי, ולכן אין מה לייצא.");
    const data = zipBundle(bundle.files.map((f) => ({ path: `${f.folder}/${f.name}`, text: f.text })));
    this.saver.save(`קישורים-לספרייה-האישית-${new Date().toISOString().slice(0, 10)}.zip`, data, "application/zip");
  }
}


