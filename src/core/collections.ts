/**
 * Appends to the list kept under a key, creating it on first use. In place: building lists with
 * `m.set(k, [...(m.get(k) ?? []), x])` copies the list on every append — quadratic, 12–25 s for
 * 40,000 items under one key (security review A8).
 */
export function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
