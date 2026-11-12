"""Learns the Hebrew-to-English Sefaria ref prefixes from the library itself (compatibility review B1).

For every ref_1/ref_2 in the present links roots of an otzaria-library checkout, the DB heRef of that
line is split into prefix + address and paired with the English prefix of the ref (longest match in
.github/data/sefaria_ref_prefixes.tsv). Writes prefix_pairs.tsv and report.txt (exact-match rate per
family) into <outdir>; scripts/sefaria-ref-prefixes.mjs turns the pairs into
src/core/links/sefaria-ref-prefixes.ts. Read-only on the database.

Usage: py -I scripts/sefaria-ref-pairs.py <otzaria-library> <seforim.db> <outdir>
"""
import json, os, re, sqlite3, sys, collections, random

LIB, DB, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = json.load(open(os.path.join(LIB, 'manual_links_sync.json'), encoding='utf-8'))
roots = [r['path'] for r in cfg['links_roots'] if r['expected_state'] == 'present']

# --- TSV prefixes (English) ---
prefixes = {}
for ln in open(os.path.join(LIB, '.github/data/sefaria_ref_prefixes.tsv'), encoding='utf-8'):
    ln = ln.rstrip('\n')
    if not ln or ln.startswith('#'):
        continue
    p, _, off = ln.partition('\t')
    prefixes[p] = [int(v) for v in off.split(',')] if off else []
by_first = collections.defaultdict(list)
for p in prefixes:
    by_first[p[:3]].append(p)
ADDR = re.compile(r'(?:\d+[ab]?)(?::\d+[ab]?)*')

def split_en(ref):
    cands = [p for p in by_first.get(ref[:3], []) if ref.startswith(p) and ADDR.fullmatch(ref[len(p):])]
    if not cands:
        return None
    p = max(cands, key=len)
    return p, ref[len(p):].split(':')

# --- Hebrew numerals ---
VAL = {c: v for c, v in zip('אבגדהוזחטיכלמנסעפצקרשת', [1,2,3,4,5,6,7,8,9,10,20,30,40,50,60,70,80,90,100,200,300,400])}
VAL.update({'ך': 20, 'ם': 40, 'ן': 50, 'ף': 80, 'ץ': 90})

def gem(tok):
    tok = tok.replace('"', '').replace("'", '').replace('״', '').replace('׳', '')
    if not tok:
        return None
    parts = tok.split(' ')
    if len(parts) == 2:  # "א רצ" thousands form
        a, b = gem(parts[0]), gem(parts[1])
        return None if a is None or b is None else a * 1000 + b
    if len(parts) != 1 or any(c not in VAL for c in tok):
        return None
    return sum(VAL[c] for c in tok)

def he_addr_to_en(tok, talmud):
    if talmud:
        if tok[-1:] not in ('.', ':'):
            return None
        n = gem(tok[:-1])
        return None if n is None else f"{n}{'a' if tok[-1] == '.' else 'b'}"
    n = gem(tok)
    return None if n is None else n

def build(heRef, n_addr, en_prefix, talmud_first, offsets):
    """heRef -> (hePrefix, english address string) or None."""
    toks = heRef.split(', ')
    if len(toks) <= n_addr:
        return None
    addr = [t.lstrip(" ") for t in toks[-n_addr:]]
    hep = ', '.join(toks[:-n_addr]) + ', '
    out = []
    for i, t in enumerate(addr):
        v = he_addr_to_en(t, talmud_first and i == 0)
        if v is None:
            return None
        out.append(v)
    # offsets: top offset unknown in TSV (only depth>=2 children offsets); apply child offsets
    if offsets and len(out) == 2 and isinstance(out[0], int):
        out[1] = out[1] + offsets[out[0] - 1]
    return hep, ':'.join(str(v) for v in out)

# --- DB ---
con = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
sef = collections.defaultdict(list)
for bid, title in con.execute('select id,title from book where sourceId=1'):
    sef[title].append(bid)
he_titles = set(l.strip() for l in open(os.path.join(LIB, '.github/data/sefaria_he_titles.txt'), encoding='utf-8') if l.strip() and not l.startswith('#'))
line_cache = {}
def line_heref(bid, idx0):
    key = bid
    if key not in line_cache:
        line_cache[key] = dict(con.execute('select lineIndex, heRef from line where bookId=?', (bid,)))
    return line_cache[key].get(idx0)

