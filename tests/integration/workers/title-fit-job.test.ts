import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { registryService } from "../../support/books-service";

/* The title-fit report through the worker's API (SourcesApi.titleFit), for the screens that show it before a run. */
describe("titleFit through the books service", () => {
  it("reads both books in the worker and answers with the verdict and its reasons", async () => {
    const reg = new SourceRegistry();
    const service = registryService(reg);
    const plain = { path: "פירוש פשוט על בראשית.txt", blob: new Blob([strToU8(["פירוש פשוט על בראשית", "ביאור ראשון בלי כותרת", "ביאור שני בלי כותרת"].join("\n"))]) };
    const res = await service.open([{ path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) }, plain]);
    const all = res.sources.flatMap((s) => s.books);
    const book = (t: string) => all.find((b) => b.title === t)!;
    const ref = (t: string) => ({ key: book(t).key, title: t, origin: book(t).origin });
    const good = await service.titleFit!(ref("תרגום אונקלוס על בראשית"), ref("בראשית"));
    expect(good.verdict).toBe("fit");
    const none = await service.titleFit!(ref("פירוש פשוט על בראשית"), ref("בראשית"));
    expect(none.verdict).toBe("unfit");
    expect(none.reasons[0]!.code).toBe("title-fit/no-titles");
  });
});
