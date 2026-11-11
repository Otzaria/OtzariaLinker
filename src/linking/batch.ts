import type { BookRef } from "../core/links/model";
import { baseTitleKey, declaredBaseKey } from "../core/links/titles";

/*
 * Batch linking (stage 8.4): many commentaries at once, each against the base book its title names.
 * Pairing is by title only ("X על <base>", the same rule the generator uses to decide direction), so
 * it is explainable and never guesses: a book whose base is not open, or is ambiguous, is listed as
 * unpaired with the reason instead of being linked to a lookalike.
 */
export interface BatchPair {
  source: BookRef;
  target: BookRef | null;
  /** why there is no target (Hebrew), when target is null */
  reason?: string;
}

/** Open books by their base-title key, built once and shared by many lookups (the max-link planner pairs thousands). */
export type TitleIndex = ReadonlyMap<string, readonly BookRef[]>;

export function titleIndex(bases: readonly BookRef[]): TitleIndex {
  const byKey = new Map<string, BookRef[]>();
  for (const b of bases) {
    const k = baseTitleKey(b.title);
    const list = byKey.get(k);
    if (list) list.push(b);
    else byKey.set(k, [b]);
  }
  return byKey;
}

/**
 * The open book a base-title key names, or why there is none. The official library wins over
 * personal copies; more than one candidate of the same kind is ambiguous.
 */
export function resolveBaseKey(k: string, index: TitleIndex, self: BookRef): { target: BookRef } | { reason: string } {
  const hits = (index.get(k) ?? []).filter((b) => b.key !== self.key);
  if (!hits.length) return { reason: `ספר הבסיס "${k}" אינו פתוח באף מקור.` };
  const official = hits.filter((b) => b.origin !== "personal");
  const pool = official.length ? official : hits;
  if (pool.length > 1) return { reason: `נמצאו ${pool.length} ספרים בשם "${pool[0]!.title}". בחרו את הבסיס ידנית.` };
  return { target: pool[0]! };
}

/** One commentary against an index of open books, by its title. */
export function pairOne(c: BookRef, index: TitleIndex): BatchPair {
  const k = declaredBaseKey(c.title);
  if (!k) return { source: c, target: null, reason: 'השם אינו בצורה "… על <ספר>", ולכן לא ידוע על איזה ספר הוא.' };
  const r = resolveBaseKey(k, index, c);
  return "target" in r ? { source: c, target: r.target } : { source: c, target: null, reason: r.reason };
}

export function pairByTitle(commentaries: readonly BookRef[], bases: readonly BookRef[]): BatchPair[] {
  const index = titleIndex(bases);
  return commentaries.map((c) => pairOne(c, index));
}
