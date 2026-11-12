import type { AltTocStructure } from "../../../core/alt-toc/model";
import type { BookRef } from "../../../core/links/model";
import { toGematria } from "../../../core/text/gematria";
import type { AddrElem } from "./address";
import { unitNameKey } from "./named";
import { strictValue } from "./numbers";
import type { Resolution } from "./resolve";

/*
 * A book cited by DAF whose own references are not by daf — the Zohar: its lines are "ספר הזהר, וירא,
 * כו, ז" (parsha, paragraph), but books cite it as "זוה"ק ח"א פ"ט ע"ב", "בזוהר (חלק א דף קיט ע"ב)",
 * "בזוה"ק (וירא קג:)". The library has the printed pagination as an alternative structure (alt_toc
 * "Daf Zohar"/"דפים": volume › parsha › "דף קג:"), and this module reads any structure of that shape:
 * entries "דף <numeral><.|:>", each running to the line before the next one, under named entries (the
 * parsha). The volume is the "כרך"/"חלק" entry above, or — when the reader drops such entries (they
 * point at no line) — counted: the daf numbers start again at every new volume.
 *
 * Pure; the worker job reads the structures (workers/citations-job.ts) when a citation needs them.
 */

export interface DafEntry {
  /** 1-based volume */
  readonly volume: number;
  readonly n: number;
  readonly amud: 1 | 2;
  /** 0-based first and last (inclusive) line */
  readonly line: number;
  readonly end: number;
}

/** A named entry of the structure (a parsha) and the lines it spans, until the next name at its level or above. */
export interface DafSection {
  /** loose key (named.ts) */
  readonly key: string;
  readonly volume: number;
  readonly line: number;
  readonly end: number;
}

export interface DafStructure {
  readonly book: BookRef;
  readonly entries: readonly DafEntry[];
  readonly sections: readonly DafSection[];
}

