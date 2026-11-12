import { describe, expect, it } from "vitest";
import { extractDh } from "../../../../src/linking/automatic/dibur-hamatchil";

const dh = (line: string, max?: number) => {
  const e = extractDh(line, max);
  return { ...e, words: e.dh.map((t) => t.key), cont: e.continuation.map((t) => t.key) };
};

describe('extractDh: where the ד"ה ends', () => {
  it("a bold opening is the ד\"ה (רש\"י, תוספות)", () => {
    const e = dh("<b>בראשית ברא.</b> אֵין הַמִּקְרָא הַזֶּה אוֹמֵר אֶלָּא דָּרְשֵׁנִי");
    expect(e).toMatchObject({ kind: "dh", words: ["בראשית", "ברא"], boundary: "bold", explicit: true, text: "בראשית ברא" });
  });

  it("nested empty bold tags do not end the bold run early (רש\"י on the ש\"ס)", () => {
    const e = dh("<b><b></b><i></i>ולכתחלה הוא דלא</b> – ובהא איכא למימר");
    expect(e).toMatchObject({ words: ["ולכתחלה", "הוא", "דלא"], boundary: "bold", explicit: true });
  });

  it("a dash with a space ends it; a maqaf inside a word does not", () => {
    expect(dh("מאימתי קורין – פירוש הדבר")).toMatchObject({ words: ["מאימתי", "קורינ"], boundary: "dash" });
    expect(dh("כל־האדם - פירוש")).toMatchObject({ words: ["כל", "האדמ"], boundary: "dash" });
  });

  it("a period or colon ends it", () => {
    expect(dh("ויאמר אלהים. פירוש הדבר כך")).toMatchObject({ words: ["ויאמר", "אלהימ"], boundary: "punctuation" });
    expect(dh("ויאמר אלהים: פירוש")).toMatchObject({ boundary: "punctuation" });
  });

  it("וכו׳ ends it, and the words after it are a resumed quote", () => {
    const e = dh("ויאמר אלהים וכו׳ יהי אור. וזה פירושו");
    expect(e).toMatchObject({ words: ["ויאמר", "אלהימ"], cont: ["יהי", "אור"], boundary: "etc", explicit: true });
    expect(dh("<b>ויאמר וגו׳</b> פירוש ארוך")).toMatchObject({ words: ["ויאמר"], cont: [] });
  });

  it("without a boundary the first 12 words are taken and the ד\"ה is not explicit", () => {
    const line = Array.from({ length: 20 }, (_, i) => `מלה${"אבגדהוזחטיכלמנסעפצקרשת"[i]}`).join(" ");
    const e = dh(line);
    expect(e.words).toHaveLength(12);
    expect(e).toMatchObject({ explicit: false, boundary: "none" });
    expect(dh(line, 5).words).toHaveLength(5);
  });

  it("a boundary past the word cap does not count", () => {
    const line = `${Array.from({ length: 14 }, () => "מלה").join(" ")}. סוף`;
    expect(dh(line)).toMatchObject({ explicit: false, boundary: "none" });
  });
});

describe("extractDh: pointer words at the start", () => {
  it('strips ד"ה, "גמ׳", "רש"י ד"ה", "תוד"ה" and a bracketed number, to a fixed point', () => {
    expect(dh('ד"ה מאימתי קורין - פי׳')).toMatchObject({ words: ["מאימתי", "קורינ"], stripped: ['ד"ה'] });
    expect(dh("גמ׳ מאימתי קורין - פי׳")).toMatchObject({ words: ["מאימתי", "קורינ"], stripped: ["גמ׳"] });
    expect(dh('בא"ד')).toMatchObject({ kind: "baad" });
    expect(dh('רש"י ד"ה מאימתי - פי׳')).toMatchObject({ words: ["מאימתי"] });
    expect(dh('תוד"ה מאימתי - פי׳')).toMatchObject({ words: ["מאימתי"] });
    expect(dh("(א) <b>מאימתי.</b> פירוש")).toMatchObject({ words: ["מאימתי"], boundary: "bold" });
    expect(dh('שם ד"ה מאימתי - פי׳')).toMatchObject({ words: ["מאימתי"] });
  });

  it("a bare שם before text is stripped and the text is searched", () => {
    expect(dh("שם. מאימתי קורין - פי׳")).toMatchObject({ kind: "dh", words: ["מאימתי", "קורינ"] });
  });

  it('בא"ד / שם בא"ד continue the previous line; a line that is only שם means the same place', () => {
    expect(dh('בא"ד ואם תאמר')).toMatchObject({ kind: "baad", dh: [] });
    expect(dh('שם בא"ד ואם תאמר')).toMatchObject({ kind: "baad" });
    expect(dh('<b>א"ד</b> ועוד')).toMatchObject({ kind: "baad" });
    expect(dh("שם")).toMatchObject({ kind: "sham" });
    expect(dh("<b>שם:</b>")).toMatchObject({ kind: "sham" });
  });

  it("does not take an ordinary word for a pointer (בתולה ≠ בתו׳, משנהו ≠ משנה)", () => {
    expect(dh("בתולה נשאת ליום הרביעי. פירוש")).toMatchObject({ words: ["בתולה", "נשאת", "ליומ", "הרביעי"] });
  });

  it("headings and empty lines have no ד\"ה", () => {
    expect(dh("<h2>פרק א</h2>").kind).toBe("heading");
    expect(dh("").kind).toBe("empty");
    expect(dh("123 ...").kind).toBe("empty");
    expect(extractDh({ text: "פרק א", heading: 2 }).kind).toBe("heading");
  });

  it("the ד\"ה text is reported as written — normalization never rewrites it", () => {
    const e = dh("<b>וַיֹּאמֶר אֱלֹהִים יְהִי־אוֹר.</b> פירוש");
    expect(e.text).toBe("וַיֹּאמֶר אֱלֹהִים יְהִי־אוֹר");
    expect(e.words).toEqual(["ויאמר", "אלהימ", "יהי", "אור"]);
  });
});
