"""Builds the inputs of the product audit (docs/reviews/PRODUCT_AUDIT.md) under a scratch folder.

Usage: py scripts/audit/make_inputs.py <out-dir>
Nothing is written into the repository. Texts are short, hand-written samples (the first verses of
Genesis 1 and invented commentaries), so no library content is copied.
"""
import json, os, sqlite3, sys, shutil

OUT = sys.argv[1]
SCHEMA = os.path.join(os.path.dirname(__file__), "..", "..", "tests", "fixtures", "schemas", "v5.sql")
HEB = "א ב ג ד ה ו ז ח ט י".split()
GEN1 = [
    "בראשית ברא אלהים את השמים ואת הארץ.",
    "והארץ היתה תהו ובהו וחשך על פני תהום ורוח אלהים מרחפת על פני המים.",
    "ויאמר אלהים יהי אור ויהי אור.",
    "וירא אלהים את האור כי טוב ויבדל אלהים בין האור ובין החשך.",
    "ויקרא אלהים לאור יום ולחשך קרא לילה ויהי ערב ויהי בקר יום אחד.",
    "ויאמר אלהים יהי רקיע בתוך המים ויהי מבדיל בין מים למים.",
    "ויעש אלהים את הרקיע ויבדל בין המים אשר מתחת לרקיע ובין המים אשר מעל לרקיע ויהי כן.",
    "ויקרא אלהים לרקיע שמים ויהי ערב ויהי בקר יום שני.",
    "ויאמר אלהים יקוו המים מתחת השמים אל מקום אחד ותראה היבשה ויהי כן.",
    "ויקרא אלהים ליבשה ארץ ולמקוה המים קרא ימים וירא אלהים כי טוב.",
]
DH = ["בראשית ברא", "תהו ובהו", "יהי אור", "כי טוב", "ויקרא אלהים לאור", "יהי רקיע", "ויעש אלהים את הרקיע", "ויקרא אלהים לרקיע", "יקוו המים", "ויקרא אלהים ליבשה"]

def write(path, lines):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))

def base_book(title="בראשית"):
    return [f"<h1>{title}</h1>", "<h2>פרק א</h2>", *GEN1]

def commentary(title, flavour="ביאור", n=10):
    out = [f"<h1>{title}</h1>", "<h2>פרק א</h2>"]
    for i in range(n):
        out += [f"<h3>פסוק {HEB[i]}</h3>", f"{DH[i]} - {flavour}: כאן בא הסבר קצר על הפסוק ה{HEB[i]}׳ שבפרק."]
    return out

def notes_pair(book="ספר דוגמה"):
    body = [f"<h1>{book}</h1>", "<h2>פרק א</h2>", "שורה ראשונה עם הערה (1) ועוד אחת (2).", "שורה שנייה עם הערה (3).",
            "<h2>פרק ב</h2>", "כאן המספור מתחיל שוב (1)."]
    notes = [f"<h1>הערות על {book}</h1>", "<h2>פרק א</h2>", "(1) הערה ראשונה בפרק א.", "(2) הערה שנייה בפרק א.", "(3) הערה שלישית.",
             "<h2>פרק ב</h2>", "(1) הערה ראשונה בפרק ב."]
    return body, notes

if os.path.isdir(OUT):
    shutil.rmtree(OUT)
os.makedirs(OUT)

