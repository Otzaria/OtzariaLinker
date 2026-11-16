"""
The citations engine's knowledge (names books write), mined from and verified against a real seforim.db.
The database is opened read-only (immutable) and never written; output goes to the file given.

    py -I scripts/citations/knowledge.py rambam-mine   <seforim.db> <phrases.json> [per_topic=800]
    py -I scripts/citations/knowledge.py rambam-select <phrases.json> <readings.json> <out.json>
    py -I scripts/citations/knowledge.py chapters      <seforim.db> <out.json>

rambam-mine: for every topic book "משנה תורה, הלכות X", up to `per_topic` of its LINKER links (LinkerToOtzaria's
citations, chosen by sha1 of the link id), the words of the citing span after a word for "הלכות" or after a chapter
("פ"ט מתרומות") — how books write the topic — counted per topic the link points to.

rambam-select: the written forms the engine does NOT already read as that topic (readings.json: what the scanner
reads for each phrase, written by tests/validation/citations-knowledge.test.ts with KNOWLEDGE_PHRASES), kept when
LINKER agrees (at least 3 links, at least 95% to one topic) and the letters do not fit ANOTHER topic better
(LinkerToOtzaria's own errors: "פסהמ"ק" — its letters are פסולי המוקדשין, LINKER links it to מחוסרי כפרה).

chapters: the chapter names of the Mishnah and the Yerushalmi (the database has alt_toc names only for the Bavli):
the opening words of each chapter's first mishnah / halacha, as tractates' chapters are named — with the Bavli's
alt_toc name of the same tractate's chapter when it starts with the same words (the name books use).
"""
import hashlib
import html
import json
import re
import sqlite3
import sys
from collections import Counter, defaultdict

import zstandard

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def connect(path):
    return sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True)


class Codec:
    def __init__(self, c):
        self.by_id = {}
        for (d,) in c.execute("select dict from zstd_dict"):
            zd = zstandard.ZstdCompressionDict(d)
            self.by_id[zd.dict_id()] = zstandard.ZstdDecompressor(dict_data=zd)
        self.plain = zstandard.ZstdDecompressor()

    def text(self, v):
        if v is None:
            return ""
        if isinstance(v, str):
            return v
        if isinstance(v, (bytes, bytearray)) and v[:4] == b"\x28\xb5\x2f\xfd":
            p = zstandard.get_frame_parameters(v)
            d = self.by_id.get(p.dict_id, self.plain) if p.dict_id else self.plain
            return d.decompress(v).decode("utf-8")
        return bytes(v).decode("utf-8", "replace")


def visible(h):
    """the line's visible characters, as anchors count them (tags out, an entity is one character)"""
    out, i, s = [], 0, h or ""
    while i < len(s):
        ch = s[i]
        if ch == "<":
            j = s.find(">", i)
            if j < 0:
                break
            i = j + 1
            continue
        if ch == "&":
            j = s.find(";", i, i + 11)
            if j > 0:
                out.append(html.unescape(s[i:j + 1]))
                i = j + 1
                continue
        out.append(ch)
        i += 1
    return "".join(out)


MARK = re.compile(r"^(?:פ[\"']|פרק|פר'|ה[\"']|הלכה|הל'|סי'|סימן|ס[\"']|דף|\d+)$")
VALUE = {ch: v for ch, v in zip("אבגדהוזחטיכלמנסעפצקרשת", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400])}


def numeral(w):
    """a bare Hebrew numeral ("יא", "קכ"): its letters in descending value (ט"ו / ט"ז too)"""
    v = [VALUE.get(ch) for ch in w.translate(str.maketrans("ךםןףץ", "כמנפצ"))]
    return 0 < len(v) <= 4 and None not in v and (all(a >= b for a, b in zip(v, v[1:])) or w in ("טו", "טז"))


def stop(w):
    # where the topic's words end: a marker, "שם", a number ("ג", "יא", "ה"א", "הי"ב") — not "יו"ט", "שני", "טוב"
    if MARK.match(w) or w == "שם":
        return True
    bare = re.sub(r"[\"']", "", w)
    if bare == w:
        return len(w) <= 2 and numeral(w)
    return len(bare) <= 3 and (numeral(bare) or (bare[0] in "פהמס" and numeral(bare[1:])))
