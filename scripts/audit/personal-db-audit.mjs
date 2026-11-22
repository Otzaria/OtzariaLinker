#!/usr/bin/env node
/*
 * Offline, READ-ONLY audit of a personal Otzaria database made by Personal-DB-Creator (links in `external_link`,
 * no `link` table), e.g. "otzarya-unofficial-books". It measures; it never writes inside the database or the repo,
 * and it prints AGGREGATE numbers only (counts, book titles of a few top rows) — never book text.
 *
 *   node scripts/audit/personal-db-audit.mjs <personal.db> [--official <seforim.db>] [--phase stats|sample|graph|quick-check|all]
 *                                           [--seed 52] [--per-stratum 60] [--out result.json]
 *
 * Phases are kept apart on purpose (docs/research/PERSONAL_DB_V52_AUDIT.md):
 *   stats        counts and breakdowns of the whole file (SQL and one scan)   — STATISTICS
 *   sample       a seeded stratified random sample and a failure-focused sample of existing links, each verified
 *                against the real tables (and the official database when given)    — SAMPLING, then EVALUATION
 *   graph        the books-and-relations graph aggregated by class (docs/research/PERSONAL_DB_RELATION_MAP.md)
 *   quick-check  PRAGMA quick_check with its running time (slow on a multi-GB file; run it alone)
 *
 * The database is opened with { readOnly: true }. Line text is decoded only for the sampled lines, with the same
 * zstd decoder the tool ships (node_modules/zstd-wasm-decoder) and each database's OWN dictionary.
 * KNOWN_TYPES must match src/core/links/connection-type.ts (parseConnectionType).
 */
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const DB_PATH = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
if (!DB_PATH) {
  console.error("usage: node scripts/audit/personal-db-audit.mjs <personal.db> [--official <seforim.db>] [--phase stats|sample|graph|quick-check|all] [--seed N] [--per-stratum N] [--out file.json]");
  process.exit(2);
}
const OFFICIAL_PATH = flag("official");
const PHASE = flag("phase", "all");
const SEED = Number(flag("seed", "52"));
const PER_STRATUM = Number(flag("per-stratum", "60"));
const OUT = flag("out");
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const official = OFFICIAL_PATH ? new DatabaseSync(OFFICIAL_PATH, { readOnly: true }) : null;
const all = (d, sql, ...a) => d.prepare(sql).all(...a);
const one = (d, sql, ...a) => d.prepare(sql).get(...a);

// the generator's names (connection-type.ts KNOWN) — a connectionType outside it is stored as OTHER by the generator
const KNOWN_TYPES = new Set([
  "commentary", "super_commentary", "supercommentary", "targum", "reference", "source", "midrash", "quotation", "quotation_auto", "quotation_auto_tanakh",
  "mesorat_hashas", "ein_mishpat", "ein_mishpat_/_ner_mitsvah", "ein_mishpat_/_ner_mitzvah", "dibur_hamatchil", "parshanut", "mishnah_in_talmud", "related",
  "related_passage", "linker", "sifrei_mitzvot", "essay", "allusion", "liturgy", "ellucidation", "elucidation", "explication", "law", "summary", "footnotes",
  "footnote", "", "none", "other",
]);
const typeKey = (raw) => String(raw ?? "").trim().toLowerCase().replaceAll(" ", "_");
const typeOf = (raw) => (raw === null || String(raw).trim() === "" ? "REFERENCE" : KNOWN_TYPES.has(typeKey(raw)) ? typeKey(raw).toUpperCase() : "OTHER(unrecognised)");

const result = { tool: "scripts/audit/personal-db-audit.mjs", openedReadOnly: true, date: new Date().toISOString().slice(0, 10), seed: SEED };
const save = () => (OUT ? writeFileSync(OUT, JSON.stringify(result, null, 1)) : console.log(JSON.stringify(result, null, 1)));

