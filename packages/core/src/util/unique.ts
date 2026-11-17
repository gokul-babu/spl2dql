/**
 * Next suffix to try per base name, kept beside each `taken` set a caller passes. Names are only
 * ever added to `taken`, so every suffix below the stored one is known to be taken already: each
 * call is O(1) amortised instead of trying -2, -3, … from the start every time (ADR-029).
 */
const nextSuffix = new WeakMap<Set<string>, Map<string, number>>();

/**
 * `base`, or the first of `make(2)`, `make(3)`, … that is not in `taken` (compared in lower case).
 * The name returned is added to `taken`.
 */
export function uniqueName(base: string, taken: Set<string>, make: (n: number) => string): string {
  const key = base.toLowerCase();
  if (!taken.has(key)) {
    taken.add(key);
    return base;
  }
  let counters = nextSuffix.get(taken);
  if (!counters) {
    counters = new Map();
    nextSuffix.set(taken, counters);
  }
  let n = counters.get(key) ?? 2;
  let candidate = make(n);
  while (taken.has(candidate.toLowerCase())) candidate = make(++n);
  counters.set(key, n + 1);
  taken.add(candidate.toLowerCase());
  return candidate;
}
