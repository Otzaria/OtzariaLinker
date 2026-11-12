import { batch, effect, type ReadonlySignal, type Signal } from "@preact/signals";
import type { NoticeKind, Screen, SideTab } from "./store";
import { isGuidedStep } from "./guided-flow";

/*
 * Hash routing (works under file://: only the fragment changes, the document never reloads).
 *
 * The screens' signals in AppStore (screen, sideTab, suggestMode, dialog, helpSection, startTask) stay
 * the single source of truth; this module mirrors them into the address and back:
 *   - a user action that changes them pushes a history entry (a tab, a screen, a dialog);
 *   - closing a dialog goes BACK when the entry under it is the screen it was opened from (so Esc, the
 *     close button and the browser's Back all leave the same history), and otherwise replaces it, so
 *     no dead dialog entry is left behind;
 *   - Back/Forward (hashchange) apply the route to the signals;
 *   - a deep link or a reload to a screen that needs open sources falls back to home with a note:
 *     the browser cannot reopen files by itself.
 * No DOM here: the address bar is behind LocationPort (the app layer passes window.location).
 * The routes are documented in docs/USER_GUIDE.md ("כתובות") and docs/ARCHITECTURE.md.
 */

export type DialogId = "export" | "help" | "relink" | "alt-toc" | "start";
export type SuggestMode = "pair" | "batch" | "maxlink";

export interface Route {
  screen: Screen;
  tab?: SideTab;
  /** the suggestions tab in max-link mode */
  maxlink?: boolean;
  /** a dialog over the screen; the transient ones (map-db, import-records) come from pending files */
  dialog?: DialogId | "map-db" | "import-records";
  /** the help's section (heading id), the guided task's id, or the guided flow's step */
  section?: string;
}

const TABS: readonly SideTab[] = ["builder", "links", "suggestions", "qa", "books"];
const DIALOGS: readonly string[] = ["export", "help", "relink", "alt-toc", "start", "map-db", "import-records"];
/** dialogs that only make sense over open sources or links */
const NEEDS_WORK = new Set(["export", "relink", "alt-toc", "map-db", "import-records"]);

