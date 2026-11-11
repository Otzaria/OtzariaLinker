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

export function pairByTitle(commentaries: readonly BookRef[], bases: readonly BookRef[]): BatchPair[] {
  const byKey = new Map<string, BookRef[]>();
  for (const b of bases) {
    const k = baseTitleKey(b.title);
    byKey.set(k, [...(byKey.get(k) ?? []), b]);
  }
  return commentaries.map((c): BatchPair => {
    const k = declaredBaseKey(c.title);
    if (!k) return { source: c, target: null, reason: 'השם אינו בצורה "… על <ספר>", ולכן לא ידוע על איזה ספר הוא.' };
    const hits = (byKey.get(k) ?? []).filter((b) => b.key !== c.key);
    if (!hits.length) return { source: c, target: null, reason: `ספר הבסיס "${k}" אינו פתוח באף מקור.` };
    // the official library wins over personal copies; more than one candidate of the same kind is ambiguous
    const official = hits.filter((b) => b.origin !== "personal");
    const pool = official.length ? official : hits;
    if (pool.length > 1) return { source: c, target: null, reason: `נמצאו ${pool.length} ספרים בשם "${pool[0]!.title}". בחרו את הבסיס ידנית.` };
    return { source: c, target: pool[0]! };
  });
}
