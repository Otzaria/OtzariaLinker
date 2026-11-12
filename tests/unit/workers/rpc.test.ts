import { describe, expect, it } from "vitest";
import { RpcClient, serve, type FromWorker, type Port, type ToWorker } from "../../../src/workers/rpc";

type Api = {
  [op: string]: (...args: never[]) => unknown;
  add(a: number, b: number): number;
  slow(): string;
  fail(): never;
};

/** An in-process pair of ports with asynchronous delivery, like postMessage. */
function pair() {
  let toServer: (m: ToWorker) => void = () => {};
  const client: Port = { onmessage: null, postMessage: (m) => queueMicrotask(() => toServer(m)) };
  const post = (m: FromWorker) => queueMicrotask(() => client.onmessage?.({ data: m } as MessageEvent<FromWorker>));
  toServer = serve<Api>(
    {
      add: (_c, a, b) => a + b,
      async slow(ctx) {
        for (let i = 0; i < 50; i++) {
          ctx.progress(i, 50);
          if (ctx.signal.aborted) throw new DOMException("x", "AbortError");
          await new Promise((r) => setTimeout(r, 2));
        }
        return "done";
      },
      fail() {
        throw Object.assign(new Error("בעיה"), { code: "db/wal" });
      },
    },
    post,
  );
  return new RpcClient<Api>(client);
}

describe("rpc", () => {
  it("calls and returns", async () => {
    expect(await pair().call("add", [2, 3])).toBe(5);
  });
  it("errors keep their code and Hebrew message across the boundary", async () => {
    await expect(pair().call("fail", [])).rejects.toMatchObject({ code: "db/wal", message: "בעיה" });
  });
  it("cancellation reaches the handler and rejects with code 'cancelled'", async () => {
    const ac = new AbortController();
    const seen: number[] = [];
    const p = pair().call("slow", [], { signal: ac.signal, onProgress: (d) => seen.push(d) });
    setTimeout(() => ac.abort(), 15);
    await expect(p).rejects.toMatchObject({ code: "cancelled" });
    expect(seen[0]).toBe(0);
  });
  it("unknown operations fail clearly", async () => {
    await expect(pair().call("nope" as "add", [1, 1])).rejects.toMatchObject({ code: "rpc/unknown-op" });
  });
});
