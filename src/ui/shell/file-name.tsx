import type { ComponentChildren } from "preact";

/*
 * File names in Hebrew text. "ספר שלי_links.json" in an RTL line breaks into runs that read
 * backwards ("links.json_ספר שלי"); a file name is shown as one left-to-right unit, the way the file
 * manager shows it, and never takes its neighbours' direction.
 */

/** A file name inside JSX. */
export function FileName({ name }: { name: string }) {
  return (
    <bdi dir="ltr" class="fname">
      {name}
    </bdi>
  );
}

/** Whether a source's name is a file name ("אישי-פירושים.db"), not a folder or "4 קובצי טקסט". */
export const isFileName = (name: string): boolean => /\.[A-Za-z0-9]{1,8}$/.test(name);

/**
 * A source's name (audit F19): a file name as one LTR unit — "אישי-פירושים.db", never
 * "db.אישי-פירושים" — and any other name (a folder) isolated in its own direction.
 */
export function SourceName({ name, class: cls }: { name: string; class?: string }) {
  return isFileName(name) ? (
    <bdi dir="ltr" class={cls ? `fname ${cls}` : "fname"}>
      {name}
    </bdi>
  ) : (
    <bdi class={cls}>{name}</bdi>
  );
}

/** A source's name inside a plain string (an <option>): LTR-isolated when it is a file name. */
export const sourceNameText = (name: string): string => (isFileName(name) ? ltr(name) : name);

/** A file name inside a plain string (an <option>, a title, a hint): Unicode's LTR isolate. */
export const ltr = (name: string): string => `⁦${name}⁩`;

const QUOTED = /"([^"\n]*\.[A-Za-z0-9]{1,8})"/g;
const LEADING = /^([^:\n]+\.[A-Za-z0-9]{1,8})(: )/;

/** A message (a notice) with each quoted file name, and a leading "file: …", isolated as LTR. */
export function withFileNames(text: string): ComponentChildren {
  const out: ComponentChildren[] = [];
  let rest = text;
  const lead = LEADING.exec(rest);
  if (lead) {
    out.push(<FileName key="lead" name={lead[1]!} />, lead[2]);
    rest = rest.slice(lead[0].length);
  }
  let at = 0;
  for (const m of rest.matchAll(QUOTED)) {
    out.push(rest.slice(at, m.index), '"', <FileName key={m.index} name={m[1]!} />, '"');
    at = m.index + m[0].length;
  }
  out.push(rest.slice(at));
  return out;
}
