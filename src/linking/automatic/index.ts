import { runDiburHamatchilEngine, type DhOptions } from "./dibur-hamatchil";
import { runFootnotesEngine, type FootnotesOptions } from "./footnotes";
import { runHeadingsEngine, type HeadingsOptions } from "./headings";
import type { EngineBook, EngineContext, EngineId, EngineResult } from "./types";

/*
 * All automatic engines behind one call. Every engine links SOURCE → TARGET in the file direction:
 *   headings, dibur-hamatchil: the user gives the commentary first and the base second;
 *   footnotes:                 the main book (with markers) first, the notes book second.
 * A suggestion's own source/target is the RECORD direction, which may differ: dibur-hamatchil writes
 * base → commentary with a word anchor when both books are Otzaria's (docs/research/DH_ANCHOR_DIRECTION.md).
 */
export type EngineOptions = { headings: HeadingsOptions; footnotes: FootnotesOptions; "dibur-hamatchil": DhOptions };

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
  {
    id: "dibur-hamatchil",
    title: "לפי דיבור המתחיל",
    sourceRole: "הפירוש",
    targetRole: "ספר הבסיס",
    description: 'כל דיבור המתחיל בפירוש מחופש בטקסט הבסיס, בתוך הפרק שהכותרות מצביעות עליו. כששני הספרים מאוצריא, הקישור נכתב מצד הבסיס עם עוגן על מילות הד"ה.',
  },
  {
    id: "footnotes",
    title: "הערות שוליים",
    sourceRole: "הספר עם סימני ההערות",
    targetRole: "ספר ההערות",
    description: "מספרי ההערות בטקסט (<sup>, סוגריים או תבנית משלכם) מותאמים לשורות בספר ההערות, גם כשהמספור מתחיל מחדש בכל פרק.",
  },
];

export function runEngine(id: EngineId, source: EngineBook, target: EngineBook, options: Record<string, unknown> = {}, ctx: EngineContext = {}): EngineResult {
  switch (id) {
    case "headings":
      return runHeadingsEngine(source, target, options as HeadingsOptions, ctx);
    case "dibur-hamatchil":
      return runDiburHamatchilEngine(source, target, options as DhOptions, ctx);
    case "footnotes":
      return runFootnotesEngine(source, target, options as FootnotesOptions, ctx);
    default:
      throw Object.assign(new Error(`המנוע "${id}" עדיין לא זמין בגרסה הזו.`), { code: "engine/unavailable" });
  }
}

export * from "./types";
