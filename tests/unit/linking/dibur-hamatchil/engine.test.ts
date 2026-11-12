import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BookOrigin, BookRef, Link } from "../../../../src/core/links/model";
import { storedForm } from "../../../../src/core/links/stored-form";
import { validateLink } from "../../../../src/core/links/validate";
import { headingLevel } from "../../../../src/core/text/html";
import { countVisibleChars } from "../../../../src/core/text/offsets";
import { searchKey, visibleSlice } from "../../../../src/matching/hebrew-tokens";
import { anchorPolicy, inheritedConfidence, runDiburHamatchilEngine, type DhOptions } from "../../../../src/linking/automatic/dibur-hamatchil";
import type { EngineBook, EngineResult, Suggestion } from "../../../../src/linking/automatic/types";

const ref = (key: string, title: string, origin: BookOrigin = "otzaria"): BookRef => ({ key, title, origin, isBaseBook: false });
const book = (r: BookRef, texts: readonly string[]): EngineBook => ({ book: r, lines: texts.map((text, index) => ({ index, text, heading: headingLevel(text) })) });

const BASE = ref("txt:base", "ספר הבסיס");
const COMM = ref("txt:comm", "פירוש על ספר הבסיס");

const GENESIS = [
  "<h1>ספר הבסיס</h1>",
  "<h2>פרק א</h2>",
  "(א) בְּרֵאשִׁ֖ית בָּרָ֣א אֱלֹהִ֑ים אֵ֥ת הַשָּׁמַ֖יִם וְאֵ֥ת הָאָֽרֶץ׃",
  "(ב) וְהָאָ֗רֶץ הָיְתָ֥ה תֹ֙הוּ֙ וָבֹ֔הוּ וְחֹ֖שֶׁךְ עַל־פְּנֵ֣י תְה֑וֹם",
  "(ג) וַיֹּ֥אמֶר אֱלֹהִ֖ים יְהִ֣י א֑וֹר וַֽיְהִי־אֽוֹר׃",
  "(ד) וַיַּ֧רְא אֱלֹהִ֛ים אֶת־הָא֖וֹר כִּי־ט֑וֹב וַיַּבְדֵּ֣ל אֱלֹהִ֔ים בֵּ֥ין הָא֖וֹר וּבֵ֥ין הַחֹֽשֶׁךְ׃",
  "(ה) וַיִּקְרָ֨א אֱלֹהִ֤ים לָאוֹר֙ י֔וֹם וְלַחֹ֖שֶׁךְ קָ֣רָא לָ֑יְלָה",
  "<h2>פרק ב</h2>",
  "(א) וַיְכֻלּ֛וּ הַשָּׁמַ֥יִם וְהָאָ֖רֶץ וְכָל־צְבָאָֽם׃",
  "(ב) וַיְכַ֤ל אֱלֹהִים֙ בַּיּ֣וֹם הַשְּׁבִיעִ֔י מְלַאכְתּ֖וֹ אֲשֶׁ֣ר עָשָׂ֑ה",
];

function codesOf(res: EngineResult, line: number): string[] {
  const s = res.suggestions.find((x) => commentaryLine(x) === line);
  if (s) return [...s.rules, ...s.reasons.map((r) => r.code)];
  return res.unmatched.find((u) => u.line === line)?.reasons.map((r) => r.code) ?? [];
}
/** the commentary line of a suggestion, in either record shape */
const commentaryLine = (s: Suggestion) => (s.source.book.key === COMM.key ? s.source.line : s.target.line);
const baseSide = (s: Suggestion) => (s.source.book.key === BASE.key ? s.source : s.target);
const byLine = (res: EngineResult, line: number) => res.suggestions.find((s) => commentaryLine(s) === line);

const run = (comm: readonly string[], base: readonly string[] = GENESIS, opts: DhOptions = {}, origin: BookOrigin = "otzaria") =>
  runDiburHamatchilEngine(book({ ...COMM, origin }, comm), book({ ...BASE, origin }, base), opts);

