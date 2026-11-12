import { computed, signal } from "@preact/signals";
import { describe, expect, it } from "vitest";
import { formatRoute, parseHash, Router, type DialogId, type LocationPort, type RouterHost, type SuggestMode } from "../../../src/state/router";
import type { SideTab } from "../../../src/state/store";

/** A browser history of hash entries: push/replace/back change it and fire hashchange later, as browsers do. */
function fakeHistory(initial = "#/") {
  const entries = [initial];
  let at = 0;
  let queued = 0;
  let listener = () => {};
  const port: LocationPort = {
    read: () => entries[at]!,
    push: (h) => (entries.splice(at + 1), entries.push(h), (at = entries.length - 1), queued++),
    replace: (h) => ((entries[at] = h), queued++),
    back: () => (at > 0 && at--, queued++),
    listen: (cb) => ((listener = cb), () => (listener = () => {})),
  };
  return {
    port,
    entries: () => entries.slice(),
    at: () => at,
    /** lets the router see the state (it waits for the end of the task), then delivers the pending hashchange events */
    flush: async () => {
      for (let i = 0; i < 4; i++) {
        await Promise.resolve();
        while (queued > 0) (queued--, listener());
      }
    },
    /** the browser's Back / Forward buttons */
    userBack: () => (at--, listener()),
    userForward: () => (at++, listener()),
    type: (h: string) => (entries.splice(at + 1), entries.push(h), (at = entries.length - 1), listener()),
  };
}

function fakeHost(work = true) {
  const pendingDbs = signal<string[]>([]);
  const notes: string[] = [];
  const guidedStep = signal("files");
  const guidedReady = ["files", "books", "plan"];
  const host: RouterHost = {
    screen: signal<"home" | "workspace" | "guided">("home"),
    sideTab: signal<SideTab>("builder"),
    suggestMode: signal<SuggestMode>("pair"),
    dialog: signal<DialogId | null>(null),
    helpSection: signal<string | undefined>(undefined),
    startTask: signal<string | null>(null),
    guidedStep,
    showGuided: (step) => {
      host.screen.value = "guided";
      // as the flow does: a step it cannot show yet falls back to the first
      guidedStep.value = step && guidedReady.includes(step) ? step : "files";
    },
    pendingDialog: computed(() => (pendingDbs.value.length ? "map-db" : null)),
    dismissPending: () => (pendingDbs.value = pendingDbs.value.slice(1)),
    hasWork: () => work,
    notify: (_k, t) => void notes.push(t),
  };
  return { host, pendingDbs, notes, guidedStep };
}

describe("routes", () => {
  it("every route reads back the same", async () => {
    for (const h of ["#/", "#/workspace/builder", "#/workspace/links", "#/workspace/suggestions", "#/workspace/qa", "#/workspace/books", "#/maxlink", "#/export", "#/relink", "#/alt-toc", "#/help", "#/help/3-%D7%A4%D7%AA%D7%99%D7%97%D7%94", "#/start/folder-otzaria", "#/map-db", "#/import-records"])
      expect(formatRoute(parseHash(h)!)).toBe(h);
  });
  it("short and unknown forms", async () => {
    expect(parseHash("")).toEqual({ screen: "home" });
    expect(parseHash("#")).toEqual({ screen: "home" });
    expect(formatRoute(parseHash("#/workspace")!)).toBe("#/workspace/builder");
    expect(parseHash("#/help/3-פתיחה")?.section).toBe("3-פתיחה");
    for (const bad of ["#/nothing", "#/workspace/nope", "#/export/x", "#/start", "#section-id", "#/workspace/links/extra"]) expect(parseHash(bad)).toBeNull();
  });
});