// ---------------------------------------------------------------------------------------------- shared tables
const libraryId = one(db, "select value from schema_meta where key='library_id'")?.value ?? null;
const books = all(db, "select id, title, categoryId, totalLines from book order by id");
const bookById = new Map(books.map((b) => [b.id, b]));
const ownByTitle = new Map();
for (const b of books) if (!ownByTitle.has(b.title)) ownByTitle.set(b.title, b); // first (lowest id) wins, as the tool does
const cats = new Map(all(db, "select id, parentId, title, level from category").map((c) => [c.id, c]));
const rootOf = (catId) => {
  let c = cats.get(catId);
  for (let i = 0; c && c.parentId != null && i < 20; i++) c = cats.get(c.parentId);
  return c?.title ?? "(no category)";
};
const pathOf = (catId) => {
  const out = [];
  for (let c = cats.get(catId), i = 0; c && i < 20; c = c.parentId != null ? cats.get(c.parentId) : undefined, i++) out.unshift(c.title);
  return out.join(" > ");
};
const officialByTitle = new Map();
if (official) for (const b of all(official, "select id, title, totalLines, isBaseBook from book order by id")) if (!officialByTitle.has(b.title)) officialByTitle.set(b.title, b);
const histogram = (values, edges) => {
  const out = Object.fromEntries([...edges.map((e, i) => [`${e}${i + 1 < edges.length ? `-${edges[i + 1] - 1}` : "+"}`, 0])]);
  const keys = Object.keys(out);
  for (const v of values) {
    let k = 0;
    for (let i = 0; i < edges.length; i++) if (v >= edges[i]) k = i;
    out[keys[k]]++;
  }
  return out;
};

