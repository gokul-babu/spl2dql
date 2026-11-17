import { readFileSync } from 'node:fs';
import { convertDashboardSource, translate } from '@spl2dql/core';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { isAppScript } from '../src/lib/app-script.ts';
import { EXAMPLES } from '../src/lib/examples.ts';
import { checkBudget, MAX_TOTAL } from '../src/lib/input-files.ts';
import { lineIndex } from '../src/lib/lines.ts';
import { DEFAULT_MAPPING, isEmptyMappingText } from '../src/lib/mapping-empty.ts';
import { ADDED_COMMENT, addEntries, entriesFor, findEntry, skeleton } from '../src/lib/mapping-text.ts';
import { conversionCost, keepConversion, keepLimit, keepResult, keepWithin, MAX_KEPT, resultCost } from '../src/lib/retained.ts';
import { hashOf, titleOf, VIEWS, viewFromHash } from '../src/lib/route.ts';
import { resolveMapping } from '../src/lib/worker-mapping.ts';

describe('lineIndex', () => {
  it('agrees with counting newlines from the start', () => {
    const text = 'a\nbb\n\nccc\n';
    const naive = (offset: number) => text.slice(0, offset).split('\n').length;
    const idx = lineIndex(text);
    for (let o = 0; o <= text.length; o++) expect(idx.lineOf(o), String(o)).toBe(naive(o));
    expect(idx.startOf(1)).toBe(0);
    expect(idx.startOf(2)).toBe(2);
    expect(idx.startOf(4)).toBe(6);
    expect(idx.startOf(99)).toBe(text.length);
  });

  it('is fast on a long text with many lookups', () => {
    const text = 'x\n'.repeat(500_000);
    const t = performance.now();
    const idx = lineIndex(text);
    for (let i = 0; i < 100_000; i++) idx.lineOf(i * 7);
    expect(performance.now() - t).toBeLessThan(2_000);
  });
});

describe('the view in the address', () => {
  it('maps every view to a fragment and back', () => {
    for (const v of VIEWS) expect(viewFromHash(hashOf(v))).toBe(v);
    expect(hashOf('translate')).toBe('');
    expect(viewFromHash('#q=abc')).toBe('translate');
    expect(viewFromHash('#/nope')).toBe('translate');
    expect(viewFromHash('#/translate')).toBe('translate');
    expect(viewFromHash('#main')).toBe('translate');
    expect(titleOf('mapping')).toBe('Mapping – spl2dql');
  });
});

describe('isEmptyMappingText', () => {
  it('treats the starting text, blank text and empty sections as empty', () => {
    expect(isEmptyMappingText(DEFAULT_MAPPING)).toBe(true);
    expect(isEmptyMappingText('')).toBe(true);
    expect(isEmptyMappingText('version: 1\nindexes:\nfields: []\nmacros: ~\n# a comment\n')).toBe(true);
  });

  it('treats any entry, nesting, flow content or default as a mapping of their own', () => {
    expect(isEmptyMappingText('version: 1\nindexes:\n  web:\n    dataObject: logs\n')).toBe(false);
    expect(isEmptyMappingText('version: 1\nfields: { level: loglevel }\n')).toBe(false);
    expect(isEmptyMappingText('defaults:\n  dataObject: events\n')).toBe(false);
    expect(isEmptyMappingText('fields: [\n')).toBe(false);
  });
});

describe('mapping text', () => {
  it('adds entries with a comment, turns an empty flow section into a block, and keeps what is there', () => {
    const out = addEntries(DEFAULT_MAPPING, [skeleton('indexes', 'web'), skeleton('fields', 'level'), skeleton('fields', 'level')]);
    expect(out?.added).toBe(2);
    const text = out?.text ?? '';
    expect(text).toContain('# Mapping file: tells the translator');
    expect(text).toContain(`#${ADDED_COMMENT}`);
    expect(parse(text)).toMatchObject({ version: 1, indexes: { web: { dataObject: 'logs', buckets: [] } }, fields: { level: 'level' } });
    expect(findEntry(text, 'indexes', 'web')).toBe(text.indexOf('  web:') + 2);
    expect(addEntries('fields: [\n', [skeleton('fields', 'a')])).toBeUndefined();
  });

  it('turns mapping notes into one entry per name', () => {
    const r = translate('index=web status>=500 | lookup http_status code AS status OUTPUT description | stats count by status');
    const entries = entriesFor(r.diagnostics);
    expect(entries.map((e) => `${e.section}:${e.name}`).sort()).toEqual(['fields:status', 'indexes:web', 'lookups:http_status']);
  });
});