/** "#/workspace/links" → a route; null when the hash is not one of ours. "" and "#" are home. */
export function parseHash(hash: string): Route | null {
  const h = hash.replace(/^#/, "");
  if (h === "" || h === "/") return { screen: "home" };
  if (!h.startsWith("/")) return null;
  const parts = h.slice(1).split("/").map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const [head, a, ...rest] = parts;
  if (rest.length) return null;
  if (head === "workspace") {
    if (a === undefined || a === "") return { screen: "workspace", tab: "builder" };
    return (TABS as readonly string[]).includes(a) ? { screen: "workspace", tab: a as SideTab } : null;
  }
  if (head === "maxlink" && a === undefined) return { screen: "workspace", tab: "suggestions", maxlink: true };
  // the guided flow (state/guided-flow.ts): "#/guided" is its first step
  if (head === "guided") {
    if (a === undefined || a === "") return { screen: "guided", section: "files" };
    return isGuidedStep(a) ? { screen: "guided", section: a } : null;
  }
  if (head && DIALOGS.includes(head)) {
    if (a !== undefined && head !== "help" && head !== "start") return null;
    if (head === "start" && !a) return null;
    return { screen: "home", dialog: head as Route["dialog"] & string, ...(a && { section: a }) };
  }
  return null;
}

/** The canonical hash of a route. A dialog's hash names only the dialog: the screen under it is in the entry before. */
export function formatRoute(r: Route): string {
  if (r.dialog) return `#/${r.dialog}${r.section && (r.dialog === "help" || r.dialog === "start") ? `/${encodeURIComponent(r.section)}` : ""}`;
  if (r.screen === "home") return "#/";
  if (r.screen === "guided") return `#/guided/${r.section ?? "files"}`;
  if (r.maxlink && r.tab === "suggestions") return "#/maxlink";
  return `#/workspace/${r.tab ?? "builder"}`;
}

/** The same route always reads the same (percent-encoding differs between browsers). */
const normalHash = (h: string): string => {
  const r = parseHash(h);
  return r ? formatRoute(r) : h;
};

/** The address bar, as the router needs it (the app layer implements it on window.location). */
export interface LocationPort {
  /** the current hash ("" reads as "#/") */
  read(): string;
  push(hash: string): void;
  replace(hash: string): void;
  back(): void;
  /** called on every hashchange; returns the unsubscribe */
  listen(onChange: () => void): () => void;
}

/** What the router reads and writes in the store. */
export interface RouterHost {
  readonly screen: Signal<Screen>;
  readonly sideTab: Signal<SideTab>;
  readonly suggestMode: Signal<SuggestMode>;
  readonly dialog: Signal<DialogId | null>;
  readonly helpSection: Signal<string | undefined>;
  readonly startTask: Signal<string | null>;
  /** the guided flow's step (shown when screen is "guided") */
  readonly guidedStep: ReadonlySignal<string>;
  /** the address asks for the guided flow at a step: the flow shows the furthest it can (state/guided-flow.ts resolveStep) */
  showGuided(step?: string): void;
  /** files waiting in the mapping wizard / the records dialog: shown as transient dialogs */
  readonly pendingDialog: ReadonlySignal<"map-db" | "import-records" | null>;
  /** dismisses the pending file the transient dialog shows (Back over the mapping wizard) */
  dismissPending(which: "map-db" | "import-records"): void;
  /** open sources or links: the workspace and its dialogs have something to show */
  hasWork(): boolean;
  notify(kind: NoticeKind, text: string): void;
}

export class Router {
  /** a mirror of this session's history entries (the browser does not tell Back from Forward) */
  private stack: string[] = [];
  private at = 0;
  /** the hash the address shows, as far as the router knows (its own pushes included) */
  private shown = "#/";
  private applying = false;
  /** a state change is waiting for the end of the current task (see schedule) */
  private scheduled = false;
  /** history.back() was asked for and its hashchange has not arrived yet */
  private backPending = false;
  private backTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly stops: (() => void)[] = [];

  constructor(
    private readonly host: RouterHost,
    private readonly port: LocationPort,
  ) {}

  /** The route the screens show right now. */
  current(): Route {
    const h = this.host;
    const pending = h.pendingDialog.value;
    const dialog = pending ?? h.dialog.value;
    if (dialog) {
      const section = dialog === "help" ? h.helpSection.value : dialog === "start" ? (h.startTask.value ?? undefined) : undefined;
      return { screen: h.screen.value, dialog, ...(section && { section }) };
    }
    if (h.screen.value === "home") return { screen: "home" };
    if (h.screen.value === "guided") return { screen: "guided", section: h.guidedStep.value };
    const tab = h.sideTab.value;
    return { screen: "workspace", tab, ...(tab === "suggestions" && h.suggestMode.value === "maxlink" && { maxlink: true }) };
  }

  /** Reads the address once (a deep link or a reload), then keeps the two in step. */
  start(): void {
    const initial = normalHash(this.port.read());
    this.stack = [initial];
    this.at = 0;
    this.shown = initial;
    this.applyHash(initial, true);
    this.stops.push(this.port.listen(() => this.onHashChange()));
    this.stops.push(
      effect(() => {
        formatRoute(this.current()); // subscribes to every signal the route reads
        this.schedule();
      }),
    );
  }

  /*
   * One user action often changes several signals in a row, across a dialog closing (the mapping
   * wizard closes, then the workspace opens): the address follows the state once the current task is
   * done, so it sees where the action ended and not a step on the way. And history.back() is
   * asynchronous: a push before it lands would be undone by it, so nothing moves until it has.
   */
  private schedule(): void {
    if (this.applying || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.backPending) this.onState(formatRoute(this.current()));
    });
  }

  private settleBack(): void {
    this.backPending = false;
    clearTimeout(this.backTimer);
    this.schedule();
  }

  stop(): void {
    for (const s of this.stops.splice(0)) s();
  }

  /** Signals changed: move the address along. */
  private onState(next: string): void {
    if (this.applying || next === this.shown) return;
    const prev = parseHash(this.shown);
    const nextRoute = parseHash(next);
    if (prev?.dialog) {
      if (!nextRoute?.dialog && this.stack[this.at - 1] === next) {
        // closing a dialog: back to the entry it was opened from
        this.at--;
        this.shown = next;
        this.backPending = true;
        // a browser that never reports it must not freeze the address
        this.backTimer = setTimeout(() => this.backPending && this.settleBack(), 1000);
        this.port.back();
        return;
      }
      // a dialog that leads elsewhere (the guided task to the workspace, export to alt-toc), or the
      // help moving between sections: the dialog's entry becomes the new place
      this.stack[this.at] = next;
      this.shown = next;
      this.port.replace(next);
      return;
    }
    this.stack = [...this.stack.slice(0, this.at + 1), next];
    this.at = this.stack.length - 1;
    this.shown = next;
    this.port.push(next);
  }

  /** Back, Forward, or a hash typed into the address bar. */
  private onHashChange(): void {
    const h = normalHash(this.port.read());
    if (this.backPending) {
      // our own back() landed; wherever it landed, the signals are the truth and the address follows them
      this.shown = h;
      return this.settleBack();
    }
    if (h === this.shown) return; // the echo of our own push/replace
    if (this.stack[this.at - 1] === h) this.at--;
    else if (this.stack[this.at + 1] === h) this.at++;
    else {
      this.stack = [...this.stack.slice(0, this.at + 1), h];
      this.at = this.stack.length - 1;
    }
    this.shown = h;
    this.applyHash(h, false);
  }

  /** Puts the signals where the hash says; falls back (and corrects the address) when it cannot. */
  private applyHash(hash: string, initial: boolean): void {
    const h = this.host;
    const r = parseHash(hash);
    this.applying = true;
    try {
      batch(() => {
        if (!r) return;
        // the guided flow needs nothing open: it starts at the step it can show (its first, after a reload)
        if (r.screen === "guided" && !r.dialog) {
          const pendingNow = h.pendingDialog.value;
          if (pendingNow) h.dismissPending(pendingNow);
          h.dialog.value = null;
          h.showGuided(r.section);
          return;
        }
        const needsWork = r.screen === "workspace" || (r.dialog !== undefined && NEEDS_WORK.has(r.dialog));
        if (needsWork && !h.hasWork()) {
          h.dialog.value = null;
          h.screen.value = "home";
          h.notify(
            "info",
            initial
              ? "הכתובת שנפתחה מובילה למסך שצריך ספרים פתוחים, והדפדפן לא פותח קבצים מעצמו. התחלנו במסך הפתיחה: בחרו משימה או פתחו את הקבצים שוב."
              : "המסך הזה צריך ספרים פתוחים. פתחו קבצים, תיקייה או מסד, ואז תוכלו לחזור אליו.",
          );
          return;
        }
        // a transient dialog (mapping wizard, records) left by Back: its file is skipped, as with "לא לפתוח"
        const pending = h.pendingDialog.value;
        if (pending && r.dialog !== pending) h.dismissPending(pending);
        if (r.dialog === "map-db" || r.dialog === "import-records") {
          // nothing pending any more (it was handled): stay where the signals are
          return;
        }
        if (r.dialog) {
          if (r.dialog === "help") h.helpSection.value = r.section;
          if (r.dialog === "start") h.startTask.value = r.section ?? null;
          h.dialog.value = r.dialog;
          return;
        }
        h.dialog.value = null;
        h.screen.value = r.screen;
        if (r.screen === "workspace") {
          h.sideTab.value = r.tab ?? "builder";
          if (r.maxlink) h.suggestMode.value = "maxlink";
          else if (r.tab === "suggestions" && h.suggestMode.value === "maxlink") h.suggestMode.value = "pair";
        }
      });
    } finally {
      this.applying = false;
    }
    // the address is corrected to what is shown (unknown hash, fallback, a handled transient dialog)
    const canonical = formatRoute(this.current());
    if (canonical !== hash) {
      this.stack[this.at] = canonical;
      this.shown = canonical;
      this.port.replace(canonical);
    }
  }
}
