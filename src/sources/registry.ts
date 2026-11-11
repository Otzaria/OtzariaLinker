import type { SourceBook, SourceInfo, SourceLine } from "../core/books";
import { sourceIdOfBookKey } from "../core/books";
import { LinkerError } from "../core/errors";
import type { Link } from "../core/links/model";
import { decodeText } from "../core/text/decode";
import { blobSource } from "../database/sqlite/lazy/byte-source";
import { safeUnzip } from "./archives/safe-unzip";
import type { BookSource } from "./book-source";
import { DbBookSource } from "./db/db-source";
import { detectKind, type DetectedKind } from "./detect";
import { TextFilesSource, type TextFile } from "./text/text-source";

/*
 * Everything the user has opened, behind one door (stage 6). The user drops files without saying
 * what they are; each file is classified by content (detect.ts), books become sources, and
 * links/project files are handed back as text for the state layer to import.
 */

/** One file the user gave: a dropped/picked File, with its path inside a picked folder. */
export interface InputFile {
  /** relative path ("folder/sub/x.txt") or just the name */
  path: string;
  blob: Blob;
}

export interface OpenedSource {
  info: SourceInfo;
  books: SourceBook[];
}

export interface OpenResult {
  sources: OpenedSource[];
  /** links files and project files, as decoded text — imported by the state layer */
  documents: { path: string; kind: "links-json" | "links-csv" | "project"; text: string }[];
  /** files that were not opened, each with a reason the user can act on */
  skipped: { path: string; reason: string }[];
}

const HEAD = 4096;
const MAX_TEXT_DOC = 256 * 1024 ** 2;
/** a ZIP is read whole into memory to be inflated, so its size is capped first */
const MAX_ZIP = 512 * 1024 ** 2;

export class SourceRegistry {
  private readonly sources = new Map<string, BookSource>();
  private seq = 0;

  async open(files: readonly InputFile[], signal?: AbortSignal): Promise<OpenResult> {
    const result: OpenResult = { sources: [], documents: [], skipped: [] };
    const texts: TextFile[] = [];
    const notUtf8: string[] = [];
    for (const f of files) {
      signal?.throwIfAborted();
      const kind = detectKind(new Uint8Array(await f.blob.slice(0, HEAD).arrayBuffer()), f.path);
      await this.route(f, kind, result, texts, notUtf8);
    }
    if (texts.length) {
      const src = new TextFilesSource(this.nextId(), labelForTexts(texts), texts);
      // decided at open time: a warning added on first read (inside the source) never reached the UI
      if (notUtf8.length)
        src.info.warnings.push({
          code: "source/not-utf8",
          message: `${notUtf8.length} קבצים אינם שמורים ב־UTF-8: ${notUtf8.slice(0, 5).join(", ")}${notUtf8.length > 5 ? "…" : ""}. הכלי מציג אותם נכון, אבל הגנרטור של אוצריא קורא כל ספר כ־UTF-8 — שמרו אותם מחדש ב־UTF-8 לפני שליחה לספרייה.`,
        });
      result.sources.push(await this.add(src));
    }
    return result;
  }

  async lines(bookKey: string, from: number, to: number): Promise<SourceLine[]> {
    return this.of(bookKey).lines(bookKey, from, to);
  }

  async existingLinks(bookKey: string, from: number, to: number): Promise<Link[]> {
    return this.of(bookKey).existingLinks(bookKey, from, to);
  }

  close(sourceId: string): void {
    this.sources.get(sourceId)?.close();
    this.sources.delete(sourceId);
  }