describe('the example mapping', () => {
  it('resolves the names of all five examples', () => {
    const { mapping, use } = resolveMapping({ example: true });
    expect(use).toBe('example');
    const out = EXAMPLES.map((e) => translate(e.spl, mapping ? { mapping } : {}));
    expect(out.map((r) => r.confidence)).toEqual(['high', 'review', 'review', 'review', 'low']);
    for (const [i, r] of out.entries()) {
      const unresolved = r.diagnostics.filter((d) => /^SPL400[1-8]$/.test(d.code)).map((d) => `${d.code} ${d.subject}`);
      // The last example's "Country" would come from iplocation, which is not translated.
      expect(unresolved, EXAMPLES[i]?.title).toEqual(i === 4 ? ['SPL4003 Country'] : []);
    }
  });

  it('tells an invalid own mapping from an empty one', () => {
    expect(resolveMapping({ own: '' }).use).toBe('none');
    expect(resolveMapping({ own: 'fields: [\n' }).use).toBe('invalid');
    expect(resolveMapping({ own: 'version: 1\nnope: 1\n' }).use).toBe('invalid');
    expect(resolveMapping({ own: DEFAULT_MAPPING }).use).toBe('own');
  });
});

describe('drop budget', () => {
  it('refuses more than 100 MB in one drop before reading', () => {
    expect(() => checkBudget([{ path: 'a.conf', size: MAX_TOTAL }])).not.toThrow();
    expect(() =>
      checkBudget([
        { path: 'a.conf', size: MAX_TOTAL },
        { path: 'b.conf', size: 1 },
      ]),
    ).toThrow('These files add up to more than 100 MB. Choose fewer files at once.');
  });
});

describe('what one drop keeps', () => {
  it('stops before the result that would go over the budget, and charges notes too', () => {
    const searches = ['index=a | head 1', 'index=b | stats count by host', 'index=c | transaction x', 'index=d | head 2'];
    const all = keepWithin(searches, (spl) => keepResult(translate(spl)), Number.MAX_SAFE_INTEGER);
    expect(all.kept).toHaveLength(4);
    const costs = all.kept.map(resultCost);
    for (const [i, k] of all.kept.entries()) expect(costs[i]).toBeGreaterThan(k.dql.length);
    const budget = (costs[0] ?? 0) + (costs[1] ?? 0);
    const some = keepWithin(searches, (spl) => keepResult(translate(spl)), budget);
    expect(some.kept).toHaveLength(2);
    expect(some.spent).toBe(budget);
    expect(keepWithin(searches, (spl) => keepResult(translate(spl)), 0).kept).toEqual([]);
  });

  it('keeps only what the views show or download', () => {
    const k = keepResult(translate('index=web | stats count by host'));
    expect(Object.keys(k).sort()).toEqual(['confidence', 'diagnostics', 'dql']);
    const sample = readFileSync(new URL('../../../examples/splunk-app/default/data/ui/views/web_overview.xml', import.meta.url), 'utf8');
    const full = convertDashboardSource({ name: 'web_overview.xml', text: sample }, {});
    const kept = keepConversion(full);
    for (const t of kept.tiles) if (t.result) expect(Object.keys(t.result)).toEqual(['dql']);
    for (const v of kept.variables) expect('result' in v).toBe(false);
    expect(kept.dashboard).toEqual(full.dashboard);
    expect(conversionCost(kept)).toBeLessThan(JSON.stringify(full).length);
  });

  it('a test may lower the limit, never raise it', () => {
    const g = globalThis as { __spl2dqlKeepLimit?: number };
    expect(keepLimit()).toBe(MAX_KEPT);
    g.__spl2dqlKeepLimit = 10;
    expect(keepLimit()).toBe(10);
    g.__spl2dqlKeepLimit = MAX_KEPT * 2;
    expect(keepLimit()).toBe(MAX_KEPT);
    delete g.__spl2dqlKeepLimit;
  });
});

describe('the Trusted Types check', () => {
  const origin = 'https://spl2dql.pages.dev';
  const allowed = [`${origin}/assets/translate.worker-Ab12.js`, `${origin}/sw.js`];
  it('accepts exactly the app’s two scripts on its own origin over http(s)', () => {
    for (const url of allowed) expect(isAppScript(url, origin, allowed), url).toBe(true);
  });
  it('refuses blob:, data:, javascript:, other paths and other origins', () => {
    for (const url of [
      `blob:${origin}/0b4c1f4e-0000-4000-8000-000000000000`,
      'data:text/javascript,postMessage(1)',
      'javascript:void 0',
      `${origin}/assets/other.js`,
      `${origin}/sw.js?x=1`,
      'https://example.com/sw.js',
      'not a url',
    ]) {
      expect(isAppScript(url, origin, allowed), url).toBe(false);
    }
  });
});
