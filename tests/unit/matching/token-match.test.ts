import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { hebrewTokens, type HebToken } from "../../../src/matching/hebrew-tokens";
import { acronymInitials, initialsKeys, keySimilarity, matchStep, mayStep, StepVocabulary, stepProfiler } from "../../../src/matching/token-match";

/*
 * mayStep is a cheap NECESSARY condition for matchStep: the ד"ה search skips a start when it says
 * false, and the engine's output must not change (src/linking/automatic/dibur-hamatchil/search.ts).
 * So: matchStep(a, i, b, j) ≠ null ⇒ mayStep(a[i], b[j]) — on every bridge, and on generated words.
 */
const toks = (s: string): HebToken[] => hebrewTokens(s);
const stepProfile = stepProfiler();
const may = (a: readonly HebToken[], i: number, b: readonly HebToken[], j: number) => mayStep(a[i]!, stepProfile(a[i]!.key), b[j]!, stepProfile(b[j]!.key));

describe("mayStep never rejects a step matchStep would take", () => {
  // each pair: a step of matchStep at (0, 0)
  const bridges: [string, string, string][] = [
    ["exact", "בראשית ברא", "בראשית ברא"],
    ["same stem", "והארץ", "הארץ"],
    ["plene / defective", "מצווה", "מצוה"],
    ["whole-word skeleton", "בונה", "בנה"],
    ["one edit", "שמעון", "שמעין"],
    ["two edits in a long word", "והתפללתם", "והתפלתום"],
    ["acronym", 'ת"ר', "תנו רבנן"],
    ["acronym with a glued prefix", 'וא"ר', "ואמר רבי"],
    ["acronym on the other side", "תנו רבנן", 'ת"ר'],
    ["truncation", "מתני'", "מתניתין"],
    ["one-letter truncation", "ר' יוחנן", "רבי יוחנן"],
    ["the divine name", "וה' אמר", "ויהוה אמר"],
    ["contraction", "קמשמע לן", "קא משמע לן"],
    ["contraction, other side", "קא משמע לן", "קמשמע לן"],
    ["glued words", "והאמר רב", "והא אמר רב"],
    ["glued words, other side", "והא אמר רב", "והאמר רב"],
    ["glued words keeping the א", "לכדתניא", "לכד תניא"],
    ["an abbreviation of the table written without quote marks", "אעפ שאמרו", "אף על פי שאמרו"],
    ["an unmarked abbreviation on the other side", "מנא הני מילי", "מנהמ"],
  ];
  for (const [name, a, b] of bridges) {
    it(name, () => {
      const ta = toks(a);
      const tb = toks(b);
      expect(matchStep(ta, 0, tb, 0)).not.toBeNull();
      expect(may(ta, 0, tb, 0)).toBe(true);
    });
  }

  it("and it does reject unrelated words (the reason it exists)", () => {
    const [a, b, c] = [toks("שמעון"), toks("מלכות"), toks("אמר")];
    expect(matchStep(a, 0, b, 0)).toBeNull();
    expect(may(a, 0, b, 0)).toBe(false);
    expect(may(c, 0, toks("לה"), 0)).toBe(false);
  });

  it("property: on generated words and their variants, matchStep ≠ null ⇒ mayStep", () => {
    const letters = "אבגדהוזחטיכלמנסעפצקרשת".split("");
    const word = fc.array(fc.constantFrom(...letters), { minLength: 1, maxLength: 9 }).map((w) => w.join(""));
    // a variant: a few random edits, a prefix letter, ו/י dropped — the near misses that matter
    const edit = fc.tuple(fc.nat(10), fc.constantFrom(...letters), fc.constantFrom("sub", "ins", "del"));
    const variant = fc.tuple(word, fc.array(edit, { maxLength: 3 }), fc.constantFrom("", "ו", "ה", "ב", "ל"), fc.boolean()).map(([w, edits, prefix, defective]) => {
      let s = w;
      for (const [pos, ch, op] of edits) {
        const k = pos % (s.length + 1);
        s = op === "sub" ? s.slice(0, k) + ch + s.slice(k + 1) : op === "ins" ? s.slice(0, k) + ch + s.slice(k) : s.slice(0, k) + s.slice(k + 1);
      }
      return [w, prefix + (defective ? s.replace(/[וי]/g, "") : s)] as const;
    });
    const marks = fc.constantFrom("", "'", '"');
    fc.assert(
      fc.property(variant, marks, marks, ([w, v], m1, m2) => {
        if (!v) return;
        const mark = (s: string, m: string) => (m === '"' && s.length >= 2 ? `${s.slice(0, -1)}"${s.slice(-1)}` : `${s}${m}`);
        const a = toks(`${mark(w, m1)} אחרי`);
        const b = toks(`${mark(v, m2)} שאחרי`);
        if (!a.length || !b.length) return;
        if (matchStep(a, 0, b, 0) !== null) expect(may(a, 0, b, 0)).toBe(true);
        if (matchStep(b, 0, a, 0) !== null) expect(may(b, 0, a, 0)).toBe(true);
      }),
      { numRuns: 20_000 },
    );
  });
});

