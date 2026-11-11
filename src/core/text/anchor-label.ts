/** The generator's `anchorLabelFromHeRef` looks for " אות " and takes what follows. */
export function anchorLabelFromHeRef(heRef: unknown): string | null {
  const m = String(heRef ?? "").match(/\sאות\s+(.+)$/);
  return m ? m[1]!.trim() : null;
}

/** Appends " אות X" to a heRef unless it already carries a label. */
export function withAnchorLabel(heRef: string, label: string | null | undefined): string {
  if (!label) return heRef;
  return /\sאות\s/.test(heRef) ? heRef : `${heRef} אות ${label}`;
}