describe("ד\"ה engine: finding the quoted line", () => {
  const res = run(["<h1>פירוש</h1>", "<h2>פרק א</h2>", "<b>בראשית ברא.</b> פירוש ארוך על הפסוק", "<b>תהו ובהו.</b> לשון תמה", "<b>יהי אור.</b> פירוש", "<h2>פרק ב</h2>", "<b>ויכלו.</b> פירוש"]);

  it("places each ד\"ה on its base line, with Hebrew reasons and rule ids", () => {
    expect(res.suggestions.map((s) => [commentaryLine(s), baseSide(s).line])).toEqual([[2, 2], [3, 3], [4, 4], [6, 8]]);
    const s = byLine(res, 2)!;
    expect(["certain", "high"]).toContain(s.confidence);
    expect(s.reasons.map((r) => r.text)).toContain("נמצא אחרי נרמול ניקוד");
    expect(s.rules).toEqual(expect.arrayContaining(["dh/extract-bold", "dh/window-heading", "dh/normalized"]));
    expect(s.engine).toBe("dibur-hamatchil");
    expect(res.unmatched).toEqual([]);
  });

  it("the default window is the base section whose heading matches (פרק ב → lines of פרק ב)", () => {
    expect(byLine(res, 6)!.reasons.find((r) => r.code === "dh/window-heading")!.text).toContain("פרק ב");
  });

  it('a ד"ה written exactly like the base says so: "הדיבור המתחיל נמצא כלשונו"', () => {
    const r = run(["<b>בראשית ברא.</b> פירוש"], ["בראשית ברא אלהים את השמים"]);
    expect(r.suggestions[0]!.reasons.map((x) => x.text)).toContain("הדיבור המתחיל נמצא כלשונו");
  });

  it("a maqaf separates words: יהי אור finds יְהִי־אוֹר and the anchor covers it", () => {
    const r = run(["<b>ויהי אור.</b> פירוש"], GENESIS);
    const s = r.suggestions[0]!;
    expect(baseSide(s).line).toBe(4);
    expect(visibleSlice(GENESIS[4]!, s.anchor!.rawStart, s.anchor!.rawEnd!)).toBe("וַֽיְהִי־אֽוֹר");
  });

  it("a ד\"ה that runs over the end of a base line yields a target range", () => {
    const base = ["אחד שנים שלשה ארבעה חמשה ויאמר אלהים", "יהי אור ויהי אור", "וירא אלהים את האור"];
    const r = run(["<b>ויאמר אלהים יהי אור.</b> פירוש"], base);
    const s = r.suggestions[0]!;
    expect(baseSide(s)).toMatchObject({ line: 0, end: 1 });
    expect(s.rules).toContain("dh/span-next-line");
  });

  it('a resumed quote after "וכו׳" found a few lines on extends the range', () => {
    const base = ["ויאמר אלהים יהי רקיע בתוך המים", "ויעש אלהים את הרקיע", "ויקרא אלהים לרקיע שמים ויהי ערב ויהי בקר"];
    const s = run(["ויאמר אלהים יהי רקיע וכו׳ ויקרא אלהים לרקיע שמים. פירוש"], base).suggestions[0]!;
    expect(baseSide(s)).toMatchObject({ line: 0, end: 2 });
    expect(s.rules).toContain("dh/continuation");
  });
});

