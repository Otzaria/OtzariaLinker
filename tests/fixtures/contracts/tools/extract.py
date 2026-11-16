"""Pick real _links.json records per shape and join them with the real seforim.db rows (read-only)."""
import json, os, sys, sqlite3, subprocess, collections
import zstandard

LIB = r'C:/Users/User/Documents/DEV/_linker-research/contracts/otzaria-library'
BS = chr(92)
con = sqlite3.connect('file:C:/ProgramData/otzaria/books/seforim.db?mode=ro', uri=True)
con.execute('PRAGMA query_only=ON')
dict_blob = con.execute('select dict from zstd_dict').fetchone()[0]
dctx = zstandard.ZstdDecompressor(dict_data=zstandard.ZstdCompressionDict(dict_blob))
SRC = {r[0]: r[1] for r in con.execute('select id,name from source')}


def content(line_id):
    row = con.execute('select content from line_content where id=?', (line_id,)).fetchone()
    if row is None:
        return None
    c = row[0]
    if isinstance(c, bytes):
        return dctx.decompress(c, max_output_size=1 << 24).decode('utf-8')
    return c


def count_visible(html, end):
    # exact port of generator/common HtmlCharCounter.countVisibleChars
    if not html or end <= 0:
        return 0
    count = 0; in_tag = False; i = 0; n = min(len(html), end)
    while i < n:
        c = html[i]
        if in_tag:
            if c == '>':
                in_tag = False
        elif c == '<':
            in_tag = True
        elif c == '&':
            lim = min(n, i + 10); j = i + 1; term = False
            while j < lim:
                if html[j] == ';':
                    term = True; break
                j += 1
            count += 1
            if term:
                i = j
        else:
            count += 1
        i += 1
    return count


def utf16_len(s):
    return len(s.encode('utf-16-le')) // 2


def book(title):
    rows = con.execute('select id, sourceId, totalLines, isBaseBook from book where title=?', (title,)).fetchall()
    return [dict(id=r[0], source=SRC.get(r[1]), totalLines=r[2], isBaseBook=r[3]) for r in rows]


def line(book_id, idx0):
    r = con.execute('select id, heRef from line where bookId=? and lineIndex=?', (book_id, idx0)).fetchone()
    return None if r is None else dict(id=r[0], heRef=r[1])


def target_title(path2):
    last = path2.split(BS)[-1] if BS in path2 else path2.split('/')[-1]
    return last.rsplit('.', 1)[0] if '.' in last else last


def links_between(a, b):
    rows = con.execute(
        'select l.id, l.sourceBookId, l.targetBookId, l.sourceLineId, l.targetLineId, l.targetLineIndex, '
        'l.targetBookOrderIndex, ct.name, l.baseProvenance from link l join connection_type ct on ct.id=l.connectionTypeId '
        'where (l.sourceLineId=? and l.targetLineId=?) or (l.sourceLineId=? and l.targetLineId=?)', (a, b, b, a)).fetchall()
    out = []
    for r in rows:
        lid = r[0]
        out.append(dict(
            link=dict(id=lid, sourceBookId=r[1], targetBookId=r[2], sourceLineId=r[3], targetLineId=r[4],
                      targetLineIndex=r[5], targetBookOrderIndex=r[6], connectionType=r[7], baseProvenance=r[8],
                      storedDirection='as_file' if r[3] == a else 'flipped'),
            link_anchor=[dict(side=x[0], charStart=x[1], charEnd=x[2], label=x[3]) for x in con.execute(
                'select side,charStart,charEnd,label from link_anchor where linkId=? order by side,charStart', (lid,))],
            link_range=[dict(side=x[0], endLineId=x[1], endLineIndex=x[2]) for x in con.execute(
                'select side,endLineId,endLineIndex from link_range where linkId=? order by side', (lid,))],
            link_coverage_rows={str(x[0]): x[1] for x in con.execute(
                'select side,count(*) from link_coverage where linkId=? group by side', (lid,))},
            link_suppressed_side=[dict(side=x[0], reasonMask=x[1]) for x in con.execute(
                'select side,reasonMask from link_suppressed_side where linkId=?', (lid,))],
        ))
    return out


