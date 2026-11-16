"""The gaps of the library benchmark: which database links the tool does NOT regenerate, and why
(docs/validation/COVERAGE_REPORT.md).

For a stratified sample of the missed links of every stored type, a lexical classifier reads the two
lines of the link and asks whether the text itself carries a handle the engines could use:

  A  inferable from the text — a citation (book name / acronym + a location, "שם" after one), a
     dibur-hamatchil of one line found in the other, the same Sefaria location in a commentary and its
     base (heRef), a footnote marker: an engine (or the planner) missed it;
  B  needs outside knowledge — B1: the two lines share a quotation (a verse, a parallel passage) with
     no reference; B2: nothing in either line points at the other (a parallel, a legal source, a topic);
  C  doubtful database link — an empty line, a citation in the text that points ELSEWHERE in the same
     book, or a dibur-hamatchil that is found in a neighbouring line and not in the linked one.

It reads the benchmark's cache (BENCH_DIR: runs-*.jsonl, and the design that
`BENCH_MODE=report BENCH_DESIGN_DUMP=1` writes) and the database, read only. Nothing is run.

    py -I scripts/bench/coverage_gaps.py classify  <bench-dir> [per-owner=10]
    py -I scripts/bench/coverage_gaps.py reclassify <bench-dir>              again, from gaps-raw.jsonl
    py -I scripts/bench/coverage_gaps.py handcheck <bench-dir> [n] [tag] [seed] [exclude-tags]   blind file to label by hand
    py -I scripts/bench/coverage_gaps.py agree     <bench-dir> <labels.tsv> [tag]                  classifier vs hand labels
    py -I scripts/bench/coverage_gaps.py truth     <bench-dir> [tags=set1,set2]   A/B/C from the adjudicated hand labels
    py -I scripts/bench/coverage_gaps.py fresh     <bench-dir> [per-tier=20] new suggestions to judge by hand
    py -I scripts/bench/coverage_gaps.py freshscore <bench-dir> <labels.tsv>

Outputs go to <bench-dir> (git-ignored): gaps-items.jsonl, gaps-summary.json, gaps-handcheck.txt,
fresh-handcheck.txt. The texts in them are library text: never commit them.
"""
import hashlib
import json
import math
import os
import random
import re
import sqlite3
import sys
from collections import Counter, defaultdict

import zstandard

sys.stdout.reconfigure(encoding="utf-8")
DB = "file:C:/ProgramData/otzaria/books/seforim.db?mode=ro&immutable=1"
SEED = "coverage-1"
BOOT = 400


# ─── database ────────────────────────────────────────────────────────────────────────────────────

class Db:
    def __init__(self):
        self.c = sqlite3.connect(DB, uri=True)
        self.c.text_factory = lambda b: b.decode("utf-8", "surrogateescape")
        self.dec = {}
        for (d,) in self.c.execute("select dict from zstd_dict"):
            zd = zstandard.ZstdCompressionDict(d)
            self.dec[zd.dict_id()] = zstandard.ZstdDecompressor(dict_data=zd)
        self.plain = zstandard.ZstdDecompressor()
        self.types = dict(self.c.execute("select id, name from connection_type"))
        self.type_id = {v: k for k, v in self.types.items()}
        self.titles = dict(self.c.execute("select id, title from book"))
        self.by_title = {}
        for i, t in self.titles.items():
            self.by_title.setdefault(t, i)
        self.acr = defaultdict(list)
        for b, t in self.c.execute("select bookId, term from book_acronym"):
            self.acr[b].append(t)
        self.headings = {}
        self.tocs = {}
        self.cache = {}

    def text(self, v):
        if v is None:
            return ""
        if isinstance(v, str):
            return v
        if v[:4] == b"\x28\xb5\x2f\xfd":
            p = zstandard.get_frame_parameters(v)
            d = self.dec.get(p.dict_id, self.plain) if p.dict_id else self.plain
            return d.decompress(v).decode("utf-8")
        return str(v)

    def heading_lines(self, book):
        if book not in self.headings:
            self.headings[book] = {r[0] for r in self.c.execute("select lineId from tocEntry where bookId = ? and lineId is not null", (book,))}
        return self.headings[book]

    def lines(self, book, idxs):
        """{lineIndex: (text, heRef, isHeading)} for the given indexes (cached)."""
        want = [i for i in set(idxs) if i >= 0 and (book, i) not in self.cache]
        hs = self.heading_lines(book) if want else set()
        for k in range(0, len(want), 500):
            part = want[k:k + 500]
            q = ",".join("?" * len(part))
            for li, lid, heref, toc, content in self.c.execute(
                f"select l.lineIndex, l.id, l.heRef, l.tocEntryId, lc.content from line l left join line_content lc on lc.id = l.id where l.bookId = ? and l.lineIndex in ({q})", [book, *part]
            ):
                self.cache[(book, li)] = (self.text(content), heref or "", lid in hs, toc)
            for i in part:
                self.cache.setdefault((book, i), ("", "", False, None))
        return {i: self.cache[(book, i)] for i in idxs if (book, i) in self.cache}

    def toc_path(self, book, toc):
        """the texts of a line's table-of-contents entry and its ancestors"""
        if book not in self.tocs:
            self.tocs[book] = {i: (p, t) for i, p, t in self.c.execute("select e.id, e.parentId, x.text from tocEntry e join tocText x on x.id = e.textId where e.bookId = ?", (book,))}
        out, seen = [], set()
        while toc is not None and toc in self.tocs[book] and toc not in seen:
            seen.add(toc)
            p, t = self.tocs[book][toc]
            out.append(t)
            toc = p
        return out

    def links(self, type_name, s, t):
        """(id, sourceBook, sourceLine, sourceEnd, targetBook, targetLine, targetEnd, anchor0) of one stored (type, source, target)."""
        tid = self.type_id.get(type_name)
        if type_name == "OTHER":
            cond, args = "(l.connectionTypeId = ? or l.connectionTypeId is null or l.connectionTypeId not in (select id from connection_type))", [tid]
        else:
            cond, args = "l.connectionTypeId = ?", [tid]
        rows = list(self.c.execute(
            f"""select l.id, sl.lineIndex, tl.lineIndex from link l join line sl on sl.id = l.sourceLineId join line tl on tl.id = l.targetLineId
                where l.sourceBookId = ? and l.targetBookId = ? and {cond}""", [s, t, *args]))
        return [(i, s, a, t, b) for i, a, b in rows]

    def link_extras(self, ids):
        ranges, anchors = {}, {}
        ids = list(ids)
        for k in range(0, len(ids), 900):
            part = ids[k:k + 900]
            q = ",".join("?" * len(part))
            for lid, side, end in self.c.execute(f"select linkId, side, endLineIndex from link_range where linkId in ({q})", part):
                ranges[(lid, side)] = end
            for lid, side, cs, ce in self.c.execute(f"select linkId, side, charStart, charEnd from link_anchor where linkId in ({q}) order by charStart", part):
                anchors.setdefault((lid, side), (cs, ce))
        return ranges, anchors


# ─── text ────────────────────────────────────────────────────────────────────────────────────────

TAG = re.compile(r"<[^>]+>")
MARKS = re.compile(r"[\u0591-\u05BD\u05BF-\u05C7]")
FINALS = str.maketrans("ךםןףץ", "כמנפצ")


def visible(html):
    """the line as the reader sees it (tags out, entities decoded) — anchors count these characters"""
    s = TAG.sub("", html or "")
    return s.replace("&nbsp;", " ").replace("&quot;", '"').replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")


def norm(s):
    s = MARKS.sub("", s).replace("\u05BE", " ")
    s = s.replace("״", '"').replace("׳", "'").replace("“", '"').replace("”", '"').replace("„", '"').replace("‘", "'").replace("’", "'").replace("`", "'")
    return re.sub(r"\s+", " ", s).strip()


def skel(word):
    w = re.sub(r"[^א-ת]", "", word).translate(FINALS)
    if len(w) > 3 and w[0] == "ו":
        w = w[1:]
    if len(w) > 2:
        w = w[0] + re.sub(r"[וי]", "", w[1:])
    return w


def words(s):
    return [w for w in (skel(x) for x in s.split()) if w]


VAL = {c: v for c, v in zip("אבגדהוזחטיכלמנסעפצקרשת", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400])}