describe("false-positive guards", () => {
  it("a common short phrase does not match alone", () => {
    const r = run(["<b>את כל.</b> פירוש"], ["ויעש את כל המלאכה", "ויקח את כל הכסף"]);
    expect(r.suggestions).toEqual([]);
    expect(r.unmatched[0]!.reasons[0]!.code).toBe("dh/not-found");
  });

  it("a short but real phrase that occurs twice is never certain", () => {
    const s = run(["<b>על הארץ.</b> פירוש"], ["ויהי על הארץ", "ויבא על הארץ מים"]).suggestions[0]!;
    expect(s.confidence).toBe("ambiguous");
  });

  it("two verbatim occurrences close in score are reported as ambiguous, with the other as an alternative", () => {
    const base = ["אחד שנים", "ויאמר משה אל העם", "שלשה ארבעה", "ויאמר משה אל העם", "חמשה ששה"];
    const s = run(["<b>ויאמר משה אל העם.</b> פירוש"], base).suggestions[0]!;
    expect(s.confidence).toBe("ambiguous");
    expect(s.warnings.map((w) => w.code)).toContain("dh/ambiguous");
    expect(s.alternatives.map((a) => a.target.line)).toEqual([[1, 3].find((x) => x !== baseSide(s).line)]);
  });

  it("prefers the next position after the previous match", () => {
    const base = ["ויאמר משה אל העם", "ויעש משה כן", "ויקח משה את המטה", "ויאמר משה אל העם", "ויבא משה"];
    const r = run(["<b>ויקח משה את המטה.</b> פירוש", "<b>ויאמר משה אל העם.</b> פירוש"], base);
    const s = byLine(r, 1)!;
    expect(baseSide(s).line).toBe(3);
    expect(s.rules).toContain("dh/order");
  });

  it("a caller window limits the search", () => {
    const base = ["ויאמר משה אל העם", "ויעש משה כן", "ויקח משה את המטה"];
    const opts: DhOptions = { windows: () => ({ from: 1, to: 2 }), ladder: false };
    const r = run(["<b>ויאמר משה אל העם.</b> פירוש", "<b>ויקח משה את המטה.</b> פירוש"], base, opts);
    expect(byLine(r, 0)).toBeUndefined();
    expect(byLine(r, 1)!.rules).toContain("dh/window-caller");
  });

  it("when the base lines open with their own ד\"ה, a run must start at a line's first word", () => {
    const base = ["<b>ויקח משה.</b> פירוש ארוך", "<b>ויעש כן.</b> ויקח משה את המטה", "<b>ויבא.</b> פירוש"];
    const r = run(["<b>ויקח משה.</b> על רש״י"], base);
    expect(baseSide(r.suggestions[0]!).line).toBe(0);
  });
});

describe('inheritance: בא"ד and שם', () => {
  const res = run(["<b>תהו ובהו.</b> לשון תמה", 'בא"ד ועוד דבר', "<b>יהי אור.</b> פירוש", "שם", 'בא"ד עוד']);

  it("takes the previous line's place, with lower confidence", () => {
    const parent = byLine(res, 0)!;
    const baad = byLine(res, 1)!;
    expect(baseSide(baad).line).toBe(baseSide(parent).line);
    expect(baad.rules).toEqual(["dh/inherit-baad"]);
    expect(baad.score).toBeLessThan(parent.score);
    expect(baad.anchor).toBeUndefined();
    expect(baseSide(byLine(res, 3)!).line).toBe(4);
    expect(byLine(res, 3)!.rules).toEqual(["dh/inherit-sham"]);
  });

  it("decays once per hop along a chain, and a chain too weak to trust ends", () => {
    const parent = byLine(res, 2)!.score;
    expect(byLine(res, 3)!.score).toBeCloseTo(parent * 0.8, 2);
    const second = inheritedConfidence(parent, 2);
    expect(second).toBeCloseTo(parent * 0.64, 2);
    if (second >= 0.6) expect(byLine(res, 4)!.score).toBe(second);
    else expect(codesOf(res, 4)).toEqual(["dh/inherit-weak"]);
  });

  it("with no linked line before it, a בא\"ד line stays unmatched", () => {
    const r = run(['בא"ד ועוד', "<b>זזזזז קקקקק.</b> לא קיים", 'בא"ד שוב']);
    expect(r.suggestions).toEqual([]);
    expect(r.unmatched.map((u) => [u.line, u.reasons[0]!.code])).toEqual([[0, "dh/no-parent"], [1, "dh/not-found"], [2, "dh/no-parent"]]);
  });
});

