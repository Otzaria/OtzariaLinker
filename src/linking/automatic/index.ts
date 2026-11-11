import { runHeadingsEngine, type HeadingsOptions } from "./headings";
import type { EngineBook, EngineContext, EngineId, EngineResult } from "./types";

/*
 * All automatic engines behind one call. Every engine links SOURCE → TARGET in the file direction:
 *   headings, dibur-hamatchil: source = the commentary, target = the base book;
 *   footnotes:                 source = the main book (marker), target = the notes book.
 */
export type EngineOptions = { headings: HeadingsOptions };

export interface EngineInfo {
  id: EngineId;
  title: string;
  /** what the user picks as source and target, in plain words */
  sourceRole: string;
  targetRole: string;
  description: string;
}

export const ENGINES: readonly EngineInfo[] = [
  {
    id: "headings",
    title: "לפי כותרות",
    sourceRole: "הפירוש",
    targetRole: "ספר הבסיס",
    description: "כל שורה בפירוש מקושרת למקום בבסיס לפי הכותרות שמעליה: פרק ופסוק, סימן וסעיף, דף ועמוד.",
  },
];

export function runEngine(id: EngineId, source: EngineBook, target: EngineBook, options: Record<string, unknown> = {}, ctx: EngineContext = {}): EngineResult {
  switch (id) {
    case "headings":
      return runHeadingsEngine(source, target, options as HeadingsOptions, ctx);
    default:
      throw Object.assign(new Error(`המנוע "${id}" עדיין לא זמין בגרסה הזו.`), { code: "engine/unavailable" });
  }
}

export * from "./types";
