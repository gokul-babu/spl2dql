/**
 * Trusted Types: with `require-trusted-types-for 'script'` in the Content-Security-Policy, the
 * browser accepts a script address (a worker, the service worker) only from a policy. This one
 * policy accepts exactly the two scripts the app starts — the translation worker under `assets/`
 * and `sw.js` — as http(s) addresses on the page's own origin (lib/app-script.ts). Where the
 * browser has no Trusted Types, the same check still runs before the address is used.
 */
import { isAppScript } from './app-script.ts';
import workerUrl from './translate.worker.ts?worker&url';

interface Policy {
  createScriptURL(url: string): unknown;
}
interface TrustedTypes {
  createPolicy(name: string, rules: { createScriptURL(url: string): string }): Policy;
}

/** The translation worker, as the bundler names it. */
export const WORKER_SCRIPT = new URL(workerUrl, import.meta.url);
/** The service worker, next to the page. */
export const SERVICE_WORKER_SCRIPT = new URL('./sw.js', globalThis.location.href);

const ALLOWED = [WORKER_SCRIPT.href, SERVICE_WORKER_SCRIPT.href];
const refuse = (): never => {
  throw new TypeError('Only the app’s own scripts can run.');
};

let policy: Policy | undefined;
try {
  policy = (globalThis as { trustedTypes?: TrustedTypes }).trustedTypes?.createPolicy('spl2dql', {
    createScriptURL: (url) => (isAppScript(url, globalThis.location.origin, ALLOWED) ? url : refuse()),
  });
} catch {
  policy = undefined;
}

/** One of the app's two scripts, in the form the browser accepts; anything else throws. */
export function appScript(url: URL): string {
  if (!isAppScript(url.href, globalThis.location.origin, ALLOWED)) refuse();
  return (policy ? policy.createScriptURL(url.href) : url.href) as string;
}