describe("the flexibility ladder (A–D)", () => {
  it("strict finds a verbatim ד\"ה with no rung", () => {
    expect(codesOf(run(["<b>יהי אור.</b> פי׳"]), 0).some((c) => c.startsWith("dh/rung"))).toBe(false);
  });

  it("A: a two-word fragment deep in the line (strict wants 3 words there)", () => {
    const filler = Array.from({ length: 20 }, (_, i) => `שורה ${"אבגדהוזחטיכלמנסעפצקר"[i]} סתם`);
    const base = ["אחד שנים שלשה ארבעה מלכות שמים חמשה", ...filler];
    expect(codesOf(run(["<b>מלכות שמים שלמה גדולה.</b> פי׳"], base), 0)).toContain("dh/rung-A");
  });

  it("B: the matched words are frequent in the book, so only without document IDF does the run clear the bar", () => {
    const base = [
      ...Array.from({ length: 6 }, (_, i) => `מלאכה ${["אחד", "שנים", "שלשה", "ארבעה", "חמשה", "ששה"][i]} שבתות`),
      "מלאכה שבתות קודש",
      "סוף",
    ];
    expect(codesOf(run(["<b>מלאכה שבתות פרחי.</b> פי׳"], base), 0)).toContain("dh/rung-B");
  });

  it("C (ladderWide): the ד\"ה is just outside the window, in the neighbouring section", () => {
    const base = Array.from({ length: 12 }, (_, i) => (i === 6 ? "ויקח משה את המטה" : `שורה ${"אבגדהוזחטיכל"[i]} סתם`));
    const r = run(["<b>ויקח משה את המטה.</b> פי׳"], base, { windows: () => ({ from: 0, to: 1 }), ladderWide: true });
    expect(codesOf(r, 0)).toContain("dh/rung-C");
    expect(baseSide(r.suggestions[0]!).line).toBe(6);
  });

  it("by default the neighbouring sections are not searched (rungs C/D were mostly wrong on real books)", () => {
    const base = Array.from({ length: 12 }, (_, i) => (i === 6 ? "ויקח משה את המטה" : `שורה ${"אבגדהוזחטיכל"[i]} סתם`));
    const r = run(["<b>ויקח משה את המטה.</b> פי׳"], base, { windows: () => ({ from: 0, to: 1 }) });
    expect(r.suggestions).toEqual([]);
    expect(codesOf(r, 0)).toContain("dh/not-found");
  });

  it("D (ladderWide): only a lowered bar accepts a one-word partial match", () => {
    const base = ["מגדלות נהרות שמשון", "ימים"];
    expect(codesOf(run(["<b>מגדלות פרח כוכב.</b> פי׳"], base, { ladderWide: true }), 0)).toContain("dh/rung-D");
  });

  it("a ladder hit costs confidence: the same match scores lower than a strict one", () => {
    const strict = run(["<b>ויקח משה את המטה.</b> פי׳"], ["ויקח משה את המטה", "אחר"]).suggestions[0]!.score;
    const base = Array.from({ length: 12 }, (_, i) => (i === 6 ? "ויקח משה את המטה" : `שורה ${"אבגדהוזחטיכל"[i]} סתם`));
    const laddered = run(["<b>ויקח משה את המטה.</b> פי׳"], base, { windows: () => ({ from: 0, to: 1 }), ladderWide: true }).suggestions[0]!.score;
    expect(laddered).toBeLessThan(strict);
  });

  it("no ladder for a line without an explicit ד\"ה boundary", () => {
    const base = ["אחד שנים שלשה ארבעה מלכות שמים חמשה"];
    const line = "מלכות שמים שלמה גדולה ועוד מילים רבות בלי שום סימן של סוף דבור כלל ועיקר";
    expect(codesOf(run([line], base), 0).some((c) => c.startsWith("dh/rung"))).toBe(false);
  });
});

describe("unique anchor (few words, one line in the window)", () => {
  it("a line without a boundary is placed by its first words when they appear together in one line only", () => {
    const base = [
      ...Array.from({ length: 8 }, (_, i) => `אבן ${["אחד", "שנים", "שלשה", "ארבעה", "חמשה", "ששה", "שבעה", "שמונה"][i]} טוב`),
      "בבל אבן טוב מאד",
      "סוף",
    ];
    const line = "אבן טוב זה פירוש ארוך ועוד מילים רבות שאין להן סימן סוף כלל ועיקר בשום מקום";
    const r = run([line], base);
    expect(baseSide(r.suggestions[0]!).line).toBe(8);
    expect(r.suggestions[0]!.rules).toContain("dh/unique-anchor");
  });
});

