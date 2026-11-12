import { describe, expect, it } from "vitest";
import type { BookOrigin } from "../../../../src/core/links/model";
import { headingLevel } from "../../../../src/core/text/html";
import { runPatternEngine, type PatternOptions } from "../../../../src/linking/automatic/pattern";
import type { EngineBook, EngineResult } from "../../../../src/linking/automatic/types";

/*
 * Structure references mapped into the target's NESTED heading tree (target "tree"). The target
 * shapes follow the library's real books: שולחן ערוך / מגן אברהם (<h2>סימן</h2> + "(א)" lines),
 * משנה (<h2>פרק</h2> + "(א)"), בבלי (<h2>דף ב.</h2> / <h2>דף ב:</h2>), and a commentary with
 * "סימן › סעיף" headings like מחצית השקל.
 */
const book = (title: string, key: string, texts: readonly string[], origin: BookOrigin = "personal"): EngineBook => ({
  book: { key, title, origin },
  lines: texts.map((text, index) => ({ index, text, heading: headingLevel(text) })),
});
const run = (src: readonly string[], tgt: readonly string[], opts: PatternOptions, title = "יעד") => runPatternEngine(book("מקור", "s", src), book(title, "t", tgt), opts);
const pairs = (res: EngineResult) => res.suggestions.map((s) => `${s.source.line}>${s.target.line}${s.target.end !== undefined ? `-${s.target.end}` : ""}`);
const conf = (res: EngineResult) => res.suggestions.map((s) => s.confidence);
const codes = (xs: readonly { code: string }[]) => xs.map((x) => x.code);
const unmatchedCodes = (res: EngineResult) => res.unmatched.flatMap((u) => codes(u.reasons));

describe("nested references into a nested tree", () => {
  const tgt = ["<h1>יעד</h1>", "<h2>סימן ה</h2>", "<h3>סעיף ג</h3>", "<h4>סעיף קטן א</h4>", "טקסט א", "<h4>סעיף קטן ב</h4>", "טקסט ב", "<h4>סעיף קטן ג</h4>", "טקסט ג"];

  it('"סימן ה סעיף ג ס"ק ב" → the line under h2 סימן ה › h3 סעיף ג › h4 ס"ק ב', () => {
    const res = run(['עיין סימן ה סעיף ג ס"ק ב'], tgt, { preset: "siman-seif-sk" });
    expect(pairs(res)).toEqual(["0>6"]);
    expect(conf(res)).toEqual(["certain"]);
    expect(res.suggestions[0]!.reasons.map((r) => r.text).join(" ")).toContain("סימן ה › סעיף ג › סעיף קטן ב");
  });

  it('a range "ס"ק א-ג" covers the first line of א through the last line of ג', () => {
    expect(pairs(run(['סימן ה ס"ק א-ג'], tgt, { preset: "siman-seif-sk" }))).toEqual(["0>4-8"]);
  });

  it("the whole section as a range on request", () => {
    expect(pairs(run(["סימן ה סעיף ג"], tgt, { preset: "siman-seif", sectionRanges: true }))).toEqual(["0>4-8"]);
  });
});

describe("a Shulchan Aruch-shaped target: <h2>סימן</h2> and numbered lines", () => {
  const sa = ["<h1>שולחן ערוך</h1>", "<h2>סימן א</h2>", "<b>דין השכמת הבוקר</b>", "(א) יתגבר", "(ב) המשכים", "(ג) טוב", "<h2>סימן ב</h2>", "(א) לא ילבש", "(ב) אל יאמר", "(ג) ידקדק"];

  it('"סי\' ב ס"ג": the numbered line (ג) under סימן ב, certain', () => {
    const res = run(["כמ\"ש בסי' ב ס\"ג"], sa, { preset: "siman-seif" });
    expect(pairs(res)).toEqual(["0>9"]);
    expect(conf(res)).toEqual(["certain"]);
  });

  it("a level the target lacks makes the match partial: the parent, never certain", () => {
    const res = run(['סימן ב סעיף ג ס"ק ז'], sa, { preset: "siman-seif-sk" });
    expect(pairs(res)).toEqual(["0>9"]);
    expect(res.suggestions[0]!.confidence).not.toBe("certain");
    expect(codes(res.suggestions[0]!.warnings)).toContain("pattern/partial");
  });

  it("a reference to a סימן the target does not have is reported", () => {
    expect(unmatchedCodes(run(["סימן ט"], sa, { preset: "siman" }))).toEqual(["pattern/no-heading"]);
  });
});

