/**
 * Appends every item without spreading them into one call: a spread passes each item as an argument,
 * and a large list (an IN list, a long field list) would exceed the call stack.
 */
export function append<T>(to: T[], items: Iterable<T>): void {
  for (const item of items) to.push(item);
}