describe("record shape and anchors (docs/research/DH_ANCHOR_DIRECTION.md)", () => {
  const comm = ["<b>יהי אור.</b> פירוש"];

  it("two local Otzaria books: base→commentary \"commentary\" record with an anchor that survives the generator", () => {
    const r = run(comm, GENESIS, {}, "otzaria");
    const s = r.suggestions[0]!;
    expect(s).toMatchObject({ declaredType: "commentary", source: { book: { key: BASE.key }, line: 4 }, target: { book: { key: COMM.key }, line: 0 } });
    expect(visibleSlice(GENESIS[4]!, s.anchor!.rawStart, s.anchor!.rawEnd!)).toBe("יְהִ֣י א֑וֹר");
    expect(countVisibleChars(GENESIS[4]!, s.anchor!.rawEnd!)).toBeGreaterThan(countVisibleChars(GENESIS[4]!, s.anchor!.rawStart));
    expect(s.heRef2).toBe("פירוש על ספר הבסיס");
    const link: Link = { id: s.id, status: "new", provenance: "auto", source: s.source, target: s.target, declaredType: s.declaredType, heRef2: s.heRef2, anchor: s.anchor! };
    expect(storedForm(link)).toMatchObject({ flipped: false, stored: "COMMENTARY" });
    const problems = validateLink(link, { line: () => ({ exists: true, heading: null, anchorLength: GENESIS[4]!.length }), lineCount: () => 10 });
    expect(problems.filter((p) => p.code.includes("anchor"))).toEqual([]);
    expect(r.notes.map((n) => n.code)).toContain("dh/anchors-base");
  });

  it("a Sefaria book on either side: commentary→base \"source\" record, no anchor (it would be dropped)", () => {
    const r = runDiburHamatchilEngine(book(COMM, comm), book({ ...BASE, origin: "sefaria" }, GENESIS));
    const s = r.suggestions[0]!;
    expect(s).toMatchObject({ declaredType: "source", source: { book: { key: COMM.key }, line: 0 }, target: { book: { key: BASE.key }, line: 4 } });
    expect(s.anchor).toBeUndefined();
    expect(s.heRef2).toBe("ספר הבסיס, פרק א");
    expect(storedForm(s)).toMatchObject({ flipped: true, stored: "COMMENTARY" }); // the reason it can carry no anchor
    expect(r.notes.map((n) => n.code)).toContain("dh/anchors-sefaria");
  });

  it('anchors: "off" keeps the commentary-side shape even for local books', () => {
    expect(run(comm, GENESIS, { anchors: "off" }).suggestions[0]!).toMatchObject({ declaredType: "source", source: { book: { key: COMM.key } } });
  });

  it("no anchor on a base line that carries merged footnotes (it would cancel the merge)", () => {
    const base = ['ויאמר אלהים יהי אור<i class="footnote">הערה</i> ויהי אור'];
    const s = run(comm, base).suggestions[0]!;
    expect(s.anchor).toBeUndefined();
    expect(s.warnings.map((w) => w.code)).toContain("dh/anchor-skipped-notes");
  });

  it("anchorPolicy: unknown/personal origin → no anchor", () => {
    expect(anchorPolicy(ref("a", "א", "personal"), ref("b", "ב")).anchors).toBe(false);
    expect(anchorPolicy(ref("a", "א", "unknown"), ref("b", "ב")).anchors).toBe(false);
    expect(anchorPolicy(ref("a", "א"), ref("b", "ב")).anchors).toBe(true);
  });

  it("the database heRef is used for heRef_2 when the line has one", () => {
    const base: EngineBook = { book: { ...BASE, origin: "sefaria" }, lines: GENESIS.map((text, index) => ({ index, text, heading: headingLevel(text), heRef: index === 4 ? "בראשית, א, ג" : null })) };
    const s = runDiburHamatchilEngine(book({ ...COMM, origin: "sefaria" }, comm), base).suggestions[0]!;
    expect(s.heRef2).toBe("בראשית, א, ג");
  });
});