HILCHOT = re.compile(r"^[ובלכ]{0,2}[דמ]?ה?(?:ה'|הל'|הלכות|הלכו'|הלכ')$")
CHAPTER = re.compile(r"^(?:[ובד]{0,2})(?:פ[א-ת]?[\"'][א-ת]?|ספ\"[א-ת]|רפ\"[א-ת]|[א-ת]{1,2}'?)$")


def rambam_mine(db_path, out_path, per=800):
    db = connect(db_path)
    codec = Codec(db)
    found = defaultdict(Counter)
    for bid, title in db.execute("select id,title from book where title like 'משנה תורה, הלכות %'").fetchall():
        topic = title[len("משנה תורה, הלכות "):]
        rows = db.execute("""select l.id, l.sourceLineId, a.charStart, a.charEnd from link l join link_anchor a on a.linkId=l.id and a.side=0
            where l.targetBookId=? and l.connectionTypeId=(select id from connection_type where name='LINKER')""", (bid,)).fetchall()
        rows = sorted(rows, key=lambda r: hashlib.sha1(f"r{r[0]}".encode()).hexdigest())[:per]
        for _, lid, cs, ce in rows:
            r = db.execute("select content from line_content where id=?", (lid,)).fetchone()
            if not r:
                continue
            span = visible(codec.text(r[0]))[cs:(ce or cs)].replace("״", '"').replace("׳", "'")
            words = re.findall(r"[א-ת\"']+", span)
            for k, w in enumerate(words):
                if HILCHOT.match(w):
                    got = words[k + 1:k + 4]
                elif k and CHAPTER.match(words[k - 1]) and re.match(r"^[דמ][א-ת]", w):
                    got = [w[1:]] + words[k + 1:k + 3]
                else:
                    continue
                phrase = []
                for x in got:
                    if stop(x):
                        break
                    phrase.append(x)
                if phrase:
                    found[" ".join(phrase)][topic] += 1
                break
    json.dump({k: dict(v) for k, v in found.items()}, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=0)


FINALS = str.maketrans("ךםןףץ", "כמנפצ")


def letters(s):
    return re.sub(r"[^א-ת]", "", s).translate(FINALS)


def loose(s):
    """ו and י inside a word do not count ("גזלה" = "גזילה", "דיעות" = "דעות")"""
    s = letters(s)
    return s[:1] + re.sub(r"[וי]", "", s[1:-1]) + s[-1:] if len(s) > 2 else s


def fits(written, topic):
    """the written letters (loosely) are a subsequence of the topic's, each written word opening at a topic word"""
    tw = [loose(w) for w in topic.split()]
    ww = [loose(w) for w in written.split()]
    cut = [w.endswith("'") for w in written.split()]
    def go(i, j):
        if i == len(ww):
            return True
        for k in range(j, len(tw)):
            for t in (tw[k], tw[k][1:] if tw[k][:1] in "הו" else None):
                if not t or t[:1] != ww[i][:1]:
                    continue
                rest = "".join(tw[k:])[len(tw[k]) - len(t):]
                # the word's letters in order, within this topic word and the next ones
                # (a written article ה the title does not have is skipped: "באהמ"ק" — ביאת מקדש)
                pos, ok = 0, True
                for ch in ww[i]:
                    found = rest.find(ch, pos)
                    if found < 0 and ch == "ה":
                        continue
                    if found < 0:
                        ok = False
                        break
                    pos = found + 1
                # a word cut with a geresh is the start of a topic word ("זכיי'" — זכייה, "מלכי'" — מלכים)
                ok = ok or (cut[i] and letters(topic.split()[k]).startswith(letters(written.split()[i])))
                if ok and go(i + 1, k + 1):
                    return True
        return False
    return go(0, 0)


def write_names(path, source, names):
    """one entry a line, for a readable diff"""
    nl = "\n"
    rows = f",{nl}".join("  " + json.dumps(n, ensure_ascii=False) for n in names)
    with open(path, "w", encoding="utf-8", newline=nl) as f:
        f.write(f'{{{nl} "source": {json.dumps(source, ensure_ascii=False)},{nl} "names": [{nl}{rows}{nl} ]{nl}}}{nl}')


