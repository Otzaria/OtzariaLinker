import { useMemo } from "preact/hooks";
import { sourceIdOfBookKey } from "../../core/books";
import type { OpenedSource } from "../../state/services";
import { useStore } from "../context";

/*
 * Where a book comes from, when several sources are open: a badge per source kind (the Otzaria
 * database, a personal database, a folder, loose files, a ZIP, a mapped database), and the source's
 * name next to a title that more than one open source has — "בראשית" from seforim.db and from a
 * folder are different books, and a link must be made from the one the user means.
 */
export type SourceBadgeKind = "otzaria" | "personal" | "mapped" | "folder" | "files" | "zip";

const BADGE_LABEL: Record<SourceBadgeKind, string> = {
  otzaria: "מסד אוצריא",
  personal: "מסד אישי",
  mapped: "מסד ממופה",
  folder: "תיקייה",
  files: "קבצים",
  zip: "ZIP",
};

export function badgeOf(s: OpenedSource): { kind: SourceBadgeKind; label: string } {
  const kind: SourceBadgeKind =
    s.info.kind === "mapped-db"
      ? "mapped"
      : s.info.kind === "otzaria-db"
        ? s.books.some((b) => b.origin === "personal") ? "personal" : "otzaria"
        : /\.zip$/i.test(s.info.label)
          ? "zip"
          : s.books.some((b) => b.path?.includes("/"))
            ? "folder"
            : "files";
  return { kind, label: BADGE_LABEL[kind] };
}

export function SourceBadge({ source, name }: { source: OpenedSource; name?: boolean }) {
  const b = badgeOf(source);
  return (
    <span class={`src-badge ${b.kind}`} title={`${b.label}: ${source.info.label}`}>
      {b.label}
      {name && (
        <>
          {": "}
          <bdi>{source.info.label}</bdi>
        </>
      )}
    </span>
  );
}

/** The source of a book key, and whether its title is also open from another source. */
export function useBookOrigin(): (bookKey: string | null | undefined) => { source: OpenedSource | undefined; ambiguous: boolean } {
  const store = useStore();
  const sources = store.sources.value;
  const byTitle = store.booksByTitle.value;
  return useMemo(() => {
    const byId = new Map(sources.map((s) => [s.info.id, s]));
    return (key) => {
      if (!key) return { source: undefined, ambiguous: false };
      const source = byId.get(sourceIdOfBookKey(key));
      const title = store.books.peek().get(key)?.title;
      const same = title ? (byTitle.get(title) ?? []) : [];
      return { source, ambiguous: new Set(same.map((b) => sourceIdOfBookKey(b.key))).size > 1 };
    };
  }, [sources, byTitle]);
}
