/**
 * ADR-029, second round: the independent re-test of 2026-11-17 bypassed some
 * first-round fixes. One block per re-test finding; inputs are the re-tester's. Bounds are generous
 * and the facts asserted (how many panels were translated, sizes, notes) do not depend on time.
 */
import {
  convertDashboard,
  convertDashboardSource,
  DashboardError,
  importSplunkConfig,
  mergeMappingSections,
  parseMappingConfig,
  readDashboard,
  regexToDpl,
  translate,
} from '@spl2dql/core';
import { describe, expect, it } from 'vitest';

const timed = <T>(run: () => T): { value: T; ms: number } => {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
};
const TOO_LARGE = /too large to convert in one go/;

/** The re-tester's macros: s0 expands to about 990 KB that prints past the output budget. */
function slowMapping() {
  const body = Array.from({ length: 700 }, (_, i) => `f${i}=f${i}+1`).join(', ');
  const conf = `[s1]\ndefinition = ${body},\n[s0]\ndefinition = index=a | eval ${'`s1` '.repeat(100)} z=1\n`;
  const imported = importSplunkConfig([{ name: 'macros.conf', text: conf }]);
  const mapping = parseMappingConfig(mergeMappingSections({}, imported.sections));
  if (!mapping.ok) throw new Error(JSON.stringify(mapping.issues));
  return mapping.value;
}

describe('the dashboard budget is charged for the work (re-test finding 4)', () => {
  it('charges a panel the length after macro expansion, and a "too large" translation the full cap', () => {
    // 200 panels of `s0`: 12.7 s before, every panel translated 990 KB.
    const panels = '<row><table><search><query>`s0`</query></search></table></row>'.repeat(200);
    const { value: c, ms } = timed(() =>
      convertDashboardSource({ name: 'd.xml', text: `<dashboard><label>D</label>${panels}</dashboard>` }, { mapping: slowMapping() }),
    );
    expect(ms).toBeLessThan(10_000);
    const translated = c.tiles.filter((t) => t.result !== undefined);
    expect(translated.length).toBe(5);
    expect(c.tiles.filter((t) => TOO_LARGE.test(t.notes[0] ?? ''))).toHaveLength(195);
  });

  it('ignores a <prefix> field name over 200 characters, with a note (tokamp)', () => {
    const xml = (nameLength: number, tokens: number): string =>
      `<form><label>D</label><fieldset><input type="text" token="t"><prefix>${'A'.repeat(nameLength)}="</prefix><suffix>"</suffix></input></fieldset><search id="b"><query>index=a ${'$t$ '.repeat(tokens)}</query></search><row><table><search base="b"><query>head 1</query></search></table></row></form>`;
    // 60,000 characters × 30,000 tokens would have built a 1.8 GB string.
    const { value: c, ms } = timed(() => convertDashboardSource({ name: 'd.xml', text: xml(60_000, 30_000) }));
    expect(ms).toBeLessThan(5000);
    expect(c.notes.some((n) => /names a field longer than 200 characters/.test(n))).toBe(true);
    expect(readDashboard({ name: 'd.xml', text: xml(60_000, 1) }).inputs[0]?.filterField).toBeUndefined();
    expect(readDashboard({ name: 'd.xml', text: xml(200, 1) }).inputs[0]?.filterField).toBe('A'.repeat(200));
  });

  it('refuses before building a search whose tokens would grow it past the budget', () => {
    // 200 characters × 30,000 tokens: 6.2 M characters once rewritten, more than the 5 M budget.
    const xml = `<form><label>D</label><fieldset><input type="text" token="t"><prefix>${'A'.repeat(200)}="</prefix><suffix>"</suffix></input></fieldset><row><table><search><query>index=a ${'$t$ '.repeat(30_000)}</query></search></table></row></form>`;
    const { value: c, ms } = timed(() => convertDashboardSource({ name: 'd.xml', text: xml }));
    expect(ms).toBeLessThan(5000);
    expect(c.tiles[0]?.notes[0]).toMatch(TOO_LARGE);
    expect(c.tiles[0]?.result).toBeUndefined();
  });
});

