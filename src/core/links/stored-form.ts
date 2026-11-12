import { parseConnectionType, SOURCE_VIEW_TYPES, appPanelOf, type AppPanel, type ConnectionType } from "./connection-type";
import type { Link, LinkSide } from "./model";
import { titleDeclaresDependencyOn } from "./titles";

/*
 * What the generator will actually store for a link-file record — port of the record loop in
 * Generator.kt:2276-2329 (SeforimLibrary@23f1f8f1). The UI shows the user THIS (effective type,
 * panel, direction), not just what they typed: a declared "commentary" can end up as OTHER.
 */
export interface StoredForm {
  /** The record is not imported at all. */
  skipped: null | "linker" | "sefaria-both";
  declared: ConnectionType;
  /** false when the declared string is unknown to the generator (stored as OTHER) */
  knownType: boolean;
  stored: ConnectionType;
  /** stored with source and target swapped (SOURCE, or a dependant that names its base) */
  flipped: boolean;
  /** a dependent type pointing from a non-base book into a base book without "X על <base>" → OTHER */
  downgraded: boolean;
  /** isBaseBook of a side is unknown, so flip/downgrade could not be decided for certain */
  uncertain: boolean;
  /** the side that becomes the stored source/target */
  storedSource: LinkSide;
  storedTarget: LinkSide;
  panel: AppPanel | null;
}

export function storedForm(link: Pick<Link, "source" | "target" | "declaredType">): StoredForm {
  const { type: declared, known } = parseConnectionType(link.declaredType);
  const src = link.source;
  const tgt = link.target;
  const base = { declared, knownType: known, storedSource: src, storedTarget: tgt, flipped: false, downgraded: false };

  if (declared === "LINKER")
    return { ...base, skipped: "linker", stored: "LINKER", uncertain: false, panel: null };
  if (src.book.origin === "sefaria" && tgt.book.origin === "sefaria")
    return { ...base, skipped: "sefaria-both", stored: declared, uncertain: false, panel: null };

  const oriented = SOURCE_VIEW_TYPES.has(declared);
  const uncertain = oriented && (tgt.book.isBaseBook === undefined || src.book.isBaseBook === undefined);
  const pointsFromNonBaseIntoBase = oriented && tgt.book.isBaseBook === true && src.book.isBaseBook !== true;
  const reversedDependant = pointsFromNonBaseIntoBase && titleDeclaresDependencyOn(src.book.title, tgt.book.title);
  const flipped = declared === "SOURCE" || reversedDependant;
  const downgraded = pointsFromNonBaseIntoBase && !reversedDependant;
  const stored: ConnectionType = declared === "SOURCE" ? "COMMENTARY" : downgraded ? "OTHER" : declared;

  return {
    skipped: null,
    declared,
    knownType: known,
    stored,
    flipped,
    downgraded,
    uncertain,
    storedSource: flipped ? tgt : src,
    storedTarget: flipped ? src : tgt,
    panel: appPanelOf(stored),
  };
}