def is_numeral(tok):
    """a Hebrew numeral as written in a reference: letters in non-increasing value (טו/טז allowed), at most 4"""
    t = re.sub(r"['\"]", "", tok).translate(FINALS)
    if not t or len(t) > 4 or any(c not in VAL for c in t):
        return False
    if t in ("טו", "טז"):
        return True
    v = [VAL[c] for c in t]
    return all(a >= b for a, b in zip(v, v[1:])) and not (len(t) >= 2 and t in ("יה", "יו"))


LOCWORD = r"(?:דף|דפים|ד'|עמוד|עמ'|ע\"[אב]|פרק|פרקים|פ\"[א-ת]{1,3}|פ'|פרשת|פרשה|פר'|סי'|סימן|סימנים|סעיף|סעי'|ס\"ק|סק\"|הלכה|הלכות|ה\"[א-ת]{1,3}|הל'|פסוק|פסוקים|מצוה|מצות|אות|שורש|כלל|רמז|ח\"[א-ג]|חלק|במשנה|משנה|מ\"[א-ת]{1,2}|מאמר|שער|ענף|תשובה|שאלה|סוף|ריש|דיבור|ד\"ה|בד\"ה)"
NUMTOK = re.compile(r"(?<![א-ת'\"])([א-ת]{1,4}['\"]?[א-ת]?|[א-ת]['\"])(?=[\s.:,;)\]]|$)")
LOCWORD_RE = re.compile(r"(?<![א-ת])[בלוכד]?" + LOCWORD + r"(?![א-ת])")


def has_location(window):
    if LOCWORD_RE.search(window) or re.search(r"\d", window):
        return True
    for m in NUMTOK.finditer(window):
        tok = m.group(1)
        if ("'" in tok or '"' in tok or re.match(r"[.:]", window[m.end():m.end() + 1] or "")) and is_numeral(tok):
            return True
    return False


ABBREV = {"סי", "סע", "עי", "וע", "הל", "פי", "שם", "דף", "רש", "רפ", "ספ", "סס", "רס", "טז", "בי", "שך", "עא", "עב", "פ", "ר", "ס", "קו", "מש"}
PREFIXES = ("רפ", "ספ", "סס", "רס", "סו", "ר", "ס", "פ", "ח", "מ", "ה", "ד", "ל", "ב", "ו")


def numerals(window, plain=False, start=0):
    """every number a reference may mean: the token, and the token without up to two letters of an
    abbreviation in front of it (פ"ג = פרק ג, ח"א = חלק א, פי"ז = פרק יז, בפ"ב = בפרק ב, ר"פ = no number;
    "ה ע"ב" = daf ה; ט"ז, ב"י, ש"ך are commentators, not numbers)"""
    out = []
    window = re.split(r"(?<![א-ת])(?:ב?ד\"ה|תוד\"ה|סד\"ה)(?![א-ת])", window)[0]
    window = re.sub(r"(?<![א-ת])([א-ת]{1,3})\s+(?:ע\"|עמוד\s+)([אב])(?![א-ת])", r"\1. ", window)
    for m in NUMTOK.finditer(window):
        tok = m.group(1)
        bare = re.sub(r"['\"]", "", tok)
        if m.start() < start or bare in ABBREV:
            continue
        head = window[:m.start()]
        inside = head.count("(") > head.count(")") or head.count("[") > head.count("]")
        marked = "'" in tok or '"' in tok
        written = marked or inside or re.match(r"[.:,]", window[m.end():m.end() + 1] or "")
        if not written and not plain:
            continue
        cands = {bare}
        for pre in PREFIXES if marked else ():
            if bare.startswith(pre) and len(bare) > len(pre):
                rest = bare[len(pre):]
                cands.add(rest)
                for pre2 in PREFIXES:
                    if rest.startswith(pre2) and len(rest) > len(pre2):
                        cands.add(rest[len(pre2):])
        for c in cands:
            if c not in ABBREV and is_numeral(c):
                out.append(c.translate(FINALS))
    return out


# ─── book names ──────────────────────────────────────────────────────────────────────────────────

EXPAND = {
    "תוספות": ["תוס'", "תוספ'", "תוד\"ה", "התוס'", "בתוס'"],
    "משנה תורה": ["רמב\"ם", "הרמב\"ם", "רמבם", "הרמבם", "מיימוני"],
    "שולחן ערוך": ["שו\"ע", "ש\"ע", "שלחן ערוך", "השו\"ע", "בשו\"ע"],
    "אורח חיים": ["או\"ח", "אורח חיים", "א\"ח"],
    "יורה דעה": ["יו\"ד", "י\"ד"],
    "אבן העזר": ["אה\"ע", "אבה\"ע", "אהע\"ז"],
    "חושן משפט": ["חו\"מ", "ח\"מ", "חשן משפט"],
    "תלמוד ירושלמי": ["ירושלמי", "ירוש'", "בירושלמי"],
    "משנה ברורה": ["מ\"ב", "משנ\"ב", "המ\"ב"],
    "מגן אברהם": ["מג\"א", "המג\"א"],
    "טורי זהב": ["ט\"ז", "הט\"ז"],
    "ספר הזהר": ["זוהר", "זהר", "זוה\"ק", "זה\"ק", "בזוהר", "בזה\"ק"],
    "זוהר": ["זוהר", "זהר", "זוה\"ק", "זה\"ק"],
    "בית יוסף": ["ב\"י", "הב\"י"],
    "בראשית רבה": ["ב\"ר", "בר\"ר", "בראשית רבא"],
    "שמות רבה": ["שמו\"ר", "ש\"ר"],
    "ויקרא רבה": ["ויק\"ר", "וי\"ר"],
    "במדבר רבה": ["במ\"ר", "במד\"ר"],
    "דברים רבה": ["דב\"ר"],
    "ילקוט שמעוני": ["ילקוט", "ילק\"ש", "יל\"ש"],
    "תהילים": ["תהלים", "תהל'", "תה'"],
    "ישעיהו": ["ישעיה", "ישעי'", "יש'"],
    "ירמיהו": ["ירמיה", "ירמי'"],
    "יחזקאל": ["יחזק'"],
    "שמואל א": ["ש\"א", "שמ\"א", "שמואל"],
    "שמואל ב": ["ש\"ב", "שמ\"ב", "שמואל"],
    "מלכים א": ["מ\"א", "מלכים"],
    "מלכים ב": ["מ\"ב", "מלכים"],
    "דברי הימים א": ["דה\"א", "דברי הימים"],
    "דברי הימים ב": ["דה\"ב", "דברי הימים"],
    "משלי": ["משלי"],
    "בבא קמא": ["ב\"ק", "בבא קמא"],
    "בבא מציעא": ["ב\"מ", "בבא מציעא"],
    "בבא בתרא": ["ב\"ב", "בבא בתרא"],
    "עבודה זרה": ["ע\"ז"],
    "ראש השנה": ["ר\"ה"],
    "מועד קטן": ["מו\"ק"],
    "יום טוב": ["יו\"ט"],
    "ביצה": ["ביצה", "יו\"ט"],
    "רש\"י": ["רש\"י", "פרש\"י", "פירש\"י", "רשי"],
    "מדרש תהילים": ["מדרש תהלים", "שוחר טוב", "מדרש שוחר טוב"],
    "ספר החינוך": ["חינוך", "החינוך", "מנ\"ח"],
    "ספר המצוות": ["סה\"מ", "ספר המצות"],
    "סמ\"ג": ["סמ\"ג"],
}
PARASHOT = {
    "בראשית": ["בראשית", "נח", "לך לך", "וירא", "חיי שרה", "תולדות", "ויצא", "וישלח", "וישב", "מקץ", "ויגש", "ויחי"],
    "שמות": ["שמות", "וארא", "בא", "בשלח", "יתרו", "משפטים", "תרומה", "תצוה", "כי תשא", "ויקהל", "פקודי"],
    "ויקרא": ["ויקרא", "צו", "שמיני", "תזריע", "מצורע", "אחרי מות", "קדושים", "אמור", "בהר", "בחוקותי", "בחקתי"],
    "במדבר": ["במדבר", "נשא", "בהעלותך", "שלח", "קרח", "חקת", "חוקת", "בלק", "פינחס", "פנחס", "מטות", "מסעי"],
    "דברים": ["דברים", "ואתחנן", "עקב", "ראה", "שופטים", "כי תצא", "כי תבוא", "נצבים", "וילך", "האזינו", "וזאת הברכה"],
}
# a parasha named in brackets, as the books of mitzvot cite a verse: "[ואתחנן] וקשרתם לאות על ידך"
PARASHA_RE = {b: re.compile(r"[(\[]\s*(?:פרשת\s+|פ'\s+)?(" + "|".join(sorted(v, key=len, reverse=True)) + r")\s*[)\],]") for b, v in PARASHOT.items()}
GENERIC = {"על", "ספר", "חלק", "מסכת", "הלכות", "פירוש", "חידושי", "חדושי", "שו\"ת", "הגהות", "ביאור", "הערות", "משנה", "תלמוד", "מדרש", "סדר", "תורה"}
PREFIX = r"(?<![א-ת])(?:ו?[בדהלמשכ]{0,2})"


