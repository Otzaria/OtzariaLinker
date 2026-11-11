import type { BookRef, Link, LinkSide } from "../core/links/model";
import type { LineFate, LineMapping } from "../matching/line-diff";
import { visibleSlice } from "../matching/hebrew-tokens";
import { rawOffsetFromVisible, visibleUnits } from "../core/text/offsets";

/*
 * Moving links to a new edition of a book (stage 11). Given the line mapping old → new
 * (matching/line-diff.ts), every project link with an end in the old book gets a plan:
 *   certain — every end it has in that book landed on an identical line;
 *   review  — an end landed on an EDITED line, or a range end had to be shortened: the user decides;
 *   lost    — an end's line no longer exists: never moved automatically.
 * Word anchors are carried only to an identical line, or re-found when their words occur exactly
 * once in the edited line; otherwise the anchor is dropped and the item goes to review.
 */
export type RelinkVerdict = "certain" | "review" | "lost";

export interface RelinkItem {
  link: Link;
  verdict: RelinkVerdict;
  /** Hebrew reasons, one per decision */
  reasons: string[];
  /** the link as it would be in the new edition (absent when lost) */
  moved?: Link;
}

export interface RelinkPlan {
  items: RelinkItem[];
  counts: Record<RelinkVerdict, number>;
  /** project links that do not touch the old book — untouched */
  untouched: number;
}

export interface RelinkInput {
  links: readonly Link[];
  oldBook: BookRef;
  newBook: BookRef;
  mapping: Pick<LineMapping, "to" | "fate">;
  /** anchor texts of the old and new edition, for the lines anchors sit on (may be partial) */
  oldLine?: (i: number) => string | undefined;
  newLine?: (i: number) => string | undefined;
  isOld: (ref: BookRef) => boolean;
}

export function planRelink(input: RelinkInput): RelinkPlan {
  const items: RelinkItem[] = [];
  let untouched = 0;
  for (const link of input.links) {
    if (link.provenance === "db" || link.status === "deleted") continue;
    const s = input.isOld(link.source.book);
    const t = input.isOld(link.target.book);
    if (!s && !t) {
      untouched++;
      continue;
    }
    items.push(planOne(link, s, t, input));
  }
  const counts = { certain: 0, review: 0, lost: 0 };
  for (const i of items) counts[i.verdict]++;
  return { items, counts, untouched };
}

function planOne(link: Link, inSource: boolean, inTarget: boolean, input: RelinkInput): RelinkItem {
  const reasons: string[] = [];
  let verdict: RelinkVerdict = "certain";
  const worse = (v: RelinkVerdict) => {
    if (v === "lost" || (v === "review" && verdict === "certain")) verdict = v;
  };
  const moveSide = (side: LinkSide, label: string): LinkSide | null => {
    const to = input.mapping.to[side.line] ?? -1;
    const fate: LineFate = input.mapping.fate[side.line] ?? "deleted";
    if (to < 0) {
      reasons.push(`שורה ${side.line + 1} ב${label} נמחקה במהדורה החדשה.`);
      worse("lost");
      return null;
    }
    if (fate === "changed") {
      reasons.push(`שורה ${side.line + 1} ב${label} נערכה במהדורה החדשה (עכשיו שורה ${to + 1}).`);
      worse("review");
    } else if (to !== side.line) reasons.push(`שורה ${side.line + 1} ב${label} זזה לשורה ${to + 1}.`);
    let end: number | undefined;
    if (side.end !== undefined) {
      const e = input.mapping.to[side.end] ?? -1;
      if (e > to) end = e;
      else {
        // the range's last line is gone: shorten to the last surviving line of the range
        for (let i = side.end - 1; i > side.line; i--) {
          const m = input.mapping.to[i] ?? -1;
          if (m > to) {
            end = m;
            break;
          }
        }
        reasons.push(`סוף הטווח ב${label} נמחק, והטווח קוצר.`);
        worse("review");
      }
    }
    return { book: input.newBook, line: to, ...(end !== undefined && { end }) };
  };

  const source = inSource ? moveSide(link.source, "ספר המקור") : link.source;
  const target = inTarget ? moveSide(link.target, "ספר היעד") : link.target;
  if (!source || !target) return { link, verdict: "lost", reasons };

  let anchor = link.anchor;
  if (anchor && inSource) {
    const fate = input.mapping.fate[link.source.line];
    if (fate === "changed") {
      const moved = refindAnchor(anchor, input.oldLine?.(link.source.line), input.newLine?.(source.line));
      if (moved) {
        anchor = { ...anchor, ...moved };
        reasons.push("העוגן נמצא שוב בשורה הערוכה.");
      } else {
        anchor = undefined;
        reasons.push("המילים של העוגן לא נמצאו בדיוק פעם אחת בשורה הערוכה, ולכן העוגן הוסר.");
        worse("review");
      }
    }
  }
  const { anchor: _old, ...rest } = link;
  const moved: Link = {
    ...rest,
    source,
    target,
    ...(anchor && { anchor }),
    status: link.status === "existing" ? "edited" : link.status,
    ...(inTarget && { targetPath: undefined }),
  };
  if (inTarget) delete (moved as { targetPath?: string }).targetPath;
  if (!reasons.length) reasons.push("השורה זהה במהדורה החדשה.");
  return { link, verdict, reasons, moved };
}

/** The anchor's words in the old line, found exactly once in the new line → new raw offsets. */
function refindAnchor(a: NonNullable<Link["anchor"]>, oldLine: string | undefined, newLine: string | undefined): { rawStart: number; rawEnd?: number } | null {
  if (!oldLine || !newLine) return null;
  const words = visibleSlice(oldLine, a.rawStart, a.rawEnd ?? a.rawStart + 1);
  if (!words.trim()) return null;
  const units = visibleUnits(newLine);
  // the visible text, unit by unit; an entity unit is several characters, so keep where each unit starts
  let visible = "";
  const unitAt = new Map<number, number>(); // char offset in `visible` → unit index
  units.forEach((u, i) => {
    unitAt.set(visible.length, i);
    visible += newLine.slice(u.start, u.end);
  });
  const at = visible.indexOf(words);
  if (at < 0 || visible.indexOf(words, at + 1) >= 0) return null;
  const startUnit = unitAt.get(at);
  const endUnit = at + words.length === visible.length ? units.length : unitAt.get(at + words.length);
  if (startUnit === undefined || endUnit === undefined) return null; // the match cuts through an entity
  return { rawStart: rawOffsetFromVisible(newLine, startUnit), ...(a.rawEnd !== undefined && { rawEnd: endUnit < units.length ? units[endUnit]!.start : newLine.length }) };
}
