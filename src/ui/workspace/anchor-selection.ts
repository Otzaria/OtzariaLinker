import { rawOffsetFromVisible, visibleUnits } from "../../core/text/offsets";

/*
 * A text selection inside one rendered line → a word anchor in RAW offsets of the line's anchor
 * text. The rendered line is sanitizeBookHtml(anchorText), which keeps exactly the generator's
 * visible characters in order (sanitize.ts), so the n-th visible DOM character is visible unit n.
 * Text inside <x-uncounted> (after a lone "<") is invisible to the generator and cannot be anchored.
 */
export interface SelectedAnchor {
  rawStart: number;
  rawEnd: number;
  text: string;
}

export function anchorFromSelection(lineText: HTMLElement, anchorText: string, sel: Selection | null): SelectedAnchor | null {
  if (!sel || sel.isCollapsed || sel.rangeCount !== 1) return null;
  const range = sel.getRangeAt(0);
  if (!lineText.contains(range.startContainer) || !lineText.contains(range.endContainer)) return null;
  const start = visibleOffset(lineText, range.startContainer, range.startOffset);
  const end = visibleOffset(lineText, range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  // trim surrounding spaces the user dragged over
  const units = visibleUnits(anchorText);
  let a = Math.min(start, end);
  let b = Math.min(Math.max(start, end), units.length);
  const charAt = (v: number) => anchorText.slice(units[v]!.start, units[v]!.end);
  while (a < b && /\s/.test(charAt(a))) a++;
  while (b > a && /\s/.test(charAt(b - 1))) b--;
  if (a >= b || b > units.length) return null;
  const rawStart = rawOffsetFromVisible(anchorText, a);
  const rawEnd = b < units.length ? units[b]!.start : anchorText.length;
  return { rawStart, rawEnd, text: range.toString().trim() };
}

/** Number of counted characters before (node, offset) inside root; null inside uncounted text. */
function visibleOffset(root: HTMLElement, node: Node, offset: number): number | null {
  let count = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const uncounted = !!(n.parentElement && n.parentElement.closest("x-uncounted"));
    if (n === node) return uncounted ? null : count + offset;
    if (!uncounted) count += n.nodeValue?.length ?? 0;
  }
  // the boundary is an element: count text nodes before its offset-th child
  if (node.nodeType === Node.ELEMENT_NODE) {
    const r = document.createRange();
    r.setStart(root, 0);
    r.setEnd(node, offset);
    return r.toString().length;
  }
  return null;
}
