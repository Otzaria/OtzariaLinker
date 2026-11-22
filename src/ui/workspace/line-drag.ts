import { MAX_BOOK_LINES } from "../../core/limits";

/** What the reader puts on a drag of a line number (application/x-otzaria-line). */
export interface DraggedLine {
  bookKey: string;
  line: number;
}

/** The drop's payload read back: null unless it is exactly a book key and a 0-based line index (the data is not trusted). */
export function parseDraggedLine(raw: string | undefined): DraggedLine | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return null;
    const { bookKey, line } = v as Record<string, unknown>;
    return typeof bookKey === "string" && typeof line === "number" && Number.isInteger(line) && line >= 0 && line < MAX_BOOK_LINES ? { bookKey, line } : null;
  } catch {
    return null;
  }
}
