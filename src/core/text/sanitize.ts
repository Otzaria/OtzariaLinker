/*
 * Book-line HTML → HTML that is safe to put into the DOM (stage 17; fixes v3's TD-C4, where book
 * HTML went into innerHTML verbatim).
 *
 * Policy: an allowlist of formatting/heading tags, emitted WITHOUT any attribute (no on*, style,
 * href, src, class from the book). Every other tag is dropped — but its text content is KEPT and
 * escaped, never removed. That is deliberate: anchors are captured on rendered text and converted
 * to raw offsets with countVisibleChars/rawOffsetFromVisible, so the sanitized output must contain
 * exactly the same visible characters, in the same order, as the generator's counting rules see in
 * the raw line. "<script>x</script>" therefore renders as the harmless visible text "x".
 *
 * The scanner uses the generator's tag/entity rules (offsets.ts): an entity is at most 10 chars,
 * and a "<" with no ">" hides the rest of the line from the generator's count. That rest is still
 * shown to the user, escaped, inside <x-uncounted>, which the UI excludes from anchor selection.
 */

const ALLOWED = new Set([
  "b", "strong", "i", "em", "u", "s", "big", "small", "sup", "sub", "mark",
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "div", "br", "font", "q", "cite",
]);
const VOID = new Set(["br"]);
const ENTITY_SPAN = 10;
const VALID_ENTITY = /^&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});$/;

const escapeText = (t: string): string => t.replace(/[<>&"]/g, (c) => escapeChar(c));
const escapeChar = (ch: string): string =>
  ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === "&" ? "&amp;" : ch === '"' ? "&quot;" : ch;

export function sanitizeBookHtml(raw: unknown): string {
  const s = String(raw ?? "");
  const n = s.length;
  const open: string[] = [];
  let out = "";
  let i = 0;
  while (i < n) {
    const ch = s[i]!;
    if (ch === "<") {
      const gt = s.indexOf(">", i);
      if (gt === -1) {
        out += `<x-uncounted>${escapeText(s.slice(i))}</x-uncounted>`;
        break;
      }
      out += renderTag(s.slice(i + 1, gt), open);
      i = gt + 1;
    } else if (ch === "&") {
      let sc = i + 1;
      const lim = Math.min(n, i + ENTITY_SPAN);
      while (sc < lim && s[sc] !== ";") sc++;
      if (sc < lim) {
        const ent = s.slice(i, sc + 1);
        // A valid entity renders as one glyph, matching the counting rule. An "entity-shaped"
        // invalid sequence (e.g. "&a b;") is counted as ONE visible char by the generator but would
        // render as several — it is shown as a single replacement mark to keep offsets aligned.
        out += VALID_ENTITY.test(ent) ? ent : "�";
        i = sc + 1;
      } else { out += "&amp;"; i++; }
    } else {
      out += escapeChar(ch);
      i++;
    }
  }
  // Close whatever the book left open, so one bad line cannot restyle the rest of the page.
  while (open.length) out += `</${open.pop()}>`;
  return out;
}

function renderTag(inner: string, open: string[]): string {
  const m = /^\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(inner);
  if (!m) return "";
  const closing = m[1] === "/";
  const name = m[2]!.toLowerCase();
  if (!ALLOWED.has(name)) return "";
  if (VOID.has(name)) return closing ? "" : `<${name}>`;
  if (!closing) {
    if (/\/\s*$/.test(inner)) return ""; // self-closed non-void tag: no effect
    open.push(name);
    return `<${name}>`;
  }
  const at = open.lastIndexOf(name);
  if (at === -1) return ""; // stray closing tag
  let out = "";
  while (open.length > at) out += `</${open.pop()}>`;
  return out;
}