describe("context: a reference without its upper levels takes them from the source's headings", () => {
  // מחצית השקל → מגן אברהם: "ס"ק ג" means ס"ק ג of the סימן the commentary is under
  const ma = ["<h1>מגן אברהם</h1>", "<h2>סימן א</h2>", "(א) שיהא", "(ב) מפני", "(ג) ומיד", "<h2>סימן ב</h2>", "(א) חלוקו", "(ב) אל", "(ג) ידקדק"];
  const src = ["<h1>מחצית השקל</h1>", "<h2>סימן ב</h2>", "<h3>סעיף ג</h3>", '<b>ס"ק ג ידקדק</b> וכו\'', "<h2>סימן א</h2>", '<b>מ"א ס"ק ב\' מפני</b> ועכ"פ'];

  it("the source's סימן decides; the link is certain and says why", () => {
    const res = run(src, ma, { preset: "siman-seif-sk" }, "מגן אברהם");
    expect(pairs(res)).toEqual(["3>8", "5>3"]);
    expect(conf(res)).toEqual(["certain", "certain"]);
    expect(codes(res.suggestions[0]!.reasons)).toContain("pattern/context");
  });

  it("without the context the same reference fits every סימן: ambiguous, with the others as alternatives", () => {
    const res = run(src, ma, { preset: "siman-seif-sk", context: false }, "מגן אברהם");
    expect(conf(res)).toEqual(["ambiguous", "ambiguous"]);
    expect(res.suggestions[0]!.alternatives.length).toBeGreaterThan(0);
  });

  it("a bare marker \"(ג)\" is placed by the context too, but never certain", () => {
    const res = run(["<h2>סימן ב</h2>", "ועיין לעיל (ג)"], ma, { preset: "marker" });
    expect(pairs(res)).toEqual(["1>8"]);
    expect(conf(res)).toEqual(["high"]);
  });
});

describe("untagged headings in the target", () => {
  it('"סימן א" alone on a line and "<b>סימן ב</b>" are headings of the tree', () => {
    const tgt = ["סימן א", "טקסט א", "<b>סימן ב</b>", "טקסט ב", "(סימן ג)", "טקסט ג"];
    const res = run(["סימן ב", "סימן ג"], tgt, { preset: "siman" });
    expect(pairs(res)).toEqual(["0>3", "1>5"]);
    expect(codes(res.notes)).toContain("pattern/untagged-headings");
  });

  it('a line that only starts like a heading ("סימן ה אמר…") is text, not a heading', () => {
    const res = run(["סימן ה"], ["סימן ה אמר רבי", "טקסט"], { preset: "siman" });
    expect(res.suggestions).toEqual([]);
  });
});

describe("daf and amud (a Bavli-shaped target)", () => {
  const bavli = ["<h1>ברכות</h1>", "<h2>דף ב.</h2>", "מאימתי", "גמ'", "<h2>דף ב:</h2>", "דילמא", "<h2>דף ג.</h2>", "מפני חשד"];

  it("each notation reaches its side; a daf without a side is its first side", () => {
    const res = run(["עיין דף ב:", "(ב.)", 'לקמן ג ע"א', "בדף ב"], bavli, { preset: "daf" }, "ברכות");
    expect(pairs(res)).toEqual(["0>5", "1>2", "2>7", "3>2"]);
    expect(conf(res)).toEqual(["certain", "certain", "certain", "certain"]);
  });

  it("a daf right after another tractate's name is not this book's", () => {
    const res = run(["עיין שבת דף ב:", 'ועי\' ב"ק דף ב.'], bavli, { preset: "daf" }, "ברכות");
    expect(res.suggestions).toEqual([]);
    expect(unmatchedCodes(res)).toEqual(["pattern/other-book", "pattern/other-book"]);
  });

  it('"מסכת ודף" links only references that name the target, by name or abbreviation', () => {
    const bk = ["<h1>בבא קמא</h1>", "<h2>דף ב.</h2>", "ארבעה אבות", "<h2>דף ב:</h2>", "המבעה"];
    const res = run(['ב"ק ב:', "בבא קמא דף ב.", 'ב"מ ב:', "מסכת בבא קמא דף ב ע\"ב"], bk, { preset: "masechet-daf" }, "בבא קמא");
    expect(pairs(res)).toEqual(["0>4", "1>2", "3>4"]);
    expect(unmatchedCodes(res)).toEqual(["pattern/other-book"]);
  });
});

