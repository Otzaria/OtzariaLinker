import { describe, expect, it } from "vitest";
import { linesFingerprint } from "../../../src/core/text/fingerprint";
import type { BookRef } from "../../../src/core/links/model";
import { bookFingerprint, failBook, runOrder, finishBook, jobCsv, jobTotals, parseJobRecord, stableId, stepsSignature, type JobBook, type JobRecord } from "../../../src/linking/batch-job";
import type { PlanStep } from "../../../src/linking/plan";

const ref = (key: string, title: string): BookRef => ({ key, title, origin: "otzaria" });
const C = ref("s1:ביאור על בראשית.txt", "ביאור על בראשית");
const B = ref("s1:בראשית.txt", "בראשית");
const pair = (engine: "headings" | "dibur-hamatchil", options?: Record<string, unknown>): PlanStep =>
  ({ id: `${engine}:${C.key}>${B.key}`, kind: "pair", engine, source: C, target: B, relation: {} as never, why: "", ...(options && { options }) }) as PlanStep;
const book = (over: Partial<JobBook> = {}): JobBook => ({ title: C.title, status: "pending", engines: { headings: [1, 0, 0], citations: [1, 0, 0] }, suggestions: 0, ms: 0, ...over });

describe("linesFingerprint", () => {
  it("is equal for the same lines, and changes with a character, a line break or a line", () => {
    const fp = linesFingerprint(["א ב", "ג"]);
    expect(linesFingerprint(["א ב", "ג"])).toBe(fp);
    expect(linesFingerprint(["א ב", "ד"])).not.toBe(fp);
    expect(linesFingerprint(["א", "ב", "ג"])).not.toBe(fp);
    expect(linesFingerprint(["א ב", "ג", ""])).not.toBe(fp);
    expect(fp).toMatch(/^2:[0-9a-f]{16}$/);
  });
});

