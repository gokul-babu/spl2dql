import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, openView, test } from './fixtures.ts';

const app = fileURLToPath(new URL('../../../examples/splunk-app/default/', import.meta.url));
const file = (path: string) => ({ name: path.replace(/^.*\//, ''), mimeType: 'text/plain', buffer: readFileSync(app + path) });

test.describe('whole-app migration: saved searches, dashboards and Splunk configuration files', () => {
  test('the empty Translate view offers examples and the two file views', async ({ page }) => {
    await page.goto('/');
    const start = page.getByTestId('start');
    await expect(start).toContainText('Start from an example');
    await start.getByRole('button', { name: 'Errors per host' }).click();
    await expect(page.getByLabel('Dynatrace DQL query (read only)')).toContainText('summarize count = count(), by:{host.name}');
    await expect(page.getByTestId('start')).toHaveCount(0);
  });

  test('the sample app converts into dashboards with a layout preview, variables and a download', async ({ page, watch }) => {
    await page.goto('/');
    await page.getByTestId('start').getByRole('button', { name: 'Convert dashboards' }).click();
    await page.getByRole('button', { name: 'Load the sample app' }).click();
    const list = page.getByTestId('dashboard-list');
    await expect(list.getByRole('button')).toHaveCount(2);
    await list.getByRole('button', { name: /Web overview/ }).click();
    await expect(page.getByTestId('dashboard-counts')).toHaveText('6 converted · 1 need manual work · 2 text · 3 variables');

    // Every tile of the converted dashboard is in the preview, at its place on the grid.
    const grid = page.getByTestId('tile-grid');
    await expect(grid.getByRole('button')).toHaveCount(9);
    const first = await grid.getByRole('button', { name: /Requests over time/ }).boundingBox();
    const second = await grid.getByRole('button', { name: /Top pages/ }).boundingBox();
    expect(first && second && second.y > first.y).toBe(true);

    // The panel that could not be translated says why and keeps its Splunk search.
    const detail = page.getByTestId('tile-detail');
    await expect(detail).toContainText('Needs manual work');
    await expect(detail).toContainText('transaction with options has no DQL equivalent.');
    await expect(detail).toContainText('transaction JSESSIONID maxpause=5m');

    // A converted panel: tokens became variables, and a saved search was found by name.
    await grid.getByRole('button', { name: /Server errors/ }).click();
    await expect(detail).toContainText('in(status, array($status_tok)) and in(host.name, array($host_tok))');
    await grid.getByRole('button', { name: /Slow requests/ }).click();
    await expect(detail).toContainText("LONG:'duration_ms'");
    await expect(page.getByTestId('variables')).toContainText('$host_tok');
    await expect(page.getByTestId('variables')).toContainText('Filled by a query');

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download dashboard' }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe('Web_overview.json');
    const json = JSON.parse(readFileSync(await saved.path(), 'utf8'));
    expect(json.type).toBe('dashboard');
    expect(Object.keys(json.content.tiles)).toHaveLength(9);
    expect(Object.keys(json.content.layouts)).toHaveLength(9);
    expect(json.content.variables.map((v: { key: string }) => v.key)).toEqual(['host_tok', 'status_tok', 'uri_tok']);

    await grid.getByRole('button', { name: /Server errors/ }).click();
    await detail.getByRole('button', { name: 'Open in Translate' }).click();
    await expect(page.getByLabel('Splunk SPL search')).toContainText('$status_tok$');
    await expect(page.getByTestId('notes')).toContainText('SPL4009');

    expect(watch.external).toEqual([]);
    expect(watch.api).toEqual([]);
    expect(watch.errors).toEqual([]);
  });

  test('a Dashboard Studio dashboard keeps its layout and its chained searches', async ({ page }) => {
    await page.goto('/');
    await openView(page, 'Dashboards');
    await page.getByLabel('Choose files').setInputFiles([file('data/ui/views/security_posture.xml')]);
    await expect(page.getByTestId('dashboard-counts')).toHaveText('5 converted · 0 need manual work · 2 text · 2 variables');
    await page
      .getByTestId('tile-grid')
      .getByRole('button', { name: /Top sources/ })
      .click();
    const detail = page.getByTestId('tile-detail');
    await expect(detail).toContainText('limit $top_n:noquote');
    await expect(detail).toContainText('Its drilldown (what a click does) is not carried over.');
  });

  test('batch reads saved time ranges and uses macros, extractions, eventtypes and tags from the same drop', async ({ page }) => {
    await page.goto('/');
    await openView(page, 'Batch');
    await page
      .getByLabel('Choose files')
      .setInputFiles([
        file('savedsearches.conf'),
        file('macros.conf'),
        file('props.conf'),
        file('transforms.conf'),
        file('eventtypes.conf'),
        file('tags.conf'),
      ]);
    const table = page.getByTestId('batch-table');
    await expect(table.locator('tbody tr')).toHaveCount(9);
    await expect(table).toContainText('-60m@m to now · runs */15 * * * *');
    await expect(table).toContainText('Switched off in Splunk');
    const summary = page.getByTestId('ingest-summary');
    await expect(summary).toContainText('definitions added to the mapping');
    await expect(summary).toContainText('2 definitions could not be carried over');

    // The eventtype resolved through eventtypes.conf and its fields through props.conf.
    await table
      .getByRole('row', { name: /failed SSH logins/ })
      .getByRole('button', { name: 'Open' })
      .click();
    const dql = page.getByLabel('Dynatrace DQL query (read only)');
    await expect(dql).toContainText('matchesPhrase(content, "Failed password")');
    await expect(dql).toContainText('preserveFieldsOnFailure:true');
    await expect(page.getByTestId('notes')).not.toContainText('SPL4006');

    await openView(page, 'Mapping');
    await expect(page.getByLabel('Mapping file (YAML)')).toContainText('security_content_ctime(1):');
    await expect(page.getByText('The mapping file is valid.')).toBeVisible();
  });

  test('the Mapping view reads Splunk configuration files and keeps what the mapping already has', async ({ page }) => {
    await page.goto('/');
    await openView(page, 'Mapping');
    await page.getByLabel('Mapping file (YAML)').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText('version: 1\nmacros:\n  web_index:\n    definition: index=mine\n');
    await page.getByLabel('Choose files').setInputFiles([file('macros.conf')]);
    await expect(page.getByTestId('ingest-summary')).toContainText('2 definitions added from the Splunk configuration files.');
    const editor = page.getByLabel('Mapping file (YAML)');
    await expect(editor).toContainText('definition: index=mine');
    await expect(editor).toContainText('security_content_summariesonly:');
    await expect(page.getByTestId('ingest-summary')).toContainText('1 definition could not be carried over');
  });

  test('a file that is not a dashboard is reported, not converted', async ({ page }) => {
    await page.goto('/');
    await openView(page, 'Dashboards');
    await page
      .getByLabel('Choose files')
      .setInputFiles([{ name: 'broken.xml', mimeType: 'text/xml', buffer: Buffer.from('<dashboard><label>x</label><row>') }]);
    await expect(page.getByTestId('ingest-summary')).toContainText('is not closed');
    await expect(page.getByTestId('dashboard-detail')).toHaveCount(0);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`a converted dashboard is accessible in the ${theme} theme and fits a phone`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.goto('/');
      await openView(page, 'Dashboards');
      await page.getByRole('button', { name: 'Load the sample app' }).click();
      await expect(page.getByTestId('tile-grid')).toBeVisible();
      for (const view of ['Dashboards', 'Batch', 'Mapping']) {
        await openView(page, view);
        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
        expect(results.violations.map((v) => `${view}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      for (const view of ['Dashboards', 'Batch']) {
        await openView(page, view);
        const widths = await page.evaluate(() => {
          const scroller = document.querySelector('main > div');
          return { page: document.documentElement.scrollWidth, inner: scroller ? scroller.scrollWidth - scroller.clientWidth : 0 };
        });
        expect(widths.page, view).toBeLessThanOrEqual(390);
        expect(widths.inner, view).toBeLessThanOrEqual(0);
      }
    });
  }
});