def resolve(rel, rec):
    src_title = os.path.basename(rel)[:-len('_links.json')]
    tgt_title = target_title(rec['path_2'])
    res = dict(sourceTitle=src_title, targetTitle=tgt_title, sourceBooks=book(src_title), targetBooks=book(tgt_title))
    if len(res['sourceBooks']) != 1 or len(res['targetBooks']) != 1:
        res['status'] = 'book_not_found_or_ambiguous'
        return res
    sb, tb = res['sourceBooks'][0], res['targetBooks'][0]
    sl = line(sb['id'], int(rec['line_index_1']) - 1)
    tl = line(tb['id'], int(rec['line_index_2']) - 1)
    res['sourceLine'] = sl; res['targetLine'] = tl
    if not sl or not tl:
        res['status'] = 'line_not_found'
        return res
    res['dbLinks'] = links_between(sl['id'], tl['id'])
    if 'start' in rec:
        c = content(sl['id'])
        if c is not None:
            s = int(rec['start'])
            res['anchorCheck'] = dict(
                rawStart=s, sourceLineLength=len(c), sourceLineUtf16Length=utf16_len(c),
                expectedCharStart=count_visible(c, s),
                contextAfterRawStart=c[s:s + 40], contextBeforeRawStart=c[max(0, s - 40):s])
    res['status'] = 'matched' if res['dbLinks'] else 'no_db_link_between_lines'
    return res


def shape_of(r):
    s1 = 'R' if r.get('line_index_1_end') not in (None, r.get('line_index_1')) else 'L'
    s2 = 'R' if r.get('line_index_2_end') not in (None, r.get('line_index_2')) else 'L'
    shape = s1 + '->' + s2
    if 'start' in r:
        shape += '+anchor' + ('-range' if 'end' in r else '-point')
    if 'ref_2' in r:
        shape += '+ref_2'
    if 'ref_1' in r:
        shape += '+ref_1'
    if str(r.get('Conection Type')).lower().startswith('footnote'):
        shape += '+footnotes'
    if str(r.get('path_2', '')).replace(BS, '/').split('/')[-1].startswith('הערות'):
        shape += '+hearot'
    return shape


def main(outdir, per_shape=10):
    head = subprocess.check_output(['git', '-C', LIB, 'rev-parse', 'HEAD'], text=True).strip()
    files = []
    for dp, dn, fn in os.walk(LIB):
        if '.git' in dp:
            continue
        for f in fn:
            if f.endswith('_links.json'):
                rel = os.path.relpath(os.path.join(dp, f), LIB).replace(BS, '/')
                if not rel.startswith('extraBooks'):
                    files.append(rel)
    files.sort()
    picked = collections.defaultdict(list)
    for rel in files:
        data = json.loads(open(os.path.join(LIB, rel), 'rb').read().decode('utf-8-sig'))
        by_shape = collections.defaultdict(list)
        for i, r in enumerate(data):
            by_shape[shape_of(r)].append(i)
        for sh, idxs in by_shape.items():
            # up to 3 records per file, spread over the file (middle, 3/4, last)
            for i in sorted({idxs[len(idxs) // 2], idxs[(3 * len(idxs)) // 4], idxs[-1]}):
                if len(picked[sh]) >= per_shape:
                    break
                r = data[i]
                picked[sh].append(dict(file=rel, recordIndex=i, record=r, db=resolve(rel, r)))
    stats = {k: collections.Counter(x['db']['status'] for x in v) for k, v in picked.items()}
    json.dump(dict(libraryCommit=head, picked=picked, stats=stats), open(os.path.join(outdir, 'raw_examples.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    print(json.dumps(stats, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv[1])