describe("the batch job's pure parts", () => {
  it("a suggestion id loses the session's book keys, so the same suggestion has one id in every session", () => {
    const s = { id: `headings:${C.key}#4>${B.key}#7`, source: { book: C, line: 4 }, target: { book: B, line: 7 } };
    expect(stableId(s)).toBe("headings:ביאור על בראשית#4>בראשית#7");
    const again = { ...s, id: `headings:s2.1:ביאור על בראשית.txt#4>s2.1:בראשית.txt#7`, source: { book: { ...C, key: "s2.1:ביאור על בראשית.txt" }, line: 4 }, target: { book: { ...B, key: "s2.1:בראשית.txt" }, line: 7 } };
    expect(stableId(again)).toBe(stableId(s));
  });

  it("a book's fingerprint follows its text, its base's text and its steps; unknown when a text could not be read", () => {
    const fps = { [C.key]: "c1", [B.key]: "b1" };
    const fp = bookFingerprint([pair("headings")], fps);
    expect(fp).toBeTruthy();
    expect(bookFingerprint([pair("headings")], { ...fps, [B.key]: "b2" })).not.toBe(fp);
    expect(bookFingerprint([pair("headings")], { ...fps, [C.key]: "c2" })).not.toBe(fp);
    expect(bookFingerprint([pair("headings"), pair("dibur-hamatchil")], fps)).not.toBe(fp);
    expect(bookFingerprint([pair("headings")], fps, { headings: { ranges: false } })).not.toBe(fp);
    expect(bookFingerprint([pair("headings")], { [C.key]: "c1" })).toBeUndefined();
    expect(stepsSignature([pair("headings", { declaredType: "targum" })])).not.toBe(stepsSignature([pair("headings")]));
  });

  it("a book's status: done, 'no match', failed with the reasons; per engine done and failed", () => {
    expect(finishBook(book(), [{ engine: "headings", suggestions: 5 }, { engine: "citations", suggestions: 0 }], 10, "fp")).toMatchObject({ status: "done", suggestions: 5, engines: { headings: [1, 1, 0], citations: [1, 1, 0] }, fingerprint: "fp" });
    expect(finishBook(book(), [{ engine: "headings", suggestions: 0 }, { engine: "citations", suggestions: 0 }], 10, "fp").status).toBe("no-match");
    const f = finishBook(book(), [{ engine: "headings", suggestions: 3 }, { engine: "citations", error: "דף פגום", suggestions: 0 }], 10, "fp");
    expect(f).toMatchObject({ status: "failed", why: "דף פגום", engines: { headings: [1, 1, 0], citations: [1, 0, 1] } });
    expect(failBook(book({ fingerprint: "old" }), "הקובץ השתנה", 3)).toMatchObject({ status: "failed", why: "הקובץ השתנה", engines: { headings: [1, 0, 1] } });
    expect(failBook(book({ fingerprint: "old" }), "x", 3).fingerprint).toBeUndefined();
  });

  it("totals: settled books, and an unchanged book's steps count as done", () => {
    const job = { books: [book({ status: "done", engines: { headings: [1, 1, 0] } }), book({ status: "unchanged", engines: { headings: [1, 0, 0] } }), book(), book({ status: "not-planned", engines: {} })] } as JobRecord;
    const t = jobTotals(job);
    expect(t).toMatchObject({ runnable: 3, settled: 2 });
    expect(t.engines.find((e) => e.engine === "headings")).toMatchObject({ planned: 3, done: 2, failed: 0 });
  });

  it("a stored record: a running job comes back paused; anything else is dropped", () => {
    const rec: JobRecord = { v: 1, id: "x", scope: "s", sources: ["ביאורים"], state: "running", books: [book({ status: "done" })], startedAt: 1, ms: 5 };
    expect(parseJobRecord(JSON.stringify(rec))).toMatchObject({ state: "paused", books: [{ status: "done" }] });
    expect(parseJobRecord("{")).toBeNull();
    expect(parseJobRecord(JSON.stringify({ ...rec, v: 2 }))).toBeNull();
    expect(parseJobRecord(JSON.stringify({ ...rec, books: [{ title: "a", status: "weird", engines: {} }] }))!.books).toEqual([]);
  });

  it("the user's choices (explicit pairs, per-pair methods) survive storage; malformed entries are dropped", () => {
    const rec: JobRecord = { v: 1, id: "x", scope: "s", sources: [], state: "done", books: [], startedAt: 1, ms: 5, choices: { pairs: [{ dependant: "א", base: "ב", kind: "notes" }], methods: { "א>ב": ["headings", "footnotes"] } } };
    expect(parseJobRecord(JSON.stringify(rec))!.choices).toEqual(rec.choices);
    const damaged = { ...rec, choices: { pairs: [{ dependant: "א" }, 7, { dependant: "ג", base: "ד", kind: "bogus" }], methods: { "א>ב": ["pattern?", "citations"], "ג>ד": ["dibur-hamatchil"] } } };
    expect(parseJobRecord(JSON.stringify(damaged))!.choices).toEqual({ pairs: [{ dependant: "ג", base: "ד" }], methods: { "ג>ד": ["dibur-hamatchil"] } });
    expect(parseJobRecord(JSON.stringify({ ...rec, choices: "x" }))!.choices).toBeUndefined();
  });

  it("books that read the same bases run next to each other, groups in order of appearance", () => {
    const on = (t: string, base: BookRef): PlanStep[] => [{ id: t, kind: "pair", engine: "headings", source: ref(`k:${t}`, t), target: base, relation: {} as never, why: "" } as PlanStep, { id: `c:${t}`, kind: "single", engine: "citations", source: ref(`k:${t}`, t), why: "" }];
    const S = ref("s1:שמות.txt", "שמות");
    const steps = new Map([["a", on("a", B)], ["b", on("b", S)], ["c", on("c", B)], ["d", on("d", S)], ["e", [{ id: "c:e", kind: "single", engine: "citations", source: ref("k:e", "e"), why: "" } as PlanStep]]]);
    expect(runOrder(["a", "b", "c", "d", "e"], steps)).toEqual(["a", "c", "b", "d", "e"]);
  });

  it("does not depend on the order the books were opened in: titles run in natural order (a chosen folder arrives in the file system's order)", () => {
    const steps = new Map(["ביאור 1 על בראשית", "ביאור 2 על בראשית", "ביאור 10 על בראשית", "ביאור 11 על בראשית", "ביאור 20 על בראשית"].map((t) => [t, [{ id: t, kind: "pair", engine: "headings", source: ref(`k:${t}`, t), target: B, relation: {} as never, why: "" } as PlanStep]]));
    const sorted = [...steps.keys()];
    // an ext4 directory lists in hash order, NTFS alphabetically: the same folder, two orders
    const ext4 = ["ביאור 11 על בראשית", "ביאור 2 על בראשית", "ביאור 20 על בראשית", "ביאור 10 על בראשית", "ביאור 1 על בראשית"];
    expect(runOrder(ext4, steps)).toEqual(sorted);
    expect(runOrder([...sorted].reverse(), steps)).toEqual(sorted);
    expect(runOrder(sorted, steps)).toEqual(sorted);
  });

  it("the per-book report as CSV", () => {
    const job = { books: [book({ status: "failed", why: "דף פגום" }), book({ title: "בראשית", status: "not-planned", why: "ספר בסיס", engines: {} }), book({ status: "done", suggestions: 4, changedDecisions: 2 })] } as JobRecord;
    const csv = jobCsv(job);
    expect(csv.startsWith("﻿\"ספר\",\"מצב\"")).toBe(true);
    expect(csv).toContain('"נכשל"');
    expect(csv).toContain("דף פגום");
    expect(csv).toContain("2 החלטות שלכם עליו נשמרו");
  });
});