describe("determinism, abort and progress", () => {
  const comm = Array.from({ length: 60 }, (_, i) => (i % 2 ? "<b>יהי אור.</b> פי׳" : "<b>תהו ובהו.</b> פי׳"));

  it("ids and output are identical across runs", () => {
    const a = run(comm);
    const b = run(comm);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.suggestions[0]!.id).toBe("dibur-hamatchil:txt:comm#0>txt:base#3");
    expect(new Set(a.suggestions.map((s) => s.id)).size).toBe(a.suggestions.length);
  });

  it("an aborted signal stops before the first line", () => {
    const ac = new AbortController();
    ac.abort();
    const r = runDiburHamatchilEngine(book(COMM, comm), book(BASE, GENESIS), {}, { signal: ac.signal });
    expect(r.suggestions).toEqual([]);
    expect(r.notes.map((n) => n.code)).toContain("engine/aborted");
  });

  it("aborting mid-run returns what was found so far; progress is reported", () => {
    const ac = new AbortController();
    const calls: [number, number][] = [];
    const r = runDiburHamatchilEngine(book(COMM, comm), book(BASE, GENESIS), {}, {
      signal: ac.signal,
      progress: (done, total) => {
        calls.push([done, total]);
        if (done >= 25) ac.abort();
      },
    });
    expect(calls[0]).toEqual([0, 60]);
    expect(r.suggestions.length).toBe(25);
    expect(r.notes.map((n) => n.code)).toContain("engine/aborted");
  });
});

describe("property: search normalization never changes the text the engine outputs", () => {
  const WORDS = ["בְּרֵאשִׁ֖ית", "בָּרָ֣א", "אֱלֹהִ֑ים", "הַשָּׁמַ֖יִם", "וְהָאָֽרֶץ", "תֹ֙הוּ֙", "מְרַחֶ֖פֶת", "<b>אוֹר</b>", "כָּל־הָאָדָם", "רַבִּי", "מִשְׁפָּטִים", "ת\"ר"];
  const deepFreeze = <T>(o: T): T => {
    if (o && typeof o === "object") {
      Object.freeze(o);
      for (const v of Object.values(o)) deepFreeze(v);
    }
    return o;
  };

  it("the anchor is a slice of the untouched base line whose search key is the ד\"ה's; inputs are not mutated", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...WORDS), { minLength: 3, maxLength: 12 }),
        fc.nat(),
        fc.integer({ min: 1, max: 4 }),
        (words, start, len) => {
          const line = `(א) ${words.join(" ")}׃`;
          const from = start % words.length;
          const quote = words.slice(from, from + len);
          const dhText = quote.map((w) => w.replace(/<[^>]*>/g, "").replace(/[֑-ׇ]/g, (c) => (c === "־" ? "־" : ""))).join(" ");
          const base = deepFreeze(book(BASE, ["<h2>פרק א</h2>", line, "סוף"]));
          const comm = deepFreeze(book(COMM, [`<b>${dhText}.</b> פירוש`]));
          const before = JSON.stringify([base, comm]);
          const r = runDiburHamatchilEngine(comm, base);
          expect(JSON.stringify([base, comm])).toBe(before);
          for (const s of r.suggestions) {
            if (!s.anchor) continue;
            const slice = line.slice(s.anchor.rawStart, s.anchor.rawEnd);
            expect(line.includes(slice)).toBe(true);
            expect(searchKey(slice)).toBe(searchKey(dhText));
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe("a weak match before the previous line's place", () => {
  const base = ["ויאמר משה אל אהרן קח מחתה", "שורה בינונית סתם", "שורה שלישית סתם", "שורה רביעית סתם", "ויקח אהרן את המחתה ויתן עליה אש", "סוף דבר"];

  it("is not suggested: on real books such matches were right 212 times in 1,080", () => {
    const r = run(["<b>ויקח אהרן את המחתה.</b> פי׳", "<b>קח מחתה ועשה.</b> פי׳"], base);
    expect(byLine(r, 0)).toBeDefined();
    expect(byLine(r, 1)).toBeUndefined();
    expect(codesOf(r, 1)).toContain("dh/backward-weak");
  });

  it("a strong backward match stays, with its warning", () => {
    const r = run(["<b>ויקח אהרן את המחתה.</b> פי׳", "<b>ויאמר משה.</b> פי׳"], base);
    const s = byLine(r, 1)!;
    expect(baseSide(s).line).toBe(0);
    expect(s.confidence).toBe("high");
    expect(s.warnings.map((w) => w.code)).toContain("dh/backward");
  });
});