describe('nothing in one file ends a run (re-test finding 5)', () => {
  it('skips an extraction whose pattern would be longer than 10,000 characters', () => {
    const r = importSplunkConfig([
      { name: 'props.conf', text: '[s]\nEXTRACT-a = (?<f>x)(?:(?:(?:abcdefghijklmnopqrst){8}){8}){8}\nEXTRACT-b = id=(?<id>\\d+)\n' },
    ]);
    expect(Object.keys(r.sections.extractions ?? {})).toEqual(['id']);
    expect(r.skipped[0]?.reason).toMatch(/longer than 10000 characters/);
    expect(parseMappingConfig(mergeMappingSections({}, r.sections)).ok).toBe(true);
  });

  it('holds every imported section to the mapping file limits, so the result always validates', () => {
    const tags = Array.from({ length: 10_050 }, (_, i) => `[host=h${i}]\nt${i} = enabled\n`).join('');
    const macros = Array.from({ length: 10_050 }, (_, i) => `[m${i}]\ndefinition = index=a\n`).join('');
    const r = importSplunkConfig([
      { name: 'macros.conf', text: macros },
      { name: 'tags.conf', text: tags },
    ]);
    expect(Object.keys(r.sections.macros ?? {})).toHaveLength(10_000);
    expect(Object.keys(r.sections.tags ?? {})).toHaveLength(10_000);
    expect(r.skipped.filter((s) => /more than 10000 entries/.test(s.reason)).map((s) => s.section)).toEqual(['macros', 'tags']);
    const merged = mergeMappingSections({ version: 1, macros: { own: 'index=b' } }, r.sections);
    const checked = parseMappingConfig(merged);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.value.macros.get('own')?.definition).toBe('index=b');
  });

  it('reads a Studio type that is not text without throwing', () => {
    for (const text of [
      '{"visualizations":{"a":{"type":{"toString":1}}},"dataSources":{}}',
      '{"visualizations":{},"dataSources":{},"inputs":{"i":{"type":{"toString":1},"options":{"token":"t"}}}}',
      '{"visualizations":{},"dataSources":{},"inputs":{"i":{"type":"input.dropdown","options":{"token":"t","defaultValue":[{"toString":1},"a"]}}}}',
      '{"visualizations":{},"dataSources":{},"layout":{"tabs":{"items":[{"layoutId":{"toString":1}}]},"layoutDefinitions":{"a":{}}}}',
    ]) {
      expect(() => convertDashboardSource({ name: 'a.json', text }), text).not.toThrow();
    }
  });
});

describe('Dashboard Studio tabs (re-test finding 6)', () => {
  const tabs = (items: unknown[], definitions: Record<string, unknown>, visualizations: Record<string, unknown> = {}): string =>
    JSON.stringify({ title: 'T', visualizations, dataSources: {}, layout: { tabs: { items }, layoutDefinitions: definitions } });

  it('reads at most 200 tabs (130,000 overflowed the stack before)', () => {
    const items = Array.from({ length: 130_000 }, (_, i) => ({ layoutId: `l${i}`, label: 'x' }));
    const definitions = Object.fromEntries(Array.from({ length: 130_000 }, (_, i) => [`l${i}`, { structure: [] }]));
    const { value: c, ms } = timed(() => convertDashboardSource({ name: 'a.json', text: tabs(items, definitions) }));
    expect(ms).toBeLessThan(5000);
    expect(c.tiles).toHaveLength(200);
    expect(c.notes).toContain('The dashboard has more than 200 tabs; the rest were left out.');
  });

  it('reads a layout that many tabs show once (59 s for 1.2 MB before)', () => {
    const n = 40_000;
    const text = tabs(
      Array.from({ length: n }, () => ({ layoutId: 'a' })),
      { a: { structure: Array.from({ length: n }, () => ({ item: 'r' })) } },
      { r: { type: 'splunk.rectangle' } },
    );
    const { value: model, ms } = timed(() => readDashboard({ name: 'a.json', text }));
    expect(ms).toBeLessThan(5000);
    expect(model.dropped).toContain('199 tab(s) show a layout an earlier tab already shows; it was converted once.');
  });

  it('counts tab headings toward the panel limit', () => {
    const structure = Array.from({ length: 1999 }, (_, i) => ({ item: 'v', position: { x: 0, y: i } }));
    const text = tabs(
      [
        { layoutId: 'a', label: 'one' },
        { layoutId: 'b', label: 'two' },
      ],
      { a: { structure }, b: { structure: [] } },
      { v: { type: 'splunk.table' } },
    );
    expect(() => readDashboard({ name: 'a.json', text })).toThrow(DashboardError);
  });
});

