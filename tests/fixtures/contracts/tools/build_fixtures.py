"""Turn raw_examples.json + a few DB-only samples into small, documented fixture files."""
import json, os, sys
sys.path.insert(0, r'C:/Users/User/Documents/DEV/_linker-research/contracts/scripts')
import extract as X

RAW = json.load(open(sys.argv[1], encoding='utf-8'))
OUT = sys.argv[2]
os.makedirs(OUT, exist_ok=True)
DBV = dict(X.con.execute('select key,value from schema_meta').fetchall())
PROV = {
    'libraryRepo': 'Otzaria/otzaria-library',
    'libraryCommit': RAW['libraryCommit'],
    'db': 'C:/ProgramData/otzaria/books/seforim.db (read-only)',
    'dbVersion': DBV.get('db_version'), 'dbSchemaVersion': DBV.get('db_schema_version'),
    'generatorRepo': 'Otzaria/SeforimLibrary@otzaria 23f1f8f16d2070d6b0459cc684722f4d029ad115',
    'note': 'The DB was built from an earlier library snapshot than libraryCommit; ref-managed line_index values '
            'may have drifted. line ids are DB-build specific. lineIndex in the DB is 0-based; line_index_* in the file is 1-based.',
}


def slim(e):
    db = e['db']
    out = dict(file=e['file'], recordIndex=e['recordIndex'], record=e['record'], resolution=dict(
        status=db['status'], sourceTitle=db['sourceTitle'], targetTitle=db['targetTitle'],
        sourceBook=db['sourceBooks'][0] if len(db['sourceBooks']) == 1 else db['sourceBooks'],
        targetBook=db['targetBooks'][0] if len(db['targetBooks']) == 1 else db['targetBooks']))
    if 'sourceLine' in db:
        out['resolution']['sourceLine'] = db['sourceLine']
        out['resolution']['targetLine'] = db['targetLine']
    if 'dbLinks' in db:
        out['dbRows'] = db['dbLinks']
    if 'anchorCheck' in db:
        ac = db['anchorCheck']
        stored = [a for l in db.get('dbLinks', []) for a in l['link_anchor'] if a['side'] == 0]
        ac['dbCharStart'] = [a['charStart'] for a in stored]
        ac['matchesGeneratorFormula'] = ac['expectedCharStart'] in ac['dbCharStart']
        out['anchorCheck'] = ac
    return out


