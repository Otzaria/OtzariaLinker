import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import type { BookRef } from "../../../../src/core/links/model";
import { SourceRegistry } from "../../../../src/sources/registry";
import { citationsJob } from "../../../../src/workers/citations-job";
import { fileBlob } from "./file-blob";

/*
 * The V7 round (issue #41 B8, B9) on books of the personal database v52 (copyright-restricted, never copied into the repo; both
 * databases opened read-only, file-backed Blobs):
 *   OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db OTZARIA_PERSONAL_DB=…/otzarya-unofficial-books-52.db V52_OUT=<file.json> \
 *     npx vitest run tests/integration/linking/citations/v52-v7.local.test.ts
 * The sample: the 8 personal books of 300–4000 lines with the smallest sha1("v7-b9:" + title). Each is run twice — the default type
 * ("reference") and "ציטוט בטקסט" (citationType "inline-linker") — and per run the suggestions are counted by confidence, with how many
 * carry an anchor and how many were read as a quantity (rule citations.quantity-like). Numbers only; no thresholds.
 */
const DB = process.env.OTZARIA_DB;
const PERSONAL = process.env.OTZARIA_PERSONAL_DB;

describe.runIf(DB && PERSONAL)("citations on v52 books (read-only)", () => {
  it("anchors and quantities per run", async () => {
    const reg = new SourceRegistry();
    const opened = await reg.open([
      { path: "seforim.db", blob: fileBlob(DB!) },
      { path: "v52.db", blob: fileBlob(PERSONAL!) },
    ]);
    const personal = opened.sources.flatMap((s) => s.books).filter((b) => b.origin === "personal" && (b.lineCount ?? 0) >= 300 && (b.lineCount ?? 0) <= 4000);
    const sha = (t: string) => createHash("sha1").update(`v7-b9:${t}`).digest("hex");
    const sample = [...personal].sort((a, b) => (sha(a.title) < sha(b.title) ? -1 : 1)).slice(0, 8);
    const rows: unknown[] = [];
    for (const b of sample) {
      const ref: BookRef = { key: b.key, title: b.title, origin: b.origin };
      for (const citationType of ["reference", "inline-linker"] as const) {
        const r = await citationsJob(reg, ref, { citationType }, {});
        const by: Record<string, number> = {};
        for (const s of r.suggestions) by[s.confidence] = (by[s.confidence] ?? 0) + 1;
        const quantity = r.suggestions.filter((s) => s.rules.includes("citations.quantity-like"));
        const row = {
          book: b.title,
          lines: b.lineCount,
          citationType,
          suggestions: r.suggestions.length,
          by,
          anchored: r.suggestions.filter((s) => s.anchor).length,
          inline: r.suggestions.filter((s) => s.declaredType === "INLINE_LINKER").length,
          ranged: r.suggestions.filter((s) => s.target.end !== undefined).length,
          quantityLike: quantity.length,
          quantityExamples: quantity.slice(0, 5).map((s) => `${s.heRef2} (${s.reasons[0]?.text ?? ""})`),
          notes: r.notes.map((n) => n.code),
        };
        rows.push(row);
        console.log(JSON.stringify(row));
      }
    }
    if (process.env.V52_OUT) writeFileSync(process.env.V52_OUT, JSON.stringify(rows, null, 1));
  }, 3_600_000);
});
