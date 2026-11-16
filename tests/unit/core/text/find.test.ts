import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { matchLine, searchLimit, SEARCH_LIMIT, SEARCH_MAX_LIMIT, snippetAround } from "../../../../src/core/text/find";
import { foldForSearch, foldQuery } from "../../../../src/core/text/hebrew";
import { htmlToPlainText } from "../../../../src/core/text/html";

describe("htmlToPlainText — the line as the reader shows it", () => {
  it("drops inline tags without splitting a word, and block tags become a space", () => {
    expect(htmlToPlainText("<big>בְּ</big>רֵאשִׁית")).toBe("בְּרֵאשִׁית");
    expect(htmlToPlainText("<h2>פרק א</h2>")).toBe("פרק א");
    expect(htmlToPlainText("שורה<br>שנייה")).toBe("שורה שנייה");
    expect(htmlToPlainText('<span title=">">א</span>')).toBe("\">א"); // the tag ends at the first ">", as in sanitize
  });
  it("decodes named and numeric entities; unknown names vanish; white space collapses", () => {
    expect(htmlToPlainText("א&amp;ב&nbsp;&thinsp;ג &quot;ד&quot; &#1488;&#x5D1;")).toBe('א&ב ג "ד" אב');
    expect(htmlToPlainText("א&unknownentity;ב")).toBe("אב");
    expect(htmlToPlainText("א&#xD800;ב")).toBe("א�ב");
    expect(htmlToPlainText("  א \n\t ב  ")).toBe("א ב");
  });
  it("a '<' with no '>' stays as text (the reader shows it), an '&' that is no entity too", () => {
    expect(htmlToPlainText("א < ב")).toBe("א < ב");
    expect(htmlToPlainText("A & B")).toBe("A & B");
  });
  it("never throws on null or numbers", () => {
    expect(htmlToPlainText(null)).toBe("");
    expect(htmlToPlainText(12)).toBe("12");
  });
});

describe("foldForSearch — ignores nikud, teamim, quotes and punctuation", () => {
  it("drops nikud and cantillation", () => {
    expect(foldForSearch("בְּרֵאשִׁ֖ית בָּרָ֣א").text).toBe("בראשית ברא");
  });
  it("quote variants fold to nothing: וי\"א, וי״א and וי''א are the same", () => {
    expect(foldQuery('וי"א')).toBe("ויא");
    expect(foldQuery("וי״א")).toBe("ויא");
    expect(foldQuery("וי''א")).toBe("ויא");
    expect(foldQuery("מ׳ ’ד‘")).toBe("מ ד");
  });
  it("maqaf, sof pasuq and punctuation separate words; runs of spaces become one", () => {
    expect(foldForSearch("עַל־פְּנֵי הַמָּיִם׃").text).toBe("על פני המים ");
    expect(foldQuery("א,  ב. (ג) — ד…")).toBe("א ב ג ד");
  });
  it("no abbreviation expansion (unlike normalize): the text is searched as written", () => {
    expect(foldQuery("סי' א")).toBe("סי א");
  });
  it("lower-cases Latin and drops invisible marks", () => {
    expect(foldQuery("Genesis\u200f 1")).toBe("genesis 1");
  });
  it("every folded char maps back to its place in the input", () => {
    const s = "בְּ, רֵא";
    const f = foldForSearch(s);
    expect(f.text).toBe("ב רא");
    expect(f.map).toEqual([0, 3, 5, 7]);
    for (let i = 0; i < f.text.length; i++) if (f.text[i] !== " ") expect(s[f.map[i]!]).toBe(f.text[i]);
  });
});