def write(name, comment, shapes, extra=None):
    items = []
    for sh in shapes:
        items += [dict(shape=sh, **slim(e)) for e in RAW['picked'].get(sh, [])]
    doc = {'_comment': comment, '_provenance': PROV, 'examples': items}
    if extra:
        doc.update(extra)
    json.dump(doc, open(os.path.join(OUT, name), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(name, len(items))


write('line-to-line.json',
      'Plain line->line records without ref_* (local<->local). "source"-typed records are stored flipped as COMMENTARY '
      '(dbRows[].link.storedDirection == "flipped"). Some records resolve to no book (name traps) - see status.',
      ['L->L'])
write('line-to-line-sefaria-ref.json',
      'line->line records whose target (ref_2) or source (ref_1) is a Sefaria-owned book. ref_* are pipeline-only fields; '
      'the DB build ignores them (ignoreUnknownKeys). Mostly "source" -> flipped COMMENTARY.',
      ['L->L+ref_2', 'L->L+ref_1'])
write('line-to-range.json',
      'Records with line_index_2_end (target-side range). Stored link sits on the start line; link_range holds the last line; '
      'link_coverage one row per covered line after the first (headings excluded). Side follows the STORED direction '
      '(flipped "source" records put the file\'s line_index_2_end on side 0).',
      ['L->R', 'L->R+ref_1', 'L->R+ref_2'])
write('range-to-line.json',
      'Records with line_index_1_end (source-side range), all "source"-typed with ref_2 -> stored flipped, so the range '
      'appears on side 1.',
      ['R->L+ref_2'])
write('anchor-point.json',
      'Word-anchored records: "start" only (no "end" exists anywhere in the live library). anchorCheck recomputes '
      'countVisibleChars(rawLine, start) on the DB line text and compares to link_anchor.charStart. label comes from '
      '" אות X" in heRef_2 only; otherwise NULL. tashma records also carry ref_1 + anchor_src_hash + anchor_context (pipeline-only).',
      ['L->L+anchor-point', 'L->R+anchor-point', 'L->L+anchor-point+ref_1'])

# notes companions: evidence that "הערות על X" was merged inline (no book row, line_note rows on the base line)
notes = []
for sh in ('L->L+footnotes+hearot', 'L->L+hearot'):
    for e in RAW['picked'].get(sh, []):
        s = slim(e)
        sb = e['db']['sourceBooks']
        if len(sb) == 1:
            lid = X.line(sb[0]['id'], int(e['record']['line_index_1']) - 1)
            if lid:
                s['baseLineNotes'] = [dict(noteIndex=r[0], charPos=r[1], hasMarker=r[2]) for r in X.con.execute(
                    'select noteIndex,charPos,hasMarker from line_note where lineId=?', (lid['id'],))]
        s['shape'] = sh
        notes.append(s)
json.dump({'_comment': 'Records pointing at "הערות על X" companions. When the merge plan accepts the pair, the companion gets NO '
                       'book row: its notes are merged into the base lines (line_note rows in schema 7) and every link record '
                       'into it is skipped. status=book_not_found_or_ambiguous with an empty targetBook is the expected outcome. '
                       'A source file whose name is not the exact DB title (e.g. ׳׳ vs ״) is dropped entirely.',
           '_provenance': PROV, 'examples': notes},
          open(os.path.join(OUT, 'notes-companion.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('notes-companion.json', len(notes))

dg = json.load(open(sys.argv[3], encoding='utf-8'))
json.dump({'_comment': 'A dependent-type record ("commentary") from a non-base book into a base book (isBaseBook=1) whose title '
                       'does not declare "X על <base>": the generator stores it as OTHER (Generator.kt:2282-2291).',
           '_provenance': PROV, 'counts': dg['counts'], 'examples': [dict(file=e['file'], recordIndex=e['recordIndex'],
                                                                           record=e['record'], dbRows=e['db'].get('dbLinks'))
                                                                      for e in dg['examples']]},
          open(os.path.join(OUT, 'dependent-downgraded-to-other.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


# DB-only shapes (no library input exists)
def db_link(lid):
    r = X.con.execute(
        'select l.id, sb.title, sbs.name, sl.lineIndex, sl.heRef, tb.title, tbs.name, tl.lineIndex, tl.heRef, ct.name, l.sourceLineId '
        'from link l join book sb on sb.id=l.sourceBookId join source sbs on sbs.id=sb.sourceId '
        'join book tb on tb.id=l.targetBookId join source tbs on tbs.id=tb.sourceId '
        'join line sl on sl.id=l.sourceLineId join line tl on tl.id=l.targetLineId '
        'join connection_type ct on ct.id=l.connectionTypeId where l.id=?', (lid,)).fetchone()
    d = dict(linkId=r[0], source=dict(title=r[1], origin=r[2], lineIndex0=r[3], heRef=r[4]),
             target=dict(title=r[5], origin=r[6], lineIndex0=r[7], heRef=r[8]), connectionType=r[9],
             link_anchor=[dict(side=x[0], charStart=x[1], charEnd=x[2], label=x[3]) for x in X.con.execute(
                 'select side,charStart,charEnd,label from link_anchor where linkId=?', (lid,))],
             link_range=[dict(side=x[0], endLineIndex0=x[1]) for x in X.con.execute(
                 'select side,endLineIndex from link_range where linkId=?', (lid,))],
             link_coverage_rows={str(x[0]): x[1] for x in X.con.execute(
                 'select side,count(*) from link_coverage where linkId=? group by side', (lid,))},
             link_suppressed_side=[dict(side=x[0], reasonMask=x[1]) for x in X.con.execute(
                 'select side,reasonMask from link_suppressed_side where linkId=?', (lid,))])
    if d['link_anchor']:
        c = X.content(r[10]) or ''
        a = d['link_anchor'][0]
        # visible text under the anchor (strip tags) for human review
        import re
        vis = re.sub(r'<[^>]*>', '', c)
        d['visibleTextAtAnchor'] = vis[a['charStart']:(a['charEnd'] or a['charStart'] + 1)] if a['side'] == 0 else None
    return d


rr = [x[0] for x in X.con.execute(
    'select r0.linkId from link_range r0 join link_range r1 on r1.linkId=r0.linkId and r1.side=1 where r0.side=0 '
    'and r0.linkId % 997 = 0 limit 10')]
lk = [x[0] for x in X.con.execute(
    'select la.linkId from link_anchor la join link l on l.id=la.linkId where l.connectionTypeId=15 and la.linkId % 9973 = 0 limit 10')]
q1 = [x[0] for x in X.con.execute(
    'select la.linkId from link_anchor la where la.side=1 and la.linkId % 13 = 0 limit 5')]
sup = [x[0] for x in X.con.execute('select linkId from link_suppressed_side where linkId % 4999 = 0 limit 5')]
json.dump({'_comment': 'Shapes that exist in the DB but have NO producer in the live otzaria-library _links.json files: '
                       'range->range (Sefaria CSV ranges on both sides), LINKER citation range anchors (LinkerToOtzaria Phase-2, '
                       'never from _links.json - "linker" records are skipped by the generator), side=1 anchors (Sefaria char-level '
                       'QUOTATION), and link_suppressed_side rows (Sefaria visibility masks). Not reproducible from _links.json.',
           '_provenance': PROV,
           'rangeToRange': [db_link(i) for i in rr], 'linkerAnchorRange': [db_link(i) for i in lk],
           'targetSideAnchor': [db_link(i) for i in q1], 'suppressedSide': [db_link(i) for i in sup]},
          open(os.path.join(OUT, 'db-only-shapes.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('db-only done', len(rr), len(lk), len(q1), len(sup))
