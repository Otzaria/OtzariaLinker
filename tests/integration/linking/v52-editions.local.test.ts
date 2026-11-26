import { describe, expect, it } from "vitest";
import { pairByTitle } from "../../../src/linking/batch";
import { discoverPairs } from "../../../src/linking/discovery";
import { planMaxLink } from "../../../src/linking/plan";
import { baseTitleKey, titleCorpus } from "../../../src/core/links/titles";
import { SourceRegistry } from "../../../src/sources/registry";
import { fileBlob } from "../../validation/env";

/*
 * V7 §2.8, #41 B4, #42 C12 on real book lists: the personal database v52 and the official seforim.db open together, so the titles
 * both have (36 by exact title) are two editions. Measured: how many dependants are paired with a base that has another edition,
 * and how many of those the batch path, the max-link plan and discovery mark as undecided / ambiguous. Book lists only — no text is
 * read. Runs only with both files (opened read-only):
 *   OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db OTZARIA_PERSONAL_DB=C:/Users/User/Documents/DEV/otzarya-unofficial-books-52.db \
 *   npx vitest run tests/integration/linking/v52-editions.local.test.ts
 */
const official = process.env.OTZARIA_DB;
const personal = process.env.OTZARIA_PERSONAL_DB;

describe.runIf(official && personal)("editions of one base across v52 and seforim.db (read-only)", () => {
  it("every pairing with another edition of its base is undecided on every path", async () => {
    const reg = new SourceRegistry();
    const res = await reg.open([{ path: "seforim.db", blob: await fileBlob(official!) }, { path: "v52.db", blob: await fileBlob(personal!) }]);
    const books = res.sources.flatMap((s) => s.books).map((b) => ({ key: b.key, title: b.title, origin: b.origin, ...(b.lineCount !== undefined && { lineCount: b.lineCount }) }));
    const edition = (t: string) => `${titleCorpus(t)}|${baseTitleKey(t)}`;
    const count = new Map<string, number>();
    for (const b of books) count.set(edition(b.title), (count.get(edition(b.title)) ?? 0) + 1);
    const exact = new Map<string, number>();
    for (const b of books) exact.set(b.title, (exact.get(b.title) ?? 0) + 1);
    const sameExact = [...exact.values()].filter((n) => n > 1).length;
    const v52 = res.sources[1]!.books.map((b) => books.find((x) => x.key === b.key)!);

    // the batch path: every v52 book against all open books
    const pairs = pairByTitle(v52, books).filter((p) => p.target);
    const withEditions = pairs.filter((p) => (count.get(edition(p.target!.title)) ?? 0) > 1);
    const exactEditions = withEditions.filter((p) => (exact.get(p.target!.title) ?? 0) > 1);
    const undecided = withEditions.filter((p) => (p as { undecided?: unknown[] }).undecided?.length);
    const silent = withEditions.filter((p) => !p.note);

    // the max-link plan for those dependants
    const deps = [...new Set(withEditions.map((p) => p.source.key))];
    const plan = planMaxLink({ selected: deps, library: books, singleEngines: [] });
    const stepsWith = plan.steps.filter((s) => s.kind === "pair" && (count.get(edition(s.target.title)) ?? 0) > 1 && s.relation.via !== "user");
    const flagged = stepsWith.filter((s) => s.kind === "pair" && s.ambiguousBase);

    // discovery
    const disc = discoverPairs(books, { dependants: (b) => deps.includes(b.key) });
    const discWith = disc.proposals.filter((p) => (count.get(edition(p.base.title)) ?? 0) > 1);
    const discAmb = discWith.filter((p) => p.selection === "ambiguous");

    console.log(
      `titles in both by exact title: ${sameExact}; v52 dependants paired with a base that has another edition: ${withEditions.length} (exact-title editions ${exactEditions.length}); ` +
        `batch: undecided ${undecided.length}, without any note ${silent.length}; plan: ${stepsWith.length} steps against such a base, ambiguousBase ${flagged.length}; ` +
        `discovery: ${discWith.length} proposals, ambiguous ${discAmb.length}`,
    );
    for (const p of withEditions.slice(0, 12)) console.log(`  ${p.source.title} → ${p.target!.title} (${p.target!.key})${p.note ? "" : "  [no note]"}`);
    expect(withEditions.length).toBeGreaterThan(0);
  }, 600_000);
});
