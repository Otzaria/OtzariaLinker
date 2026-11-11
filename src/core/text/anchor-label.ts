/**
 * The anchor label of a point anchor, taken from the rich heRef_2 of a links file — exact port of
 * the generator's `anchorLabelFromHeRef` (SeforimLibrary@23f1f8f1 Generator.kt:2425):
 * the text after the LAST " אות ", trimmed, 1–6 characters, Hebrew letters and quote marks only.
 * "שער הציון, סימן א, סעיף א אות ג" → "ג". Anything else → null (the anchor gets no label).
 */
const MARKER = " אות ";

export function anchorLabelFromHeRef(heRef: unknown): string | null {
  const s = String(heRef ?? "");
  const idx = s.lastIndexOf(MARKER);
  if (idx < 0) return null;
  const tail = s.slice(idx + MARKER.length).trim();
  if (!tail || tail.length > 6) return null;
  for (const ch of tail) {
    const ok = (ch >= "א" && ch <= "ת") || ch === '"' || ch === "׳" || ch === "״";
    if (!ok) return null;
  }
  return tail;
}

/** Appends " אות X" to a heRef unless it already carries a label the generator would read. */
export function withAnchorLabel(heRef: string, label: string | null | undefined): string {
  if (!label || anchorLabelFromHeRef(heRef) != null) return heRef;
  return `${heRef}${MARKER}${label}`;
}