describe('variable values must be safe for how they are used (re-test finding 10)', () => {
  it('leaves out a default that is not a number where the query writes it as a number', () => {
    const c = convertDashboard({
      format: 'simple-xml',
      title: 'T',
      inputs: [{ token: 't', kind: 'text', choices: [], defaultValue: '0 | fetch bizevents | limit 1000000' }],
      panels: [{ kind: 'table', title: 'x', dropped: [], search: { spl: 'index=a | where n > $t$' } }],
      dropped: [],
    });
    expect(c.dashboard.content.tiles['0']).toMatchObject({ type: 'data' });
    expect(String((c.dashboard.content.tiles['0'] as { query: string }).query)).toContain('$t:noquote');
    expect(c.dashboard.content.variables[0]).toMatchObject({ key: 't', type: 'text', defaultValue: '' });
    expect(c.variables[0]?.notes.some((n) => /default value was left out/.test(n))).toBe(true);
    // A number stays.
    const ok = convertDashboard({
      format: 'simple-xml',
      title: 'T',
      inputs: [{ token: 't', kind: 'text', choices: [], defaultValue: '500' }],
      panels: [{ kind: 'table', title: 'x', dropped: [], search: { spl: 'index=a | where n > $t$' } }],
      dropped: [],
    });
    expect(ok.dashboard.content.variables[0]).toMatchObject({ defaultValue: '500' });
  });

  it('leaves out a choice that is not a plain field name where the query uses it as a field', () => {
    const c = convertDashboard({
      format: 'simple-xml',
      title: 'T',
      inputs: [
        {
          token: 'f',
          kind: 'dropdown',
          choices: [
            { label: 'host', value: 'host' },
            { label: 'bad', value: 'a`b | fetch x' },
          ],
          defaultValue: 'a`b | fetch x',
        },
      ],
      panels: [{ kind: 'table', title: 'x', dropped: [], search: { spl: 'index=a | stats count by $f$' } }],
      dropped: [],
    });
    expect(String((c.dashboard.content.tiles['0'] as { query: string }).query)).toContain('$f:backtick');
    expect(c.dashboard.content.variables[0]).toMatchObject({ type: 'csv', input: 'host' });
    expect(c.dashboard.content.variables[0]?.defaultValue).toBeUndefined();
    expect(c.variables[0]?.notes.filter((n) => /left out/.test(n))).toHaveLength(2);
  });
});

describe(':triplequote (re-test 2 finding F)', () => {
  it('leaves out a default or choice containing three double quotes', () => {
    const bad = 'x""") | fetch bizevents | filter matchesPhrase(content, """y';
    const c = convertDashboard({
      format: 'simple-xml',
      title: 'T',
      inputs: [
        {
          token: 't',
          kind: 'dropdown',
          choices: [
            { label: 'a', value: 'error' },
            { label: 'b', value: bad },
          ],
          defaultValue: bad,
        },
      ],
      panels: [{ kind: 'table', title: 'x', dropped: [], search: { spl: 'index=a $t$' } }],
      dropped: [],
    });
    expect(String((c.dashboard.content.tiles['0'] as { query: string }).query)).toContain('$t:triplequote');
    expect(c.dashboard.content.variables[0]).toMatchObject({ type: 'csv', input: 'error' });
    expect(c.dashboard.content.variables[0]?.defaultValue).toBeUndefined();
    expect(c.variables[0]?.notes.filter((n) => /three double quotes/.test(n))).toHaveLength(2);
  });
});

