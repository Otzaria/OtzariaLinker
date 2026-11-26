import type { AutosaveWindow } from "../state/store";

/*
 * Which window of the tool this is, for the autosave (#41 B17; AppStore.startAutosave).
 *
 * - The id lives in sessionStorage: a refresh of the tab keeps it (and is offered its own work back),
 *   a new tab gets a new one.
 * - Each window holds a Web Lock named after its id for as long as it is open. The browser releases it
 *   when the tab closes or crashes, so `live()` tells the autosave which windows' keys are still owned.
 * - A duplicated tab copies sessionStorage, id and all: its lock is already held by the original, so it
 *   takes a new id instead of sharing (and overwriting) the original's key.
 * - Without Web Locks (an old browser) `live()` answers null: the autosave then leaves every other
 *   window's key alone rather than guess which are gone.
 */
const ID_KEY = "otzaria-linker:window";
const LOCK = "otzaria-linker:window:";
const QUEUE_LOCK = "otzaria-linker:autosave-queue";

interface LockManagerLike {
  request(name: string, options: { ifAvailable?: boolean }, cb: (lock: unknown) => unknown): Promise<unknown>;
  request(name: string, cb: (lock: unknown) => unknown): Promise<unknown>;
  query(): Promise<{ held?: { name?: string }[] }>;
}

const newId = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function session(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export async function autosaveWindow(locks: LockManagerLike | undefined = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks): Promise<AutosaveWindow> {
  const store = session();
  let id = (() => {
    try {
      return store?.getItem(ID_KEY) ?? null;
    } catch {
      return null;
    }
  })();
  /** holds this window's lock until the page goes; false when another window already holds it */
  const hold = (candidate: string) =>
    new Promise<boolean>((granted) => {
      void locks!
        .request(LOCK + candidate, { ifAvailable: true }, (lock) => {
          granted(!!lock);
          return lock ? new Promise(() => {}) : undefined;
        })
        .catch(() => granted(false));
    });
  if (locks) {
    if (!id || !(await hold(id))) {
      // a fresh id; if the browser does not grant its lock either, a few more — a window without its lock looks closed to the
      // others, which would move its work away while it is open (V7 PR1 review, finding 5)
      for (let tries = 0; tries < 3; tries++) if (await hold((id = newId()))) break;
    }
  }
  id ??= newId();
  try {
    store?.setItem(ID_KEY, id);
  } catch {
    /* no sessionStorage: a refresh gets a new id, and its earlier work is offered as a closed window's */
  }
  if (!locks) return { id, live: async () => null };
  return {
    id,
    live: async () => {
      const q = await locks.query();
      return new Set((q.held ?? []).map((l) => l.name ?? "").filter((n) => n.startsWith(LOCK)).map((n) => n.slice(LOCK.length)));
    },
    // a lock request the browser refuses does not stop the work: it runs unlocked rather than not at all (finding 5)
    exclusive: <T>(fn: () => Promise<T>): Promise<T> => {
      let ran = false;
      return (locks.request(QUEUE_LOCK, () => ((ran = true), fn())) as Promise<T>).catch((err: unknown) => {
        if (ran) throw err;
        return fn();
      });
    },
  };
}