def aliases(db, book):
    """the names a text may call a book by: the title, its segments, known abbreviations, the DB's acronyms.
    For "P על Q" only P's names (and P + Q): a citation of the base Q is not a citation of its commentary."""
    title = norm(db.titles.get(book, ""))
    own = re.split(r"\s+על\s+", title, maxsplit=1)[0]
    out = {title}
    segs = []
    for part in re.split(r",\s*|\s+-\s+", own):
        part = part.strip()
        if part:
            segs.append(part)
    for p in segs:
        if p not in GENERIC and len(re.sub(r"[^א-ת]", "", p)) >= 3:
            out.add(p)
        m = re.match(r"הלכות (.+)", p)
        if m:
            out |= {f"הל' {m.group(1)}", f"הלכ' {m.group(1)}", f"הלכות {m.group(1)}"}
            if len(re.sub(r"[^א-ת]", "", m.group(1))) >= 5:
                out.add(m.group(1))
        m = re.match(r"(?:משנה|תלמוד ירושלמי|תוספתא) (.+)", p)
        if m and len(re.sub(r"[^א-ת]", "", m.group(1))) >= 3:
            out.add(m.group(1))
        for k, v in EXPAND.items():
            if k == p or k in p.split(" ") or p.startswith(k + " ") or p.endswith(" " + k) or k == title:
                out |= set(v)
    for t in db.acr.get(book, []):
        t = norm(t)
        other = db.by_title.get(t)
        if "." not in t and len(re.sub(r"[^א-ת]", "", t)) >= 2 and (other is None or other == book):
            out.add(t)
    keep = lambda a: a and len(re.sub(r"[^א-ת]", "", a)) >= 2 and a not in GENERIC and a not in ("תורה", "רמום") and not is_numeral(a)
    return sorted((a for a in out if keep(a)), key=len, reverse=True)


_alias_re = {}


def alias_re(db, book):
    if book not in _alias_re:
        al = aliases(db, book)
        alt = lambda a: re.sub(r"(?:ין|ים)(?=\s|$)", "(?:ין|ים)", re.escape(a))
        _alias_re[book] = re.compile(PREFIX + "(" + "|".join(alt(a) for a in al) + r")(?![א-ת])") if al else None
    return _alias_re[book]


# ─── features ────────────────────────────────────────────────────────────────────────────────────

# "שם" as a reference ("(שם", "שם ד"ה", "שם דף …", "שם סי' …", "ע"ש"), not the word "there" or "name"
IBID = re.compile(r"[(\[]\s*ו?שם(?![א-ת])|(?<![א-ת])ו?שם\s+(?:ב?ד\"ה|דף|סי'|סימן|פרק|פ\"|פ'|ס\"ק|סעיף|סעי'|הלכה|ה\"|בגמ'|במשנה|במתני'|ע\"[אב]|[א-ת]{1,3}[.:](?=\s|$)|[א-ת]{1,3}['\"][א-ת]?(?=[\s,.)\]]|$))|(?<![א-ת])בא\"ד(?![א-ת])")
SELF = re.compile(r"(?<![א-ת])(?:כ?ד?ל?עיל|ל?הלן|לקמן|למעלה|למטה|כדלקמן|כדלעיל|כנ\"ל|כמ\"ש)(?![א-ת])")
DH_MARK = re.compile(r"(?<![א-ת])(?:ב?ד\"ה|תוד\"ה|בא\"ד|סד\"ה|ד\"ה)(?![א-ת])")
LEAD = re.compile(r"^(?:\s*(?:[(\[][א-ת0-9]{1,4}[)\]]|[א-ת]{1,3}[).]|\*+|\d+[.)]?|[-–:•])\s*)+")
LEAD_WORDS = re.compile(r"^(?:(?:ב?ד\"ה|בא\"ד|סד\"ה|מתני'|מתניתין|גמ'|גמרא|בגמ'|בגמרא|משנה|במשנה|שם|בשם|תוס'|תוספות|תוד\"ה|בתוס'|רש\"י|ברש\"י|פרש\"י|הר\"ן|רמב\"ם|בר\"מ|ב\"ה|בס\"ד|פסוק|כתיב|כתב|וכו'|כו')[\s,.:]+)+")
DH_END = re.compile(r"\s(?:וכו'|כו'|וגו'|וגומר|עכ\"ל|פירוש|פי'|פירש|ר\"ל|כלומר|היינו|-|–)(?=\s|$)|[.:;](?:\s|$)")
MARKER_START = re.compile(r"^\s*([(\[]\s*[א-ת*]{1,3}\s*[)\]]|\*+)")


def dh_of(text):
    """the opening words of a line, as a commentary's dibur-hamatchil (skeleton words, 2–8)"""
    t = LEAD.sub("", text)
    t = LEAD_WORDS.sub("", t)
    t = LEAD.sub("", t)
    m = DH_END.search(t)
    head = t[:m.start()] if m and m.start() > 0 else " ".join(t.split()[:6])
    ws = words(head)[:8]
    return ws, bool(DH_MARK.search(text[:40]))


def same_word(a, b):
    """skeletons equal, or one a prefix of the other from 3 letters (גובים / גובה, ירושלמי / ירוש)"""
    return a == b or (min(len(a), len(b)) >= 3 and (a.startswith(b[:3]) and b.startswith(a[:3])) and abs(len(a) - len(b)) <= 2)


def find_run(needle, hay):
    """does the word sequence `needle` (its first 3, or 2 when that is all) occur contiguously in `hay`?
    Words compare loosely (same_word), and at least one of them exactly."""
    k = min(3, len(needle))
    if k < 2 or sum(len(w) for w in needle[:k]) < 5:
        return False
    n = needle[:k]
    for i in range(len(hay) - k + 1):
        win = hay[i:i + k]
        if all(same_word(a, b) for a, b in zip(n, win)) and any(a == b for a, b in zip(n, win)):
            return True
    return False


def overlap(a, b):
    """longest common contiguous word run of two skeleton lists, and where it starts in a"""
    if len(a) < 3 or len(b) < 3:
        return 0, -1
    grams = defaultdict(list)
    for i in range(len(b) - 2):
        grams[tuple(b[i:i + 3])].append(i)
    best, at = 0, -1
    for i in range(len(a) - 2):
        for j in grams.get(tuple(a[i:i + 3]), ()):
            n = 3
            while i + n < len(a) and j + n < len(b) and a[i + n] == b[j + n]:
                n += 1
            if n > best:
                best, at = n, i
    return best, at


def heref_loc(heref):
    """the location part of a Sefaria heRef ("רש\"י על ויקרא, כ, כו, א" → ["כ", "כו", "א"]; "ברכות ב." → ["ב"])"""
    parts = [p.strip() for p in norm(heref).split(",")]
    out = []
    for p in reversed(parts):
        toks = p.split()
        tail = []
        for tok in reversed(toks):
            t = tok.rstrip(".:")
            if is_numeral(t) or t.isdigit():
                tail.append(re.sub(r"['\"]", "", t).translate(FINALS))
            else:
                break
        if tail and len(tail) == len(toks):
            out = list(reversed(tail)) + out
        elif tail:
            out = list(reversed(tail)) + out
            break
        else:
            break
    return out


# Sefaria's index layers: who links what is decided by an index, not by a reference in either text
INDEX_LAYERS = {"EIN_MISHPAT", "RELATED", "MESORAT_HASHAS", "SIFREI_MITZVOT"}
COMMENTARY_LIKE = {"COMMENTARY", "SUPER_COMMENTARY", "TARGUM", "MIDRASH", "MISHNAH_IN_TALMUD", "REFERENCE", "FOOTNOTES", "EXPLICATION"}