describe("StepVocabulary.compatible (+ acronym initials): every word matchStep could step to, found by lookups", () => {
  // every pair of tokens of these lines, in context (the words after them matter to the bridges)
  function check(lines: readonly string[]): void {
    const profile = stepProfiler();
    const vocab = new StepVocabulary(profile);
    const toks = lines.map((l) => hebrewTokens(l));
    const entry = toks.map((t) => t.map((x) => vocab.add(x)));
    for (const [a, ta] of toks.entries())
      for (let i = 0; i < ta.length; i++) {
        const compat = new Set(vocab.compatible(ta[i]!, ta[i + 1]));
        const spelled = new Set(acronymInitials(ta[i]!));
        for (const [b, tb] of toks.entries())
          for (let j = 0; j < tb.length; j++)
            if (matchStep(ta, i, tb, j) !== null && !compat.has(entry[b]![j]!) && !initialsKeys(tb[j]!, tb[j + 1]).some((k) => spelled.has(k)))
              throw new Error(`${ta[i]!.key} (line ${a}) → ${tb[j]!.key} (line ${b}): matchStep steps, compatible() and the initials miss it`);
      }
  }

  it("on every bridge of matchStep", () => {
    check([
      "בראשית ברא והארץ הארץ מצווה מצוה בונה בנה שמעון שמעין והתפללתם והתפלתום",
      `ת"ר תנו רבנן וא"ר ואמר רבי מתני' מתניתין ר' יוחנן רבי יוחנן`,
      "וה' אמר ויהוה אמר קמשמע לן קא משמע לן והאמר רב והא אמר רב לכדתניא לכד תניא",
      "אעפ שאמרו אף על פי שאמרו מנהמ מנא הני מילי כדאפ כדי אכילת פרס",
    ]);
  });

  it("property: on generated lines of words and near misses", () => {
    const letters = "אבגדהוזחטיכלמנסעפצקרשת".split("");
    const word = fc.array(fc.constantFrom(...letters), { minLength: 1, maxLength: 9 }).map((w) => w.join(""));
    const marked = fc.tuple(word, fc.constantFrom("", "", "", "'", '"')).map(([w, m]) => (m === '"' && w.length >= 2 ? `${w.slice(0, -1)}"${w.slice(-1)}` : `${w}${m}`));
    const line = fc.array(marked, { minLength: 1, maxLength: 6 }).map((ws) => ws.join(" "));
    // lines derived from each other by small edits, so that fuzzy and bridged steps actually occur
    const edited = fc.tuple(line, fc.array(fc.tuple(fc.nat(60), fc.constantFrom(...letters, " ", "ו", "י"), fc.constantFrom("sub", "ins", "del")), { maxLength: 4 })).map(([l, edits]) => {
      let s2 = l;
      for (const [pos, ch, op] of edits) {
        const k = pos % (s2.length + 1);
        s2 = op === "sub" ? s2.slice(0, k) + ch + s2.slice(k + 1) : op === "ins" ? s2.slice(0, k) + ch + s2.slice(k) : s2.slice(0, k) + s2.slice(k + 1);
      }
      return [l, s2] as const;
    });
    fc.assert(fc.property(fc.array(edited, { minLength: 1, maxLength: 4 }), (pairs) => check(pairs.flat())), { numRuns: 1500 });
  });
});

describe("stepProfiler", () => {
  it("one profile per key; ids are equal exactly when the strings are", () => {
    const p = stepProfiler();
    expect(p("והארץ")).toBe(p("והארץ"));
    expect(p("לבית").stemId).toBe(p("בית").stemId); // both stem to בית
    expect(p("לבית").keyId).not.toBe(p("בית").keyId);
  });
});

describe("keySimilarity memo", () => {
  it("is symmetric and stable across many distinct pairs (the memo starts over instead of freezing)", () => {
    expect(keySimilarity("מצוה", "מצווה")).toBe(keySimilarity("מצווה", "מצוה"));
    const first = keySimilarity("שמעון", "שמעין");
    for (let i = 0; i < 5000; i++) keySimilarity(`א${i}`, `ב${i}`);
    expect(keySimilarity("שמעין", "שמעון")).toBe(first);
  });
});