describe("Router", () => {
  it("a tab or a screen pushes an entry; Back and Forward walk them", async () => {
    const b = fakeHistory();
    const { host } = fakeHost();
    new Router(host, b.port).start();
    // separate clicks: one entry each (changes inside one task make one entry)
    host.screen.value = "workspace";
    await b.flush();
    host.sideTab.value = "links";
    await b.flush();
    host.sideTab.value = "suggestions";
    await b.flush();
    expect(b.entries()).toEqual(["#/", "#/workspace/builder", "#/workspace/links", "#/workspace/suggestions"]);
    b.userBack();
    expect(host.sideTab.value).toBe("links");
    b.userBack();
    b.userBack();
    expect(host.screen.value).toBe("home");
    b.userForward();
    expect([host.screen.value, host.sideTab.value]).toEqual(["workspace", "builder"]);
  });

  it("closing a dialog goes back to the entry it was opened from; Back closes it too", async () => {
    const b = fakeHistory();
    const { host } = fakeHost();
    new Router(host, b.port).start();
    host.screen.value = "workspace";
    await b.flush();
    host.sideTab.value = "links";
    await b.flush();
    host.dialog.value = "export";
    await b.flush();
    expect(b.port.read()).toBe("#/export");
    host.dialog.value = null; // Esc or the close button
    await b.flush();
    expect(b.entries().slice(0, b.at() + 1)).toEqual(["#/", "#/workspace/builder", "#/workspace/links"]);
    // Forward reopens it; the browser's Back closes it again
    b.userForward();
    expect(host.dialog.value).toBe("export");
    b.userBack();
    expect(host.dialog.value).toBeNull();
    expect(host.sideTab.value).toBe("links");
  });

  it("a dialog that leads elsewhere leaves no dead entry", async () => {
    const b = fakeHistory();
    const { host } = fakeHost();
    new Router(host, b.port).start();
    host.startTask.value = "folder-otzaria";
    host.dialog.value = "start";
    await b.flush();
    expect(b.port.read()).toBe("#/start/folder-otzaria");
    host.screen.value = "workspace"; // the files opened under the sheet
    host.sideTab.value = "suggestions";
    host.suggestMode.value = "maxlink";
    host.dialog.value = null; // "start"
    await b.flush();
    expect(b.entries()).toEqual(["#/", "#/maxlink"]);
    b.userBack();
    expect(host.screen.value).toBe("home");
  });

  it("several changes in one task make one entry: the wizard closes and the workspace opens", async () => {
    const b = fakeHistory();
    const { host, pendingDbs } = fakeHost();
    new Router(host, b.port).start();
    pendingDbs.value = ["t1"];
    await b.flush();
    pendingDbs.value = []; // the mapping was confirmed…
    host.screen.value = "workspace"; // …and its books opened, in the same task
    await b.flush();
    expect(b.entries()).toEqual(["#/", "#/workspace/builder"]);
    expect(host.screen.value).toBe("workspace");
  });

  it("help sections replace each other in the address", async () => {
    const b = fakeHistory();
    const { host } = fakeHost();
    new Router(host, b.port).start();
    host.dialog.value = "help";
    host.helpSection.value = "8-הצעות";
    host.helpSection.value = "9-בדיקה";
    await b.flush();
    expect(b.entries()).toEqual(["#/", `#/help/${encodeURIComponent("9-בדיקה")}`]);
    host.dialog.value = null;
    await b.flush();
    expect(b.port.read()).toBe("#/");
  });

  it("a deep link without open sources falls back home, with a note", async () => {
    const b = fakeHistory("#/workspace/links");
    const { host, notes } = fakeHost(false);
    new Router(host, b.port).start();
    expect(host.screen.value).toBe("home");
    expect(b.port.read()).toBe("#/");
    expect(notes).toHaveLength(1);
    // help and a guided task work without sources
    const b2 = fakeHistory("#/help/13-קיצורי-מקלדת");
    const h2 = fakeHost(false).host;
    new Router(h2, b2.port).start();
    expect([h2.dialog.value, h2.helpSection.value]).toEqual(["help", "13-קיצורי-מקלדת"]);
  });

  it("an unknown hash is corrected to what is shown", async () => {
    const b = fakeHistory();
    const { host } = fakeHost();
    new Router(host, b.port).start();
    b.type("#/no-such-screen");
    expect(b.port.read()).toBe("#/");
    b.type("#/maxlink");
    expect([host.screen.value, host.sideTab.value, host.suggestMode.value]).toEqual(["workspace", "suggestions", "maxlink"]);
    b.type("#/workspace/suggestions");
    expect(host.suggestMode.value).toBe("pair");
  });

  it("Back over the mapping wizard skips its database", async () => {
    const b = fakeHistory();
    const { host, pendingDbs } = fakeHost();
    new Router(host, b.port).start();
    pendingDbs.value = ["t1"];
    await b.flush();
    expect(b.port.read()).toBe("#/map-db");
    b.userBack();
    expect(pendingDbs.value).toEqual([]);
    expect(b.port.read()).toBe("#/");
  });
});
