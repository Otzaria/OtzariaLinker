import type { EngineId } from "../linking/automatic";

/*
 * What the two sides of a link are CALLED, by job (issue 19). "מקור" and "יעד" are the file format's words, and they
 * collide with "a source" meaning a file or a database; for a commentary the source is the commentary and the target is
 * the book it is written on. Presentation only: the side ids `source` / `target`, the stored form (storedForm), the
 * hashes and the project file are untouched — only the words the user reads change, and the screens carry
 * `data-side="source|target"` so tests do not depend on them.
 *
 *   name  — the full name: panel names, accessible names, messages
 *   short — the badge on a button or a pane
 *   hint  — one line of what the side is, for tooltips
 *   from  — "from the …", for a sentence ("גררו אליה מספר שורה מהמקור")
 */
export type RoleKind = "commentary" | "notes" | "citations" | "generic";

export interface RoleName {
  readonly name: string;
  readonly short: string;
  readonly hint: string;
  readonly from: string;
}
export interface RoleLabels {
  readonly source: RoleName;
  readonly target: RoleName;
}

export const ROLE_LABELS: Readonly<Record<RoleKind, RoleLabels>> = {
  commentary: {
    source: { name: "ספר הפירוש", short: "פירוש", hint: "הפירוש: הקישור יוצא ממנו אל ספר הבסיס", from: "מהפירוש" },
    target: { name: "ספר הבסיס", short: "בסיס", hint: "הספר שהפירוש נכתב עליו", from: "מספר הבסיס" },
  },
  notes: {
    source: { name: "גוף הספר", short: "גוף הספר", hint: "הספר עם סימני ההערות", from: "מגוף הספר" },
    target: { name: "ספר ההערות", short: "הערות", hint: "הספר שבו ההערות עצמן", from: "מספר ההערות" },
  },
  citations: {
    source: { name: "הספר המפנה", short: "מפנה", hint: "הספר שבו כתובים מראי המקום", from: "מהספר המפנה" },
    target: { name: "הספר המצוטט", short: "מצוטט", hint: "הספר שאליו מפנים", from: "מהספר המצוטט" },
  },
  generic: {
    source: { name: "הספר המקשר", short: "מקשר", hint: "הספר שממנו יוצא הקישור", from: "מהספר המקשר" },
    target: { name: "הספר המקושר", short: "מקושר", hint: "הספר שאליו הקישור מפנה", from: "מהספר המקושר" },
  },
};

const KIND_OF: Partial<Record<EngineId, RoleKind>> = {
  headings: "commentary",
  "dibur-hamatchil": "commentary",
  footnotes: "notes",
  citations: "citations",
};

/** The kind of job an engine is; no engine (manual linking), or one without roles of its own (pattern), is generic. */
export const roleKindOf = (engine: EngineId | null | undefined): RoleKind => (engine && KIND_OF[engine]) || "generic";

export const roleLabels = (engine: EngineId | null | undefined): RoleLabels => ROLE_LABELS[roleKindOf(engine)];

/** "in the …" for a role name: "הספר המקשר" → "בספר המקשר", "הספר המפנה" → "בספר המפנה", "גוף הספר" → "בגוף הספר". */
export const inRole = (name: string): string => `ב${name.startsWith("ה") ? name.slice(1) : name}`;