  private async route(f: InputFile, kind: DetectedKind, result: OpenResult, texts: TextFile[], notUtf8: string[]): Promise<void> {
    switch (kind) {
      case "sqlite":
        try {
          result.sources.push(await this.add(await DbBookSource.open(this.nextId(), nameOf(f.path), blobSource(f.blob))));
        } catch (err) {
          result.skipped.push({ path: f.path, reason: reasonOf(err, "לא הצלחתי לקרוא את המסד.") });
        }
        return;
      case "zip":
        return this.openZip(f, result);
      case "links-json":
      case "project":
        if (f.blob.size > MAX_TEXT_DOC) return void result.skipped.push({ path: f.path, reason: "הקובץ גדול מדי לייבוא (מעל 256MB)." });
        result.documents.push({ path: f.path, kind, text: decodeText(new Uint8Array(await f.blob.arrayBuffer())).text });
        return;
      case "text":
        if (/\.txt$/i.test(f.path) || !/\.[a-z0-9]{1,5}$/i.test(f.path)) {
          texts.push({ path: f.path, read: async () => new Uint8Array(await f.blob.arrayBuffer()) });
          const enc = decodeText(new Uint8Array(await f.blob.slice(0, 64 * 1024).arrayBuffer())).encoding;
          if (enc !== "utf-8") notUtf8.push(`${f.path} (${enc})`);
        } else result.skipped.push({ path: f.path, reason: "קובץ טקסט שאינו ‎.txt — לא נטען כספר." });
        return;
      case "json":
        return void result.skipped.push({ path: f.path, reason: "קובץ JSON שאינו קובץ קישורים של אוצריא. ייבוא JSON אחר דורש מיפוי שדות (מצב מתקדם, בקרוב)." });
      case "csv":
      case "tsv":
        if (f.blob.size > MAX_TEXT_DOC) return void result.skipped.push({ path: f.path, reason: "הקובץ גדול מדי לייבוא (מעל 256MB)." });
        result.documents.push({ path: f.path, kind: "links-csv", text: decodeText(new Uint8Array(await f.blob.arrayBuffer())).text });
        return;
      case "binary":
        return void result.skipped.push({ path: f.path, reason: "קובץ בינארי שאינו מסד SQLite או ZIP." });
    }
  }

  private async openZip(f: InputFile, result: OpenResult): Promise<void> {
    if (f.blob.size > MAX_ZIP)
      return void result.skipped.push({ path: f.path, reason: "הארכיון גדול מ־512MB, ולכן לא נפתח בדפדפן. חלצו אותו במחשב ובחרו את התיקייה." });
    let entries;
    try {
      entries = safeUnzip(new Uint8Array(await f.blob.arrayBuffer()), { include: (p) => /\.(txt|json)$/i.test(p) });
    } catch (err) {
      return void result.skipped.push({ path: f.path, reason: reasonOf(err, "הארכיון פגום או חשוד.") });
    }
    if (!entries.length)
      return void result.skipped.push({ path: f.path, reason: "בארכיון אין ספרים (‎.txt) או קובצי קישורים — או שהוא פגום." });
    const texts: TextFile[] = [];
    for (const e of entries) {
      const path = `${nameOf(f.path)}/${e.path}`;
      const kind = detectKind(e.bytes.subarray(0, HEAD), e.path);
      if (kind === "links-json" || kind === "project") result.documents.push({ path, kind, text: decodeText(e.bytes).text });
      else if (kind === "text" && /\.txt$/i.test(e.path)) texts.push({ path: e.path, read: async () => e.bytes });
      else result.skipped.push({ path, reason: "קובץ בתוך הארכיון שאינו ספר ‎.txt או קובץ קישורים." });
    }
    if (texts.length) result.sources.push(await this.add(new TextFilesSource(this.nextId(), nameOf(f.path), texts)));
  }

  private async add(s: BookSource): Promise<OpenedSource> {
    this.sources.set(s.info.id, s);
    return { info: s.info, books: await s.books() };
  }

  private of(bookKey: string): BookSource {
    const s = this.sources.get(sourceIdOfBookKey(bookKey));
    if (!s) throw new LinkerError("source/closed", "המקור של הספר הזה כבר נסגר.");
    return s;
  }

  private nextId(): string {
    return `s${++this.seq}`;
  }
}

const nameOf = (path: string): string => path.split(/[\\/]/).at(-1) ?? path;

function labelForTexts(files: readonly TextFile[]): string {
  const roots = new Set(files.map((f) => (f.path.includes("/") ? f.path.split("/")[0]! : "")));
  if (roots.size === 1 && !roots.has("")) return [...roots][0]!;
  return files.length === 1 ? nameOf(files[0]!.path) : `${files.length} קובצי טקסט`;
}

function reasonOf(err: unknown, fallback: string): string {
  return err instanceof LinkerError ? err.message : `${fallback} (${err instanceof Error ? err.message : String(err)})`;
}
