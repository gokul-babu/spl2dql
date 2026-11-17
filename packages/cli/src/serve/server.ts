import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegularFile } from '../safe-fs.ts';

/**
 * `spl2dql serve`: serves the built web app on the loopback interface. The app translates in the
 * browser; this server has no API, reads no credentials and makes no outbound connections. It only
 * hands out a fixed set of files read once at start-up (docs/spec/cli.md → serve).
 */
export interface ServeOptions {
  port: number;
  host: string;
  /** Directory with the built web app; defaults to ../../web next to this file. */
  webDir?: string;
}

export interface ServeHandle {
  url: string;
  close(): Promise<void>;
  closed: Promise<void>;
}

export class ServeError extends Error {}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * The policy when the web folder has no `_headers` file (an unbuilt checkout): the same rules the
 * build writes (apps/web/vite.config.ts), so the local server never sends less than the hosted page.
 */
export const DEFAULT_HEADERS = `/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types spl2dql; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
/sw.js
  ! Content-Security-Policy
  Content-Security-Policy: default-src 'none'; connect-src 'self'; frame-ancestors 'none'
/social.png
  ! Cross-Origin-Resource-Policy
  Cross-Origin-Resource-Policy: cross-origin
`;

/** One rule of a `_headers` file: a path pattern and its lines in order. */
interface HeaderRule {
  pattern: string;
  lines: ({ set: string; value: string } | { remove: string })[];
}

/**
 * Reads the subset of the `_headers` format the build writes: a path (`/sw.js`) or a folder
 * pattern (`/assets/*`, `/*`) at the start of a line, then indented `Name: value` lines and
 * `! Name` lines that remove a header an earlier rule set. Comments and blank lines are skipped.
 */
export function parseHeadersFile(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      rules.push({ pattern: raw.trim(), lines: [] });
      continue;
    }
    const rule = rules[rules.length - 1];
    if (!rule) continue;
    const line = raw.trim();
    if (line.startsWith('!')) {
      rule.lines.push({ remove: line.slice(1).trim().toLowerCase() });
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    rule.lines.push({ set: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
  }
  return rules;
}

function matches(pattern: string, path: string): boolean {
  if (pattern.endsWith('/*')) return path.startsWith(pattern.slice(0, -1));
  return pattern === path;
}

/**
 * The headers a path gets: every matching rule in order. The hosted page's caching rules are not
 * applied: a loopback server sends `Cache-Control: no-store` for everything (docs/spec/cli.md).
 */
export function headersFor(rules: readonly HeaderRule[], path: string): Record<string, string> {
  const out = new Map<string, [string, string]>();
  for (const rule of rules) {
    if (!matches(rule.pattern, path)) continue;
    for (const line of rule.lines) {
      if ('remove' in line) out.delete(line.remove);
      else out.set(line.set.toLowerCase(), [line.set, line.value]);
    }
  }
  out.set('cache-control', ['Cache-Control', 'no-store']);
  return Object.fromEntries([...out.values()]);
}

/** Starts the local web app server. Loopback only; GET and HEAD only; own Host names only. */
export async function startServer(options: ServeOptions): Promise<ServeHandle> {
  if (!LOOPBACK.has(options.host)) throw new ServeError('spl2dql serve only listens on 127.0.0.1, ::1 or localhost.');
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new ServeError('Invalid port.');
  const webDir = options.webDir ?? fileURLToPath(new URL('../../web', import.meta.url));
  const files = loadStatic(webDir);
  // The same policy the hosted page gets: the built `_headers`, read once (ADR-029).
  const headersPath = join(webDir, '_headers');
  const rules = parseHeadersFile(existsSync(headersPath) ? readFileSync(headersPath, 'utf8') : DEFAULT_HEADERS);
  let port = options.port;
  const allowedHosts = (): Set<string> => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  const send = (res: ServerResponse, status: number, type: string, body: Uint8Array | string, head: boolean, path = '/'): void => {
    res.writeHead(status, { ...headersFor(rules, path), 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
    res.end(head ? undefined : body);
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // DNS-rebinding defence: only our own Host names.
    if (!allowedHosts().has(req.headers.host ?? '')) return send(res, 403, 'text/plain; charset=utf-8', 'Forbidden host', false);
    const head = req.method === 'HEAD';
    if (req.method !== 'GET' && !head) {
      res.setHeader('Allow', 'GET, HEAD');
      return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', false);
    }
    // The request body is never read; drop anything sent.
    req.resume();
    let path: string;
    try {
      path = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return send(res, 400, 'text/plain; charset=utf-8', 'Bad request', head);
    }
    const asked = path;
    if (path === '/') path = '/index.html';
    // The header rules are not a file to serve.
    if (path === '/_headers') return send(res, 404, 'text/plain; charset=utf-8', 'Not found', head, asked);
    // Static files come from an allow-list built at start-up; no filesystem access per request.
    // Paths without an extension are app views (/batch, /mapping …) and get the app page.
    const file = files.get(path) ?? (extname(path) === '' ? files.get('/index.html') : undefined);
    if (!file) return send(res, 404, 'text/plain; charset=utf-8', 'Not found', head, asked);
    return send(res, 200, file.type, file.body, head, asked);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  const hostForUrl = options.host === '::1' ? '[::1]' : options.host;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });
  server.on('close', () => resolveClosed());
  return {
    url: `http://${hostForUrl}:${port}`,
    closed,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

interface StaticFile {
  body: Uint8Array;
  type: string;
}

const FALLBACK_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>spl2dql</title></head><body><p>The web app is not built. Run <code>pnpm build</code> in the repository.</p></body></html>`;

const MAX_STATIC_FILE = 20_000_000 - 1;

/** Reads the built web app once. Symbolic links, unknown file types and files of 20 MB or more are skipped. */
function loadStatic(dir: string): Map<string, StaticFile> {
  const out = new Map<string, StaticFile>();
  if (!existsSync(dir)) {
    out.set('/index.html', { body: Buffer.from(FALLBACK_PAGE), type: MIME['.html'] as string });
    return out;
  }
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const type = MIME[extname(entry.name).toLowerCase()];
        if (!type) continue;
        let body: Buffer;
        try {
          body = readRegularFile(full, MAX_STATIC_FILE);
        } catch {
          continue; // too large, or no longer a regular file
        }
        out.set(`/${relative(dir, full).split(sep).join('/')}`, { body, type });
      }
    }
  };
  walk(dir);
  if (!out.has('/index.html')) out.set('/index.html', { body: Buffer.from(FALLBACK_PAGE), type: MIME['.html'] as string });
  return out;
}
