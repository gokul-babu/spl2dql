/**
 * A lookup table with no prototype, so user-controlled keys such as "constructor", "toString" or
 * "__proto__" never resolve to Object.prototype members. Use it for every table indexed by text
 * that comes from a search, a mapping file or any other input.
 */
export function dict<T>(entries: Record<string, T>): Readonly<Record<string, T>> {
  const out = Object.create(null) as Record<string, T>;
  for (const [k, v] of Object.entries(entries)) out[k] = v;
  return Object.freeze(out);
}