def family(title, heref):
    """the kind of book a citation points at, for grouping the citation forms"""
    t = norm(title or "")
    if t in TANAKH:
        return "תנ\"ך"
    if re.search(r"זוהר|זהר|תיקוני|תקוני", t):
        return "זוהר ותיקונים"
    if t.startswith("משנה תורה") or t.startswith("רמב\"ם"):
        return "רמב\"ם"
    if re.search(r"שולחן ערוך|שלחן ערוך|^טור|ארבעה טורים", t):
        return "שו\"ע וטור"
    if t.startswith("משנה "):
        return "משנה"
    if t.startswith("תלמוד ירושלמי"):
        return "ירושלמי"
    if " על " in t and is_daf_ref(heref):
        return "מפרשי הש\"ס"
    if is_daf_ref(heref):
        return "בבלי"
    if " על " in t:
        return "מפרשים אחרים"
    if re.search(r"רבה|מדרש|ספרא|ספרי|מכילתא|ילקוט|תנחומא|פסיקתא|פרקי דרבי", t):
        return "מדרש"
    if re.search(r"שו\"ת|שות |תשובות", t):
        return "שו\"ת"
    return "שאר הספרים"


def cite_surface(s):
    """how a citation is written (the part that decides whether a pattern can read it)"""
    if IBID.search(s) or re.search(r"(?<![א-ת])(?:ו?שם|ע\"ש)(?![א-ת])", s):
        return "\"שם\""
    if SELF.search(s):
        return "לעיל/להלן"
    if re.search(r"ד\"ה|תוד\"ה", s):
        return "ד\"ה"
    if re.search(r"(?<![א-ת])(?:פ\"ק|פרק קמא|פרק בתרא|פ' בתרא)(?![א-ת])", s) or re.search(r"(?<![א-ת])(?:פרק|בפרק|פ'|בפ'|ר\"פ|ס\"פ|בר\"פ|רפ\"ק)\s+(?![א-ת]{1,3}['\"])(?!\w{1,3}(?:\s|$))[א-ת]{2,}", s):
        return "פרק בשמו"
    if re.search(r"(?<![א-ת])[א-ת]{1,3}['\"]?[א-ת]?\s*,?\s+[אב]['׳](?![א-ת])", s):
        return "עמוד כאות (\"לט ב'\")"
    if re.search(r"(?<![א-ת])(?:סי'|סימן|ס\"ק|סעיף|סעי'|הל'|הלכה|ה\"[א-ת])", s):
        return "סימן/הלכה"
    return "מספרים"


def cite_form(snippet, title="", heref=""):
    return f"{family(title, heref)} · {cite_surface(snippet)}"


def dh_form(dep_text, marked, kind):
    t = norm(visible(dep_text))
    lead = "סימן הערה בפתיחה" if MARKER_START.match(t) else ""
    if marked:
        f = "ד\"ה מפורש (\"ד\"ה\", \"בא\"ד\")"
    elif re.match(r"^\s*(?:[(\[][^)\]]{1,4}[)\]]\s*)?(?:מתני'|גמ'|משנה|גמרא)", t):
        f = "פתיחה \"מתני'\" / \"גמ'\""
    elif re.search(r"^[^.:]{0,80}?\s(?:וכו'|כו'|וגו')", t):
        f = "מילים + \"וכו'\""
    else:
        f = "מילים בפתיחה בלי סימן"
    return f + (" · " + lead if lead else "") + (" · זוג לא מתוכנן" if kind == "U" else "")


def section_keys(heref, toc):
    """the numbers that place a line in its book's top sections: its heRef's location, or the numbers in its headings"""
    loc = heref_loc(heref) if heref else []
    if loc:
        return set(loc[:1]), True
    keys = set()
    for t in toc or []:
        keys |= set(numerals(norm(t), plain=True))
    return keys, False


def is_daf_ref(heref):
    """a Talmud-style location ("ברכות, ב., א"): its second number is a segment, not a cited unit"""
    return bool(re.search(r"[א-ת][.:](?:\s|,|$)", norm(heref or "")))


TANAKH = {"בראשית", "שמות", "ויקרא", "במדבר", "דברים", "יהושע", "שופטים", "שמואל א", "שמואל ב", "מלכים א", "מלכים ב", "ישעיהו",
          "ירמיהו", "יחזקאל", "הושע", "יואל", "עמוס", "עובדיה", "יונה", "מיכה", "נחום", "חבקוק", "צפניה", "חגי", "זכריה", "מלאכי",
          "תהילים", "משלי", "איוב", "שיר השירים", "רות", "איכה", "קהלת", "אסתר", "דניאל", "עזרא", "נחמיה", "דברי הימים א", "דברי הימים ב"}


def cite_matches(cited, heref):
    """does a citation's numbers agree with the linked line's location? (None: cannot tell) — for a verse
    ("ויקרא, ו, א") both chapter and verse must be cited when two numbers are; elsewhere one shared number
    (a chapter, a siman, a daf) is enough"""
    loc = heref_loc(heref) if heref else []
    if not cited or not loc:
        return None
    if len(loc) == 2 and len(cited) >= 2 and norm(heref).split(",")[0].strip() in TANAKH:
        return loc[0] in cited and loc[1] in cited
    return bool(set(cited) & set(loc))


def name_hits(db, xv, yb):
    """the other book's names in a line: [(match, a single-word name outside brackets?)] — "שבת", "נדה",
    "כלה" are also plain words; "(ברכות:)", "במס' שבת" are names"""
    rx = alias_re(db, yb)
    if not rx:
        return []
    out = []
    for m in rx.finditer(xv):
        name = m.group(1)
        lone = " " not in name and '"' not in name and "'" not in name
        bracketed = re.search(r"[(\[]\s*\S{0,4}$", xv[max(0, m.start() - 6):m.start() + 1]) or re.search(
            r"(?:במס'|מסכת|בגמ'|בגמרא|במסכת)\s*$", xv[max(0, m.start() - 10):m.start()])
        out.append((m, lone and not bracketed))
    return out


