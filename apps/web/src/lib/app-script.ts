/**
 * The check behind the Trusted Types policy (lib/trusted.ts): an address is accepted only when it is
 * http(s), on the page's own origin, and exactly one of the app's own scripts. A same-origin `blob:`
 * or `data:` address, another path or another origin is refused.
 */
export function isAppScript(url: string, origin: string, allowed: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.origin !== origin) return false;
  return allowed.includes(u.href);
}
