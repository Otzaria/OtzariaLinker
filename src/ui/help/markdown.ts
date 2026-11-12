/*
 * The user guide inside the tool (v3 had its whole documentation in a help screen). The source is
 * docs/USER_GUIDE.md itself, bundled as text, so the guide and the help can never drift apart.
 *
 * This is a deliberately small Markdown subset — exactly what the guide uses: headings, paragraphs,
 * lists (with indented continuation lines), tables, fenced code, `---`, **bold**, `code`, links and
 * <kbd>. Everything is HTML-escaped first; the only markup that survives from the source is <kbd>,
 * so the result is safe to set as innerHTML even though the input is our own file.
 */

export interface GuideHeading {
  id: string;
  text: string;
  level: number;
}

export interface RenderedGuide {
  html: string;
  /** level-2 headings, for the side navigation */
  toc: GuideHeading[];
  /** every heading id, to check links against */
  ids: Set<string>;
  /** every `#anchor` link in the text */
  anchors: string[];
}

/**
 * Where links to other documents (ARCHITECTURE.md…) point: the docs folder AT THIS VERSION'S TAG
 * (every release is tagged v<version>, release.yml checks it), so the help never describes another
 * version. Without a build version (unit tests) it falls back to main.
 */
const VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : null;
export const DOCS_BASE = `https://github.com/Otzaria/OtzariaLinker/blob/${VERSION ? `v${VERSION}` : "main"}/docs/`;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** GitHub's heading anchors: lower case, punctuation removed, spaces → "-" */
export function slug(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/[`*]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** headings with "## title" text; the guide's own table of contents is replaced by the side navigation */
const SKIP_SECTIONS = new Set(["תוכן"]);

export function renderGuide(md: string): RenderedGuide {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const toc: GuideHeading[] = [];
  const ids = new Set<string>();
  const anchors: string[] = [];
  const inl = (s: string) => inline(s, anchors);
  let i = 0;
  let skipping = false;

  const isBlockStart = (l: string) => /^(#{1,6} |```|\||[-*] |\d+\. |---\s*$|<\/?div)/.test(l);

  while (i < lines.length) {
    const line = lines[i]!;
    const h = /^(#{1,6}) (.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const text = h[2]!.trim();
      skipping = level <= 2 && SKIP_SECTIONS.has(text);
      if (!skipping) {
        const id = slug(text);
        ids.add(id);
        if (level === 2) toc.push({ id, text: text.replace(/[`*]/g, ""), level });
        out.push(`<h${level} id="${esc(id)}">${inl(text)}</h${level}>`);
      }
      i++;
      continue;
    }
    if (skipping) {
      i++;
      continue;
    }
    if (/^<\/?div\b[^>]*>\s*$/.test(line) || !line.trim()) {
      i++;
      continue;
    }
    if (/^---\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith("```"); i++) body.push(lines[i]!);
      i++;
      out.push(`<pre dir="ltr"><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (line.startsWith("|")) {
      const rows: string[][] = [];
      for (; i < lines.length && lines[i]!.startsWith("|"); i++) rows.push(cells(lines[i]!));
      const [head, sep, ...body] = rows;
      const hasHead = !!sep && sep.every((c) => /^:?-{3,}:?$/.test(c));
      const tr = (r: string[], tag: string) => `<tr>${r.map((c) => `<${tag}>${inl(c)}</${tag}>`).join("")}</tr>`;
      out.push(
        `<div class="table-wrap"><table>${hasHead ? `<thead>${tr(head!, "th")}</thead><tbody>${body.map((r) => tr(r, "td")).join("")}` : `<tbody>${rows.map((r) => tr(r, "td")).join("")}`}</tbody></table></div>`,
      );
      continue;
    }
    const li = /^([-*]|\d+\.) (.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[1]!);
      const start = ordered ? parseInt(li[1]!, 10) : 1;
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^([-*]|\d+\.) (.*)$/.exec(lines[i]!);
        if (!m || /\d/.test(m[1]!) !== ordered) break;
        let text = m[2]!;
        // continuation lines are indented under the item
        for (i++; i < lines.length && /^ {2,}\S/.test(lines[i]!); i++) text += " " + lines[i]!.trim();
        items.push(`<li>${inl(text)}</li>`);
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ""}>${items.join("")}</${tag}>`);
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i]!.trim() && !isBlockStart(lines[i]!); i++) para.push(lines[i]!.trim());
    if (!para.length) {
      // a line that looks like a block start but is not one (e.g. "<div" mid-text): keep it as text
      para.push(line.trim());
      i++;
    }
    out.push(`<p>${inl(para.join(" "))}</p>`);
  }
  return { html: out.join("\n"), toc, ids, anchors };
}

function cells(row: string): string[] {
  // split on | that is not inside `code` and not escaped
  const out: string[] = [];
  let cur = "";
  let code = false;
  const s = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let k = 0; k < s.length; k++) {
    const c = s[k]!;
    if (c === "\\" && s[k + 1] === "|") (cur += "|"), k++;
    else if (c === "`") (code = !code), (cur += c);
    else if (c === "|" && !code) out.push(cur.trim()), (cur = "");
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function inline(src: string, anchors: string[]): string {
  // code spans first: their content is literal
  const codes: string[] = [];
  let s = src.replace(/`([^`]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s);
  s = s.replace(/&lt;kbd&gt;(.*?)&lt;\/kbd&gt;/g, "<kbd>$1</kbd>");
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text: string, rawHref: string) => {
    const href = rawHref.replace(/&amp;/g, "&");
    if (href.startsWith("#")) {
      const id = decodeURIComponent(href.slice(1));
      anchors.push(id);
      return `<a href="#${esc(id)}" data-anchor="${esc(id)}">${text}</a>`;
    }
    let url: string | null = null;
    if (/^https:\/\//i.test(href)) url = href;
    else if (/^[\w./-]+\.md(#.*)?$/i.test(href) && !href.includes("..")) url = DOCS_BASE + href.replace(/^\.\//, "");
    return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
  });
  return s.replace(/\u0000(\d+)\u0000/g, (_, n: string) => `<code>${esc(codes[Number(n)]!)}</code>`);
}
