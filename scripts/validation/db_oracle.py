"""
Ground truth for the real-data validation (tests/validation, docs/validation/REAL_DATA_REPORT.md).

An INDEPENDENT reader of an Otzaria seforim.db: Python's sqlite3 (the real SQLite engine) plus the
`zstandard` package (libzstd) for line_content / line_note. The TypeScript tests compare what the
tool's own lazy page reader returns with what this script prints.

The database is opened read-only (`mode=ro`) and never written. Output goes to the file given on the
command line (JSON or JSONL), never next to the database.

    py -3 -I scripts/validation/db_oracle.py <command> <seforim.db> <out> [args]

commands
    books     <db> <out.json>                    every book with metadata, line counts and flags
    sample    <db> <out.json>                    the deterministic sample of book ids for check 1
    truth     <db> <out.jsonl> <ids.json>        per-book truth (lines, notes, toc, alt_toc, link windows)
    anchors   <db> <out.json> [per_type]         a deterministic sample of link_anchor rows
    presence  <db> <out.jsonl> <in.jsonl>        DB links between given line pairs (for library records)
    gold      <db> <out.json> <pairs.json>       links between pairs of books (engine ground truth)
    divine    <db> <out.json> [n]                a deterministic sample of line_divine_name rows
"""
import hashlib
import json
import sqlite3
import sys

import zstandard

sys.stdout.reconfigure(encoding="utf-8")

WINDOW = 40  # lines per link window
ROW_CAP = 3000  # links per window listed row by row; above it only count + hash


def connect(path):
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    c.text_factory = lambda b: b.decode("utf-8", "surrogateescape")
    return c


class Codec:
    def __init__(self, c):
        self.by_id = {}
        tables = {r[0] for r in c.execute("select name from sqlite_master where type='table'")}
        if "zstd_dict" in tables:
            for (d,) in c.execute("select dict from zstd_dict"):
                zd = zstandard.ZstdCompressionDict(d)
                self.by_id[zd.dict_id()] = zstandard.ZstdDecompressor(dict_data=zd)
        self.plain = zstandard.ZstdDecompressor()

    def text(self, v):
        if v is None:
            return None
        if isinstance(v, str):
            return v
        if isinstance(v, (bytes, bytearray)) and v[:4] == b"\x28\xb5\x2f\xfd":
            params = zstandard.get_frame_parameters(v)
            d = self.by_id.get(params.dict_id, self.plain) if params.dict_id else self.plain
            return d.decompress(v).decode("utf-8")
        return str(v)


def h(s):
    """12 hex chars of SHA-1 of the UTF-8 text (or "-" for NULL) — the same in tests/validation/env.ts."""
    if s is None:
        return "-"
    return hashlib.sha1(s.encode("utf-8", "surrogatepass")).hexdigest()[:12]


def category_paths(c):
    cats = {i: (p, t) for i, p, t in c.execute("select id, parentId, title from category")}
    memo = {}

    def path(i):
        if i in memo:
            return memo[i]
        out, seen = [], set()
        while i is not None and i in cats and i not in seen:
            seen.add(i)
            p, t = cats[i]
            out.append(t)
            i = p
        memo[i] = list(reversed(out))
        return memo[i]

    return path


def cmd_books(db, out):
    c = connect(db)
    path = category_paths(c)
    counts = dict(c.execute("select bookId, count(*) from line group by bookId"))
    notes = dict(c.execute("select l.bookId, count(*) from line_note n join line l on l.id = n.lineId group by l.bookId"))
    divine = dict(c.execute("select l.bookId, count(*) from line_divine_name n join line l on l.id = n.lineId group by l.bookId"))
    alt = dict(c.execute("select bookId, count(*) from alt_toc_structure group by bookId"))
    base = [list(r) for r in c.execute("select bookId, baseBookId from book_base_text order by bookId, baseBookId")]
    books = []
    for (bid, title, src, cat, base_flag, total, order) in c.execute(
        "select b.id, b.title, s.name, b.categoryId, b.isBaseBook, b.totalLines, b.orderIndex from book b left join source s on s.id = b.sourceId order by b.id"
    ):
        books.append({
            "id": bid, "title": title, "source": src, "categoryId": cat, "categoryPath": path(cat),
            "isBaseBook": None if base_flag is None else base_flag == 1, "totalLines": total, "orderIndex": order,
            "lineCount": counts.get(bid, 0), "notes": notes.get(bid, 0), "divine": divine.get(bid, 0), "altToc": alt.get(bid, 0),
        })
    meta = dict(c.execute("select key, value from schema_meta"))
    json.dump({"meta": meta, "books": books, "baseText": base}, open(out, "w", encoding="utf-8"), ensure_ascii=False)