describe("Mishnah, Rambam, Tanakh shapes", () => {
  const mishna = ["<h1>משנה ברכות</h1>", "<h2>פרק א</h2>", "(א) מאימתי", "(ב) מאימתי", "<h2>פרק ב</h2>", "(א) היה קורא", "(ב) אלו הן", "(ג) הקורא"];

  it('"פ"ב מ"ג" and "פרק ב משנה ב" reach the numbered mishna', () => {
    const res = run(['כדתנן פ"ב מ"ג', "פרק ב משנה ב"], mishna, { preset: "perek-mishna" });
    expect(pairs(res)).toEqual(["0>7", "1>6"]);
    expect(conf(res)).toEqual(["certain", "certain"]);
  });

  it("a verse number where the target has one line per verse and no numbering: the N-th line, high", () => {
    const tanakh = ["<h1>בראשית</h1>", "<h2>פרק א</h2>", "בראשית ברא", "והארץ היתה", "ויאמר אלהים", "<h2>פרק ב</h2>", "ויכלו"];
    const res = run(["(א, ג)"], tanakh, { preset: "perek-pasuk" });
    expect(pairs(res)).toEqual(["0>4"]);
    expect(conf(res)).toEqual(["high"]);
    expect(res.suggestions[0]!.rules).toContain("pattern.ordinal-line");
  });

  it('an everyday-word numeral ("פרק לא") is never certain', () => {
    const tgt = ["<h2>פרק ל</h2>", "א", "<h2>פרק לא</h2>", "ב"];
    const res = run(["פרק לא"], tgt, { preset: "perek-halacha" });
    expect(pairs(res)).toEqual(["0>3"]);
    expect(conf(res)).toEqual(["high"]);
    expect(codes(res.suggestions[0]!.warnings)).toContain("pattern/ambiguous-number");
  });
});

describe("named levels", () => {
  it('"פרשת נח" is matched against the target\'s heading names; the words after the name are not part of it', () => {
    const tgt = ["<h2>פרשת בראשית</h2>", "א", "<h2>פרשת נח</h2>", "ב"];
    expect(pairs(run(["כמבואר בפרשת נח היא"], tgt, { preset: "parsha" }))).toEqual(["0>3"]);
  });

  it('"שער הבטחון פרק ג": a named שער and a numbered פרק under it', () => {
    const tgt = ["<h2>שער היחוד</h2>", "<h3>פרק ג</h3>", "א", "<h2>שער הבטחון</h2>", "<h3>פרק ב</h3>", "ב", "<h3>פרק ג</h3>", "ג"];
    expect(pairs(run(["עיין שער הבטחון פרק ג"], tgt, { preset: "shaar-perek" }))).toEqual(["0>7"]);
  });
});

describe("the general preset and the user's own template", () => {
  const tgt = ["<h2>סימן ב</h2>", "<h3>סעיף א</h3>", "א", "<h3>סעיף ג</h3>", "ג"];

  it('the default preset chains "סימן ב, סעיף ג" into one reference', () => {
    const res = run(["עיין סימן ב, סעיף ג"], tgt, {});
    expect(pairs(res)).toEqual(["0>4"]);
    expect(res.suggestions[0]!.rules).toContain("pattern.preset.general");
  });

  it("a template with placeholders runs as a tree reference; a plain regex keeps v3's line target", () => {
    expect(pairs(run(["ס' ב/ג"], tgt, { regex: "ס'\\s?{סימן}/{סעיף}" }))).toEqual(["0>4"]);
    expect(pairs(run(["ס' 3"], ["א", "ב", "ג"], { regex: "ס'\\s?(\\d)" }))).toEqual(["0>2"]);
  });

  it("an unknown preset name is reported, not guessed", () => {
    expect(codes(run(["סימן ב"], tgt, { preset: "nope" }).notes)).toEqual(["pattern/unknown-preset"]);
  });
});

