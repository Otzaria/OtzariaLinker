import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceLine } from "../../../src/core/books";
import { LineStore, RETRY_MS } from "../../../src/state/lines";
import type { BooksService } from "../../../src/state/services";

/* Review C8: the line cache must not keep a stale answer, and must not keep an error forever. */

const lineAt = (index: number): SourceLine => ({ index, text: `שורה ${index}`, anchorText: `שורה ${index}`, heRef: null, heading: null, existsInDb: true });

/** A service whose every lines() call waits until the test settles it. */
function controlled() {
  const calls: { from: number; to: number; resolve: (v: SourceLine[]) => void; reject: (e: Error) => void }[] = [];
  const service = {
    lines: (_key: string, from: number, to: number) => new Promise<SourceLine[]>((resolve, reject) => calls.push({ from, to, resolve, reject })),
    existingLinks: async () => [],
  } as unknown as BooksService;
  return { service, calls };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.restoreAllMocks());

describe("LineStore (review C8)", () => {
  it("a chunk still loading when everything is forgotten does not come back — not even as an error", async () => {
    const { service, calls } = controlled();
    const store = new LineStore(service);
    expect(store.line("s1:5", 3)).toBeUndefined(); // starts the load; the worker is busy
    // the worker is replaced: its pending calls fail (RpcClient.failAll), the sources are forgotten
    store.forgetAll();
    calls[0]!.reject(new Error("הפעולה שבוטלה לא נעצרה, ולכן מנוע הקריאה הופעל מחדש."));
    await flush();
    expect(store.errorAt("s1:5", 3)).toBeNull();
    // asked again (a new source with the same key would be read afresh)
    store.line("s1:5", 3);
    expect(calls).toHaveLength(2);
    calls[1]!.resolve([lineAt(3)]);
    await flush();
    expect(store.line("s1:5", 3)?.text).toBe("שורה 3");
  });

  it("a late answer for a forgotten chunk is dropped, also when it succeeds", async () => {
    const { service, calls } = controlled();
    const store = new LineStore(service);
    store.line("s1:5", 3);
    store.forgetSource("s1");
    calls[0]!.resolve([lineAt(3)]);
    await flush();
    expect(store.peek("s1:5", 3)).toBeUndefined();
  });

  it("a chunk that failed is read again when a view asks for it after RETRY_MS, not before", async () => {
    const { service, calls } = controlled();
    const store = new LineStore(service);
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    store.line("s1:5", 3);
    calls[0]!.reject(new Error("קריאת הקובץ נכשלה"));
    await flush();
    expect(store.errorAt("s1:5", 3)).toBe("קריאת הקובץ נכשלה");
    store.line("s1:5", 3);
    expect(calls).toHaveLength(1); // a view re-rendering on the error does not hammer the worker
    now += RETRY_MS;
    store.line("s1:5", 3);
    expect(calls).toHaveLength(2);
    calls[1]!.resolve([lineAt(3)]);
    await flush();
    expect(store.errorAt("s1:5", 3)).toBeNull();
    expect(store.line("s1:5", 3)?.text).toBe("שורה 3");
  });
});
