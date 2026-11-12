import { parseConnectionType, type ConnectionType } from "./connection-type";
import type { Link, LinkSide } from "./model";
import { storedForm } from "./stored-form";

/*
 * THE rule for "is this link already there?" — one module, used by the quality check (a project
 * link that duplicates a database link), by the suggestions' "already exists" state, by copying a
 * database link into the project, and by the max-linking dedupe. Documented in
 * docs/contracts/LINK_FORMATS.md §4.5. Two levels:
 *
 *   "same-link"  the generator's identity of a stored link: IdAllocator.linkId(srcLineId, tgtLineId,
 *                connectionTypeId) (SeforimLibrary@23f1f8f1 generator/common/.../ids/IdAllocator.kt:73).
 *                That is the stored source line, the stored target line and the STORED type — after
 *                the generator converts a file record (storedForm: "source" flips into COMMENTARY,
 *                a dependant type into a base book is downgraded to OTHER…). Two such records become
 *                ONE database row, whatever their file, direction or spelling.
 *   "same-lines" the same two lines, in either direction and of any type. Such a link adds nothing a
 *                reader of Otzaria does not already see on both lines (e.g. the library stores Onkelos
 *                as TARGUM and an engine suggests COMMENTARY).
 *
 * Books are compared by exact TITLE, never by session key: the generator resolves a links file's
 * name and path_2 by exact title (LINK_FORMATS §1.3), so a link written while reading a text edition
 * of a book lands on the database book of the same title; and a link imported before its book was
 * opened ("unresolved:<title>") still matches. Ranges and anchors are not part of the identity:
 * records that differ only in them merge into one link (several anchors, the widest range).
 */
export type LinkMatch = "same-link" | "same-lines";

type Ends = Pick<Link, "source" | "target">;

const end = (s: LinkSide) => `${s.book.title}#${s.line}`;

/**
 * The stored identity of a link, or null when the generator would not store it at all (a "linker"
 * record, Sefaria↔Sefaria). A database link ("db") is already in stored form and is taken as is.
 */
export function storedLinkIdentity(l: Ends & Pick<Link, "declaredType"> & { provenance?: Link["provenance"] }): string | null {
  if (l.provenance === "db") return identity(l.source, l.target, parseConnectionType(l.declaredType).type);
  const f = storedForm(l);
  return f.skipped ? null : identity(f.storedSource, f.storedTarget, f.stored);
}

const identity = (s: LinkSide, t: LinkSide, type: ConnectionType) => `${end(s)}>${end(t)}:${type}`;

/** The two lines of a link, unordered: equal for the same lines in any direction and of any type. */
export function linePairIdentity(l: Ends): string {
  const a = end(l.source);
  const b = end(l.target);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Existing links, indexed for matchLink. Build it once per comparison, not per link. */
export interface LinkMatchIndex {
  readonly links: ReadonlySet<string>;
  readonly pairs: ReadonlySet<string>;
}

export function linkMatchIndex(existing: Iterable<Ends & Pick<Link, "declaredType"> & { provenance?: Link["provenance"] }>): LinkMatchIndex {
  const links = new Set<string>();
  const pairs = new Set<string>();
  for (const l of existing) {
    const id = storedLinkIdentity(l);
    if (id) links.add(id);
    pairs.add(linePairIdentity(l));
  }
  return { links, pairs };
}

/** How a link matches the existing ones: the very same stored link, only the same lines, or not at all. */
export function matchLink(l: Ends & Pick<Link, "declaredType"> & { provenance?: Link["provenance"] }, index: LinkMatchIndex): LinkMatch | null {
  const id = storedLinkIdentity(l);
  if (id && index.links.has(id)) return "same-link";
  return index.pairs.has(linePairIdentity(l)) ? "same-lines" : null;
}