// ---------------------------------------------------------------------------------------------- stats
function stats() {
  const r = {};
  log("stats: file facts");
  r.file = { name: DB_PATH.split(/[\\/]/).pop(), bytes: statSync(DB_PATH).size };
  r.pragma = Object.fromEntries(["user_version", "application_id", "page_size", "page_count", "freelist_count", "journal_mode", "auto_vacuum"].map((p) => [p, Object.values(one(db, `PRAGMA ${p}`))[0]]));
  r.libraryId = libraryId;
  const tables = all(db, "select name from sqlite_master where type='table' order by name").map((t) => t.name);
  r.tables = tables;
  r.rowCounts = Object.fromEntries(tables.map((t) => [t, one(db, `select count(*) n from "${t}"`).n]));
  log("stats: indexes and keys");
  r.indexes = {};
  r.foreignKeys = {};
  for (const t of tables) {
    r.indexes[t] = all(db, `PRAGMA index_list("${t}")`).map((ix) => ({ name: ix.name, unique: !!ix.unique, origin: ix.origin, columns: all(db, `PRAGMA index_info("${ix.name}")`).map((c) => c.name) }));
    r.foreignKeys[t] = all(db, `PRAGMA foreign_key_list("${t}")`).length;
  }
  r.primaryKeys = Object.fromEntries(tables.map((t) => [t, all(db, `PRAGMA table_info("${t}")`).filter((c) => c.pk).map((c) => c.name)]));
  r.foreignKeyCheckViolations = all(db, "PRAGMA foreign_key_check").length;

  log("stats: external_link breakdowns");
  const ex = (sql) => all(db, sql);
  r.byTargetSource = ex("select targetSource, count(*) n from external_link group by 1 order by 2 desc");
  r.byConnectionType = ex("select connectionType, count(*) n from external_link group by 1 order by 2 desc");
  const unrec = r.byConnectionType.filter((t) => typeOf(t.connectionType) === "OTHER(unrecognised)");
  r.unrecognisedConnectionType = { distinctValues: unrec.length, rows: unrec.reduce((s, t) => s + t.n, 0) };
  r.pairs = {
    rows: one(db, "select count(*) n from external_link").n,
    distinctBookPairs: one(db, "select count(*) n from (select 1 from external_link group by sourceBookId, targetSource, targetTitle)").n,
    distinctLinePairs: one(db, "select count(*) n from (select 1 from external_link group by sourceBookId, sourceLineIndex, targetSource, targetTitle, targetLineIndex)").n,
    distinctSourceLines: one(db, "select count(*) n from (select 1 from external_link group by sourceBookId, sourceLineIndex)").n,
    distinctTargetLines: one(db, "select count(*) n from (select 1 from external_link group by targetSource, targetTitle, targetLineIndex)").n,
    distinctSourceBooks: one(db, "select count(distinct sourceBookId) n from external_link").n,
  };

  log("stats: duplicates");
  const dupRows = (inner) => {
    const g = one(db, `select count(*) groups, coalesce(sum(c - 1), 0) extra from (select count(*) c from external_link ${inner})`);
    return { groups: g.groups, extraRows: g.extra };
  };
  const norm = "upper(trim(ifnull(nullif(trim(connectionType), ''), 'REFERENCE')))";
  r.duplicates = {
    sameDirectionExact: dupRows("group by sourceBookId, sourceLineIndex, targetSource, targetTitle, targetLineIndex, ifnull(targetRef,''), ifnull(connectionType,'') having count(*) > 1"),
    sameDirectionSameLinesAndType: dupRows(`group by sourceBookId, sourceLineIndex, targetSource, targetTitle, targetLineIndex, ${norm} having count(*) > 1`),
    sameLinesDifferentType: one(db, `select count(*) groups from (select 1 from external_link group by sourceBookId, sourceLineIndex, targetSource, targetTitle, targetLineIndex having count(distinct ${norm}) > 1)`).groups,
  };
  if (libraryId) {
    const rev = one(
      db,
      `select count(*) rows from external_link e join book tb on tb.title = e.targetTitle join book sb on sb.id = e.sourceBookId
         join external_link f on f.sourceBookId = tb.id and f.sourceLineIndex = e.targetLineIndex and f.targetTitle = sb.title and f.targetLineIndex = e.sourceLineIndex and f.targetSource = ?
        where e.targetSource = ?`,
      libraryId,
      libraryId,
    );
    r.duplicates.reverseInternalRows = rev.rows;
    r.duplicates.reverseInternalPairs = rev.rows / 2;
  }

  log("stats: one scan (flags by proxy)");
  const toc = new Set(all(db, "select lineId from tocEntry where lineId is not null").map((x) => Number(x.lineId)));
  const lineId = (bookId, idx) => bookId * 2 ** 20 + idx + 1;
  // verify the line.id rule on a sample of rows before using it as a proxy
  const rule = one(db, "select count(*) n, sum(id = bookId * 1048576 + lineIndex + 1) ok from (select id, bookId, lineIndex from line limit 200000)");
  r.lineIdRule = { checked: rule.n, matching: rule.ok };
  const flags = { rows: 0, internalRows: 0, officialRows: 0, targetBookUnresolved: 0, internalTargetOutOfRange: 0, officialTargetOutOfRange: 0, internalTargetIsTocLine: 0, sourceIsTocLine: 0, sourceLineOutOfRange: 0, sourceBookMissing: 0 };
  const perClassDegree = new Map();
  const perBookOut = new Map();
  for (const e of db.prepare("select sourceBookId sb, sourceLineIndex sl, targetSource ts, targetTitle tt, targetLineIndex tl, connectionType ct from external_link").iterate()) {
    flags.rows++;
    perBookOut.set(e.sb, (perBookOut.get(e.sb) ?? 0) + 1);
    const sb = bookById.get(e.sb);
    if (!sb) flags.sourceBookMissing++;
    else if (e.sl >= sb.totalLines) flags.sourceLineOutOfRange++;
    if (toc.has(lineId(e.sb, e.sl))) flags.sourceIsTocLine++;
    const isOwn = e.ts === libraryId;
    if (isOwn) {
      flags.internalRows++;
      const tb = ownByTitle.get(e.tt);
      if (!tb) flags.targetBookUnresolved++;
      else {
        if (e.tl >= tb.totalLines) flags.internalTargetOutOfRange++;
        if (toc.has(lineId(tb.id, e.tl))) flags.internalTargetIsTocLine++;
      }
    } else {
      flags.officialRows++;
      const tb = officialByTitle.get(e.tt);
      if (official && !tb) flags.targetBookUnresolved++;
      else if (tb && e.tl >= tb.totalLines) flags.officialTargetOutOfRange++;
    }
    const cls = `${isOwn ? "internal" : "official"}/${typeOf(e.ct)}`;
    perClassDegree.set(cls, (perClassDegree.get(cls) ?? 0) + 1);
  }
  r.flagsByProxy = { ...flags, note: "TOC-line flags use tocEntry.lineId as a proxy for header lines (the sample phase checks the real text); official flags need --official" };
  r.classes = Object.fromEntries([...perClassDegree].sort((a, b) => b[1] - a[1]));

  log("stats: categories, books, top books");
  const incomingInternal = new Set(libraryId ? all(db, "select distinct b.id id from external_link e join book b on b.title = e.targetTitle where e.targetSource = ?", libraryId).map((x) => x.id) : []);
  const roots = new Map();
  const root = (name) => roots.get(name) ?? roots.set(name, { books: 0, lines: 0, booksWithOutgoing: 0, booksWithIncomingInternal: 0, booksWithNoLink: 0, outgoingLinks: 0 }).get(name);
  for (const b of books) {
    const x = root(rootOf(b.categoryId));
    const out = perBookOut.get(b.id) ?? 0;
    x.books++;
    x.lines += b.totalLines;
    x.outgoingLinks += out;
    if (out) x.booksWithOutgoing++;
    if (incomingInternal.has(b.id)) x.booksWithIncomingInternal++;
    if (!out && !incomingInternal.has(b.id)) x.booksWithNoLink++;
  }
  r.byRootCategory = Object.fromEntries([...roots].sort((a, b) => b[1].books - a[1].books));
  r.books = { total: books.length, withOutgoing: perBookOut.size, withIncomingInternal: incomingInternal.size, withNoLinkEitherWay: books.filter((b) => !perBookOut.has(b.id) && !incomingInternal.has(b.id)).length };
  r.outDegreeHistogram = histogram(books.map((b) => perBookOut.get(b.id) ?? 0), [0, 1, 10, 100, 1000, 10000, 100000]);
  const top = (n, rows) => rows.slice(0, n);
  r.topBooksByOutgoing = top(
    15,
    [...perBookOut].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ title: bookById.get(id)?.title, root: rootOf(bookById.get(id)?.categoryId), outgoing: n })),
  );
  r.topInternalTargets = libraryId ? ex(`select targetTitle title, count(*) incoming from external_link where targetSource = '${libraryId.replaceAll("'", "''")}' group by 1 order by 2 desc limit 15`) : [];
  r.topOfficialTargets = ex("select targetTitle title, count(*) incoming, count(distinct sourceBookId) fromBooks from external_link where targetSource = 'official' group by 1 order by 2 desc limit 15");

  log("stats: commentary-like books without links");
  const catLike = /מפרשים|מפרשי|חידושים|ביאור/;
  const hasLink = (b) => perBookOut.has(b.id) || incomingInternal.has(b.id);
  const titleBase = (t) => /^(.+?) על (.+)$/.exec(t)?.[2];
  const candidates = [];
  for (const b of books) {
    const byCat = catLike.test(pathOf(b.categoryId));
    const byNotes = b.title.startsWith("הערות על ");
    const base = titleBase(b.title);
    const byTitle = !!base && (ownByTitle.has(base) || officialByTitle.has(base));
    if (byCat || byNotes || byTitle) candidates.push({ b, byCat, byNotes, byTitle });
  }
  const noLink = candidates.filter((c) => !hasLink(c.b));
  r.commentaryLike = {
    note: "heuristics, a guess and not a content audit: category path matches מפרשים/מפרשי/חידושים/ביאור; title 'הערות על …'; title 'X על Y' where Y is a book (own, or official when --official is given)",
    byCategory: candidates.filter((c) => c.byCat).length,
    byNotesTitle: candidates.filter((c) => c.byNotes).length,
    byXOnYTitle: candidates.filter((c) => c.byTitle).length,
    total: candidates.length,
    withoutAnyLink: noLink.length,
    withoutAnyLinkByCategory: noLink.filter((c) => c.byCat).length,
    withoutAnyLinkByXOnYTitle: noLink.filter((c) => c.byTitle).length,
    withoutAnyLinkByRoot: Object.fromEntries(Object.entries(noLink.reduce((m, c) => ((m[rootOf(c.b.categoryId)] = (m[rootOf(c.b.categoryId)] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1])),
    withoutOutgoingBaseLink: candidates.filter((c) => !perBookOut.has(c.b.id) && !c.byNotes).length,
    examples: noLink.slice(0, 12).map((c) => c.b.title),
  };
  result.stats = r;
}

// ---------------------------------------------------------------------------------------------- zstd (sample)
let decoders = null;
async function loadDecoder() {
  if (decoders) return decoders;
  const base = fileURLToPath(new URL("../../node_modules/zstd-wasm-decoder/_esm/", import.meta.url));
  const { ZstdDecoder } = await import("file:///" + base.replaceAll("\\", "/") + "index.node.js");
  const wasm = new WebAssembly.Module(readFileSync(base + "zstd-decoder.wasm"));
  const dictId = (d) => (d.length >= 8 && d[0] === 0x37 && d[1] === 0xa4 && d[2] === 0x30 && d[3] === 0xec ? d[4] + d[5] * 256 + d[6] * 65536 + d[7] * 16777216 : null);
  const frame = (b) => {
    const fhd = b[4], fcs = fhd >> 6, ss = (fhd >> 5) & 1, df = fhd & 3;
    let p = 5 + (ss ? 0 : 1);
    const dl = [0, 1, 2, 4][df];
    let id = 0;
    for (let i = 0; i < dl; i++) id += b[p + i] * 2 ** (8 * i);
    p += dl;
    const fb = fcs === 0 ? (ss ? 1 : 0) : [0, 2, 4, 8][fcs];
    let size = null;
    if (fb) {
      size = 0;
      for (let i = 0; i < fb; i++) size += b[p + i] * 2 ** (8 * i);
      if (fb === 2) size += 256;
    }
    return { id, size };
  };
  const codec = (d) => {
    const by = new Map();
    for (const r of all(d, "select dict from zstd_dict")) {
      const dict = new Uint8Array(r.dict);
      by.set(dictId(dict), new ZstdDecoder({ dictionary: dict }).init(wasm));
    }
    return (v) => {
      if (typeof v === "string") return v;
      const b = new Uint8Array(v);
      if (!(b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd)) throw new Error("not a zstd frame");
      const h = frame(b);
      const dec = by.get(h.id);
      if (!dec || h.size === null) throw new Error("no dictionary or size");
      return Buffer.from(dec.decompressSync(b, h.size)).toString("utf8");
    };
  };
  decoders = { own: codec(db), official: official ? codec(official) : null };
  return decoders;
}
const visible = (html) => html.replace(/<[^>]*>/g, "").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
const isHeader = (html) => /^<h[1-6]/i.test(html); // headingLevel(): the line STARTS with <h1>-<h6>

/** a seeded generator (mulberry32): the same seed gives the same sample */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (arr, n, rand) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
};

// ---------------------------------------------------------------------------------------------- sample + evaluation
async function sample() {
  const rand = rng(SEED);
  const dec = await loadDecoder();
  const r = { seed: SEED, perStratum: PER_STRATUM };
  log("sample: strata");
  const toc = new Set(all(db, "select lineId from tocEntry where lineId is not null").map((x) => Number(x.lineId)));
  const lineId = (b, i) => b * 2 ** 20 + i + 1;
  const strata = new Map();
  const failures = { targetOutOfRange: [], targetIsTocLine: [], sourceIsTocLine: [], targetUnresolved: [] };
  for (const e of db.prepare("select rowid id, sourceBookId sb, sourceLineIndex sl, targetSource ts, targetTitle tt, targetRef tr, targetLineIndex tl, connectionType ct from external_link").iterate()) {
    const own = e.ts === libraryId;
    const cls = `${own ? "internal" : "official"}/${typeOf(e.ct)}`;
    (strata.get(cls) ?? strata.set(cls, []).get(cls)).push(e.id);
    const tb = own ? ownByTitle.get(e.tt) : officialByTitle.get(e.tt);
    if (!tb && (own || official)) failures.targetUnresolved.push(e.id);
    else if (tb) {
      if (e.tl >= tb.totalLines) failures.targetOutOfRange.push(e.id);
      if (own && toc.has(lineId(tb.id, e.tl))) failures.targetIsTocLine.push(e.id);
    }
    if (toc.has(lineId(e.sb, e.sl))) failures.sourceIsTocLine.push(e.id);
  }
  r.strataSizes = Object.fromEntries([...strata].map(([k, v]) => [k, v.length]));
  r.failureCandidates = Object.fromEntries(Object.entries(failures).map(([k, v]) => [k, v.length]));

  const getRow = db.prepare("select rowid id, sourceBookId sb, sourceLineIndex sl, targetSource ts, targetTitle tt, targetRef tr, targetLineIndex tl, connectionType ct from external_link where rowid = ?");
  const ownLine = db.prepare("select l.id id, c.content content from line l left join line_content c on c.id = l.id where l.bookId = ? and l.lineIndex = ?");
  const offLine = official ? official.prepare("select l.id id, l.heRef heRef, c.content content from line l left join line_content c on c.id = l.id where l.bookId = ? and l.lineIndex = ?") : null;

  const sideCheck = (where, bookRow, idx, d, codec, withRef) => {
    const res = { book: !!bookRow, inRange: false, row: false, decodes: false, notHeader: false, nonEmpty: false };
    if (!bookRow) return res;
    res.inRange = idx >= 0 && idx < bookRow.totalLines;
    const row = (where === "own" ? ownLine : offLine)?.get(bookRow.id, idx);
    if (!row) return res;
    res.row = true;
    res.heRef = row.heRef ?? null;
    try {
      const html = codec(row.content);
      res.decodes = true;
      res.notHeader = !isHeader(html);
      res.nonEmpty = visible(html).length > 0;
    } catch {
      /* counted as not decodable */
    }
    return res;
  };
  const verify = (ids) => {
    const tally = { n: 0, sourceOk: 0, targetBookFound: 0, targetInRange: 0, targetLineExists: 0, targetNotHeader: 0, targetNonEmpty: 0, refMatchesHeRef: 0, refChecked: 0, allPass: 0, notDecodable: 0, targetNotVerifiable: 0 };
    const reasons = {};
    for (const id of ids) {
      const e = getRow.get(id);
      tally.n++;
      const own = e.ts === libraryId;
      const s = sideCheck("own", bookById.get(e.sb), e.sl, db, dec.own);
      const sOk = s.book && s.inRange && s.row && s.notHeader && s.nonEmpty;
      if (sOk) tally.sourceOk++;
      const tBook = own ? ownByTitle.get(e.tt) : officialByTitle.get(e.tt);
      let tOk = false;
      if (!own && !official) tally.targetNotVerifiable++;
      else {
        const t = sideCheck(own ? "own" : "official", tBook, e.tl, own ? db : official, own ? dec.own : dec.official);
        if (t.book) tally.targetBookFound++;
        if (t.inRange) tally.targetInRange++;
        if (t.row) tally.targetLineExists++;
        if (t.row && !t.decodes) tally.notDecodable++;
        if (t.notHeader) tally.targetNotHeader++;
        if (t.nonEmpty) tally.targetNonEmpty++;
        if (!own && e.tr) {
          tally.refChecked++;
          if (t.heRef === e.tr) tally.refMatchesHeRef++;
        }
        tOk = t.book && t.inRange && t.row && t.notHeader && t.nonEmpty;
        if (!tOk) {
          const why = !t.book ? "target book not found" : !t.inRange ? "target out of range" : !t.row ? "target line missing" : !t.notHeader ? "target is a header" : "target empty or undecodable";
          reasons[why] = (reasons[why] ?? 0) + 1;
        }
      }
      if (!sOk) {
        const why = !s.book ? "source book missing" : !s.inRange ? "source out of range" : !s.row ? "source line missing" : !s.notHeader ? "source is a header" : "source empty or undecodable";
        reasons[why] = (reasons[why] ?? 0) + 1;
      }
      if (sOk && tOk) tally.allPass++;
    }
    return { ...tally, failureReasons: reasons };
  };

  log("sample: stratified random sample (seeded) — evaluation");
  r.stratifiedRandom = {};
  for (const [cls, ids] of [...strata].sort()) r.stratifiedRandom[cls] = verify(pick(ids, PER_STRATUM, rand));
  r.stratifiedRandomTotal = Object.values(r.stratifiedRandom).reduce((s, x) => s + x.n, 0);
  log("sample: failure-focused sample — evaluation");
  r.failureFocused = {};
  for (const [kind, ids] of Object.entries(failures)) r.failureFocused[kind] = { population: ids.length, ...(ids.length ? verify(pick(ids, PER_STRATUM, rand)) : {}) };
  result.sample = r;
}

// ---------------------------------------------------------------------------------------------- graph
function graph() {
  const r = {};
  log("graph: edges");
  const own = (title) => ownByTitle.get(title);
  const edges = new Map(); // "fromId>toKey:class" → weight
  const nodes = { own: new Set(), official: new Set() };
  const perBook = new Map();
  const bk = (id) => perBook.get(id) ?? perBook.set(id, { out: {}, in: {}, outBooks: new Set(), inBooks: new Set() }).get(id);
  const addTo = (o, k) => (o[k] = (o[k] ?? 0) + 1);
  for (const e of db.prepare("select sourceBookId sb, targetSource ts, targetTitle tt, connectionType ct from external_link").iterate()) {
    const isOwn = e.ts === libraryId;
    const cls = typeOf(e.ct);
    const from = bk(e.sb);
    nodes.own.add(e.sb);
    if (isOwn) {
      const tb = own(e.tt);
      if (!tb) continue;
      nodes.own.add(tb.id);
      const to = bk(tb.id);
      addTo(from.out, `internal/${cls}`);
      addTo(to.in, `internal/${cls}`);
      from.outBooks.add(`own:${tb.id}`);
      to.inBooks.add(e.sb);
      const k = `${e.sb}>own:${tb.id}|${cls}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    } else {
      nodes.official.add(e.tt);
      addTo(from.out, `official/${cls}`);
      from.outBooks.add(`official:${e.tt}`);
      const k = `${e.sb}>official:${e.tt}|${cls}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  r.nodes = { ownBooks: books.length, ownBooksWithAnyRelation: perBook.size, officialBooksTargeted: nodes.official.size };
  r.edges = { bookToBookEdgesByClass: {}, totalDistinctEdges: edges.size };
  for (const k of edges.keys()) {
    const scope = k.includes(">official:") ? "official" : "internal";
    const cls = k.split("|")[1];
    const c = (r.edges.bookToBookEdgesByClass[`${scope}/${cls}`] ??= { edges: 0, links: 0 });
    c.edges++;
    c.links += edges.get(k);
  }
  const title = (key) => (key.startsWith("official:") ? key.slice(9) : bookById.get(Number(key.slice(4)))?.title);
  r.topEdgesByWeight = [...edges].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, w]) => {
    const [fromTo, cls] = k.split("|");
    const [from, to] = fromTo.split(">");
    return { from: bookById.get(Number(from))?.title, to: title(to), scope: to.startsWith("official:") ? "official" : "internal", type: cls, links: w };
  });

  log("graph: classification");
  const has = (b, prefix) => Object.keys(b.out).some((k) => k.startsWith(prefix));
  const classes = { commentaryOnOfficial: [], internalSourceOrCommentary: [], notesBook: [], footnotedBook: [], citing: [], isolated: [], other: [] };
  const commentaryIds = new Set();
  for (const b of books) {
    const g = perBook.get(b.id);
    if (g && Object.keys(g.out).some((k) => k.startsWith("official/SOURCE") || k.startsWith("official/COMMENTARY"))) commentaryIds.add(b.id);
  }
  for (const b of books) {
    const g = perBook.get(b.id);
    if (!g) {
      classes.isolated.push(b.id);
      continue;
    }
    let placed = false;
    if (commentaryIds.has(b.id)) (classes.commentaryOnOfficial.push(b.id), (placed = true));
    if (b.title.startsWith("הערות על ") && Object.keys(g.in).some((k) => k.endsWith("FOOTNOTES"))) (classes.notesBook.push(b.id), (placed = true));
    if (has(g, "internal/FOOTNOTES")) (classes.footnotedBook.push(b.id), (placed = true));
    if (has(g, "internal/SOURCE") || has(g, "internal/COMMENTARY")) (classes.internalSourceOrCommentary.push(b.id), (placed = true));
    if (has(g, "official/REFERENCE") || has(g, "internal/REFERENCE")) (classes.citing.push(b.id), (placed = true));
    if (!placed) classes.other.push(b.id);
  }
  // a commentary on a commentary: an own book with a SOURCE/COMMENTARY link to an own book that is itself a commentary on an official book
  const superIds = new Set();
  for (const [k] of edges) {
    const [fromTo, cls] = k.split("|");
    if (!/^(SOURCE|COMMENTARY)$/.test(cls)) continue;
    const [from, to] = fromTo.split(">");
    if (to.startsWith("own:") && commentaryIds.has(Number(to.slice(4))) && Number(from) !== Number(to.slice(4))) superIds.add(Number(from));
  }
  r.classification = {
    note: "rules, not truth: commentary = an outgoing official SOURCE/COMMENTARY link; super-commentary = an own book with a SOURCE/COMMENTARY link to an own book that is a commentary; notes = 'הערות על …' that receives FOOTNOTES; citing = outgoing REFERENCE. A book can be in several classes. A→B and B→C does NOT prove A→C: no transitive link is inferred anywhere here.",
    counts: Object.fromEntries(Object.entries(classes).map(([k, v]) => [k, v.length])),
    superCommentaryByRule: superIds.size,
    examples: Object.fromEntries(Object.entries(classes).map(([k, v]) => [k, v.slice(0, 5).map((id) => bookById.get(id)?.title)])),
  };
  const byRoot = {};
  for (const id of commentaryIds) byRoot[rootOf(bookById.get(id).categoryId)] = (byRoot[rootOf(bookById.get(id).categoryId)] ?? 0) + 1;
  r.commentariesByRootCategory = Object.fromEntries(Object.entries(byRoot).sort((a, b) => b[1] - a[1]));

  log("graph: per-book relation counts and official hubs");
  const deg = (f) => books.map((b) => f(perBook.get(b.id)));
  r.degree = {
    outLinks: histogram(deg((g) => (g ? Object.values(g.out).reduce((s, n) => s + n, 0) : 0)), [0, 1, 10, 100, 1000, 10000, 100000]),
    distinctOutBooks: histogram(deg((g) => g?.outBooks.size ?? 0), [0, 1, 2, 5, 10, 25]),
    distinctInBooksInternal: histogram(deg((g) => g?.inBooks.size ?? 0), [0, 1, 2, 5, 10]),
  };
  const hub = new Map();
  for (const [k, w] of edges) {
    const [fromTo] = k.split("|");
    const [from, to] = fromTo.split(">");
    if (!to.startsWith("official:")) continue;
    const h = hub.get(to) ?? hub.set(to, { commentaries: new Set(), links: 0 }).get(to);
    h.commentaries.add(from);
    h.links += w;
  }
  r.officialHubs = {
    distinctOfficialBooks: hub.size,
    top: [...hub].sort((a, b) => b[1].commentaries.size - a[1].commentaries.size).slice(0, 15).map(([t, h]) => ({ title: t.slice(9), ownBooks: h.commentaries.size, links: h.links })),
    officialBooksWithAtLeast5OwnCommentaries: [...hub.values()].filter((h) => h.commentaries.size >= 5).length,
  };
  result.graph = r;
}

// ---------------------------------------------------------------------------------------------- main
async function sha256() {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(DB_PATH).on("data", (d) => h.update(d)).on("end", () => res(h.digest("hex"))).on("error", rej);
  });
}
const want = (p) => PHASE === "all" || PHASE === p;
if (PHASE === "quick-check") {
  const t0 = performance.now();
  log("PRAGMA quick_check ... (slow on a big file)");
  const rows = all(db, "PRAGMA quick_check");
  result.quickCheck = { result: rows.map((x) => Object.values(x)[0]).slice(0, 5), seconds: Math.round((performance.now() - t0) / 100) / 10 };
  save();
  process.exit(0);
}
if (want("stats")) {
  result.sha256 = await sha256();
  stats();
}
if (want("sample")) await sample();
if (want("graph")) graph();
save();