const DAF_TITLE = /^דף\s+([א-ת]{1,4})\s*([.:])$/;
const VOLUME_TITLE = /^(?:כרך|חלק)\s+([א-ת]{1,2})['׳]?$/;
/** the most lines one printed page holds (the Zohar's run to some 30–60) */
const MAX_PAGE = 150;
/** at least this many daf entries make a structure a pagination */
const MIN_DAPIM = 20;
/** a new volume starts its dafim again: a daf this low after one this high (inserted sections go back less far) */
const RESTART_LOW = 3;
const RESTART_HIGH = 50;

/** The pagination of a book from its alt_toc structures, or null when none has that shape. */
export function dafStructureFromAltToc(book: BookRef, structures: readonly AltTocStructure[], lastLine: number): DafStructure | null {
  let best: AltTocStructure | null = null;
  let most = 0;
  for (const s of structures) {
    const n = s.entries.filter((e) => DAF_TITLE.test(e.heTitle.trim())).length;
    if (n > most) {
      most = n;
      best = s;
    }
  }
  if (!best || most < MIN_DAPIM) return null;
  const raw: { volume: number; n: number; amud: 1 | 2; line: number }[] = [];
  const named: { key: string; level: number; volume: number; line: number; at: number }[] = [];
  let volume = 1;
  let explicitVolume = false;
  let maxN = 0;
  for (const [at, e] of best.entries.entries()) {
    const title = e.heTitle.trim();
    const d = DAF_TITLE.exec(title);
    if (!d) {
      const v = VOLUME_TITLE.exec(title);
      const vn = v ? strictValue(v[1]!) : null;
      if (vn) {
        volume = vn;
        explicitVolume = true;
        maxN = 0;
        continue;
      }
      const key = unitNameKey(title);
      if (key) named.push({ key, level: e.level, volume, line: e.line - 1, at });
      continue;
    }
    const n = strictValue(d[1]!);
    if (!n) continue;
    // the numbers start again: the next volume (when no volume entry said so)
    if (!explicitVolume && n <= RESTART_LOW && maxN >= RESTART_HIGH) {
      volume++;
      maxN = 0;
      // the name just before the restart opened the new volume
      for (let k = named.length - 1; k >= 0 && named[k]!.line >= (raw.at(-1)?.line ?? -1); k--) named[k] = { ...named[k]!, volume };
    }
    maxN = Math.max(maxN, n);
    raw.push({ volume, n, amud: d[2] === "." ? 1 : 2, line: e.line - 1 });
  }
  if (!raw.length) return null;
  const sorted = raw.map((r, i) => ({ r, i })).sort((a, b) => a.r.line - b.r.line || a.i - b.i);
  // a page runs to where the NEXT page starts (its first listing after it): a section printed beside the
  // page (רעיא מהימנא, מדרש הנעלם) is listed with its own page marks in between, and is on the same page
  const starts = new Map<string, number[]>();
  for (const { r } of sorted) (starts.get(`${r.volume}:${r.n}:${r.amud}`) ?? starts.set(`${r.volume}:${r.n}:${r.amud}`, []).get(`${r.volume}:${r.n}:${r.amud}`)!).push(r.line);
  const entries: DafEntry[] = sorted.map(({ r }, k) => {
    let next = k + 1;
    while (next < sorted.length && sorted[next]!.r.line <= r.line) next++;
    const listed = next < sorted.length ? sorted[next]!.r.line - 1 : lastLine;
    const nextPage = r.amud === 1 ? `${r.volume}:${r.n}:2` : `${r.volume}:${r.n + 1}:1`;
    const at = starts.get(nextPage)?.find((x) => x > r.line);
    // …but not past a long stretch: the next page more than MAX_PAGE lines on is another section's
    const end = at !== undefined && at - r.line <= MAX_PAGE ? at - 1 : listed;
    return { ...r, end: Math.max(r.line, end) };
  });
  const sections: DafSection[] = named.map((x, k) => {
    const next = named.slice(k + 1).find((y) => y.level <= x.level && y.line > x.line);
    return { key: x.key, volume: x.volume, line: x.line, end: next ? next.line - 1 : lastLine };
  });
  return { book, entries, sections };
}

/**
 * A daf (and its volume, from "חלק א" / "ח"א" before it or from the parsha named) in the pagination. The
 * parsha, when named, must hold the daf (a daf the parsha starts in the middle of counts). Several places
 * for one daf (no volume named) are one link only when they are one volume's same daf; else no guess.
 */
export function resolveAltDaf(ds: DafStructure, elems: readonly AddrElem[], parsha: { readonly key: string; readonly span: { readonly line: number; readonly end: number } | null } | null): Resolution | null {
  let es = elems;
  let volume: number | null = null;
  if (es[0]?.kind === "chelek") {
    volume = es[0].n;
    es = es.slice(1);
  }
  if (es.length !== 1) return null;
  const e = es[0]!;
  if (e.kind !== "daf" && !(e.kind === "?" && (e.amud !== undefined || e.maybeAmud !== undefined))) return null;
  if (e.to !== undefined) return null;
  const amud = e.amud ?? e.maybeAmud;
  let hits = ds.entries.filter((x) => x.n === e.n && (amud === undefined || x.amud === amud) && (volume === null || x.volume === volume));
  if (parsha) {
    // the parsha's lines: from the book's own references when they name it (the Zohar's "ספר הזהר, וירא, …"),
    // else from the structure's named entries
    const spans = parsha.span ? [parsha.span] : ds.sections.filter((x) => x.key === parsha.key || x.key.startsWith(`${parsha.key} `));
    if (!spans.length) return null;
    hits = hits.filter((x) => spans.some((p) => x.line <= p.end && x.end >= p.line));
  }
  if (!hits.length) return null;
  if (new Set(hits.map((x) => x.volume)).size !== 1) return null;
  const line = Math.min(...hits.map((x) => x.line));
  const end = Math.max(...hits.map((x) => x.end));
  // a daf listed twice in one volume (the page's main text and a section printed beside it — מדרש הנעלם,
  // סתרי תורה) is one page: its first line to its last
  const v = hits[0]!.volume;
  return {
    book: ds.book,
    line,
    end,
    leaf: false,
    wholeDaf: amud === undefined,
    amudFromBareLetter: e.amud === undefined && amud !== undefined,
    label: `${ds.book.title}, חלק ${toGematria(v)}, דף ${toGematria(e.n)}${amud === 1 ? "." : amud === 2 ? ":" : ""}`,
    via: "pages",
    daf: true,
    ...(hits.length > 1 && { split: true }),
  };
}
