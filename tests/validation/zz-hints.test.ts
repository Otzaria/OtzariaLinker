import { appendFileSync } from "node:fs";
import { it } from "vitest";
import { stripTags } from "../../src/core/text/html";
import { SourceRegistry } from "../../src/sources/registry";
import { citationsJob } from "../../src/workers/citations-job";
import { DB, fileBlob } from "./env";
const OUT = process.env.TIMING_OUT!;
const log = (s: string) => appendFileSync(OUT, s + "\n");
const HINT = /(?:^|[\s(\[,;:.\-])(?:דף|דפים|פרק|פרקים|פ"[א-ת]|פ'|סימן|סימנים|סי'|סעיף|סע'|ס"ק|הלכה|הלכות|הל'|פסוק|פסוקים|ע"[אב]|עמוד|עמ'|שם|גמ'|גמרא|משנה|תוס'|תוספות|רש"י|רמב"ם|שו"ע|מדרש|זוהר|פרשת|מצוה)(?=$|[\s)\].,;:\-])/;
it.runIf(DB)("hints", async () => {
  const reg = new SourceRegistry();
  const res = await reg.open([{ path: "seforim.db", blob: await fileBlob(DB!) }]);
  const books = res.sources.flatMap((s) => s.books).filter((b) => (b.lineCount ?? 0) >= 50 && (b.lineCount ?? 0) <= 3000);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const picks = [...books].sort(() => rnd() - 0.5).slice(0, 70);
  for (const b of picks) {
    const lines = await reg.lines(b.key, 0, 1e9);
    let hints = 0, content = 0;
    for (const l of lines) { if (l.heading !== null) continue; content++; if (HINT.test(stripTags(l.anchorText))) hints++; }
    const t0 = performance.now();
    const r = await citationsJob(reg, { key: b.key, title: b.title, origin: b.origin }, {}, {});
    log(`${b.title}\t${content}\t${hints}\t${r.suggestions.length}\t${Math.round(performance.now() - t0)}`);
  }
}, 3_600_000);