def pick_sample(books):
    """Deterministic: every (top category, source) group, evenly spaced by id, plus special books."""
    groups = {}
    for b in books:
        top = b["categoryPath"][0] if b["categoryPath"] else "?"
        groups.setdefault((top, b["source"]), []).append(b)
    chosen = set()
    for key in sorted(groups, key=lambda k: (k[0] or "", k[1] or "")):
        g = sorted(groups[key], key=lambda b: b["id"])
        k = max(1, min(12, -(-len(g) // 18)))
        for j in range(k):
            chosen.add(g[(j * len(g)) // k]["id"])
    by = lambda f, n: [b["id"] for b in sorted(books, key=lambda b: (-f(b), b["id"]))[:n] if f(b) > 0]
    chosen.update(by(lambda b: b["lineCount"], 6))  # very large books
    chosen.update(by(lambda b: b["notes"], 15))  # most line notes
    for f in ("notes", "altToc", "divine"):  # spread over books that have the table
        g = [b for b in books if b[f] > 0]
        for j in range(15):
            chosen.add(g[(j * len(g)) // 15]["id"])
    return sorted(chosen)


def cmd_sample(db, out):
    tmp = out + ".books.json"
    cmd_books(db, tmp)
    books = json.load(open(tmp, encoding="utf-8"))["books"]
    import os
    os.remove(tmp)
    json.dump(pick_sample(books), open(out, "w", encoding="utf-8"))


def link_rows(c, line_ids):
    """Every link starting, ending or covering one of the lines — the same set DbLinksReader.atLines returns."""
    if not line_ids:
        return []
    q = ",".join("?" * len(line_ids))
    ids = {r[0] for r in c.execute(f"select id from link where sourceLineId in ({q}) or targetLineId in ({q})", line_ids + line_ids)}
    ids |= {r[0] for r in c.execute(f"select linkId from link_coverage where lineId in ({q})", line_ids)}
    if not ids:
        return []
    rows = []
    idl = sorted(ids)
    for i in range(0, len(idl), 900):
        part = idl[i:i + 900]
        qq = ",".join("?" * len(part))
        anchors, ranges, supp = {}, {}, {}
        for lid, side, cs, ce, label in c.execute(f"select linkId, side, charStart, charEnd, label from link_anchor where linkId in ({qq}) order by linkId, side, charStart", part):
            anchors.setdefault(lid, []).append(f"{side}:{cs}:{'' if ce is None else ce}:{label or ''}")
        for lid, side, end in c.execute(f"select linkId, side, endLineIndex from link_range where linkId in ({qq})", part):
            ranges[(lid, side)] = end
        for lid, side in c.execute(f"select linkId, side from link_suppressed_side where linkId in ({qq}) order by linkId, side", part):
            supp.setdefault(lid, []).append(str(side))
        for lid, sb, tb, sli, tli, tli_denorm, tname in c.execute(
            f"""select l.id, l.sourceBookId, l.targetBookId, sl.lineIndex, tl.lineIndex, l.targetLineIndex, ct.name
                from link l join line sl on sl.id = l.sourceLineId join line tl on tl.id = l.targetLineId
                left join connection_type ct on ct.id = l.connectionTypeId where l.id in ({qq})""", part):
            rows.append({
                "key": canonical(lid, tname, sb, sli, ranges.get((lid, 0)), tb, tli, ranges.get((lid, 1)), anchors.get(lid, []), supp.get(lid, [])),
                "denormOk": tli == tli_denorm,
            })
    rows.sort(key=lambda r: int(r["key"].split("|", 1)[0]))
    return rows


def canonical(lid, tname, sb, sli, send, tb, tli, tend, anchors, supp):
    """One link as a string — tests/validation/env.ts builds the same string from DbLinkRow."""
    e = lambda x: "" if x is None else str(x)
    return f"{lid}|{tname}|{sb}:{sli}:{e(send)}|{tb}:{tli}:{e(tend)}|{';'.join(anchors)}|{','.join(supp)}"


def window(c, entries, start):
    ids = [i for _, i in entries[start:start + WINDOW]]
    rows = link_rows(c, ids)
    keys = [r["key"] for r in rows]
    out = {"from": start, "lines": len(ids), "count": len(keys), "hash": h("\n".join(keys)), "denormBad": sum(1 for r in rows if not r["denormOk"])}
    if len(keys) <= ROW_CAP:
        out["rows"] = keys
    # per-line counts of the first 8 lines of the window (each counted alone)
    out["perLine"] = [len(link_rows(c, [i])) for i in ids[:8]]
    return out


def cmd_truth(db, out, ids_file):
    c = connect(db)
    codec = Codec(c)
    ids = json.load(open(ids_file, encoding="utf-8"))
    tables = {r[0] for r in c.execute("select name from sqlite_master where type='table'")}
    with open(out, "w", encoding="utf-8") as f:
        for bid in ids:
            entries = [(li, lid) for li, lid in c.execute("select lineIndex, id from line where bookId = ? order by lineIndex", (bid,))]
            index_of = {lid: li for li, lid in entries}
            lines = []
            for li, lid, heref, content in c.execute(
                "select l.lineIndex, l.id, l.heRef, lc.content from line l left join line_content lc on lc.id = l.id where l.bookId = ? order by l.lineIndex", (bid,)
            ):
                lines.append([li, h(codec.text(content)), h(heref)])
            notes = {}
            if "line_note" in tables:
                for lid, ni, cp, hm, body in c.execute(
                    "select n.lineId, n.noteIndex, n.charPos, n.hasMarker, n.body from line_note n join line l on l.id = n.lineId where l.bookId = ? order by n.lineId, n.noteIndex", (bid,)
                ):
                    notes.setdefault(str(index_of[lid]), []).append([cp, hm == 1, h(codec.text(body))])
            toc = [[index_of.get(lid), lvl, txt] for lid, lvl, txt in c.execute(
                "select e.lineId, e.level, t.text from tocEntry e join tocText t on t.id = e.textId where e.bookId = ? order by e.id", (bid,)
            )]
            alt = []
            for sid, key, title, he in c.execute("select id, key, title, heTitle from alt_toc_structure where bookId = ? order by id", (bid,)):
                rows = [[eid, parent, txt, None if lid is None else index_of.get(lid)] for eid, parent, txt, lid in c.execute(
                    "select e.id, e.parentId, t.text, e.lineId from alt_toc_entry e left join tocText t on t.id = e.textId where e.structureId = ? order by e.id", (sid,)
                )]
                alt.append({"key": key, "title": title, "heTitle": he, "rows": rows})
            mid = max(0, len(entries) // 2 - WINDOW // 2)
            windows = [window(c, entries, 0)]
            if mid >= WINDOW:
                windows.append(window(c, entries, mid))
            f.write(json.dumps({"id": bid, "lines": lines, "notes": notes, "toc": toc, "altToc": alt, "windows": windows}, ensure_ascii=False) + "\n")


def cmd_anchors(db, out, per_type=200):
    """For every connection type with anchors: `per_type` anchored links, evenly spaced in link id order."""
    c = connect(db)
    per_type = int(per_type)
    names = dict(c.execute("select id, name from connection_type"))
    by_type = {}
    last = None
    for lid, tid in c.execute("select a.linkId, l.connectionTypeId from link_anchor a join link l on l.id = a.linkId order by a.linkId"):
        if lid != last:
            by_type.setdefault(tid, []).append(lid)
            last = lid
    out_rows = []
    for tid in sorted(by_type):
        ids = by_type[tid]
        k = min(per_type, len(ids))
        for j in range(k):
            lid = ids[(j * len(ids)) // k]
            l = c.execute(
                "select l.sourceBookId, sl.lineIndex, l.targetBookId, tl.lineIndex from link l join line sl on sl.id = l.sourceLineId join line tl on tl.id = l.targetLineId where l.id = ?",
                (lid,),
            ).fetchone()
            for side, cs, ce, label in c.execute("select side, charStart, charEnd, label from link_anchor where linkId = ? order by side, charStart limit 1", (lid,)):
                book, li = (l[0], l[1]) if side == 0 else (l[2], l[3])
                out_rows.append({"linkId": lid, "type": names[tid], "side": side, "charStart": cs, "charEnd": ce, "label": label, "bookId": book, "lineIndex": li, "typeTotal": len(ids)})
    json.dump(out_rows, open(out, "w", encoding="utf-8"), ensure_ascii=False)


def cmd_presence(db, out, infile):
    """
    in:  JSONL {"k": key, "s": sourceTitle, "si": srcLine0, "t": targetTitle, "ti": tgtLine0}
    out: JSONL {"k": key, "links": [{"id", "dir": "same"|"flipped", "type", "anchors": [...], "ranges": {...}}], "books": [src found, tgt found]}
    Titles are matched exactly (book.title), like the generator.
    """
    c = connect(db)
    ids = {}
    for bid, title in c.execute("select id, title from book"):
        ids.setdefault(title, bid)
    line_cache = {}

    def line_id(bid, li):
        k = (bid, li)
        if k not in line_cache:
            r = c.execute("select id from line where bookId = ? and lineIndex = ?", (bid, li)).fetchone()
            line_cache[k] = r[0] if r else None
        return line_cache[k]

    with open(out, "w", encoding="utf-8") as f:
        for raw in open(infile, encoding="utf-8"):
            q = json.loads(raw)
            sb, tb = ids.get(q["s"]), ids.get(q["t"])
            res = {"k": q["k"], "books": [sb is not None, tb is not None], "links": []}
            if sb is not None and tb is not None:
                sl, tl = line_id(sb, q["si"]), line_id(tb, q["ti"])
                res["lines"] = [sl is not None, tl is not None]
                if sl is not None and tl is not None:
                    for lid, s_line, tname in c.execute(
                        "select l.id, l.sourceLineId, ct.name from link l join connection_type ct on ct.id = l.connectionTypeId where (l.sourceLineId = ? and l.targetLineId = ?) or (l.sourceLineId = ? and l.targetLineId = ?)",
                        (sl, tl, tl, sl),
                    ):
                        anchors = [[side, cs, ce, label] for side, cs, ce, label in c.execute("select side, charStart, charEnd, label from link_anchor where linkId = ? order by side, charStart", (lid,))]
                        ranges = {str(side): end for side, end in c.execute("select side, endLineIndex from link_range where linkId = ?", (lid,))}
                        res["links"].append({"id": lid, "dir": "same" if s_line == sl else "flipped", "type": tname, "anchors": anchors, "ranges": ranges})
            f.write(json.dumps(res, ensure_ascii=False) + "\n")


def cmd_pairs(db, out, n=36, max_commentary=12000, max_base=30000, min_gold=30):
    """
    Commentary pairs for the engines: book_base_text, plus "X על Y" titles whose base Y exists and is
    not already listed. Deterministic: candidates sorted by (commentary id, base id), stratified by
    (top category of the commentary, Sefaria or not, where the pair came from), evenly spaced; a pair
    is kept when both books are within the size limits and the database links them with at least
    `min_gold` COMMENTARY links (in either stored direction).
    """
    c = connect(db)
    n, max_commentary, max_base, min_gold = int(n), int(max_commentary), int(max_base), int(min_gold)
    path = category_paths(c)
    books = {bid: (title, src, cat, cnt) for bid, title, src, cat, cnt in c.execute(
        "select b.id, b.title, s.name, b.categoryId, b.totalLines from book b left join source s on s.id = b.sourceId")}
    by_title = {}
    for bid, (title, *_rest) in books.items():
        by_title.setdefault(title, bid)
    cands = {(a, b): "book_base_text" for a, b in c.execute("select bookId, baseBookId from book_base_text")}
    for bid, (title, *_rest) in books.items():
        if " על " in title:
            base = by_title.get(title.rsplit(" על ", 1)[1].strip())
            if base and base != bid and (bid, base) not in cands:
                cands[(bid, base)] = "title"
    commentary_id = c.execute("select id from connection_type where name = 'COMMENTARY'").fetchone()[0]
    groups = {}
    for (a, b), origin in sorted(cands.items()):
        ta, tb = books[a], books[b]
        if not (0 < ta[3] <= max_commentary and 0 < tb[3] <= max_base):
            continue
        top = (path(ta[2]) or ["?"])[0]
        groups.setdefault((top, ta[1] == "Sefaria", origin), []).append((a, b))
    picked = []
    keys = sorted(groups, key=lambda k: (k[0], k[1], k[2]))
    per = max(1, -(-n // max(1, len(keys))))
    for k in keys:
        g = groups[k]
        tried = 0
        took = 0
        for j in range(len(g)):
            if took >= per or tried >= per * 4:
                break
            a, b = g[(j * 7919) % len(g)]  # a fixed stride through the group
            tried += 1
            gold = c.execute("select count(*) from link where sourceBookId = ? and targetBookId = ? and connectionTypeId = ?", (a, b, commentary_id)).fetchone()[0]
            gold += c.execute("select count(*) from link where sourceBookId = ? and targetBookId = ? and connectionTypeId = ?", (b, a, commentary_id)).fetchone()[0]
            if gold >= min_gold:
                picked.append({"commentary": a, "base": b, "origin": k[2], "top": k[0], "sefaria": k[1], "gold": gold,
                               "titles": [books[a][0], books[b][0]], "lines": [books[a][3], books[b][3]]})
                took += 1
    picked.sort(key=lambda p: (p["commentary"], p["base"]))
    json.dump({"candidates": len(cands), "groups": len(keys), "pairs": picked}, open(out, "w", encoding="utf-8"), ensure_ascii=False)


def cmd_gold(db, out, pairs_file):
    """
    pairs: [[aBookId, bBookId], ...]. For each pair every link between the two books, in either
    stored direction: [linkId, type, aLine, aEnd|null, bLine, bEnd|null, storedFromA].
    [aBookId, null]: every link stored FROM book a, with the target book id as an 8th field.
    """
    c = connect(db)
    res = []
    for a, b in json.load(open(pairs_file, encoding="utf-8")):
        rows = []
        if b is None:  # a single book: every link it is the stored source of (LINKER is one-way)
            for lid, tname, sli, tb, tli in c.execute(
                """select l.id, ct.name, sl.lineIndex, l.targetBookId, tl.lineIndex from link l join connection_type ct on ct.id = l.connectionTypeId
                   join line sl on sl.id = l.sourceLineId join line tl on tl.id = l.targetLineId where l.sourceBookId = ?""",
                (a,),
            ):
                ranges = dict(c.execute("select side, endLineIndex from link_range where linkId = ?", (lid,)).fetchall())
                rows.append([lid, tname, sli, ranges.get(0), tli, ranges.get(1), True, tb])
            res.append({"a": a, "b": None, "links": rows})
            continue
        for s, t in ((a, b), (b, a)):
            for lid, tname, sli, tli in c.execute(
                """select l.id, ct.name, sl.lineIndex, tl.lineIndex from link l join connection_type ct on ct.id = l.connectionTypeId
                   join line sl on sl.id = l.sourceLineId join line tl on tl.id = l.targetLineId
                   where l.sourceBookId = ? and l.targetBookId = ?""",
                (s, t),
            ):
                ranges = dict(c.execute("select side, endLineIndex from link_range where linkId = ?", (lid,)).fetchall())
                if s == a:
                    rows.append([lid, tname, sli, ranges.get(0), tli, ranges.get(1), True])
                else:
                    rows.append([lid, tname, tli, ranges.get(1), sli, ranges.get(0), False])
        res.append({"a": a, "b": b, "links": rows})
    json.dump(res, open(out, "w", encoding="utf-8"), ensure_ascii=False)


def cmd_divine(db, out, n=400):
    c = connect(db)
    n = int(n)
    lo, hi = c.execute("select min(lineId), max(lineId) from line_divine_name").fetchone()
    step = max(1, (hi - lo) // n)
    rows, probe = [], lo
    while len(rows) < n and probe <= hi:
        r = c.execute("select lineId, charStart, span from line_divine_name where lineId >= ? order by lineId, charStart limit 1", (probe,)).fetchone()
        if r is None:
            break
        bid, li = c.execute("select bookId, lineIndex from line where id = ?", (r[0],)).fetchone()
        rows.append({"lineId": r[0], "bookId": bid, "lineIndex": li, "charStart": r[1], "span": r[2]})
        probe = r[0] + step
    json.dump(rows, open(out, "w", encoding="utf-8"), ensure_ascii=False)


if __name__ == "__main__":
    cmd, *args = sys.argv[1:]
    {"books": cmd_books, "sample": cmd_sample, "pairs": cmd_pairs, "truth": cmd_truth, "anchors": cmd_anchors, "presence": cmd_presence, "gold": cmd_gold, "divine": cmd_divine}[cmd](*args)