def classify(db, it):
    """one missed link → (class, sub, form, evidence)"""
    sb, sl, tb, tl = it["sb"], it["sl"], it["tb"], it["tl"]
    S, T = it["sText"], it["tText"]
    sv, tv = norm(visible(S)), norm(visible(T))
    sw, tw = words(sv), words(tv)
    typ, kind = it["type"], it["kind"]
    ev = {}
    # C: an empty end
    if not sw or not tw:
        return "C", "שורה ריקה", "", {"sWords": len(sw), "tWords": len(tw)}

    # (side, its text, its words, its book, the other book, the other's text, the other's words, the other's heRef, an anchor on this side)
    sides = [("s", sv, sw, sb, tb, tv, tw, it["tHeRef"], it.get("anchor"))]
    if typ != "LINKER":
        sides.append(("t", tv, tw, tb, sb, sv, sw, it["sHeRef"], None))
    ov, at = overlap(sw, tw)
    ov2, at2 = overlap(tw, sw)
    shared = max(ov, ov2)

    # A-cite: the other book named with a location next to the name (after it, or "פ"ו מ"ד ד<book>" before it);
    # for LINKER, the words Sefaria's linker anchored. C when every such citation points elsewhere and the
    # lines share no text.
    cites = []
    for side, xv, xw, xb, yb, yv, yw, yheref, anchor in sides:
        if anchor:
            a0, a1 = anchor
            win = norm(visible(S)[a0:(a1 or a0 + 40)])
            rx = alias_re(db, yb)
            bare = rx.sub(lambda m: " " * len(m.group(0)), win) if rx else win
            cites.append((side, win, numerals(bare), yheref, yb))
            break
        if xb != yb:
            for m, lone in name_hits(db, xv, yb):
                after, before = xv[m.end():m.end() + 16], xv[max(0, m.start() - 16):m.start() + 1]
                construct = xv[m.start():m.start() + 1] == "ד"
                if has_location(after) or (construct and has_location(before)):
                    lo = max(0, m.start() - 16) if construct else m.start()
                    win = xv[lo:m.end() + 24]
                    cites.append((side, win, numerals(win, start=0 if construct else m.end() - lo), yheref, yb))
        m = SELF.search(xv)
        if m and has_location(xv[m.end():m.end() + 24]):
            win = xv[m.start():m.end() + 24]
            cited = numerals(win)
            # in the same book, or a commentary's "לקמן (פי"ב מ"ג)" that is its base's location
            if xb == yb or (kind == "D" and cite_matches(cited, yheref)):
                cites.append((side, win, cited, yheref, yb))
    if cites:
        verdicts = [cite_matches(c, h) for _, _, c, h, _ in cites]
        ev["cite"] = cites[0][1]
        if typ in INDEX_LAYERS and all(v is False for v in verdicts):
            ev["cited"] = cites[0][2][:4]
            return "B", "B2 הטקסט מפנה למקום אחר באותו ספר (שכבת מפתח)", "", ev
        if all(v is False for v in verdicts) and shared < 4 and not any(IBID.search(w) for _, w, _, _, _ in cites):
            ev["cited"], ev["heRef"] = cites[0][2][:4], heref_loc(cites[0][3])
            return "C", "ההפניה בטקסט מצביעה למקום אחר", cite_form(cites[0][1], db.titles.get(cites[0][4], ""), cites[0][3]), ev
        good = next((c for c, v in zip(cites, verdicts) if v is not False), cites[0])
        return "A", "הפניה: שם ספר + מקום", cite_form(good[1], db.titles.get(good[4], ""), good[3]), ev

    # A-ibid: a "שם" reference, with the other book named before it (in the line, or the three lines above)
    for side, xv, xw, xb, yb, yv, yw, yheref, anchor in sides:
        rx = alias_re(db, yb) if xb != yb else None
        m = IBID.search(xv)
        if rx and m:
            ctx = it.get("sCtx" if side == "s" else "tCtx", "")
            if rx.search(xv[:m.start() + 1]) or rx.search(ctx):
                ev["ibid"] = xv[max(0, m.start() - 40):m.end() + 40]
                return "A", "\"שם\" אחרי הפניה בשורות שלפני", f"{family(db.titles.get(yb, ''), yheref)} · \"שם\"", ev

    # A-marker: a footnote marker that opens one line and stands inside the other (not two numbered paragraphs)
    for side, xv, xw, xb, yb, yv, yw, yheref, anchor in sides:
        m = MARKER_START.match(yv)
        if m:
            mk = re.sub(r"\s", "", m.group(1))
            body = re.sub(r"\s", "", MARKER_START.sub("", xv, count=1))
            if len(mk) >= 3 and mk in body:
                ev["marker"] = mk
                return "A", "סימן הערה", "סימן הערה בשני הצדדים", ev

    # A-dh: a commentary line opens with words found in its base line (one word, when "ד"ה" marks it).
    # A planned pair: the dependant's opening only (the base's opening quoted in a commentary is a quote),
    # except a mishna in the Talmud and a targum, where either side may open with the other.
    commentary_like = typ in COMMENTARY_LIKE or kind == "D"
    if kind == "D":
        order = [x for x in sides if x[3] == it["owner_book"]]
        if typ in ("MISHNAH_IN_TALMUD", "TARGUM"):
            order += [x for x in sides if x[3] != it["owner_book"]]
    else:
        order = sides
    for side, xv, xw, xb, yb, yv, yw, yheref, anchor in order:
        dh, marked = dh_of(xv)
        if not (commentary_like or marked):
            continue
        hit = len(dh) >= 2 and find_run(dh, yw)
        if not hit and len(dh) >= 2 and sum(len(w) for w in dh[:2]) >= 5:
            hit = find_run(dh[:2], yw)
        if not hit and marked and dh and len(dh[0]) >= 3:
            hit = dh[0] in yw
        if hit:
            ev["dh"] = " ".join(dh[:5])
            return "A", "דיבור המתחיל", dh_form(S if side == "s" else T, marked, kind), ev
    # a planned commentary that quotes its base line at length (Chavruta; "ויאמר … וקח מאתם מטה מטה")
    if kind == "D" and typ in COMMENTARY_LIKE and shared >= 5:
        ev["shared"] = shared
        return "A", "דיבור המתחיל", "ציטוט ארוך של הבסיס בתוך הפירוש", ev

    # C: the dibur-hamatchil is in a neighbouring line of the other book, not in the linked one
    if commentary_like and shared < 4:
        for side, xv, xw, xb, yb, yv, yw, yheref, anchor in order:
            dh, marked = dh_of(xv)
            near = it.get("tNear" if side == "s" else "sNear", {})
            if len(dh) >= 3:
                for off, txt in sorted(near.items(), key=lambda x: abs(int(x[0]))):
                    if int(off) and find_run(dh, words(norm(visible(txt)))):
                        ev["dh"], ev["offset"] = " ".join(dh[:5]), int(off)
                        return "C", "הד\"ה נמצא בשורה סמוכה, לא בשורה המקושרת", "", ev

    # A-section: a commentary and its base in the same section (daf, siman, chapter) by heRef or by
    # headings; two commentaries of a planned pair at the very same location ("ג, ג, א")
    st, tt = db.titles.get(sb, ""), db.titles.get(tb, "")
    title_related = bool((tt and tt in st) or (st and st in tt))
    sl_loc, tl_loc = heref_loc(it["sHeRef"]), heref_loc(it["tHeRef"])
    if sb != tb and kind == "D" and len(sl_loc) >= 2 and sl_loc == tl_loc:
        ev["section"] = sl_loc
        return "A", "אותו סימן/דף לפי הכותרות", "שני מפרשים באותו מקום בדיוק", ev
    if sb != tb and ((kind == "D" and typ in COMMENTARY_LIKE) or title_related):
        ks, s_ref = section_keys(it["sHeRef"], it.get("sToc"))
        kt, t_ref = section_keys(it["tHeRef"], it.get("tToc"))
        if ks and kt and (ks & kt) and (s_ref or t_ref):
            ev["section"] = sorted(ks & kt)[:3]
            how = "לפי heRef בשני הצדדים" if s_ref and t_ref else "לפי הכותרות של צד אחד"
            return "A", "אותו סימן/דף לפי הכותרות", how + (" · זוג לא מתוכנן" if kind == "U" else ""), ev

    # the book named without a location (a single-word name only in brackets: "(ברכות:)"; a parasha in
    # brackets for a book of the Torah), and the lines share text
    for side, xv, xw, xb, yb, yv, yw, yheref, anchor in sides:
        if xb == yb:
            continue
        hits = [m.group(1) for m, lone in name_hits(db, xv, yb) if not lone]
        par = PARASHA_RE.get(db.titles.get(yb, ""))
        if par and par.search(xv):
            hits.append(par.search(xv).group(0))
        if hits and shared >= 3:
            ev["name"], ev["shared"] = hits[0], shared
            return "A", "שם ספר + ציטוט", "שם הספר בלי מקום, עם ציטוט", ev

    if shared >= 4:
        ev["shared"] = shared
        opening = at == 0 or at2 == 0
        return "B", "B1 ציטוט משותף בלי הפניה", "פתיחה משותפת" if opening else "ציטוט באמצע השורה", ev
    for side, xv, xw, xb, yb, yv, yw, yheref, anchor in sides:
        hits = name_hits(db, xv, yb) if xb != yb else []
        if hits:
            ev["name"] = hits[0][0].group(1)
            return "B", "B2 שם הספר בלי מקום", "", ev
    return "B", "B2 אין דבר בטקסט", "", ev


# ─── sample of misses ────────────────────────────────────────────────────────────────────────────

def rank(unit):
    return int(hashlib.sha1(f"{SEED}|{unit}".encode()).hexdigest()[:8], 16)


def decode(s):
    if not s:
        return []
    acc, out = 0, []
    for d in s.split("."):
        acc += int(d, 36)
        out.append(acc)
    return out


def read_records(bench):
    """as library-benchmark.test.ts readRecords: later files (runs-~only last) replace a book's record unless they stopped more"""
    done = {}
    for f in sorted(x for x in os.listdir(bench) if re.match(r"^runs-.*\.jsonl$", x)):
        for line in open(os.path.join(bench, f), encoding="utf-8"):
            if line.strip():
                r = json.loads(line)
                old = done.get(r["id"])
                if not old or len(r["stopped"]) <= len(old["stopped"]):
                    done[r["id"]] = r
    return done