def rambam_select(phrases_path, readings_path, out_path):
    phrases = json.load(open(phrases_path, encoding="utf-8"))
    readings = json.load(open(readings_path, encoding="utf-8"))
    topics = sorted({t for v in phrases.values() for t in v})
    names = []
    for written, by in sorted(phrases.items()):
        n = sum(by.values())
        topic = max(by, key=by.get)
        if n < 3 or by[topic] / n < 0.95:
            continue
        words = written.split()
        if len(words) > 3 or any(len(letters(w)) < 2 for w in words) or re.match(r"^[ודמ]?הלכ", words[0]):
            continue
        # "מכירה" read as מ + "כירה": the ד/מ was the topic's own first letter
        first = letters(topic.split()[0])
        if any(first.startswith(letters(p + words[0])) for p in "דמ"):
            continue
        reads = (readings.get(written) or {}).get("hil")
        if reads == f"משנה תורה, הלכות {topic}":
            continue
        abbreviation = bool(re.search(r"[\"']", written))
        if not fits(written, topic):
            # the letters fit another topic and not this one: LinkerToOtzaria's error ("פסהמ"ק" → מחוסרי כפרה)
            if abbreviation:
                print(f"rejected (letters of another topic): {written} -> {topic} ({n})", file=sys.stderr)
                continue
            # another name of the topic ("שביעית", "נגעים", "גיטין"): only with more evidence
            if n < 5:
                continue
        # "מעשר בהלכה": a longer phrase of a name already kept
        if any(m["topic"] == topic and written.startswith(m["written"] + " ") for m in names):
            continue
        names.append({"written": written, "topic": topic, "linker": n})
    write_names(out_path, "scripts/citations/knowledge.py rambam-select (LINKER citations of seforim.db)", names)
    print(f"{len(names)} names", file=sys.stderr)


def chapters(db_path, out_path):
    db = connect(db_path)
    codec = Codec(db)
    books = {}
    titles = [t for (t,) in db.execute("select title from book where title like 'משנה %' or title like 'תלמוד ירושלמי %' order by title")]
    for title in titles:
        bid = db.execute("select id from book where title=?", (title,)).fetchone()[0]
        prefix = title + ", "
        first = {}
        for h, c in db.execute("select l.heRef, c.content from line l join line_content c on c.id=l.id where l.bookId=? order by l.lineIndex", (bid,)):
            if not h or not h.startswith(prefix):
                continue
            levels = [p.strip() for p in h[len(prefix):].split(",")]
            if len(levels) < 2 or levels[0] in first:
                continue
            first[levels[0]] = c
        # chapters numbered from א in order (a Mishnah's "משנה X, א, א"; a Yerushalmi's "…, א, א, א")
        names = []
        for n in range(1, len(first) + 1):
            c = first.get(gematria(n))
            if c is None:
                names = None
                break
            text = re.sub("[֑-ׇ]", "", visible(codec.text(c)))  # the vowel points and cantillation
            text = re.sub(r"^\s*(?:\([א-ת]{1,3}\)|משנה:)\s*", "", text)
            names.append(" ".join(re.findall(r"[א-ת]+", text)[:4]))
        # books whose references are not chapters (משנה תורה is not "משנה X"; commentaries are "X על …")
        if names and len(names) >= 2 and " על " not in title and not title.startswith("משנה תורה"):
            books[title] = names
    nl = chr(10)
    rows = f",{nl}".join(f"  {json.dumps(t, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)}" for t, v in books.items())
    with open(out_path, "w", encoding="utf-8", newline=nl) as f:
        f.write(f'{{{nl} "source": "scripts/citations/knowledge.py chapters (the opening words of each chapter in seforim.db)",{nl} "books": {{{nl}{rows}{nl} }}{nl}}}{nl}')
    print(f"{len(books)} books", file=sys.stderr)


GEMATRIA = [(400, "ת"), (300, "ש"), (200, "ר"), (100, "ק"), (90, "צ"), (80, "פ"), (70, "ע"), (60, "ס"), (50, "נ"), (40, "מ"), (30, "ל"), (20, "כ"), (10, "י"), (9, "ט"), (8, "ח"), (7, "ז"), (6, "ו"), (5, "ה"), (4, "ד"), (3, "ג"), (2, "ב"), (1, "א")]


def gematria(n):
    if n % 100 in (15, 16):
        return gematria(n - n % 100) + ("טו" if n % 100 == 15 else "טז") if n > 100 else ("טו" if n == 15 else "טז")
    out = ""
    for v, ch in GEMATRIA:
        while n >= v:
            out += ch
            n -= v
    return out


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "rambam-mine":
        rambam_mine(sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 800)
    elif cmd == "rambam-select":
        rambam_select(sys.argv[2], sys.argv[3], sys.argv[4])
    elif cmd == "chapters":
        chapters(sys.argv[2], sys.argv[3])
    else:
        raise SystemExit(__doc__)
