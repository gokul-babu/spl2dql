/**
 * localStorage that never throws: blocked, full or missing storage simply means preferences are not
 * remembered (docs/spec/ui.md → Behaviour).
 */
const PREFIX = 'spl2dql:';

export function load(key: string): string | undefined {
  try {
    return globalThis.localStorage?.getItem(PREFIX + key) ?? undefined;
  } catch {
    return undefined;
  }
}

export function save(key: string, value: string | undefined): void {
  try {
    if (value === undefined) globalThis.localStorage?.removeItem(PREFIX + key);
    else globalThis.localStorage?.setItem(PREFIX + key, value);
  } catch {
    // Storage unavailable: nothing to do.
  }
}
