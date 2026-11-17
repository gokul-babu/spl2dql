import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_HEADERS, headersFor, parseHeadersFile, type ServeHandle, startServer } from '../src/serve/server.ts';

/** Raw HTTP so tests can set any Host header and method (fetch forbids some). */
function raw(url: string, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }) {
  const u = new URL(url);
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers ?? {}, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

describe('spl2dql serve', () => {
  let s: ServeHandle;
  let host: string;

  beforeAll(async () => {
    const web = mkdtempSync(join(tmpdir(), 'web-'));
    mkdirSync(join(web, 'assets'));
    writeFileSync(join(web, 'index.html'), '<!doctype html><html><head><title>spl2dql</title></head><body></body></html>');
    writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(web, 'secret.env'), 'TOKEN=1');
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    writeFileSync(join(outside, 'x.js'), 'stolen');
    symlinkSync(join(outside, 'x.js'), join(web, 'assets', 'link.js'));
    s = await startServer({ port: 0, host: '127.0.0.1', webDir: web });
    host = new URL(s.url).host;
  });
  afterAll(async () => {
    await s.close();
  });

  it('refuses to bind anything but loopback', async () => {
    await expect(startServer({ port: 0, host: '0.0.0.0' })).rejects.toThrow(/127\.0\.0\.1/);
  });

  it('serves the app, its files, and app views', async () => {
    const page = await raw(s.url, { path: '/', headers: { host } });
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect((await raw(s.url, { path: '/batch', headers: { host } })).body).toContain('<title>spl2dql</title>');
    const js = await raw(s.url, { path: '/assets/app.js', headers: { host } });
    expect(js.headers['content-type']).toContain('javascript');
  });

  it('refuses foreign Host headers (DNS rebinding), with security headers', async () => {
    const r = await raw(s.url, { path: '/', headers: { host: 'evil.example' } });
    expect(r.status).toBe(403);
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('sends security headers and no CORS headers', async () => {
    const r = await raw(s.url, { path: '/', headers: { host, origin: 'https://evil.example' } });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.headers['content-security-policy']).toContain("script-src 'self'");
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('has no API and accepts only GET and HEAD', async () => {
    expect((await raw(s.url, { path: '/api/status', headers: { host } })).body).not.toContain('features');
    const post = await raw(s.url, { method: 'POST', path: '/', headers: { host, 'content-type': 'application/json' }, body: '{}' });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');
    const headReq = await raw(s.url, { method: 'HEAD', path: '/', headers: { host } });
    expect(headReq.status).toBe(200);
    expect(headReq.body).toBe('');
  });

  it('serves only allow-listed files: no traversal, no symbolic links, no unknown types', async () => {
    expect((await raw(s.url, { path: '/../../etc/passwd', headers: { host } })).body).not.toContain('root:');
    expect((await raw(s.url, { path: '/%2e%2e/%2e%2e/etc/passwd', headers: { host } })).body).not.toContain('root:');
    expect((await raw(s.url, { path: '/assets/link.js', headers: { host } })).status).toBe(404);
    expect((await raw(s.url, { path: '/secret.env', headers: { host } })).status).toBe(404);
    expect((await raw(s.url, { path: '/assets/missing.js', headers: { host } })).status).toBe(404);
  });
});

describe('spl2dql serve sends the hosted page policy from _headers (ADR-029, third round)', () => {
  let s: ServeHandle;
  let host: string;
  const headersFile = `# comment
/*
  Content-Security-Policy: default-src 'self'; connect-src 'none'; require-trusted-types-for 'script'; trusted-types spl2dql; frame-ancestors 'none'
  X-Frame-Options: DENY
  Cross-Origin-Resource-Policy: same-origin
  Cache-Control: no-cache

/assets/*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable

/sw.js
  ! Content-Security-Policy
  Content-Security-Policy: default-src 'none'; connect-src 'self'; frame-ancestors 'none'

/social.png
  ! Cross-Origin-Resource-Policy
  Cross-Origin-Resource-Policy: cross-origin
`;

  beforeAll(async () => {
    const web = mkdtempSync(join(tmpdir(), 'web-'));
    mkdirSync(join(web, 'assets'));
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>spl2dql</title>');
    writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(web, 'sw.js'), 'self');
    writeFileSync(join(web, 'social.png'), 'png');
    writeFileSync(join(web, '_headers'), headersFile);
    s = await startServer({ port: 0, host: '127.0.0.1', webDir: web });
    host = new URL(s.url).host;
  });
  afterAll(async () => {
    await s.close();
  });

  it('applies the page rule, the sw.js rule and the social.png rule, in order', async () => {
    const page = await raw(s.url, { path: '/', headers: { host } });
    expect(page.headers['content-security-policy']).toBe(
      "default-src 'self'; connect-src 'none'; require-trusted-types-for 'script'; trusted-types spl2dql; frame-ancestors 'none'",
    );
    expect(page.headers['cross-origin-resource-policy']).toBe('same-origin');
    const sw = await raw(s.url, { path: '/sw.js', headers: { host } });
    expect(sw.headers['content-security-policy']).toBe("default-src 'none'; connect-src 'self'; frame-ancestors 'none'");
    expect(sw.headers['x-frame-options']).toBe('DENY');
    const social = await raw(s.url, { path: '/social.png', headers: { host } });
    expect(social.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  it('keeps no-store for everything on loopback, whatever the file says about caching', async () => {
    for (const path of ['/', '/assets/app.js', '/sw.js', '/missing.js']) {
      expect((await raw(s.url, { path, headers: { host } })).headers['cache-control'], path).toBe('no-store');
    }
  });

  it('does not serve _headers itself', async () => {
    const r = await raw(s.url, { path: '/_headers', headers: { host } });
    expect(r.status).toBe(404);
    expect(r.body).not.toContain('Content-Security-Policy');
  });

  it('without a _headers file sends the same policy the build writes', async () => {
    const web = mkdtempSync(join(tmpdir(), 'web-'));
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>spl2dql</title>');
    writeFileSync(join(web, 'sw.js'), 'self');
    const bare = await startServer({ port: 0, host: '127.0.0.1', webDir: web });
    const h = new URL(bare.url).host;
    const page = await raw(bare.url, { path: '/', headers: { host: h } });
    expect(page.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(page.headers['content-security-policy']).toContain("require-trusted-types-for 'script'");
    expect((await raw(bare.url, { path: '/sw.js', headers: { host: h } })).headers['content-security-policy']).toBe(
      "default-src 'none'; connect-src 'self'; frame-ancestors 'none'",
    );
    await bare.close();
  });
});

describe('the built-in policy matches the one the build writes', () => {
  const built = fileURLToPath(new URL('../../../apps/web/dist/_headers', import.meta.url));
  it.skipIf(!existsSync(built))('gives every path the same headers as apps/web/dist/_headers', () => {
    const fromBuild = parseHeadersFile(readFileSync(built, 'utf8'));
    const fallback = parseHeadersFile(DEFAULT_HEADERS);
    for (const path of ['/', '/index.html', '/sw.js', '/social.png', '/assets/app.js', '/manifest.webmanifest']) {
      expect(headersFor(fallback, path), path).toEqual(headersFor(fromBuild, path));
    }
  });
});