# 1. two TXT books
write(f"{OUT}/s1/בראשית.txt", base_book())
write(f"{OUT}/s1/ביאור חדש על בראשית.txt", commentary("ביאור חדש על בראשית"))
# 2. a commentary alone (its base is in the Otzaria DB)
write(f"{OUT}/s2/ביאור חדש על בראשית.txt", commentary("ביאור חדש על בראשית"))
# 3. four books
b, n = notes_pair()
write(f"{OUT}/s3/בראשית.txt", base_book())
write(f"{OUT}/s3/ביאור חדש על בראשית.txt", commentary("ביאור חדש על בראשית"))
write(f"{OUT}/s3/ספר דוגמה.txt", b)
write(f"{OUT}/s3/הערות על ספר דוגמה.txt", n)
# 4. a folder with subfolders, plus things that are not books
root = f"{OUT}/s4/הספרייה שלי"
write(f"{root}/תורה/בראשית.txt", base_book())
write(f"{root}/פירושים/ביאור חדש על בראשית.txt", commentary("ביאור חדש על בראשית"))
write(f"{root}/פירושים/קצרים/ביאור קצר על בראשית.txt", commentary("ביאור קצר על בראשית", "קצר", 5))
write(f"{root}/הערות/ספר דוגמה.txt", b)
write(f"{root}/הערות/הערות על ספר דוגמה.txt", n)
write(f"{root}/קרא אותי.md", ["# הערות אישיות", "לא ספר"])
with open(f"{root}/תמונה.png", "wb") as f:
    f.write(b"\x89PNG\r\n\x1a\n" + b"\0" * 32)

# 6/7/11. existing links files: one good, one pointing past the end of its target, one broken JSON
def rec(l1, l2, he, path, kind="commentary"):
    return {"line_index_1": l1, "line_index_2": l2, "heRef_2": he, "path_2": path, "Conection Type": kind}
good = [rec(4 + 2 * i, 3 + i, f"בראשית א, {HEB[i]}", "בראשית.txt") for i in range(5)]
bad = [rec(4, 3, "בראשית א, א", "בראשית.txt"), rec(6, 999, "בראשית א, תתתתקצט", "בראשית.txt"), rec(500, 4, "בראשית א, ב", "בראשית.txt"),
       rec(8, 5, "ספר שלא קיים", "ספר שלא קיים.txt")]
lk = f"{OUT}/s7/links"
os.makedirs(lk, exist_ok=True)
json.dump(good, open(f"{lk}/ביאור חדש על בראשית_links.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump(bad, open(f"{lk}/ביאור קצר על בראשית_links.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
open(f"{lk}/שבור_links.json", "w", encoding="utf-8").write('[{"line_index_1": 1, "line_index_2": ')
write(f"{OUT}/s7/books/בראשית.txt", base_book())
write(f"{OUT}/s7/books/ביאור חדש על בראשית.txt", commentary("ביאור חדש על בראשית"))
write(f"{OUT}/s7/books/ביאור קצר על בראשית.txt", commentary("ביאור קצר על בראשית", "קצר", 5))

# 5/8. personal databases in the Otzaria schema (v5: plain text in line.content)
def personal_db(path, books):
    if os.path.exists(path):
        os.remove(path)
    c = sqlite3.connect(path)
    c.executescript(open(SCHEMA, encoding="utf-8").read())
    c.execute("insert into source(id,name) values(1,'אישי')")
    c.execute("insert into category(id,parentId,title,level) values(1,null,'ספרייה אישית',0)")
    lid = 1
    for bid, (title, lines) in enumerate(books, 1):
        c.execute("insert into book(id,categoryId,sourceId,title,totalLines) values(?,?,?,?,?)", (bid, 1, 1, title, len(lines)))
        for i, ln in enumerate(lines):
            c.execute("insert into line(id,bookId,lineIndex,content,heRef,charCount) values(?,?,?,?,?,?)", (lid, bid, i, ln, None, len(ln)))
            lid += 1
    c.commit()
    c.close()
os.makedirs(f"{OUT}/db", exist_ok=True)
personal_db(f"{OUT}/db/אישי-פירושים.db", [("ביאור אישי על בראשית", commentary("ביאור אישי על בראשית", "אישי")), ("הערות על ספר דוגמה", n)])
personal_db(f"{OUT}/db/אישי-מקורות.db", [("בראשית", base_book()), ("ספר דוגמה", b)])

# 9. hundreds of commentaries on Genesis (base: the Otzaria DB)
names = [f"פירוש {i:03d} על בראשית" for i in range(1, 301)]
for t in names:
    write(f"{OUT}/s9/מאות/{t}.txt", commentary(t, t.split(" על")[0], 10))
print("ok", OUT)
