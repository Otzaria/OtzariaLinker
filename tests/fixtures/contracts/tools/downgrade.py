"""Find live records with a dependent type pointing from a non-base book into a base book; show what the DB stored."""
import json, os, sys, collections
sys.path.insert(0, r'C:/Users/User/Documents/DEV/_linker-research/contracts/scripts')
import extract as X
DEP = {'commentary', 'super_commentary', 'targum', 'midrash', 'parshanut', 'dibur_hamatchil', 'ein_mishpat', 'elucidation', 'footnotes'}
res = []; cnt = collections.Counter()
for dp, dn, fn in os.walk(X.LIB):
    if '.git' in dp or 'extraBooks' in dp:
        continue
    for f in sorted(fn):
        if not f.endswith('_links.json'):
            continue
        rel = os.path.relpath(os.path.join(dp, f), X.LIB).replace(X.BS, '/')
        data = json.loads(open(os.path.join(dp, f), 'rb').read().decode('utf-8-sig'))
        src = X.book(f[:-11])
        if len(src) != 1 or src[0]['isBaseBook']:
            continue
        for i, r in enumerate(data):
            t = str(r.get('Conection Type', '')).strip().lower().replace(' ', '_')
            if t not in DEP:
                continue
            tb = X.book(X.target_title(r['path_2']))
            if len(tb) != 1 or not tb[0]['isBaseBook']:
                continue
            cnt[(t, rel.split('/')[0])] += 1
            if len(res) < 6 and (not res or res[-1]['file'] != rel):
                res.append(dict(file=rel, recordIndex=i, record=r, db=X.resolve(rel, r)))
json.dump(dict(counts={'|'.join(k): v for k, v in cnt.items()}, examples=res), open(sys.argv[1], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