def family(en):
    if re.match(r'^(Genesis|Exodus|Leviticus|Numbers|Deuteronomy|Joshua|Judges|I |II |Isaiah|Jeremiah|Ezekiel|Hosea|Joel|Amos|Obadiah|Jonah|Micah|Nahum|Habakkuk|Zephaniah|Haggai|Zechariah|Malachi|Psalms|Proverbs|Job|Song of Songs|Ruth|Lamentations|Ecclesiastes|Esther|Daniel|Ezra|Nehemiah)\b', en) and not en.startswith('I Ching'):
        return 'Tanakh'
    if en.startswith('Mishneh Torah'):
        return 'Mishneh Torah'
    if en.startswith('Shulchan Arukh'):
        return 'Shulchan Aruch'
    if en.startswith('Mishnah Berurah'):
        return 'Mishnah Berurah'
    if en.startswith('Mishnah '):
        return 'Mishnah'
    if re.match(r'^(Rashi|Tosafot) on ', en):
        return 'Rashi/Tosafot on X'
    if re.match(r'^\S+ \d+[ab]', en) or re.match(r'^[A-Z][a-z]+( [A-Z][a-z]+)? \d+[ab]:', en):
        return 'Bavli'
    if en.startswith('Zohar'):
        return 'Zohar'
    return 'other'

stats = collections.defaultdict(collections.Counter)
pair_map = collections.defaultdict(collections.Counter)  # hePrefix -> Counter(enPrefix)
fails = collections.defaultdict(list)
samples = []
n_files = 0
for root in roots:
    base = os.path.join(LIB, root)
    if not os.path.isdir(base):
        continue
    for dp, _, fns in os.walk(base):
        for fn in fns:
            if not fn.endswith('_links.json'):
                continue
            recs = json.load(open(os.path.join(dp, fn), encoding='utf-8'))
            n_files += 1
            src_title = fn[:-len('_links.json')]
            for r in recs:
                for side in ('2', '1'):
                    ref = r.get('ref_' + side)
                    if ref is None:
                        continue
                    title = (os.path.basename(r['path_2'].replace('\\', '/'))[:-4] if side == '2' else src_title)
                    li = r.get('line_index_' + side)
                    sp = split_en(ref)
                    fam = family(ref)
                    st = stats[fam]
                    st['records'] += 1
                    if sp is None:
                        st['ref_prefix_unknown'] += 1; fails[fam].append(('noprefix', ref)); continue
                    ids = sef.get(title, [])
                    if len(ids) != 1:
                        st['db_book_missing_or_dup'] += 1; fails[fam].append(('nobook', title, ref)); continue
                    he = line_heref(ids[0], li - 1)
                    if he is None:
                        st['db_line_no_heref'] += 1; fails[fam].append(('noheref', title, li, ref)); continue
                    enp, addr = sp
                    talmud = bool(re.fullmatch(r'\d+[ab]', addr[0]))
                    b = build(he, len(addr), enp, talmud, prefixes[enp])
                    if b is None:
                        st['he_parse_fail'] += 1; fails[fam].append(('heparse', he, ref)); continue
                    hep, en_addr = b
                    pair_map[hep][enp] += 1
                    if enp + en_addr == ref:
                        st['address_exact'] += 1
                    else:
                        st['address_mismatch'] += 1; fails[fam].append(('addr', he, ref, enp + en_addr))
                    if len(samples) < 40 and random.random() < 0.01:
                        samples.append((fam, he, ref))

# prefix map functional?
multi = {h: c for h, c in pair_map.items() if len(c) > 1}
en_to_he = collections.defaultdict(set)
for h, c in pair_map.items():
    for e in c:
        en_to_he[e].add(h)
multi_rev = {e: hs for e, hs in en_to_he.items() if len(hs) > 1}

with open(os.path.join(OUT, 'report.txt'), 'w', encoding='utf-8') as f:
    f.write(f'files scanned: {n_files}\n')
    tot = collections.Counter()
    for fam, st in sorted(stats.items()):
        tot.update(st)
        f.write(f'{fam:22s} {dict(st)}\n')
    f.write(f'TOTAL {dict(tot)}\n')
    f.write(f'distinct hePrefix={len(pair_map)} enPrefix={len(en_to_he)} he->multi-en={len(multi)} en->multi-he={len(multi_rev)}\n')
    for h, c in list(multi.items())[:20]:
        f.write(f'  MULTI {h!r} -> {dict(c)}\n')
    for e, hs in list(multi_rev.items())[:20]:
        f.write(f'  REV {e!r} <- {hs}\n')
    f.write('\nSAMPLES\n')
    for s in samples:
        f.write(f'  {s}\n')
    f.write('\nFAILS\n')
    for fam, fl in fails.items():
        kinds = collections.Counter(x[0] for x in fl)
        f.write(f'{fam}: {dict(kinds)}\n')
        seen = collections.Counter()
        for x in fl:
            if seen[x[0]] < 8:
                f.write(f'   {x}\n'); seen[x[0]] += 1
with open(os.path.join(OUT, 'prefix_pairs.tsv'), 'w', encoding='utf-8') as f:
    for h, c in sorted(pair_map.items()):
        for e, n in c.items():
            f.write(f'{h}\t{e}\t{n}\n')
print('done')
