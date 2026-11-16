"""Builds a folder of N text books for the batch (max-link job) measurement, scripts/bench/batch-scale.mjs.

Usage: py -I scripts/bench/make_batch_books.py <out-dir> <count> [--bases]

The books are slices of the real commentaries on the five books of the Torah in the Otzaria database
(read only), each one or two chapters of a commentary with its own headings, named "חיבור <n> על <base>"
so the planner pairs every slice with its base and the headings and dibur-hamatchil engines have real
work. (Named after their commentator, the slices of one commentary would be taken for an intermediate
commentary of each other — "אבן עזרא 3" citing רמב"ן is paired with all 40 slices of רמב"ן — and the plan
grows quadratically: 33,301 steps for 1,005 books, where the library has one רמב"ן per book.) --bases also writes the five bases into the folder (a run without the database);
without it the bases come from the database the run opens next to the folder.

The output is library text and is NOT for the repository: write it under .bench/ (gitignored) or a
temporary folder, and delete it after measuring.
"""
import os, sqlite3, sys
import zstandard

sys.stdout.reconfigure(encoding="utf-8")
DB = "file:C:/ProgramData/otzaria/books/seforim.db?mode=ro&immutable=1"
BASES = ["בראשית", "שמות", "ויקרא", "במדבר", "דברים"]
CHAPTERS_PER_SLICE = 2
MAX_LINES = 160


def main():
    out, count = sys.argv[1], int(sys.argv[2])
    with_bases = "--bases" in sys.argv[3:]
    con = sqlite3.connect(DB, uri=True)
    dicts = [zstandard.ZstdDecompressor(dict_data=zstandard.ZstdCompressionDict(b)) for (b,) in con.execute("select dict from zstd_dict")]
    plain = zstandard.ZstdDecompressor()

    def text(blob):
        if isinstance(blob, str):
            return blob
        for d in dicts:
            try:
                return d.decompress(blob).decode("utf-8")
            except zstandard.ZstdError:
                pass
        return plain.decompress(blob).decode("utf-8")

    def lines_of(book_id):
        q = "select lc.content from line l join line_content lc on lc.id = l.id where l.bookId = ? order by l.lineIndex"
        return [text(c) for (c,) in con.execute(q, (book_id,))]

    os.makedirs(out, exist_ok=True)
    slices = []  # per commentary, its chapter slices
    for base in BASES:
        for bid, title in con.execute("select id, title from book where title like ? order by title", (f"% על {base}",)):
            lines = lines_of(bid)
            chapters, cur = [], None
            for ln in lines[1:]:
                if ln.startswith("<h2"):
                    cur = [ln]
                    chapters.append(cur)
                elif cur is not None:
                    cur.append(ln)
            own = []
            for i in range(0, len(chapters), CHAPTERS_PER_SLICE):
                body = [ln for ch in chapters[i : i + CHAPTERS_PER_SLICE] for ln in ch][:MAX_LINES]
                if len(body) > 3:
                    own.append((title, body))
            slices.append(own)
    # round robin over the commentaries, so 100 books are as varied as 1,000
    picked, depth = [], 0
    while len(picked) < count and any(depth < len(s) for s in slices):
        for s in slices:
            if depth < len(s) and len(picked) < count:
                picked.append((s[depth], depth + 1))
        depth += 1
    size = 0
    names = []
    for (title, body), n in picked:
        base = title.rsplit(" על ", 1)[1]
        name = f"חיבור {len(names) + 1:04d} על {base}"
        names.append(name)
        data = "\n".join([f"<h1>{name}</h1>", *body])
        size += len(data.encode("utf-8"))
        with open(os.path.join(out, f"{name}.txt"), "w", encoding="utf-8", newline="\n") as f:
            f.write(data)
    if with_bases:
        for base in BASES:
            (bid,) = con.execute("select id from book where title = ?", (base,)).fetchone()
            data = "\n".join(lines_of(bid))
            size += len(data.encode("utf-8"))
            with open(os.path.join(out, f"{base}.txt"), "w", encoding="utf-8", newline="\n") as f:
                f.write(data)
    print(f"{len(picked)} books{' + 5 bases' if with_bases else ''}, {size / 1e6:.1f} MB → {out}")


if __name__ == "__main__":
    main()