describe("matchLine", () => {
  const line = "(א) <big>בְּ</big>רֵאשִׁ֖ית בָּרָ֣א אֱלֹהִ֑ים אֵ֥ת הַשָּׁמַ֖יִם וְאֵ֥ת הָאָֽרֶץ׃";
  it("finds a query typed without nikud, and returns the original text around it", () => {
    const h = matchLine(line, foldQuery("ברא אלהים"), 2)!;
    expect(h.line).toBe(2);
    expect(h.count).toBe(1);
    expect(h.snippet.slice(h.start, h.end)).toBe("בָּרָ֣א אֱלֹהִ֑ים");
  });
  it("the match takes the points of its last letter with it", () => {
    const h = matchLine("שָׁלוֹם עֲלֵיכֶם", foldQuery("שלו"), 0)!;
    expect(h.snippet.slice(h.start, h.end)).toBe("שָׁלוֹ");
  });
  it("a query typed with nikud matches too", () => {
    expect(matchLine(line, foldQuery("בָּרָא"), 0)).not.toBeNull();
  });
  it("searches the text, not the tags", () => {
    expect(matchLine("<big>שלום</big>", foldQuery("big"), 0)).toBeNull();
    expect(matchLine('<span class="footnote">א</span>', foldQuery("footnote"), 0)).toBeNull();
  });
  it("a word split by an inline tag is still found", () => {
    expect(matchLine(line, foldQuery("בראשית"), 0)).not.toBeNull();
  });
  it("counts every occurrence in the line", () => {
    expect(matchLine("את השמים ואת הארץ", foldQuery("את"), 0)!.count).toBe(2);
  });
  it("no match, empty query", () => {
    expect(matchLine(line, foldQuery("משה"), 0)).toBeNull();
    expect(matchLine(line, "", 0)).toBeNull();
  });
  it("quote variants match each other", () => {
    expect(matchLine("<big>וי״א שש גודלים</big>", foldQuery('וי"א'), 0)).not.toBeNull();
  });
});

describe("snippetAround", () => {
  it("keeps a short line whole", () => {
    expect(snippetAround("אבג דהו", 4, 7)).toEqual({ snippet: "אבג דהו", start: 4, end: 7 });
  });
  it("cuts a long line at word boundaries, with … where it was cut, and keeps the match offsets right", () => {
    const words = Array.from({ length: 60 }, (_, i) => `מילה${i}`).join(" ");
    const at = words.indexOf("מילה30");
    const s = snippetAround(words, at, at + 6, 20, 20);
    expect(s.snippet.startsWith("…")).toBe(true);
    expect(s.snippet.endsWith("…")).toBe(true);
    expect(s.snippet.slice(s.start, s.end)).toBe("מילה30");
    expect(s.snippet.length).toBeLessThan(60);
    expect(s.snippet.slice(1, -1).split(" ").every((w) => /^מילה\d+$/.test(w))).toBe(true);
  });
});

describe("searchLimit", () => {
  it("defaults, floors and caps", () => {
    expect(searchLimit(undefined)).toBe(SEARCH_LIMIT);
    expect(searchLimit(0)).toBe(SEARCH_LIMIT);
    expect(searchLimit(7.9)).toBe(7);
    expect(searchLimit(1e9)).toBe(SEARCH_MAX_LIMIT);
  });
});

describe("properties", () => {
  const piece = fc.constantFrom("א", "ב", "ש", "ם", "ָ", "ּ", "֑", "־", "׃", '"', "״", "'", "׳", " ", ",", ".", "<b>", "</b>", "<br>", "<big>", "</big>", "<", ">", "&amp;", "&quot;", "&#1488;", "A", "b", "\u200f", "\u00a0");
  const line = fc.array(piece, { maxLength: 40 }).map((a) => a.join(""));

  it("the fast path of htmlToPlainText gives what the full scan gives", () => {
    fc.assert(
      fc.property(line.filter((s) => !s.includes("&")), (s) => {
        // a trailing "&" forces the full scan and stays a literal at the end
        expect(htmlToPlainText(`${s}&`).slice(0, -1).trim()).toBe(htmlToPlainText(s));
      }),
    );
  });

  it("any piece of a line's folded text is found in it (the quick rejection never hides a match)", () => {
    fc.assert(
      fc.property(line, fc.nat(), fc.nat(), (s, a, b) => {
        const folded = foldForSearch(htmlToPlainText(s)).text;
        const from = a % (folded.length + 1);
        const q = folded.slice(from, from + (b % 12)).trim();
        if (q.length < 2) return;
        const hit = matchLine(s, q, 0);
        expect(hit).not.toBeNull();
        expect(foldQuery(hit!.snippet.slice(hit!.start, hit!.end))).toBe(q);
      }),
      { numRuns: 2000 },
    );
  });
});
