import type { SourceKind } from "../../core/books";

/*
 * Which of the sources already open can fill a step of a task sheet (#22). The sheet's progress used to be
 * its own state, so opening it again asked for the same database again; now an open source is offered, and
 * a step takes each source once. Pure: the sheet passes what the store holds.
 */
export interface OpenSource {
  id: string;
  kind: SourceKind;
  /** the official library (or a copy): what a step marked as "Otzaria's database" wants first */
  library: boolean;
}

export interface StepNeed {
  options: readonly string[];
  optional?: boolean;
  dbHint?: boolean;
}

const KINDS: Readonly<Record<string, readonly SourceKind[]>> = {
  db: ["otzaria-db", "mapped-db"],
  folder: ["text-files"],
  files: ["text-files"],
  zip: ["text-files"],
};

/** the open sources a step can take (by what it accepts): the library ones first when the step asks for Otzaria's database, the user's own first otherwise */
export function candidatesFor(step: StepNeed, sources: readonly OpenSource[], taken: ReadonlySet<string> = new Set()): OpenSource[] {
  const kinds = new Set(step.options.flatMap((o) => KINDS[o] ?? []));
  const list = sources.filter((s) => kinds.has(s.kind) && !taken.has(s.id));
  // the book base is the library's (a step with the hint); the book that is linked FROM is the user's own
  return step.dbHint ? [...list.filter((s) => s.library), ...list.filter((s) => !s.library)] : [...list.filter((s) => !s.library), ...list.filter((s) => s.library)];
}

/**
 * "Continue with the open books": every unfinished step takes the first open source it can use that no step
 * has taken. Steps already done keep theirs. An optional step takes one only when it is the sole way left to
 * use a source (otherwise the required steps would starve it).
 */
export function assignOpenSources(steps: readonly StepNeed[], sources: readonly OpenSource[], done: Readonly<Record<number, string[] | true>>): Record<number, string[]> {
  const taken = new Set<string>();
  for (const d of Object.values(done)) if (Array.isArray(d)) for (const id of d) taken.add(id);
  const out: Record<number, string[]> = {};
  const pass = (optional: boolean) =>
    steps.forEach((step, i) => {
      if (done[i] || out[i] || !!step.optional !== optional) return;
      const pick = candidatesFor(step, sources, taken)[0];
      if (!pick) return;
      taken.add(pick.id);
      out[i] = [pick.id];
    });
  pass(false);
  pass(true);
  return out;
}
