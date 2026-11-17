import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { unzipSync } from 'fflate';
import { expect, loadExample, openView, test, typeSpl } from './fixtures.ts';

const dist = (file: string) => readFileSync(fileURLToPath(new URL(`../dist/${file}`, import.meta.url)), 'utf8');
const dql = (page: import('@playwright/test').Page) => page.getByLabel('Dynatrace DQL query (read only)');

/** Launch hardening (ADR-030, ADR-029): first impression, loading, robustness. */
test.describe('first impression', () => {
  test('says what the tool is, runs in your browser, and has one h1 and a skip link', async ({ page, watch }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('spl2dql');
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.getByRole('banner').getByText('Translates Splunk searches to Dynatrace DQL, dashboards included.')).toBeVisible();
    await expect(page.getByTestId('mode')).toHaveText(/Runs in your browser/);
    await page.keyboard.press('Tab');
    const skip = page.getByRole('button', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();
    expect(page.url()).not.toContain('#main');
    await expect(page.getByRole('textbox', { name: 'From (start of the time range)' })).toBeVisible();
    expect(watch.errors).toEqual([]);
  });

  test('the About dialog has the version, links, licence, privacy note and disclaimer', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'About' }).click();
    const about = page.getByRole('dialog', { name: 'About spl2dql' });
    await expect(about).toBeVisible();
    await expect(about.getByTestId('version')).toHaveText(/^Version \d+\.\d+\.\d+/);
    const links = {
      'Source code on GitHub': 'https://github.com/gokul-babu/spl2dql',
      'The command-line tool on npm': 'https://www.npmjs.com/package/spl2dql',
      'Third-party notices': './THIRD-PARTY-NOTICES.txt',
    };
    for (const [name, href] of Object.entries(links)) {
      const link = about.getByRole('link', { name });
      await expect(link).toHaveAttribute('href', href);
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    await expect(about).toContainText('Licensed under Apache-2.0');
    await expect(about).toContainText(
      'No account, no analytics, no cookies. Your searches, files and mapping stay in this browser; settings are kept in its local storage. The company that hosts this page sees the usual request logs when the page loads, and your browser may tell it when a connection to the page fails. Nothing you type or drop here is ever sent.',
    );
    await expect(about).toContainText(
      'spl2dql is an independent open-source project. It is not affiliated with, endorsed by or supported by Splunk Inc., Cisco or Dynatrace. Splunk, SPL, Dynatrace and DQL are trademarks of their respective owners and are used only to describe what this tool works with. Provided without warranty; check every translated query before relying on it.',
    );
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      expect(results.violations.map((v) => `${theme}: ${v.id} ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
    }
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('the static shell and the noscript line are in the page before any script runs', async ({ request }) => {
    const html = await (await request.get('/')).text();
    expect(html).toContain('<h1 class="app-name">spl2dql</h1>');
    expect(html).toContain('Translates Splunk searches to Dynatrace DQL, dashboards included.');
    expect(html).toContain('<noscript>');
    for (const view of ['Translate', 'Batch', 'Dashboards', 'Mapping', 'Reference']) expect(html).toContain(`>${view}</a>`);
  });

  test('the shell is shown without JavaScript', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('spl2dql');
    await expect(page.getByRole('navigation', { name: 'Views' }).getByRole('link')).toHaveCount(5);
    await context.close();
  });
});

test.describe('example mapping and missing names', () => {
  test('an unmodified example uses the example mapping; one edited character and it is the person’s own search', async ({ page }) => {
    await page.goto('/');
    await loadExample(page, 0);
    await expect(page.getByTestId('confidence')).toHaveText(/Exact/);
    await expect(page.getByTestId('mapping-line')).toContainText('Using the example mapping. Your own searches need yours.');
    await page.getByTestId('mapping-line').getByRole('button', { name: 'Open Mapping' }).click();
    await expect(page).toHaveURL(/#\/mapping$/);
    await expect(page.getByTestId('example-mapping')).toContainText('Example mapping in use');
    await page.goBack();
    await expect(page.getByTestId('confidence')).toBeVisible();

    // The same search, changed by one character: the person's own, with an empty mapping.
    await page.getByLabel('Splunk SPL search').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.insertText('1');
    await expect(page.getByTestId('mapping-line')).toHaveText(/2 names need a mapping\./);
    await expect(page.getByTestId('confidence')).toHaveText(/Needs review/);
    await expect(dql(page)).toContainText('fetch logs, from:-24h@h');
  });

  test('with a mapping of their own, the example mapping is never used', async ({ page }) => {
    await page.goto('/');
    await openView(page, 'Mapping');
    await page.getByLabel('Mapping file (YAML)').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText('version: 1\nfields:\n  level: severity\n');
    await openView(page, 'Translate');
    await loadExample(page, 0);
    await expect(dql(page)).toContainText('matchesValue(severity, "ERROR")');
    await expect(page.getByTestId('confidence')).toHaveText(/Needs review/);
    await expect(page.getByTestId('notes')).toContainText('SPL4001');
    await expect(page.getByTestId('mapping-line')).toHaveCount(0);
  });

  test('the five examples with the example mapping', async ({ page }) => {
    await page.goto('/');
    const expected = ['Exact', 'Needs review', 'Needs review', 'Needs review', 'Incomplete'];
    for (const [i, word] of expected.entries()) {
      await loadExample(page, i);
      await expect(page.getByTestId('confidence')).toHaveText(new RegExp(word));
      // Every index, field and lookup resolves. The last example keeps one honest note: "Country"
      // would come from iplocation, which has no DQL equivalent.
      await expect(page.getByTestId('notes')).not.toContainText(i < 4 ? /SPL400[1-8]/ : /SPL400[124-8]/);
    }
  });

  test('missing names: one line, the names behind a toggle, and one button that adds them all', async ({ page }) => {
    await page.goto('/');
    await typeSpl(page, 'index=web status>=500\n| lookup http_status code AS status OUTPUT description\n| stats count by host');
    const line = page.getByTestId('mapping-line');
    await expect(line).toHaveText(/3 names need a mapping\./);
    const notes = page.getByTestId('notes');
    await expect(notes).not.toContainText('SPL4001');
    await line.getByRole('button', { name: 'Show the names' }).click();
    await expect(notes).toContainText('SPL4001');
    await expect(notes).toContainText('SPL4005');
    await line.getByRole('button', { name: 'Hide the names' }).click();
    await expect(notes).not.toContainText('SPL4001');
    await expect(page.getByTestId('confidence')).toHaveText(/Needs review/);

    await line.getByRole('button', { name: 'Add them to the mapping' }).click();
    await expect(page).toHaveURL(/#\/mapping$/);
    const editor = page.getByLabel('Mapping file (YAML)');
    await expect(editor).toContainText('web:');
    await expect(editor).toContainText('http_status:');
    await expect(editor).toContainText('status: status');
    await expect(editor).toContainText('Added by spl2dql: replace with where this lives in Grail.');
    await expect(editor).toBeFocused();
  });

  test('"Add mapping" on one note adds that entry and opens Mapping at it', async ({ page }) => {
    await page.goto('/');
    await openView(page, 'Mapping');
    await page.getByLabel('Mapping file (YAML)').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText('version: 1\nfields:\n  host: host.name\n');
    await openView(page, 'Translate');
    await typeSpl(page, 'index=web | stats count by host');
    const note = page.getByTestId('notes').locator('li', { hasText: 'SPL4001' });
    await note.getByRole('button', { name: 'Add mapping' }).click();
    await expect(page).toHaveURL(/#\/mapping$/);
    const editor = page.getByLabel('Mapping file (YAML)');
    await expect(editor).toBeFocused();
    await expect(editor).toContainText('host: host.name');
    const caretLine = await page.evaluate(() => getSelection()?.anchorNode?.parentElement?.closest('.cm-line')?.textContent ?? '');
    expect(caretLine).toContain('web:');
  });

  test('a mapping file with a YAML problem is not used, and the line says so', async ({ page }) => {
    await page.goto('/');
    await openView(page, 'Mapping');
    await page.getByLabel('Mapping file (YAML)').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText('version: 1\nfields: [\n');
    await openView(page, 'Translate');
    await typeSpl(page, 'index=web | head 5');
    await expect(page.getByTestId('mapping-line')).toContainText('The mapping file has a problem, so it was not used.');
  });
});

test.describe('blocking problems and copying', () => {
  test('notes of stages that were not translated come first with ■, and the status line leads with them', async ({ page }) => {
    await page.goto('/');
    await loadExample(page, 4);
    const status = page.getByTestId('status');
    await expect(status.getByTestId('blocking')).toHaveText(/2 of 4 stages not translated/);
    const first = await status.locator(':scope > span').first().textContent();
    expect(first).toContain('2 of 4 stages not translated');
    await expect(page.getByTestId('legend')).toContainText('Exact');
    await expect(page.getByTestId('legend')).toContainText('Not translated');
    const items = page.getByTestId('notes').locator('li');
    await expect(items.nth(0)).toHaveAttribute('data-blocking', 'true');
    await expect(items.nth(1)).toHaveAttribute('data-blocking', 'true');
    await expect(items.nth(0)).toContainText('■');
    await expect(items.nth(0)).toContainText('Not translated:');
    await expect(items.nth(2)).not.toHaveAttribute('data-blocking', 'true');
  });

  test('the copy button says what it copies', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await loadExample(page, 4);
    const copy = page.getByTestId('copy-dql');
    await expect(copy).toHaveText('Copy incomplete DQL');
    await expect(copy).not.toHaveClass(/primary/);
    await copy.click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('// not translated: transaction');
    await loadExample(page, 0);
    await expect(copy).toHaveText('Copy DQL');
    await expect(copy).toHaveClass(/primary/);
    await typeSpl(page, '| datamodel Web search');
    await expect(page.getByTestId('confidence')).toHaveText(/Not translated/);
    await expect(copy).toBeDisabled();
  });
});

test.describe('the view in the address', () => {
  test('Back, Forward and reload keep the view, and the title names it', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('Translate – spl2dql');
    await openView(page, 'Batch');
    await expect(page).toHaveURL(/#\/batch$/);
    await expect(page).toHaveTitle('Batch – spl2dql');
    await openView(page, 'Reference');
    await expect(page).toHaveURL(/#\/reference$/);
    await page.goBack();
    await expect(page.getByTestId('dropzone')).toBeVisible();
    await expect(page).toHaveTitle('Batch – spl2dql');
    await page.goBack();
    await expect(page.getByLabel('Splunk SPL search')).toBeVisible();
    await expect(page).toHaveTitle('Translate – spl2dql');
    await page.goForward();
    await expect(page).toHaveTitle('Batch – spl2dql');
    await page.reload();
    await expect(page.getByTestId('dropzone')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Batch' })).toHaveAttribute('aria-current', 'page');
    await page.goto('/#/nonsense');
    await expect(page.getByLabel('Splunk SPL search')).toBeVisible();
  });

  test('a share link made before views were in the address opens exactly as before', async ({ page }) => {
    // Made with lib/share.ts as it was in M4: deflate + base64url of the search, nothing else.
    const link = '/#q=y8xLSa2wLU9NUqhRKC5JLClWSM4vzStRSKpUyMgvLgEA';
    await page.goto(link);
    await expect(page.getByLabel('Splunk SPL search')).toContainText('index=web | stats count by host');
    await expect(page).toHaveURL(/#q=y8xLSa2wLU9NUqhRKC5JLClWSM4vzStRSKpUyMgvLgEA$/);
    await expect(page).toHaveTitle('Translate – spl2dql');
    // Going to another view and Back keeps edits made since the link was opened.
    await typeSpl(page, 'index=web | head 3');
    await openView(page, 'Reference');
    await page.goBack();
    await expect(page.getByLabel('Splunk SPL search')).toContainText('index=web | head 3');
  });

  test('a share link pasted into an open tab opens its search', async ({ page }) => {
    await page.goto('/#/batch');
    await page.evaluate(() => {
      location.hash = '#q=y8xLSa2wLU9NUqhRKC5JLClWSM4vzStRSKpUyMgvLgEA';
    });
    await expect(page.getByLabel('Splunk SPL search')).toContainText('index=web | stats count by host');
  });
});

test.describe('loading', () => {
  test('Batch, Dashboards, Mapping and Reference load on demand', async ({ page }) => {
    const loaded: string[] = [];
    page.on('request', (r) => loaded.push(new URL(r.url()).pathname));
    await page.goto('/');
    await loadExample(page, 0);
    for (const chunk of ['BatchView', 'DashboardsView', 'MappingView', 'ReferenceView'])
      expect(
        loaded.some((p) => p.includes(chunk)),
        chunk,
      ).toBe(false);
    for (const [view, chunk] of [
      ['Batch', 'BatchView'],
      ['Dashboards', 'DashboardsView'],
      ['Mapping', 'MappingView'],
      ['Reference', 'ReferenceView'],
    ] as const) {
      await openView(page, view);
      await expect(page.getByRole('main')).not.toHaveAttribute('aria-busy', 'true');
      expect(
        loaded.some((p) => p.includes(chunk)),
        chunk,
      ).toBe(true);
    }
    await expect(page.getByRole('cell', { name: 'stats', exact: true })).toBeVisible();
  });

  test('phone: the views fit one row and the examples come before the empty editor', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const links = page.getByRole('navigation', { name: 'Views' }).getByRole('link');
    const tops = await links.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);
    const start = await page.getByTestId('start').boundingBox();
    const editor = await page.getByLabel('Splunk SPL search').boundingBox();
    expect(start && editor && start.y < editor.y).toBe(true);
    await expect(page.getByTestId('start').getByRole('button', { name: 'Errors per host' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test('starts with no connection once the service worker is installed', async ({ page, context, watch }) => {
    await page.goto('/');
    await page.waitForFunction(async () => (await navigator.serviceWorker.ready) && navigator.serviceWorker.controller !== null);
    await context.setOffline(true);
    await page.reload();
    await loadExample(page, 0);
    await expect(dql(page)).toContainText('summarize count = count(), by:{host.name}');
    await openView(page, 'Reference');
    await expect(page.getByRole('cell', { name: 'stats', exact: true })).toBeVisible();
    await context.setOffline(false);
    expect(watch.errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(e))).toEqual([]);
  });

  test('the service worker clears only its own old caches and answers from its own cache', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    const kept = await page.evaluate(async () => {
      const other = await caches.open('another-app');
      await other.put('/assets/not-ours.js', new Response('// not ours', { headers: { 'content-type': 'text/javascript' } }));
      await caches.open('spl2dql-old');
      const reg = await navigator.serviceWorker.ready;
      await reg.update();
      return caches.keys();
    });
    expect(kept).toContain('another-app');
    const sw = dist('sw.js');
    expect(sw).toContain("k.startsWith('spl2dql-') && k !== CACHE");
    expect(sw).not.toContain('caches.match(');
  });
});

test.describe('robustness', () => {
  test('100,000 searches in one savedsearches.conf are read; the table shows 2,000 and says so', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/#/batch');
    let conf = '';
    for (let i = 0; i < 100_000; i++) conf += `[s${i}]\nsearch = index=a\n`;
    await page.getByLabel('Choose files').setInputFiles([{ name: 'savedsearches.conf', mimeType: 'text/plain', buffer: Buffer.from(conf) }]);
    const table = page.getByTestId('batch-table');
    await expect(table).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(table.locator('tbody tr')).toHaveCount(2_000);
    const more = (await page.getByTestId('more-line').filter({ hasText: 'All of them are in the download' }).textContent()) ?? '';
    const shown = /^Showing the first 2,000 of ([\d,]+) searches\. All of them are in the download\.$/.exec(more);
    expect(shown, more).not.toBeNull();
    const translated = Number((shown?.[1] ?? '').replace(/,/g, ''));
    // About 530 characters are kept per search, so the 50 MB budget ends this drop before the end.
    const left = (await page.getByTestId('not-translated-count').textContent()) ?? '';
    expect(translated + Number(/^([\d,]+) searches/.exec(left)?.[1]?.replace(/,/g, ''))).toBe(100_000);
  });

  test('a shortened Batch table still downloads every search', async ({ page }) => {
    await page.goto('/#/batch');
    let conf = '';
    for (let i = 0; i < 2_500; i++) conf += `[s${i}]\nsearch = index=a | head ${i + 1}\n`;
    await page.getByLabel('Choose files').setInputFiles([{ name: 'savedsearches.conf', mimeType: 'text/plain', buffer: Buffer.from(conf) }]);
    await expect(page.getByTestId('more-line')).toHaveText('Showing the first 2,000 of 2,500 searches. All of them are in the download.');
    await expect(page.getByTestId('batch-table').locator('tbody tr')).toHaveCount(2_000);
    await expect(page.getByText('2500 searches:')).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download results' }).click();
    const files = unzipSync(readFileSync(await (await download).path()));
    expect(Object.keys(files).filter((f) => f.endsWith('.dql'))).toHaveLength(2_500);
  });

  test('a long DQL result is not put into the pane; copying still copies all of it', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await typeSpl(page, `index=a | eval x="${'A'.repeat(600_000)}"`);
    const line = page.getByTestId('too-long');
    await expect(line).toHaveText(/^This DQL is 600,\d{3} characters long, too long to show here\. Copy DQL still copies all of it\.$/, { timeout: 20_000 });
    expect(await page.locator('.cm-content').nth(1).textContent()).toBe('');
    await page.getByTestId('copy-dql').click();
    expect((await page.evaluate(() => navigator.clipboard.readText())).length).toBeGreaterThan(600_000);
  });

  test('the Trusted Types policy starts only the app’s own two scripts', async ({ page, watch }) => {
    await page.goto('/');
    await loadExample(page, 0);
    const refused = await page.evaluate(() => {
      const out: string[] = [];
      const blob = URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }));
      try {
        new Worker(blob);
      } catch (e) {
        out.push(`blob worker: ${(e as Error).name}`);
      }
      const tt = (globalThis as unknown as { trustedTypes: { createPolicy(n: string, r: object): unknown } }).trustedTypes;
      for (const name of ['spl2dql', 'other']) {
        try {
          tt.createPolicy(name, { createScriptURL: (u: string) => u });
        } catch (e) {
          out.push(`policy ${name}: ${(e as Error).name}`);
        }
      }
      return out;
    });
    expect(refused).toEqual(['blob worker: TypeError', 'policy spl2dql: TypeError', 'policy other: TypeError']);
    expect(watch.errors.filter((e) => !/TrustedScriptURL|Trusted Type|trusted-types/i.test(e))).toEqual([]);
  });

  test('one drop keeps a limited amount of DQL; the rest is counted, named and not translated', async ({ page }) => {
    // The real limit is 50,000,000 characters; the test lowers it (it can only be lowered).
    await page.addInitScript(() => {
      (globalThis as { __spl2dqlKeepLimit?: number }).__spl2dqlKeepLimit = 3_000;
    });
    await page.goto('/#/batch');
    const conf = Array.from({ length: 12 }, (_, i) => `[Search ${i + 1}]\nsearch = index=web host=h${i} | stats count by host, status | sort -count\n`).join(
      '',
    );
    const dashboard = readFileSync(fileURLToPath(new URL('../../../examples/splunk-app/default/data/ui/views/web_overview.xml', import.meta.url)));
    await page.getByLabel('Choose files').setInputFiles([
      { name: 'savedsearches.conf', mimeType: 'text/plain', buffer: Buffer.from(conf) },
      { name: 'web_overview.xml', mimeType: 'text/xml', buffer: dashboard },
    ]);
    const over = page.getByTestId('over-budget');
    await expect(over).toContainText('These files produce more than 50 MB of DQL. The rest was not translated; choose fewer files at once.');
    const rows = await page.getByTestId('batch-table').locator('tbody tr').count();
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThan(12);
    const missing = 12 - rows;
    await expect(page.getByTestId('not-translated-count')).toHaveText(`${missing} searches and 1 dashboard were not translated`);
    await page.getByTestId('not-translated-count').click();
    await expect(over.getByRole('listitem')).toHaveCount(missing + 1);
    await expect(over).toContainText('web_overview.xml');

    // What was translated still downloads, and only that.
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download results' }).click();
    const files = unzipSync(readFileSync(await (await download).path()));
    expect(Object.keys(files).filter((f) => f.endsWith('.dql'))).toHaveLength(rows);
    const report = JSON.parse(new TextDecoder().decode(files['report.json'])) as { searches: { dql: string; notes: unknown[] }[] };
    expect(report.searches).toHaveLength(rows);
    expect(report.searches[0]?.dql).toContain('fetch logs');

    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      expect(results.violations.map((v) => `${theme}: ${v.id} ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
    }
  });

  test('a dashboard over what is left of the budget is not converted, and is named', async ({ page }) => {
    await page.addInitScript(() => {
      (globalThis as { __spl2dqlKeepLimit?: number }).__spl2dqlKeepLimit = 1_000;
    });
    await page.goto('/#/dashboards');
    const dashboard = readFileSync(fileURLToPath(new URL('../../../examples/splunk-app/default/data/ui/views/web_overview.xml', import.meta.url)));
    await page.getByLabel('Choose files').setInputFiles([{ name: 'web_overview.xml', mimeType: 'text/xml', buffer: dashboard }]);
    await expect(page.getByTestId('not-translated-count')).toHaveText('1 dashboard was not translated');
    await expect(page.getByTestId('tile-grid')).toHaveCount(0);
  });

  test('a drop over 100 MB is refused before anything is read', async ({ page }) => {
    await page.addInitScript(() => {
      const size = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')?.get;
      Object.defineProperty(File.prototype, 'size', {
        get() {
          return (this as File).name === 'huge.conf' ? 150 * 1024 * 1024 : size?.call(this);
        },
      });
    });
    await page.goto('/#/batch');
    await page.getByLabel('Choose files').setInputFiles([{ name: 'huge.conf', mimeType: 'text/plain', buffer: Buffer.from('[a]\nsearch = index=a\n') }]);
    await expect(page.getByRole('alert')).toHaveText(/These files add up to more than 100 MB\. Choose fewer files at once\./);
    await expect(page.getByTestId('batch-table')).toHaveCount(0);
  });
});

