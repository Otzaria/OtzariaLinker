/*
 * Synthetic `_links.json` text for scale tests and measurements (V7 §4.12, #42 C5): N records of the real book pair of the
 * schema-7 slice (tests/fixtures/db/seforim-v7-mini.db: ארצות החיים and המאיר לארץ על ארצות החיים), in the compact layout
 * (one line, like JSON.stringify). No user data: every record is generated from its index. 235,000 records weigh about
 * 39 MB of UTF-8 — the size of the file measured in #42 C5.
 */
export const SYNTH_SOURCE = "ארצות החיים";
export const SYNTH_TARGET = "המאיר לארץ על ארצות החיים";

export function syntheticRecords(n: number, shift = 0): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => {
    const line2 = 1 + ((i + shift) % 3000);
    return {
      line_index_1: 1 + (i % 700),
      heRef_2: `${SYNTH_TARGET} ${line2}`,
      path_2: `${SYNTH_TARGET}.txt`,
      line_index_2: line2,
      "Conection Type": i % 3 ? "commentary" : "reference",
    };
  });
}

export function syntheticLinksFile(n: number, shift = 0): string {
  return JSON.stringify(syntheticRecords(n, shift));
}
