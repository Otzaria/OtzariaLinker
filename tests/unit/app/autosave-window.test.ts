import { describe, expect, it } from "vitest";
import { autosaveWindow } from "../../../src/app/autosave-window";

/*
 * V7 PR1 review, finding 5: what the autosave's window identity does when Web Locks does not cooperate. A window without its lock
 * looks closed to the others (they would move its work away while it is open), and a refused queue lock stopped the work.
 */
function fakeLocks(opts: { deny?: number; refuseQueue?: boolean }) {
  let denied = 0;
  const held = new Set<string>();
  return {
    held,
    request(name: string, a: unknown, b?: unknown): Promise<unknown> {
      const cb = (typeof a === "function" ? a : b) as (lock: unknown) => unknown;
      const ifAvailable = typeof a === "object" && (a as { ifAvailable?: boolean }).ifAvailable;
      if (name.endsWith("autosave-queue") && opts.refuseQueue) return Promise.reject(new Error("SecurityError"));
      if (ifAvailable && denied < (opts.deny ?? 0)) {
        denied++;
        return Promise.resolve(cb(null));
      }
      held.add(name);
      return Promise.resolve(cb({ name }));
    },
    query: async () => ({ held: [...held].map((name) => ({ name })) }),
  };
}

describe("autosaveWindow when Web Locks does not cooperate (finding 5)", () => {
  it("a lock that is not granted is tried again with a fresh id: the window ends up holding one", async () => {
    const locks = fakeLocks({ deny: 2 });
    const w = await autosaveWindow(locks as never);
    expect((await w.live())!.has(w.id)).toBe(true);
  });
  it("a refused queue lock still runs the work", async () => {
    const w = await autosaveWindow(fakeLocks({ refuseQueue: true }) as never);
    expect(await w.exclusive!(async () => 42)).toBe(42);
  });
});
