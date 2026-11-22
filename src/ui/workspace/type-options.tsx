import { TYPE_GROUP_LABELS, TYPE_LABELS, typeGroups } from "../../core/links/connection-type";

/*
 * The link-type picker's options, grouped like Otzaria shows them (core/links/connection-type.ts typeGroups):
 * a native <optgroup> per group — keyboard, screen reader and RTL for free. Values are the lower-case strings the
 * file stores (`canonicalTypeString`), never changed. Used by the builder, the links table's group action and the
 * records import dialog.
 */
const GROUPS = typeGroups();

export function TypeOptions({ withKey = false }: { withKey?: boolean }) {
  const label = (t: keyof typeof TYPE_LABELS) => (withKey ? `${TYPE_LABELS[t].he} (${t.toLowerCase()})` : TYPE_LABELS[t].he);
  return (
    <>
      {(["commentaries", "links", "direction"] as const).map((g) => (
        <optgroup key={g} label={TYPE_GROUP_LABELS[g]}>
          {GROUPS[g].map((t) => (
            <option key={t} value={t.toLowerCase()} title={TYPE_LABELS[t].hint}>
              {label(t)}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}
