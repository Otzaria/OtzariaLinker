/** A string→value memo that stops growing at `max` entries (no eviction: hot keys arrive first). */
export function boundedMemo<V>(fn: (key: string) => V, max = 50_000): (key: string) => V {
  const map = new Map<string, V>();
  return (key) => {
    const hit = map.get(key);
    if (hit !== undefined) return hit;
    const val = fn(key);
    if (map.size < max) map.set(key, val);
    return val;
  };
}
