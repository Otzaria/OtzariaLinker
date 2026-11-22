import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../../src/core/links/model";
import { headingLevel } from "../../../../src/core/text/html";
import { runDiburHamatchilEngine } from "../../../../src/linking/automatic/dibur-hamatchil";
import type { EngineBook, Suggestion } from "../../../../src/linking/automatic/types";

/*
 * Issue #11 (data only): where the matched words are, on both lines, so that a screen can highlight them.
 * `matched.source` / `matched.target` are raw offsets into the line of that side of the suggestion (the engine's
 * `text`, the line as the generator counts anchors), the same convention as `anchor`. Synthetic lines (neutral words).
 */
const ref = (key: string, title: string): BookRef => ({ key, title, origin: "otzaria" });
const book = (r: BookRef, texts: readonly string[]): EngineBook => ({ book: r, lines: texts.map((text, index) => ({ index, text, heading: headingLevel(text) })) });
const BASE = ref("base", "ספר בסיס");
const COMM = ref("comm", "פירוש על ספר בסיס");
const BASE_LINES = ["<h1>ספר בסיס</h1>", "<h2>פרק א</h2>", "אלפא בטא גמא דלתא הא וו זין חית טית יוד", "כף למד מם נון סמך עין פא צדי קוף ריש", "שין תיו אלף בית גימל דלת הי ואו זיי חית"];
const COMM_LINES = ["<h1>פירוש על ספר בסיס</h1>", "<h2>פרק א</h2>", "<b>אלפא בטא גמא</b> – פירוש על הדברים האלה כאן", "<b>כף למד מם נון</b> – ועוד פירוש לדברים"];
const slice = (line: string, s: { rawStart: number; rawEnd: number }) => line.slice(s.rawStart, s.rawEnd);
const sideText = (s: Suggestion, side: "source" | "target") => {
  const b = side === "source" ? s.source : s.target;
  const lines = b.book.key === "base" ? BASE_LINES : COMM_LINES;
  return slice(lines[b.line]!, s.matched![side]!);
};
const run = (anchors: "auto" | "off") => [...runDiburHamatchilEngine(book(COMM, COMM_LINES), book(BASE, BASE_LINES), { anchors }).suggestions].sort((a, b) => (a.source.book.key === "comm" ? a.source.line : a.target.line) - (b.source.book.key === "comm" ? b.source.line : b.target.line));

describe("Suggestion.matched (dibur-hamatchil)", () => {
  it("with a word anchor (the base is the source): the ד\"ה words on the commentary line and on the base line", () => {
    const [first, second] = run("auto");
    // source = the base line, target = the commentary line
    expect(first!.source.book.key).toBe("base");
    expect(sideText(first!, "source")).toBe("אלפא בטא גמא");
    expect(sideText(first!, "target")).toBe("אלפא בטא גמא");
    expect(sideText(second!, "source")).toBe("כף למד מם נון");
    expect(sideText(second!, "target")).toBe("כף למד מם נון");
    // the base span is the anchor's: one fact, two names
    expect(first!.matched!.source).toEqual({ rawStart: first!.anchor!.rawStart, rawEnd: first!.anchor!.rawEnd });
  });

  it("without an anchor (the commentary is the source): the same words, on the other sides", () => {
    const [first] = run("off");
    expect(first!.anchor).toBeUndefined();
    expect(first!.source.book.key).toBe("comm");
    expect(sideText(first!, "source")).toBe("אלפא בטא גמא");
    expect(sideText(first!, "target")).toBe("אלפא בטא גמא");
  });

  it("is data only: the suggestion id does not depend on it", () => {
    expect(run("auto").map((s) => s.id)).toEqual(run("auto").map((s) => s.id));
    expect(run("auto")[0]!.id).not.toContain("rawStart");
  });
});