describe("a reference that belongs to another book named before it", () => {
  const ma = ["<h1>מגן אברהם</h1>", "<h2>סימן א</h2>", "(א) שיהא", "(ב) מפני", "(ג) ומיד"];

  it('"הט"ז ס"ק ג" and "בש"ך שם ס"ק ב" are skipped; "מ"א ס"ק ג" and "לעיל ס"ק ג" are the target\'s', () => {
    const src = ["<h2>סימן א</h2>", 'וכ\' הט"ז ס"ק ג', 'ועיין בש"ך שם ס"ק ב', 'דהא כתב מ"א לקמן ס"ק ג', "וכדלעיל ס\"ק ב"];
    const res = run(src, ma, { preset: "siman-seif-sk" }, "מגן אברהם");
    expect(pairs(res)).toEqual(["3>4", "4>3"]);
    expect(unmatchedCodes(res)).toEqual(["pattern/other-book", "pattern/other-book"]);
    expect(pairs(run(src, ma, { preset: "siman-seif-sk", otherBooks: false }, "מגן אברהם"))).toEqual(["1>4", "2>3", "3>4", "4>3"]);
  });

  it("a level of a structure the target does not have, right before: \"בכלל ז' ס\"ו\" is not סעיף ו of the target", () => {
    const sa = ["<h2>סימן א</h2>", "(א) א", "(ב) ב", "(ג) ג", "(ד) ד", "(ה) ה", "(ו) ו"];
    const res = run(["<h2>סימן א</h2>", "וז\"ל החיי אדם בכלל ז' ס\"ו", 'ועיין ס"ו'], sa, { preset: "siman-seif" }, "שולחן ערוך, אורח חיים");
    expect(pairs(res)).toEqual(["2>6"]);
  });

  it("a tractate named before the reference: \"בנגעים (פרק יד משנה ג)\" is not משנה ברכות", () => {
    const mishna = ["<h1>משנה ברכות</h1>", "<h2>פרק א</h2>", "(א) א", "(ב) ב", "(ג) ג"];
    const res = run(['תנינא בנגעים (פרק א משנה ג)', "לקמן (פרק א משנה ב)"], mishna, { preset: "perek-mishna" }, "משנה ברכות");
    expect(pairs(res)).toEqual(["1>3"]);
  });
});

describe("a commentary whose comments open with their place (position: start, carry)", () => {
  const ma = ["<h1>מגן אברהם</h1>", "<h2>סימן א</h2>", "(א) שיהא", "(ב) מפני", "(ג) ומיד"];
  const src = ["<h2>סימן א</h2>", '<b>ס"ק ב מפני</b> וכדלעיל ס"ק א', "ועוד בזה", '(ס"ק ג) ומיד', "<h2>סימן ב</h2>", "בלי הפניה"];

  it("only the reference that opens a line counts; the one inside the text does not", () => {
    const res = run(src, ma, { preset: "siman-seif-sk", position: "start" }, "מגן אברהם");
    expect(pairs(res)).toEqual(["1>3", "3>4"]);
  });

  it("carry: a line without a reference continues the one above it, never across a heading, never certain", () => {
    const res = run(src, ma, { preset: "siman-seif-sk", position: "start", carry: true }, "מגן אברהם");
    expect(pairs(res)).toEqual(["1>3", "2>3", "3>4"]);
    const carried = res.suggestions[1]!;
    expect(carried.confidence).toBe("high");
    expect(carried.anchor).toBeUndefined();
    expect(codes(carried.reasons)[0]).toBe("pattern/carried");
    expect(new Set(res.suggestions.map((s) => s.id)).size).toBe(3);
  });
});
