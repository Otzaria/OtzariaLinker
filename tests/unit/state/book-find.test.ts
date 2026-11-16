import { describe, expect, it } from "vitest";
import type { BookSearchResult } from "../../../src/core/text/find";
import { BookFind } from "../../../src/state/book-find";
import type { CallOptions } from "../../../src/state/services";

const hit = (line: number) => ({ line, snippet: `שורה ${line}`, start: 0, end: 4, count: 1 });

/** A searchBook that answers when the test says so, and records cancellations. */
function fakeService() {
  const calls: { key: string; query: string; opts: CallOptions | undefined; resolve: (r: BookSearchResult) => void; reject: (e: unknown) => void }[] = [];
  const cancelled: string[] = [];
  return {
    calls,
    cancelled,
    service: {
      searchBook: (key: string, query: string, _o: { limit?: number }, opts?: CallOptions) =>
        new Promise<BookSearchResult>((resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => (cancelled.push(query), reject(Object.assign(new Error("בוטל"), { code: "cancelled" }))));
          calls.push({ key, query, opts, resolve, reject });
        }),
    },
  };
}

function make() {
  const f = fakeService();
  const revealed: [string, number][] = [];
  const find = new BookFind(f.service, (k, l) => revealed.push([k, l]));
  return { ...f, find, revealed };
}

describe("BookFind — the search box of a reader", () => {
  it("searches, shows the first hit and moves between hits, wrapping around", async () => {
    const { find, calls, revealed } = make();
    const p = find.search("s1:1", "אלהים");
    expect(find.status.value).toBe("searching");
    calls[0]!.resolve({ query: "אלהים", hits: [hit(2), hit(5), hit(9)], scanned: 10, truncated: false });
    await p;
    expect(find.status.value).toBe("done");
    expect(find.pos.value).toBe(0);
    expect([...find.hitLines.value]).toEqual([2, 5, 9]);
    expect(revealed).toEqual([["s1:1", 2]]);
    find.step(1);
    find.step(1);
    expect(find.current.value?.line).toBe(9);
    find.step(1);
    expect(find.current.value?.line).toBe(2); // wraps to the first
    find.step(-1);
    expect(find.current.value?.line).toBe(9); // and back to the last
    find.goTo(1);
    expect(revealed.at(-1)).toEqual(["s1:1", 5]);
  });

  it("a new query cancels the search still running, and its late answer is ignored", async () => {
    const { find, calls, cancelled } = make();
    const first = find.search("s1:1", "אלה");
    const second = find.search("s1:1", "אלהים");
    expect(cancelled).toEqual(["אלה"]);
    await first;
    calls[1]!.resolve({ query: "אלהים", hits: [hit(7)], scanned: 10, truncated: false });
    await second;
    calls[0]!.resolve({ query: "אלה", hits: [hit(1)], scanned: 10, truncated: false }); // too late
    expect(find.result.value?.query).toBe("אלהים");
    expect(find.status.value).toBe("done");
  });

  it("a query of one letter, or only spaces and nikud, does not search and clears the hits", async () => {
    const { find, calls } = make();
    await find.search("s1:1", "  ָא ");
    expect(calls).toHaveLength(0);
    expect(find.status.value).toBe("idle");
    expect(find.result.value).toBeNull();
  });

  it("no hits: nothing to move to", async () => {
    const { find, calls, revealed } = make();
    const p = find.search("s1:1", "משה");
    calls[0]!.resolve({ query: "משה", hits: [], scanned: 10, truncated: false });
    await p;
    expect(find.pos.value).toBe(-1);
    find.step(1);
    expect(revealed).toEqual([]);
  });

  it("an error from the worker is shown, not thrown", async () => {
    const { find, calls } = make();
    const p = find.search("s1:1", "אלהים");
    calls[0]!.reject(new Error("המקור של הספר הזה כבר נסגר."));
    await p;
    expect(find.status.value).toBe("error");
    expect(find.error.value).toContain("נסגר");
  });

  it("progress while searching; close cancels and forgets everything", async () => {
    const { find, calls, cancelled } = make();
    const p = find.search("s1:1", "אלהים");
    find.open.value = true;
    calls[0]!.opts!.onProgress!(500, 2000);
    expect(find.progress.value).toEqual({ done: 500, total: 2000 });
    find.close();
    await p;
    expect(cancelled).toEqual(["אלהים"]);
    expect(find.open.value).toBe(false);
    expect(find.query.value).toBe("");
    expect(find.status.value).toBe("idle");
    expect(find.progress.value).toBeNull();
  });
});
