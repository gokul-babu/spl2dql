import AxeBuilder from '@axe-core/playwright';
import { expect, loadExample, openView, test, typeSpl } from './fixtures.ts';

test.describe('offline web app', () => {
  test('empty state shows the placeholder and no result', async ({ page, watch }) => {
    await page.goto('/');
    await expect(page.getByText('Paste a Splunk search, or pick an example.')).toBeVisible();
    await expect(page.getByText('Nothing translated yet.')).toBeVisible();
    expect(watch.errors).toEqual([]);
  });

  test('translates an example with linked stages, the example mapping and the offline syntax check', async ({ page, watch }) => {
    await page.goto('/');
    await loadExample(page, 0);
    const dql = page.getByLabel('Dynatrace DQL query (read only)');
    await expect(dql).toContainText('fetch logs, bucket:{"web_logs"}, from:-24h@h');
    await expect(dql).toContainText('filter matchesValue(loglevel, "ERROR")');
    await expect(dql).toContainText('summarize count = count(), by:{host.name}');
    await expect(page.getByTestId('confidence')).toHaveText(/Exact/);
    await expect(page.getByTestId('syntax')).toContainText('passed');
    await expect(page.getByTestId('mapping-line')).toHaveText(/Using the example mapping\. Your own searches need yours\./);
    await expect(page.getByTestId('notes')).not.toContainText('SPL4001');
    await expect(page.locator('[data-testid=seam] .ribbon')).toHaveCount(4);
    await expect(page.getByTestId('live')).toHaveText(/Translated\. Exact/);
    expect(watch.external).toEqual([]);
    expect(watch.api).toEqual([]);
    expect(watch.errors).toEqual([]);
  });

  test('a parse problem still shows the rest and underlines the problem', async ({ page }) => {
    await page.goto('/');
    await typeSpl(page, 'index=web | stats count by host | eval x=');
    await expect(page.getByLabel('Dynatrace DQL query (read only)')).toContainText('// not translated: eval x=');
    await expect(page.getByTestId('confidence')).toHaveText(/Incomplete/);
  });

  test('nothing translatable', async ({ page }) => {
    await page.goto('/');
    await typeSpl(page, '| datamodel Web search');
    await expect(page.getByText('None of this search could be translated.')).toBeVisible();
    await expect(page.getByTestId('confidence')).toHaveText(/Not translated/);
  });

  test('selecting a note focuses its stage', async ({ page }) => {
    await page.goto('/');
    await loadExample(page, 4);
    await page.getByTestId('notes').getByRole('button', { name: 'Stage 3' }).first().click();
    await expect(page.locator('.cm-stage-active').first()).toBeVisible();
  });

  test('share link round-trips the search through the URL fragment only', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await loadExample(page, 1);
    await page.getByRole('button', { name: 'Copy link' }).click();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(new URL(link).hash).toMatch(/^#q=[A-Za-z0-9_-]+$/);
    const page2 = await context.newPage();
    await page2.goto(link);
    await expect(page2.getByLabel('Splunk SPL search')).toContainText('timechart span=5m count by method');
  });

  test('a crafted share link cannot crash the app', async ({ page, watch }) => {
    await page.goto(`/#q=${'A'.repeat(5000)}`);
    await expect(page.getByText('Paste a Splunk search, or pick an example.')).toBeVisible();
    expect(watch.errors).toEqual([]);
  });

  test('copy DQL', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await loadExample(page, 0);
    await page.getByRole('button', { name: 'Copy DQL' }).click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('fetch logs');
  });

  test('works with storage blocked', async ({ page, watch }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new Error('blocked');
        },
      });
    });
    await page.goto('/');
    await loadExample(page, 0);
    await expect(page.getByLabel('Dynatrace DQL query (read only)')).toContainText('fetch logs');
    expect(watch.errors).toEqual([]);
  });

  test('mapping view: invalid YAML and invalid entries are reported, Add fills a name', async ({ page }) => {
    await page.goto('/');
    await typeSpl(page, 'index=web level=ERROR | stats count by host');
    await expect(page.getByTestId('confidence')).toBeVisible();
    await openView(page, 'Mapping');
    await expect(page.getByRole('button', { name: 'Add web to Indexes' })).toBeVisible();
    await page.getByRole('button', { name: 'Add web to Indexes' }).click();
    await expect(page.getByLabel('Mapping file (YAML)')).toContainText('web:');
    await openView(page, 'Translate');
    await expect(page.getByTestId('notes')).not.toContainText('SPL4001');
    await openView(page, 'Mapping');
    await page.getByLabel('Mapping file (YAML)').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText('version: 2\nnope: 1\n');
    await expect(page.getByTestId('mapping-issues')).toContainText('/nope');
    await page.getByRole('button', { name: 'Forget mapping' }).click();
    await expect(page.getByText('The mapping file is valid.')).toBeVisible();
  });

  test('batch view translates dropped files and offers a download', async ({ page }) => {
    await page.goto('/');
    await openView(page, 'Batch');
    await page.getByLabel('Choose files').setInputFiles([
      {
        name: 'savedsearches.conf',
        mimeType: 'text/plain',
        buffer: Buffer.from('[Errors]\nsearch = index=web error | stats count\n[Geo]\nsearch = index=web | iplocation ip\n'),
      },
      { name: 'one.spl', mimeType: 'text/plain', buffer: Buffer.from('index=web | head 5') },
    ]);
    const table = page.getByTestId('batch-table');
    await expect(table.locator('tbody tr')).toHaveCount(3);
    await expect(table).toContainText('Incomplete');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download results' }).click();
    expect((await download).suggestedFilename()).toBe('spl2dql-results.zip');
    await table.getByRole('button', { name: 'Open' }).first().click();
    await expect(page.getByLabel('Splunk SPL search')).toContainText('iplocation');
  });

  test('batch view rejects unsupported files with a message', async ({ page }) => {
    await page.goto('/');
    await openView(page, 'Batch');
    await page.getByLabel('Choose files').setInputFiles([{ name: 'x.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') }]);
    await expect(page.getByRole('alert')).toContainText('None of these files is a search, a Splunk dashboard or a Splunk configuration file.');
  });

  test('reference view lists commands and codes', async ({ page }) => {
    await page.goto('/');
    await openView(page, 'Reference');
    await expect(page.getByRole('cell', { name: 'stats', exact: true })).toBeVisible();
    await page.getByLabel('Find a command or note code').fill('SPL3001');
    await expect(page.getByRole('cell', { name: /SPL3001/ })).toBeVisible();
  });

  test('settings and shortcuts dialogs, theme switch', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByLabel('Dark').check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('the offline popover explains that nothing leaves the device', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('mode').click();
    await expect(page.getByText('No search, mapping or result leaves this device.')).toBeVisible();
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`accessibility (axe) in the ${theme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.goto('/');
      await loadExample(page, 3);
      for (const view of ['Translate', 'Batch', 'Dashboards', 'Mapping', 'Reference']) {
        await openView(page, view);
        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
        const summary = results.violations.map((v) => `${view}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target.join(' ')}`);
        expect(summary).toEqual([]);
      }
    });
  }

  test('no horizontal scrolling at phone width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await loadExample(page, 3);
    for (const view of ['Translate', 'Batch', 'Dashboards', 'Mapping', 'Reference']) {
      await openView(page, view);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), view).toBeLessThanOrEqual(390);
    }
  });

  test('installs a service worker that precaches every file the app needs', async ({ page }) => {
    await page.goto('/');
    const cached = await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      const keys = await caches.keys();
      const cache = await caches.open(keys[0] ?? '');
      return (await cache.keys()).map((r) => new URL(r.url).pathname);
    });
    const loaded = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname));
    expect(cached).toContain('/');
    for (const path of loaded.filter((p) => p.startsWith('/assets/'))) expect(cached, path).toContain(path);
    expect(cached.some((p) => p.includes('translate.worker'))).toBe(true);
  });
});
