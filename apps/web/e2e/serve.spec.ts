import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
// Built output of the CLI (pnpm build runs before the e2e suite).
import { startServer } from '../../../packages/cli/dist/serve/server.js';

const webDir = fileURLToPath(new URL('../dist', import.meta.url));

let server: Awaited<ReturnType<typeof startServer>>;

test.beforeAll(async () => {
  server = await startServer({ port: 0, host: '127.0.0.1', webDir });
});

test.afterAll(async () => {
  await server.close();
});

test('spl2dql serve: the app translates and makes no requests beyond its own files', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  const csp: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) csp.push(m.text());
  });
  await page.goto(server.url);
  await page.getByLabel('Load an example search').selectOption('4');
  await expect(page.getByTestId('confidence')).toBeVisible();
  await expect(page.getByLabel('Dynatrace DQL query (read only)')).toContainText('// not translated: iplocation clientip');
  await expect(page.getByRole('switch')).toHaveCount(0);
  expect(requests.filter((u) => !u.startsWith(server.url) && !u.startsWith('data:'))).toEqual([]);
  expect(requests.filter((u) => u.includes('/api/'))).toEqual([]);
  expect(csp).toEqual([]);
});

test('spl2dql serve: the page cannot be framed', async ({ request }) => {
  const res = await request.get(server.url);
  expect(res.headers()['x-frame-options']).toBe('DENY');
  expect(res.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
});