test.describe('a translator that fails', () => {
  // The worker script is replaced on the way in; a service worker would answer from its cache instead.
  test.use({ serviceWorkers: 'block' });

  test('answers at once instead of waiting for the time limit', async ({ page }) => {
    await page.route(/translate\.worker-[\w-]+\.js$/, (route) =>
      route.fulfill({ contentType: 'text/javascript', body: 'throw new Error("broken on purpose");' }),
    );
    await page.goto('/');
    const started = Date.now();
    await loadExampleNoWait(page);
    await expect(page.getByTestId('failure')).toHaveText(/The translator stopped unexpectedly\. Change the search to try again\./, { timeout: 10_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

test.describe('host files', () => {
  test('_headers carries the same policy as the page, plus framing, caching and the other headers', async () => {
    const html = dist('index.html');
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1];
    expect(meta).toBeDefined();
    const headers = dist('_headers');
    expect(headers).toContain(`Content-Security-Policy: ${meta}; frame-ancestors 'none'`);
    for (const line of [
      'X-Content-Type-Options: nosniff',
      'Referrer-Policy: no-referrer',
      'Cross-Origin-Opener-Policy: same-origin',
      'Cross-Origin-Resource-Policy: same-origin',
      'Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      '/assets/*\n  ! Cache-Control\n  Cache-Control: public, max-age=31536000, immutable',
    ]) {
      expect(headers).toContain(line);
    }
    expect(meta).toContain("connect-src 'none'");
    expect(meta).toContain("require-trusted-types-for 'script'");
    expect(dist('404.html')).toContain('href="/"');
    expect(html).toContain('og:image" content="https://');
  });
});

async function loadExampleNoWait(page: import('@playwright/test').Page): Promise<void> {
  await page.getByLabel('Load an example search').selectOption('0');
}
