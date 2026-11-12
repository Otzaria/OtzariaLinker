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