def cmd_classify(bench, per_owner="10"):
    per_owner = int(per_owner)
    db = Db()
    design = json.load(open(os.path.join(bench, "design-report-sample.json"), encoding="utf-8"))
    done = read_records(bench)
    matched = defaultdict(set)
    for r in done.values():
        for k, enc in r["matched"].items():
            matched[k].update(decode(enc))
    items, owners = [], []
    for typ, kinds in design["types"].items():
        for k in kinds:
            for st in k["strata"]:
                for o in st["owners"]:
                    if not o["ran"]:
                        continue
                    key = f"{typ}|{o['id']}"
                    links = []
                    for s, t, n in design["pairs"].get(key, []):
                        links += db.links(typ, s, t)
                    got = matched.get(key, set())
                    miss = [x for x in links if x[0] not in got]
                    owners.append({"type": typ, "kind": k["kind"], "stratum": st["name"], "stratumLinks": st["links"], "population": st["population"],
                                   "owner": o["id"], "links": o["links"], "found": len(links), "matched": len(got & {x[0] for x in links}), "misses": len(miss)})
                    miss.sort(key=lambda x: rank(f"link:{x[0]}"))
                    for x in miss[:per_owner]:
                        items.append({"type": typ, "kind": k["kind"], "stratum": st["name"], "owner": o["id"], "owner_book": int(o["id"][2:].split("-")[0]),
                                      "id": x[0], "sb": x[1], "sl": x[2], "tb": x[3], "tl": x[4]})
    print(f"{len(owners)} owners, {len(items)} sampled misses; reading lines…", file=sys.stderr)
    ranges, anchors = db.link_extras(it["id"] for it in items)
    need = defaultdict(set)
    for it in items:
        need[it["sb"]] |= {it["sl"], it["sl"] - 1, it["sl"] - 2, it["sl"] - 3}
        need[it["tb"]] |= {it["tl"] + d for d in range(-3, 4)}
        need[it["tb"]] |= {it["tl"] - 1, it["tl"] - 2, it["tl"] - 3}
        need[it["sb"]] |= {it["sl"] + d for d in range(-3, 4)}
    for b, idx in need.items():
        db.lines(b, sorted(idx))
    raw = open(os.path.join(bench, "gaps-raw.jsonl"), "w", encoding="utf-8")
    for it in items:
        g = lambda b, i: db.cache.get((b, i), ("", "", False, None))
        it["sText"], it["sHeRef"], it["sHead"], stoc = g(it["sb"], it["sl"])
        it["tText"], it["tHeRef"], it["tHead"], ttoc = g(it["tb"], it["tl"])
        it["sToc"], it["tToc"] = db.toc_path(it["sb"], stoc), db.toc_path(it["tb"], ttoc)
        it["sEnd"], it["tEnd"] = ranges.get((it["id"], 0)), ranges.get((it["id"], 1))
        a = anchors.get((it["id"], 0))
        if a and it["type"] == "LINKER":
            it["anchor"] = a
        it["sCtx"] = " ".join(norm(visible(g(it["sb"], it["sl"] - d)[0])) for d in (3, 2, 1))
        it["tCtx"] = " ".join(norm(visible(g(it["tb"], it["tl"] - d)[0])) for d in (3, 2, 1))
        it["tNear"] = {str(d): g(it["tb"], it["tl"] + d)[0] for d in range(-3, 4)}
        it["sNear"] = {str(d): g(it["sb"], it["sl"] + d)[0] for d in range(-3, 4)}
        it["sTitle"], it["tTitle"] = db.titles.get(it["sb"]), db.titles.get(it["tb"])
        raw.write(json.dumps(it, ensure_ascii=False) + "\n")
    raw.close()
    json.dump(owners, open(os.path.join(bench, "gaps-owners.json"), "w", encoding="utf-8"), ensure_ascii=False)
    cmd_reclassify(bench, db)


def cmd_reclassify(bench, db=None):
    """classify the sampled misses again (gaps-raw.jsonl → gaps-items.jsonl) without reading the links again"""
    db = db if isinstance(db, Db) else Db()
    owners = json.load(open(os.path.join(bench, "gaps-owners.json"), encoding="utf-8"))
    items = []
    with open(os.path.join(bench, "gaps-items.jsonl"), "w", encoding="utf-8") as out:
        for line in open(os.path.join(bench, "gaps-raw.jsonl"), encoding="utf-8"):
            it = json.loads(line)
            it["cls"], it["sub"], it["form"], it["ev"] = classify(db, it)
            for k in ("sNear", "tNear", "sCtx", "tCtx"):
                it.pop(k)
            out.write(json.dumps(it, ensure_ascii=False) + "\n")
            items.append(it)
    summarize(bench, owners, items)


# ─── estimates ───────────────────────────────────────────────────────────────────────────────────

def weights(owners, items):
    """each sampled miss → the number of the type's missed links it stands for (stratified ratio expansion)"""
    by_st = defaultdict(list)
    for o in owners:
        by_st[(o["type"], o["kind"], o["stratum"])].append(o)
    k_of = Counter((it["type"], it["owner"]) for it in items)
    w = {}
    for (typ, kind, stn), os_ in by_st.items():
        L = sum(o["found"] for o in os_)
        if not L:
            continue
        exp = os_[0]["stratumLinks"] / L
        for o in os_:
            k = k_of.get((typ, o["owner"]), 0)
            if k:
                w[(typ, o["owner"])] = exp * o["misses"] / k
    return w


def shares(owners, items, keyf, types=None, boot=BOOT):
    """estimated missed links per key (class, sub…) per type, with a bootstrap over owners within strata"""
    def est(owners_, items_):
        w = weights(owners_, items_)
        out = defaultdict(lambda: defaultdict(float))
        for it in items_:
            ww = w.get((it["type"], it["owner"]))
            if ww:
                out[it["type"]][keyf(it)] += ww
        return out

    point = est(owners, items)
    rng = random.Random(7)
    by_st = defaultdict(list)
    for o in owners:
        by_st[(o["type"], o["kind"], o["stratum"])].append(o)
    its_by = defaultdict(list)
    for it in items:
        its_by[(it["type"], it["owner"])].append(it)
    reps = []
    for _ in range(boot):
        o2, i2 = [], []
        for key, os_ in by_st.items():
            for j in range(len(os_)):
                o = rng.choice(os_)
                tag = f"{o['owner']}#{j}"
                o2.append({**o, "owner": tag})
                i2 += [{**it, "owner": tag} for it in its_by.get((o["type"], o["owner"]), [])]
        reps.append(est(o2, i2))
    return point, reps


def ci(vals):
    vals = sorted(vals)
    if not vals:
        return (0, 0)
    return vals[int(0.025 * len(vals))], vals[min(len(vals) - 1, int(0.975 * len(vals)))]