describe('budgets on what a run imports (re-test findings 3, 7)', () => {
  it('refuses a regex whose pattern would be longer than 10,000 characters, before building it', () => {
    // 1.9 KB that gave 974 KB of DPL; 2.0 KB gave 3.0 MB.
    for (const length of [1880, 2000]) {
      const re = `(?<f>x)(?:(?:(?:${'a'.repeat(length)}){8}){8}){8}`;
      const { value, ms } = timed(() => regexToDpl(re, { captures: true }));
      expect(ms).toBeLessThan(500);
      expect(value).toMatchObject({ ok: false, reason: expect.stringMatching(/longer than 10000 characters/) });
    }
    expect(regexToDpl(`(?<f>${'a'.repeat(3000)})`, { captures: true }).ok).toBe(true);
  });

  it('imports at most 5,000,000 characters of definitions (tags × eventtype: 43 MB before)', () => {
    const search = Array.from({ length: 260 }, (_, i) => `f${i}="v${i}"`).join(' ');
    const tags = Array.from({ length: 9_900 }, (_, i) => `t${i} = enabled`).join('\n');
    const { value: r, ms } = timed(() =>
      importSplunkConfig([
        { name: 'eventtypes.conf', text: `[big]\nsearch = ${search}\n` },
        { name: 'tags.conf', text: `[eventtype=big]\n${tags}\n` },
      ]),
    );
    expect(ms).toBeLessThan(5000);
    const total =
      Object.values(r.sections.tags ?? {}).reduce((n, c) => n + c.length, 0) + Object.values(r.sections.eventtypes ?? {}).reduce((n, c) => n + c.length, 0);
    expect(total).toBeLessThanOrEqual(5_000_000);
    expect(r.counts.tags).toBeLessThan(9_900);
    expect(r.skipped.filter((s) => /more than 5000000 characters/.test(s.reason))).toHaveLength(1);
  });
});

describe('nothing a user can type reaches the internal-problem catch-all (re-test finding 11)', () => {
  it('reports a function called without arguments as an expression error', () => {
    for (const fn of ['isnum', 'isint', 'isstr', 'isbool', 'typeof', 'mvindex', 'mvcount', 'tostring', 'tonumber', 'round', 'log', 'exact']) {
      for (const spl of [`index=a | eval n=${fn}()`, `index=a | where ${fn}()`]) {
        const codes = translate(spl).diagnostics.map((d) => d.code);
        expect(codes, spl).toContain('SPL1004');
        expect(codes, spl).not.toContain('SPL1008');
      }
    }
  });

  it('handles a replace with thousands of pairs and a search IN list of 150,000 values', () => {
    const replace = translate(`index=a | replace ${Array.from({ length: 3000 }, (_, i) => `"a${i}" WITH "b"`).join(', ')} IN f`);
    expect(replace.diagnostics.map((d) => d.code)).toContain('SPL1006');
    expect(replace.diagnostics.map((d) => d.code)).not.toContain('SPL1008');
    const list = translate(`index=a f IN (${Array.from({ length: 150_000 }, (_, i) => i).join(',')})`);
    expect(list.diagnostics.map((d) => d.code)).not.toContain('SPL1008');
    expect(translate(`index=a | replace ${Array.from({ length: 400 }, (_, i) => `"a${i}" WITH "b"`).join(', ')} IN f`).stages[1]?.status).not.toBe(
      'untranslated',
    );
  });

  it('gives a normal result for about 140,000 field names in one stage (re-test 2, G)', () => {
    const names = Array.from({ length: 140_000 }, (_, i) => `${i}`).join(' ');
    for (const spl of [`index=a | dedup ${names}`, `index=a | fields ${names}`, `index=a | fields f* | table ${names}`, `index=a | fields - ${names}`]) {
      const codes = translate(spl).diagnostics.map((d) => d.code);
      expect(codes, spl.slice(0, 30)).not.toContain('SPL1008');
    }
  });
});
