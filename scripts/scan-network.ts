/**
 * ADR-006 "offline by construction": fails when network code appears. This release has no online
 * features at all (ADR-022), so:
 * - packages/core/src and apps/web/src: no network API anywhere.
 * - packages/cli/src: no outbound connections (`spl2dql serve` only listens on loopback).
 * - Built bundles: no network API in the app or the worker; no remote host named.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const NETWORK = /\b(fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts\s*\()/;
const problems: string[] = [];

function files(dir: string, ext: RegExp): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...files(p, ext));
    else if (ext.test(e)) out.push(p);
  }
  return out;
}

for (const f of files(join(root, 'packages/core/src'), /\.ts$/)) {
  const m = NETWORK.exec(readFileSync(f, 'utf8'));
  if (m) problems.push(`${relative(root, f)}: "${m[1]}" — core must not contain network code`);
}
for (const f of files(join(root, 'apps/web/src'), /\.(ts|tsx)$/)) {
  const m = NETWORK.exec(readFileSync(f, 'utf8'));
  if (m) problems.push(`${relative(root, f)}: "${m[1]}" — the web app must not contain network code`);
}
const OUTBOUND = /\b(fetch\s*\(|WebSocket|from\s+'node:(?:https|http2|tls|dgram|dns)'|\b(?:http|https)\.(?:request|get)\s*\(|\bconnect\s*\(|\brequest\s*\()/;
for (const f of files(join(root, 'packages/cli/src'), /\.ts$/)) {
  const m = OUTBOUND.exec(readFileSync(f, 'utf8'));
  if (m) problems.push(`${relative(root, f)}: "${m[1]}" — the CLI must not open outbound connections`);
}
const assets = join(root, 'apps/web/dist/assets');
for (const f of files(assets, /\.js$/)) {
  const text = readFileSync(f, 'utf8');
  const net = NETWORK.exec(text);
  if (net) problems.push(`${relative(root, f)}: "${net[1]}" — the built app contains network code`);
  // Remote hosts named in the bundle (documentation links in library error messages, and the
  // project links of the About dialog, are allowed: they are links, never requests).
  for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
    const host = (m[1] ?? '').toLowerCase();
    if (
      !/(^|\.)(w3\.org|react\.dev|reactjs\.org|apache\.org|github\.com|npmjs\.com|codemirror\.net|dynatrace\.com|splunk\.com|mozilla\.org|example\.com|ecma-international\.org)$/.test(
        host,
      )
    ) {
      problems.push(`${relative(root, f)}: names the remote host ${host}`);
    }
  }
}

// The service worker (ADR-029). These rules are a lint, not the control: they catch an accidental
// change, not a deliberate one (`self['fe' + 'tch']`, `cache.add('//host/…')` and the like pass).
// The control is the policy the host sends with sw.js (`default-src 'none'; connect-src 'self'`).
// It is the one file allowed to call fetch, and only to pass on the
// request the page itself made, after it has returned for every request to another origin:
//   if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
//   … fetch(e.request) …
// Its precache list may name only paths of this site ("./…"). Nothing else that reaches the
// network, and no remote host, may appear in it.
const sw = join(root, 'apps/web/dist/sw.js');
if (existsSync(sw)) {
  const name = relative(root, sw);
  const text = readFileSync(sw, 'utf8');
  const calls = [...text.matchAll(/\bfetch\s*\(([^)]*)\)/g)];
  for (const call of calls) {
    if ((call[1] ?? '').trim() !== 'e.request') problems.push(`${name}: "fetch(${call[1]})" — the service worker may only pass on the page's own request`);
  }
  if (calls.length > 0 && !/url\.origin\s*!==\s*self\.location\.origin\)\s*return\s*;/.test(text)) {
    problems.push(`${name}: fetch without the same-origin guard — requests to other origins must be left alone`);
  }
  const other = /\b(XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts\s*\(|import\s*\()/.exec(text);
  if (other) problems.push(`${name}: "${other[1]}" — the service worker must not contain other network code`);
  const host = /(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i.exec(text);
  if (host) problems.push(`${name}: names the remote address ${host[0]}`);
  const list = /const ASSETS = (\[[^\]]*\]);/.exec(text);
  let assets: unknown;
  try {
    assets = list ? JSON.parse(list[1] as string) : undefined;
  } catch {
    assets = undefined;
  }
  if (!Array.isArray(assets) || assets.some((a) => typeof a !== 'string' || !a.startsWith('./') || a.includes('//') || a.includes('..'))) {
    problems.push(`${name}: the precache list must be a list of this site's own paths ("./…")`);
  }
}

if (problems.length > 0) {
  console.error(`Network scan failed:\n  ${[...new Set(problems)].join('\n  ')}`);
  process.exit(1);
}
console.log(
  'Network scan passed: no network code in core, the web app or its bundles; the service worker fetches its own site only; no outbound connections in the CLI.',
);