def summarize(bench, owners, items):
    design = json.load(open(os.path.join(bench, "design-report-sample.json"), encoding="utf-8"))
    oracle = [f for f in os.listdir(bench) if f.startswith("oracle-")][0]
    rows = json.load(open(os.path.join(bench, oracle), encoding="utf-8"))["rows"]
    total = Counter()
    for t, s, g, n in rows:
        total[t] += n
    point, reps = shares(owners, items, lambda it: it["cls"])
    types = sorted(point, key=lambda t: -sum(point[t].values()))
    res = {"types": {}, "subs": {}, "forms": {}}
    lines = ["type                  links   missed(est)   A          B          C           (share of the missed links, 95% bootstrap)"]
    grand = Counter()
    grand_reps = [Counter() for _ in reps]
    for t in types:
        m = sum(point[t].values())
        row = {"dbLinks": total[t], "missed": round(m), "n": sum(1 for it in items if it["type"] == t)}
        cells = []
        for c in "ABC":
            p = point[t].get(c, 0) / m if m else 0
            lo, hi = ci([(r[t].get(c, 0) / sum(r[t].values())) if sum(r[t].values()) else 0 for r in reps])
            row[c] = [p, lo, hi]
            cells.append(f"{100 * p:5.1f} ({100 * lo:4.1f}–{100 * hi:4.1f})")
            grand[c] += point[t].get(c, 0)
            for r, g in zip(reps, grand_reps):
                g[c] += r[t].get(c, 0)
        res["types"][t] = row
        lines.append(f"{t:18} {total[t]:9} {round(m):11}   " + "  ".join(cells))
    G = sum(grand.values())
    row = {"missed": round(G)}
    cells = []
    for c in "ABC":
        lo, hi = ci([g[c] / sum(g.values()) for g in grand_reps])
        row[c] = [grand[c] / G, lo, hi]
        cells.append(f"{100 * grand[c] / G:5.1f} ({100 * lo:4.1f}–{100 * hi:4.1f})")
    res["all"] = row
    lines.append(f"{'ALL':18} {sum(total.values()):9} {round(G):11}   " + "  ".join(cells))
    # sub-classes and forms, weighted
    w = weights(owners, items)
    subs, forms = defaultdict(lambda: [0.0, 0]), defaultdict(lambda: [0.0, 0])
    for it in items:
        ww = w.get((it["type"], it["owner"]), 0)
        subs[(it["type"], it["cls"], it["sub"])][0] += ww
        subs[(it["type"], it["cls"], it["sub"])][1] += 1
        if it["cls"] == "A":
            forms[(it["sub"], it["form"])][0] += ww
            forms[(it["sub"], it["form"])][1] += 1
            forms[(it["type"] + "|" + it["kind"], it["sub"], it["form"])][0] += ww
            forms[(it["type"] + "|" + it["kind"], it["sub"], it["form"])][1] += 1
    res["subs"] = {"|".join(k): v for k, v in sorted(subs.items(), key=lambda x: -x[1][0])}
    res["forms"] = {"|".join(k): v for k, v in sorted(forms.items(), key=lambda x: -x[1][0])}
    # kind split: A in planned pairs (D) vs unplanned (U)
    kinds = defaultdict(float)
    for it in items:
        kinds[(it["type"], it["kind"], it["cls"])] += w.get((it["type"], it["owner"]), 0)
    res["kinds"] = {"|".join(k): v for k, v in kinds.items()}
    # which engine an A miss belongs to: a citation is the citations engine's in any pair (it runs on every
    # book); a dibur-hamatchil / heading / marker is the pair engines' in a planned pair, the planner's otherwise
    work, books = defaultdict(lambda: [0.0, 0]), defaultdict(lambda: [0.0, 0])
    for it in items:
        if it["cls"] != "A":
            continue
        ww = w.get((it["type"], it["owner"]), 0)
        cite = it["sub"].startswith("הפניה") or it["sub"].startswith("\"שם\"") or it["sub"].startswith("שם ספר")
        bucket = "מראי מקומות" if cite else ("מנועי הזוג (ד\"ה, כותרות, הערות)" if it["kind"] == "D" else "המתכנן (זוג לא מתוכנן)")
        for k in (bucket, f"{bucket}|{it['type']}"):
            work[k][0] += ww
            work[k][1] += 1
        if cite:
            b = it["sTitle"] if it["type"] == "LINKER" else (it["sTitle"] if it["kind"] == "D" else " ↔ ".join(sorted([it["sTitle"], it["tTitle"]])))
            books[b][0] += ww
            books[b][1] += 1
    res["work"] = {k: v for k, v in sorted(work.items(), key=lambda x: -x[1][0])}
    res["citeBooks"] = {k: v for k, v in sorted(books.items(), key=lambda x: -x[1][0])[:25]}
    json.dump(res, open(os.path.join(bench, "gaps-summary.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("\n".join(lines))
    print("\nA forms (estimated missed links, sampled items):")
    for k, v in list(res["forms"].items()):
        if k.count("|") == 1:
            print(f"  {v[0]:10.0f} {v[1]:5}  {k}")


# ─── hand check ──────────────────────────────────────────────────────────────────────────────────

def show(it, width=420):
    v = visible(it["sText"])
    a = it.get("anchor")
    if a:
        a0, a1 = a[0], a[1] or a[0]
        lo = max(0, a0 - width // 2)
        s = norm(("…" if lo else "") + v[lo:a0] + " ⟦" + v[a0:a1] + "⟧ " + v[a1:a1 + width // 2])
    else:
        s = norm(v)[:width]
    return s, norm(visible(it["tText"]))[:width]


def cmd_handcheck(bench, n="160", tag="set1", seed="11", exclude=""):
    """a blind sample to label by hand: per type in proportion to its estimated misses, at least 6 for the
    larger ones; `exclude`: the keys of earlier sets (comma-separated tags), whose links are not drawn again"""
    n = int(n)
    taken = set()
    for t in filter(None, exclude.split(",")):
        taken |= {int(l.split("	")[1]) for l in open(os.path.join(bench, f"gaps-handcheck-{t}-key.tsv"), encoding="utf-8")}
    items = [json.loads(l) for l in open(os.path.join(bench, "gaps-items.jsonl"), encoding="utf-8")]
    owners = json.load(open(os.path.join(bench, "gaps-owners.json"), encoding="utf-8"))
    w = weights(owners, items)
    by_type = defaultdict(list)
    for it in items:
        by_type[it["type"]].append(it)
    mass = {t: sum(w.get((t, it["owner"]), 0) for it in its) for t, its in by_type.items()}
    big = [t for t in mass if mass[t] >= 1000]
    quota = {t: max(6, round(n * mass[t] / sum(mass[x] for x in big))) for t in big}
    rng = random.Random(int(seed))
    picked = []
    for t, q in quota.items():
        its = by_type[t]
        ws = [w.get((t, it["owner"]), 0) for it in its]
        seen = set()
        for _ in range(q * 20):
            if len([p for p in picked if p["type"] == t]) >= q:
                break
            it = rng.choices(its, weights=ws)[0]
            if it["id"] not in seen and it["id"] not in taken:
                seen.add(it["id"])
                picked.append(it)
    db = Db()
    with open(os.path.join(bench, f"gaps-handcheck-{tag}.txt"), "w", encoding="utf-8") as f:
        for i, it in enumerate(picked):
            s, t = show(it, 650)
            prev = " / ".join(norm(visible(x[0]))[:160] for x in db.lines(it["sb"], [it["sl"] - 2, it["sl"] - 1]).values())
            f.write(f"#{i} id={it['id']} {it['type']} {it['kind']}\n  S [{it['sTitle']} :{it['sl']}] {it['sHeRef']}\n    (2 lines before: {prev})\n    {s}\n  T [{it['tTitle']} :{it['tl']}{'-' + str(it['tEnd']) if it.get('tEnd') else ''}] {it['tHeRef']}\n    {t}\n\n")
    with open(os.path.join(bench, f"gaps-handcheck-{tag}-key.tsv"), "w", encoding="utf-8") as f:
        for i, it in enumerate(picked):
            f.write(f"{i}\t{it['id']}\t{it['type']}\t{it['cls']}\t{it['sub']}\t{it['form']}\n")
    print(f"{len(picked)} items: " + ", ".join(f"{t} {q}" for t, q in quota.items()))


def cmd_agree(bench, labels, tag="set1"):
    """the classifier's classes against hand labels (`<n>	<A|B|C>…` per line) of one hand-check set"""
    key = {}
    for line in open(os.path.join(bench, f"gaps-handcheck-{tag}-key.tsv"), encoding="utf-8"):
        i, lid, typ, c, sub, form = line.rstrip("\n").split("\t")
        key[int(i)] = (typ, c, sub)
    hand = {}
    for line in open(labels, encoding="utf-8"):
        if line.strip() and not line.startswith("#"):
            i, c, *note = line.rstrip("\n").split("\t")
            hand[int(i)] = (c.strip(), note[0] if note else "")
    conf = Counter()
    per_type = defaultdict(Counter)
    for i, (h, note) in hand.items():
        typ, c, sub = key[i]
        conf[(c, h)] += 1
        per_type[typ]["n"] += 1
        per_type[typ]["agree"] += c == h
    n = sum(conf.values())
    agree = sum(v for (a, b), v in conf.items() if a == b)
    print(f"agreement {agree}/{n} = {100 * agree / n:.1f}%")
    print("classifier \\ hand: " + "  ".join(f"{a}->{b}: {v}" for (a, b), v in sorted(conf.items())))
    pa = {c: sum(v for (a, b), v in conf.items() if a == c) / n for c in "ABC"}
    pb = {c: sum(v for (a, b), v in conf.items() if b == c) / n for c in "ABC"}
    pe = sum(pa[c] * pb[c] for c in "ABC")
    print(f"Cohen's kappa {(agree / n - pe) / (1 - pe):.2f}")
    for c in "ABC":
        tp = conf[(c, c)]
        pred = sum(v for (a, b), v in conf.items() if a == c)
        real = sum(v for (a, b), v in conf.items() if b == c)
        print(f"  {c}: precision {tp}/{pred}  recall {tp}/{real}")
    for t, v in sorted(per_type.items()):
        print(f"  {t:18} {v['agree']}/{v['n']}")
    json.dump({"n": n, "agree": agree, "confusion": {f"{a}>{b}": v for (a, b), v in conf.items()}, "perType": {t: dict(v) for t, v in per_type.items()}},
              open(os.path.join(bench, f"gaps-agreement-{tag}.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)


# ─── the tool's new suggestions ─────────────────────────────────────────────────────────────────

def cmd_fresh(bench, per_tier="20"):
    """new suggestions (the database has no link from the line to that book), sampled per tier in proportion to how many each kept example stands for"""
    per_tier = int(per_tier)
    db = Db()
    done = read_records(bench)
    pool = defaultdict(list)
    totals = Counter()
    for r in done.values():
        for k, v in r.get("counters", {}).items():
            g, c, p = k.split("|")
            totals[(g, c)] += v[3]
        groups = defaultdict(list)
        for x in r.get("fresh") or []:
            if x["verdict"] == "unconfirmed":
                groups[(x["group"], x["confidence"], x["pairType"])].append(x)
        for (g, c, p), xs in groups.items():
            n_new = r["counters"].get(f"{g}|{c}|{p}", [0, 0, 0, 0])[3]
            for x in xs:
                pool[(g, c)].append((n_new / len(xs), r, x))
    rng = random.Random(13)
    picked = []
    for tier in sorted(pool):
        xs = pool[tier]
        seen = set()
        for _ in range(per_tier * 30):
            if len(seen) >= min(per_tier, len(xs)):
                break
            wgt, r, x = rng.choices(xs, weights=[a for a, _, _ in xs])[0]
            key = (r["id"], x["line"], x["target"], x["tLine"])
            if key in seen:
                continue
            seen.add(key)
            picked.append((tier, r, x))
    tb_lines = defaultdict(set)
    for tier, r, x in picked:
        tb = db.by_title.get(x["target"])
        x["tb"] = tb
        tb_lines[r["id"]] |= {x["line"], x["line"] - 1}
        if tb is not None:
            tb_lines[tb] |= set(range(x["tLine"], min(x["tEnd"], x["tLine"] + 2) + 1))
    for b, idx in tb_lines.items():
        db.lines(b, sorted(idx))
    with open(os.path.join(bench, "fresh-handcheck.txt"), "w", encoding="utf-8") as f, open(os.path.join(bench, "fresh-handcheck-key.tsv"), "w", encoding="utf-8") as k:
        for i, (tier, r, x) in enumerate(picked):
            s = norm(visible(db.cache.get((r["id"], x["line"]), ("",))[0]))[:450]
            t = " | ".join(norm(visible(db.cache.get((x["tb"], l), ("",))[0]))[:300] for l in range(x["tLine"], min(x["tEnd"], x["tLine"] + 2) + 1)) if x["tb"] is not None else x["tText"]
            f.write(f"#{i} {tier[0]} {tier[1]} [{','.join(x['engines'])}] pair={x['pairType']}\n  S [{r['title']} :{x['line']}]\n    {s}\n    (the cited words: {x['text'][:160]})\n  T [{x['target']} :{x['tLine']}{'-' + str(x['tEnd']) if x['tEnd'] != x['tLine'] else ''}] {x['heRef2']}\n    {t}\n\n")
            k.write(f"{i}\t{tier[0]}\t{tier[1]}\t{x['pairType']}\n")
    json.dump({f"{g}|{c}": v for (g, c), v in totals.items()}, open(os.path.join(bench, "fresh-totals.json"), "w", encoding="utf-8"), indent=1)
    print(f"{len(picked)} new suggestions: " + ", ".join(f"{t[0]}|{t[1]} {sum(1 for p in picked if p[0] == t)}" for t in sorted(pool)))
    print("new per tier (all run books): " + ", ".join(f"{g}|{c} {v}" for (g, c), v in sorted(totals.items())))


def cmd_freshscore(bench, labels):
    key = {}
    for line in open(os.path.join(bench, "fresh-handcheck-key.tsv"), encoding="utf-8"):
        i, g, c, p = line.rstrip("\n").split("\t")
        key[int(i)] = (g, c)
    tally = defaultdict(Counter)
    for line in open(labels, encoding="utf-8"):
        if line.strip() and not line.startswith("#"):
            i, lab, *_ = line.rstrip("\n").split("\t")
            tally[key[int(i)]][lab.strip()] += 1
    totals = json.load(open(os.path.join(bench, "fresh-totals.json"), encoding="utf-8"))
    out = {}
    for tier, c in sorted(tally.items()):
        n = sum(c.values())
        ok = c["right"] + c["near"]
        p = c["right"] / n
        half = 1.96 * math.sqrt(p * (1 - p) / n)
        out["|".join(tier)] = {"n": n, **c, "new": totals.get("|".join(tier), 0)}
        print(f"{'|'.join(tier):22} n={n:3}  right {c['right']:3}  near {c['near']:3}  wrong {c['wrong']:3}  unclear {c['unclear']:3}   right {100 * p:.0f}% ±{100 * half:.0f}  (+near {100 * ok / n:.0f}%)   new in run: {totals.get('|'.join(tier), 0)}")
    json.dump(out, open(os.path.join(bench, "fresh-score.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)


def wilson(k, n):
    if not n:
        return (0.0, 0.0)
    z, p = 1.96, k / n
    c = (p + z * z / (2 * n)) / (1 + z * z / n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return (max(0.0, c - h), min(1.0, c + h))


def cmd_truth(bench, tags="set1,set2"):
    """A/B/C from the hand labels themselves (truth-<tag>.tsv: the blind labels, disagreements with the
    classifier adjudicated): each hand-check set is a draw of misses in proportion to the links they stand
    for, so per type the labelled shares estimate the type's shares directly. All types together: weighted
    by each type's estimated missed links (gaps-summary.json), with a bootstrap over the labelled items.
    Also the classifier's shares corrected by P(hand class | classifier class) of the out-of-sample set."""
    rows = []
    for tag in tags.split(","):
        key = {}
        for line in open(os.path.join(bench, f"gaps-handcheck-{tag}-key.tsv"), encoding="utf-8"):
            i, lid, typ, c, sub, form = line.rstrip("\n").split("\t")
            key[int(i)] = (typ, c)
        for line in open(os.path.join(bench, f"truth-{tag}.tsv"), encoding="utf-8"):
            i, c = line.split()
            rows.append((tag, key[int(i)][0], key[int(i)][1], c))
    summ = json.load(open(os.path.join(bench, "gaps-summary.json"), encoding="utf-8"))
    missed = {t: v["missed"] for t, v in summ["types"].items()}
    by_type = defaultdict(list)
    for tag, typ, cl, tr in rows:
        by_type[typ].append(tr)
    out = {"types": {}, "n": len(rows)}
    print(f"{'type':18} {'n':>4}   A                 B                 C")
    for t in sorted(by_type, key=lambda t: -missed.get(t, 0)):
        xs = by_type[t]
        cells, row = [], {"n": len(xs), "missed": missed.get(t, 0)}
        for c in "ABC":
            k = xs.count(c)
            lo, hi = wilson(k, len(xs))
            row[c] = [k / len(xs), lo, hi]
            cells.append(f"{100 * k / len(xs):5.1f} ({100 * lo:4.1f}–{100 * hi:4.1f})")
        out["types"][t] = row
        print(f"{t:18} {len(xs):4}   " + "  ".join(cells))
    rng = random.Random(5)
    types = [t for t in by_type if missed.get(t)]
    M = sum(missed[t] for t in types)
    point = {c: sum(missed[t] * by_type[t].count(c) / len(by_type[t]) for t in types) / M for c in "ABC"}
    reps = []
    for _ in range(2000):
        r = Counter()
        for t in types:
            xs = by_type[t]
            smp = [rng.choice(xs) for _ in xs]
            for c in "ABC":
                r[c] += missed[t] * smp.count(c) / len(smp)
        reps.append({c: r[c] / M for c in "ABC"})
    out["all"] = {c: [point[c], *ci([x[c] for x in reps])] for c in "ABC"}
    print(f"{'ALL (weighted)':18} {len(rows):4}   " + "  ".join(f"{100 * out['all'][c][0]:5.1f} ({100 * out['all'][c][1]:4.1f}–{100 * out['all'][c][2]:4.1f})" for c in "ABC"))
    # the classifier's shares, corrected by the out-of-sample confusion (the last tag)
    last = tags.split(",")[-1]
    conf = defaultdict(Counter)
    for tag, typ, cl, tr in rows:
        if tag == last:
            conf[cl][tr] += 1
    cls_all = {c: summ["all"][c][0] for c in "ABC"}
    corr = {j: sum(cls_all[k] * (conf[k][j] / sum(conf[k].values()) if conf[k] else (k == j)) for k in "ABC") for j in "ABC"}
    out["calibrated"] = corr
    out["confusion"] = {k: dict(v) for k, v in conf.items()}
    print("classifier (all types) " + " ".join(f"{c} {100 * cls_all[c]:.1f}%" for c in "ABC") + "  →  corrected by " + last + ": " + " ".join(f"{c} {100 * corr[c]:.1f}%" for c in "ABC"))
    json.dump(out, open(os.path.join(bench, "gaps-truth-summary.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    cmd, *args = sys.argv[1:]
    {"classify": cmd_classify, "reclassify": cmd_reclassify, "handcheck": cmd_handcheck, "agree": cmd_agree, "fresh": cmd_fresh, "freshscore": cmd_freshscore, "truth": cmd_truth}[cmd](*args)
