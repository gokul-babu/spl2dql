/**
 * Launch hardening (ADR-029): work and output budgets, linear readers, Markdown tiles. One block per
 * finding of the security review of 2026-11-16. Time bounds are generous (seconds) and the inputs
 * are the review's own, which took 10× to 1000× longer, or never ended, before the fix.
 */
import {
  convertDashboard,
  convertDashboardSource,
  importSplunkConfig,
  parseConf,
  parseMappingConfig,
  readDashboard,
  regexToDpl,
  safeFileName,
  translate,
} from '@spl2dql/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { codeBlock, escapeText } from '../src/dashboard/markdown.ts';
import { MAX_DIAGNOSTICS, MAX_OUTPUT } from '../src/limits.ts';

const codes = (r: { diagnostics: { code: string }[] }): string[] => r.diagnostics.map((d) => d.code);
const timed = <T>(run: () => T): { value: T; ms: number } => {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
};

describe('output budget of one translation (finding 1)', () => {
  it('does not translate a foreach whose expansion is over 200,000 characters', () => {
    // 400 fields × a 90 KB template: 20.6 MB of DQL before.
    const fields = Array.from({ length: 400 }, (_, i) => `f${i}`).join(' ');
    const r = translate(`index=a | foreach ${fields} [eval <<FIELD>> = coalesce(<<FIELD>>, ${'<<FIELD>>,'.repeat(9000)}1)]`);
    expect(r.dql.length).toBeLessThan(200_000);
    expect(r.stages[1]?.status).toBe('untranslated');
    expect(r.diagnostics.find((d) => d.stageIndex === 1)?.code).toBe('SPL1006');
  });

  it('still expands an ordinary foreach', () => {
    const r = translate('index=a | foreach a b c [eval <<FIELD>> = <<FIELD>> * 2]');
    expect(r.dql).toContain('fieldsAdd a = a * 2, b = b * 2, c = c * 2');
  });

  it('stops a translation whose DQL would be longer than 1,000,000 characters and returns nothing partial', () => {
    // Each eventstats on raw events repeats the whole pipeline before it: the text doubles per stage.
    const { value: r, ms } = timed(() => translate(`index=a ${'| eventstats count by host '.repeat(40)}`));
    expect(ms).toBeLessThan(5000);
    expect(r).toMatchObject({ dql: '', confidence: 'none', stages: [] });
    expect(codes(r)).toEqual(['SPL1006']);
    // Below the budget the same construct still translates.
    expect(translate(`index=a ${'| eventstats count by host '.repeat(3)}`).dql).toContain('join');
  });

  it('stops many foreach stages that are each under their own budget but together over the output budget', () => {
    const fields = Array.from({ length: 20 }, (_, i) => `f${i}`).join(' ');
    const stage = `| foreach ${fields} [eval <<FIELD>> = coalesce(<<FIELD>>, ${'<<FIELD>>,'.repeat(900)}1)] `;
    const r = translate(`index=a ${stage.repeat(20)}`);
    expect(r.dql.length).toBeLessThanOrEqual(MAX_OUTPUT);
    expect(codes(r)).toEqual(['SPL1006']);
  });

  it('refuses a regular expression that unrolls to more than 2,000 pattern items', () => {
    // 3.8 KB that became 13.7 MB of DPL.
    const re = `(?<f>x)${'(?:(?:(?:(?:(?:a){8}){8}){8}){8}){8}'.repeat(105)}`;
    const { value: conv, ms } = timed(() => regexToDpl(re, { captures: true }));
    expect(ms).toBeLessThan(1000);
    expect(conv.ok).toBe(false);
    const r = translate(`index=a ${`| rex "${re}" `.repeat(5)}`);
    expect(r.dql.length).toBeLessThan(50_000);
    expect(codes(r)).toContain('SPL2006');
    // Up to the budget a fixed repeat is still written out.
    const small = regexToDpl('(?<v>(?:ab){8})', { captures: true });
    expect(small.ok).toBe(true);
    expect(regexToDpl('(?:(?:(?:a){8}){8}){8}x').ok).toBe(true);
    expect(regexToDpl('(?:(?:(?:(?:a){8}){8}){8}){8}x').ok).toBe(false);
  });
});

describe('a regex never ends an import (finding 9)', () => {
  it('regexToDpl returns a refusal for anything it cannot convert, a stack overflow included', () => {
    const deep = `(?<f>x)${'(?:'.repeat(8)}a${'){8}'.repeat(8)}`;
    expect(() => regexToDpl(deep, { captures: true })).not.toThrow();
    expect(regexToDpl(deep, { captures: true }).ok).toBe(false);
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (re) => {
        const r = regexToDpl(re, { captures: true });
        return typeof r.ok === 'boolean';
      }),
    );
  });

  it('importSplunkConfig skips the one bad definition with a note and keeps the others', () => {
    const r = importSplunkConfig([
      { name: 'props.conf', text: `[s]\nEXTRACT-a = (?<f>x)${'(?:'.repeat(8)}a${'){8}'.repeat(8)}\nEXTRACT-b = id=(?<id>\\d+)\n` },
    ]);
    expect(Object.keys(r.sections.extractions ?? {})).toEqual(['id']);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]).toMatchObject({ section: 'extractions', name: '[s] EXTRACT-a' });
  });
});

describe('Dashboard Studio layout (finding 2)', () => {
  const studio = (positions: unknown[]): string =>
    JSON.stringify({
      title: 't',
      visualizations: Object.fromEntries(positions.map((_, i) => [`v${i}`, { type: 'splunk.table', dataSources: { primary: 'ds' } }])),
      dataSources: { ds: { type: 'ds.search', options: { query: 'index=a | stats count' } } },
      layout: { structure: positions.map((position, i) => ({ item: `v${i}`, type: 'block', position })) },
    });

  it('clamps positions on read', () => {
    const model = readDashboard({ name: 'a.json', text: studio([{ x: 1e9, y: 1e300, w: 5e5, h: 1e12 }]) });
    expect(model.panels[0]?.box).toMatchObject({ x: 100_000, y: 100_000, w: 100_000, h: 100_000 });
  });

  it('places one panel far down at once (it never ended before)', () => {
    const { value: c, ms } = timed(() => convertDashboardSource({ name: 'a.json', text: studio([{ x: 0, y: 1e300, w: 100, h: 100 }]) }));
    expect(ms).toBeLessThan(2000);
    expect(c.dashboard.content.layouts['0']).toEqual({ x: 0, y: 0, w: 24, h: 3 });
  });

  it('places 500 panels far apart quickly and closes the gaps (over 40 s before)', () => {
    const { value: c, ms } = timed(() =>
      convertDashboardSource({ name: 'a.json', text: studio(Array.from({ length: 500 }, (_, i) => ({ x: 0, y: i * 400_000, w: 100, h: 100 }))) }),
    );
    expect(ms).toBeLessThan(5000);
    const ys = Object.values(c.dashboard.content.layouts).map((l) => l.y);
    expect(ys).toEqual(Array.from({ length: 500 }, (_, i) => i * 3));
  });

  it('stacks panels that sit on top of each other, as stepping one row at a time did', () => {
    const c = convertDashboardSource({
      name: 'a.json',
      text: studio([
        { x: 0, y: 0, w: 600, h: 300 },
        { x: 0, y: 0, w: 600, h: 300 },
        { x: 600, y: 100, w: 600, h: 200 },
        { x: 300, y: 50, w: 600, h: 150 },
      ]),
    });
    expect(Object.values(c.dashboard.content.layouts)).toEqual([
      { x: 0, y: 0, w: 12, h: 6 },
      { x: 0, y: 6, w: 12, h: 6 },
      { x: 12, y: 0, w: 12, h: 4 },
      { x: 6, y: 12, w: 12, h: 3 },
    ]);
  });
});

describe('per-dashboard budget (finding 3)', () => {
  it('turns panels past 5,000,000 characters of SPL into manual tiles that say the dashboard is too large', () => {
    // 2,000 panels on one 400 KB base search: 22.5 s and 4.5 GB before.
    const panels = Array.from({ length: 2000 }, () => '<row><panel><table><search base="b"><query>stats count</query></search></table></panel></row>').join('');
    const xml = `<dashboard><search id="b"><query>index=a ${'x'.repeat(400_000)}</query></search>${panels}</dashboard>`;
    const { value: c, ms } = timed(() => convertDashboardSource({ name: 'a.xml', text: xml }));
    expect(ms).toBeLessThan(10_000);
    expect(c.counts.live).toBe(12);
    expect(c.counts.manual).toBe(1988);
    const over = c.tiles[c.tiles.length - 1];
    expect(over?.notes[0]).toMatch(/too large to convert in one go/);
    // Nothing of the shared base search is kept for the panels past the budget.
    expect(over?.spl).toBeUndefined();
    expect(over?.result).toBeUndefined();
  });

  it('does not follow a chain of more than 20 base searches (Simple XML)', () => {
    let xml = '<dashboard><search id="s0"><query>index=a</query></search>';
    for (let i = 1; i < 1000; i++) xml += `<search id="s${i}" base="s${i - 1}"><query>search ${'z'.repeat(3000)}</query></search>`;
    xml += '<row><panel><table><search base="s999"><query>stats count</query></search></table></panel></row>';
    xml += '<row><panel><table><search base="s5"><query>stats count</query></search></table></panel></row></dashboard>';
    const model = readDashboard({ name: 'a.xml', text: xml });
    expect(model.panels[0]?.unreadable).toMatch(/more than 20 base searches/);
    expect(model.panels[0]?.search).toBeUndefined();
    expect(model.panels[1]?.search?.spl.startsWith('index=a | search')).toBe(true);
    const c = convertDashboard(model);
    expect(c.tiles[0]).toMatchObject({ outcome: 'manual', notes: [expect.stringMatching(/more than 20 base searches/)] });
  });

  it('refuses a joined search longer than one translation accepts, when it is built', () => {
    const xml = `<dashboard><search id="b"><query>index=a ${'x'.repeat(700_000)}</query></search><search id="c" base="b"><query>${'y'.repeat(400_000)}</query></search><row><panel><table><search base="c"><query>stats count</query></search></table></panel></row></dashboard>`;
    const model = readDashboard({ name: 'a.xml', text: xml });
    expect(model.panels[0]?.unreadable).toMatch(/longer than 1000000 characters/);
    const studio = JSON.stringify({
      visualizations: { v: { type: 'splunk.table', dataSources: { primary: 'c' } } },
      dataSources: {
        b: { type: 'ds.search', options: { query: `index=a ${'x'.repeat(700_000)}` } },
        c: { type: 'ds.chain', options: { extend: 'b', query: `| ${'y'.repeat(400_000)}` } },
      },
    });
    expect(readDashboard({ name: 'a.json', text: studio }).panels[0]?.unreadable).toMatch(/longer than/);
  });

  it('reads at most 500 inputs', () => {
    const inputs = Array.from({ length: 600 }, (_, i) => `<input type="text" token="t${i}"/>`).join('');
    const model = readDashboard({ name: 'a.xml', text: `<form><fieldset>${inputs}</fieldset><row><panel><html>x</html></panel></row></form>` });
    expect(model.inputs).toHaveLength(500);
    expect(model.dropped).toContain('The dashboard has more than 500 inputs; the rest were left out.');
    const studio = JSON.stringify({
      visualizations: {},
      dataSources: {},
      inputs: Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`i${i}`, { type: 'input.text', options: { token: `t${i}` } }])),
    });
    expect(readDashboard({ name: 'a.json', text: studio }).inputs).toHaveLength(500);
  });
});

describe('linear readers (findings 4, 5, 6, 11)', () => {
  it('reads a .conf line of 160,000 blanks without "=" at once (11 s before)', () => {
    const { value, ms } = timed(() => parseConf(`[s]\na${' '.repeat(160_000)}\nb = 1\n`));
    expect(ms).toBeLessThan(1000);
    expect(value[0]?.values.get('b')).toBe('1');
  });

  it('reads .conf lines exactly as the previous regular expression did', () => {
    // The expression the reader used before (kept here as the reference for short lines).
    const OLD = /^\s*([^=[#\s][^=]*?)\s*=\s?(.*)$/;
    const old = (text: string): [string, string][] => {
      const out: [string, string][] = [];
      for (const line of text.split(/\r?\n/)) {
        if (/^\s*#/.test(line) || /^\s*\[(.+)\]\s*$/.test(line)) continue;
        const m = OLD.exec(line);
        if (m) out.push([(m[1] as string).trim(), (m[2] as string).trim()]);
      }
      return out;
    };
    const now = (text: string): [string, string][] => [...(parseConf(text)[0]?.values ?? new Map<string, string>())].filter(([, v]) => !v.includes('\n'));
    const piece = fc.constantFrom('a', 'key', ' ', '\t', '=', '#', '[', ']', '\\', 'x y', '\r', '\u2028', '\u00a0', '\ufeff', '==', ' = ', 'v');
    fc.assert(
      fc.property(
        fc.array(
          fc.array(piece, { maxLength: 8 }).map((p) => p.join('')),
          { maxLength: 6 },
        ),
        (lines) => {
          // A line ending in a backslash continues on the next; the old expression is the reference
          // for single lines only. A stanza header would start a second stanza, and this comparison
          // reads the first one.
          const text = lines.filter((l) => !/\\\r?$/.test(l) && !/^\s*\[(.+)\]\s*$/.test(l)).join('\n');
          // A later key overrides an earlier one in both.
          const expected = new Map(old(text));
          expect(new Map(now(text))).toEqual(expected);
        },
      ),
      { numRuns: 2000 },
    );
    // Edge cases written out.
    expect([...(parseConf('  a  =  b  \n')[0]?.values ?? [])]).toEqual([['a', 'b']]);
    expect(parseConf('=x\n#a=b\n[a]=b\n')).toEqual([]);
    expect([...(parseConf('a =\u2028b\n')[0]?.values ?? [])]).toEqual([['a', 'b']]);
    expect(parseConf('a = x\ry\n')).toEqual([]);
  });

  it('names 40,000 files with one name quickly and the same way as before (over 40 s before)', () => {
    const taken = new Set<string>();
    const { value: names, ms } = timed(() => Array.from({ length: 40_000 }, () => safeFileName('x', taken)));
    expect(ms).toBeLessThan(2000);
    expect(names.slice(0, 3)).toEqual(['x', 'x-2', 'x-3']);
    expect(names[39_999]).toBe('x-40000');
    // A name that is already taken by another file is skipped, as before.
    const t2 = new Set<string>();
    expect(['x', 'x-2', 'X', 'x'].map((n) => safeFileName(n, t2))).toEqual(['x', 'x-2', 'X-3', 'x-4']);
  });

  it('gives 8,000 variables that share a long prefix their keys quickly (2.4 s before)', () => {
    const pre = 'p'.repeat(70);
    const spl = `index=a ${Array.from({ length: 8000 }, (_, i) => `f=$${pre}${i}$`).join(' OR ')}`;
    const { ms } = timed(() =>
      convertDashboard({ format: 'simple-xml', title: 'T', inputs: [], panels: [{ kind: 'table', title: 'x', dropped: [], search: { spl } }], dropped: [] }),
    );
    expect(ms).toBeLessThan(2000);
    const c = convertDashboard({
      format: 'simple-xml',
      title: 'T',
      inputs: [],
      panels: [{ kind: 'table', title: 'x', dropped: [], search: { spl: `index=a f=$${pre}a$ g=$${pre}b$ h=$${pre}c$ | table f` } }],
      dropped: [],
    });
    expect(c.variables.map((v) => v.key)).toEqual([pre.slice(0, 60), `${pre.slice(0, 60)}_2`, `${pre.slice(0, 60)}_3`]);
  });

  it('reads "from datamodel" followed by 80,000 blanks at once (2.4 s before)', () => {
    const { value: r, ms } = timed(() => translate(`| from datamodel${' '.repeat(80_000)}!`));
    expect(ms).toBeLessThan(500);
    expect(codes(r)).toContain('SPL4006');
    for (const spl of ['| from datamodel:Web.Web', '| from datamodel  Web.Web', '| from datamodel : "Web.Web" ', '| from  datamodel:Web.Web']) {
      expect(codes(translate(spl))).toContain('SPL4008');
    }
  });

  it('keeps at most 10,000 notes per translation and says so once (finding 11)', () => {
    // The review's search: 527 KB, 4,051 stages, 245,055 notes, 5.1 s.
    const sub = `[search index=b ${'|x'.repeat(4900)}]`;
    const spl = `index=a ${'| head 1 '.repeat(4000)}${`| join h ${sub}`.repeat(50)}`;
    const { value: r, ms } = timed(() => translate(spl));
    expect(ms).toBeLessThan(3000);
    expect(r.stages).toHaveLength(4051);
    expect(r.diagnostics).toHaveLength(MAX_DIAGNOSTICS + 1);
    expect(r.diagnostics.filter((d) => d.message.includes('notes; the rest were left out'))).toHaveLength(1);
    expect(r.confidence).toBe('low');
  });
});

describe('macro arguments (finding 15)', () => {
  it('refuses an expansion by its computed length before building it', () => {
    const m = parseMappingConfig({ version: 1, macros: { 'm(1)': { args: ['a'], definition: '$a$'.repeat(2500) } } });
    if (!m.ok) throw new Error('mapping');
    // 2,500 × 300,000 characters would be 750 M characters: an internal error (SPL1008) before.
    const { value: r, ms } = timed(() => translate(`index=a \`m(${'q'.repeat(300_000)})\``, { mapping: m.value }));
    expect(ms).toBeLessThan(2000);
    expect(codes(r)).toEqual(['SPL1006']);
    expect(translate('index=a `m(x)`', { mapping: m.value }).dql).toContain('xxx');
  });
});

describe('Markdown tiles treat Splunk text as data (finding 7)', () => {
  const panelXml = (inner: string): string => `<dashboard><row><panel><html>${inner}</html></panel></row></dashboard>`;
  const content = (c: ReturnType<typeof convertDashboardSource>, i = 0): string => (c.dashboard.content.tiles[String(i)] as { content: string }).content;

  it('keeps text nodes of an <html> panel from becoming links, images or tags', () => {
    const c = convertDashboardSource({
      name: 'a.xml',
      text: panelXml(
        '<p><a href="https://ok.example/x">docs](javascript:alert(1)) [more</a> &lt;img src=x onerror=alert(3)&gt; ![i](https://evil.example/t.png)</p>',
      ),
    });
    const md = content(c);
    expect(md).not.toMatch(/(?<!\\)\]\(javascript:/);
    expect(md).not.toMatch(/(?<!\\)<img/);
    expect(md).not.toMatch(/(?<!\\)!\[/);
    expect(md).toContain('(https://ok.example/x)');
    expect(md).toContain('&lt;img src=x onerror=alert&#40;3&#41;&gt;');
  });

  it('escapes titles, saved-search names and reasons in a manual tile', () => {
    const c = convertDashboard({
      format: 'simple-xml',
      title: 'T',
      inputs: [],
      panels: [{ kind: 'table', title: '# Hi [x](javascript:y) <b>', savedSearch: 'S](javascript:z) ![a](https://evil.example/p.png)', dropped: [] }],
      dropped: [],
    });
    const md = content(c);
    expect(md.startsWith('### \\# Hi &#91;x&#93;&#40;javascript:y&#41; &lt;b&gt;')).toBe(true);
    expect(md).not.toMatch(/(?<!\\)\]\(javascript/);
    expect(md).not.toMatch(/(?<!\\)!\[/);
  });

  it('keeps every line of a code block inside it, whatever the line ending', () => {
    for (const end of ['\r', '\n', '\r\n', '\u2028', '\u2029', '\u0085']) {
      const block = codeBlock(`index=a | foo${end}[click](https://evil.example)`);
      expect(block.split('\n').every((l) => l.startsWith('    '))).toBe(true);
    }
    expect(codeBlock('a\u0000b\u001b[2Jc\td')).toBe('    ab[2Jc\td');
    const c = convertDashboardSource({
      name: 'a.xml',
      text: '<dashboard><row><panel><table><search><query>index=a | foo&#13;[click](https://evil.example)</query></search></table></panel></row></dashboard>',
    });
    const md = content(c);
    expect(md).not.toMatch(/\r/);
    expect(
      md
        .split('\n')
        .filter((l) => l.includes('[click]'))
        .every((l) => l.startsWith('    ')),
    ).toBe(true);
  });

  it('rebuilds Studio Markdown and treats the description as plain text', () => {
    const c = convertDashboardSource({
      name: 'a.json',
      text: JSON.stringify({
        description: 'Desc ![t](https://evil.example/t.png) <img src=x>',
        visualizations: { m: { type: 'splunk.markdown', options: { markdown: '[a](javascript:b) **bold**' } } },
        dataSources: {},
        layout: { structure: [{ item: 'm', type: 'block', position: { x: 0, y: 0, w: 100, h: 50 } }] },
      }),
    });
    expect(content(c, 0)).toBe('Desc !&#91;t&#93;&#40;https\\://evil.example/t.png&#41; &lt;img src=x&gt;');
    expect(content(c, 1)).toBe('a **bold**');
  });

  it('leaves ordinary text readable', () => {
    expect(escapeText('Error rate % by host_name, last 24 h. See #ops!')).toBe('Error rate % by host_name, last 24 h. See #ops\\!');
    expect(escapeText('1. not a list')).toBe('1\\. not a list');
    expect(escapeText('- dash')).toBe('\\- dash');
    expect(escapeText('_x_ *y* a|b `c` R&D &amp;')).toBe('\\_x\\_ \\*y\\* a\\|b &#96;c&#96; R&amp;D &amp;amp;');
    expect(escapeText('title ##')).toBe('title \\#\\#');
  });
});

describe('field names DQL cannot hold (finding 8)', () => {
  it('never prints a backtick, CR or LF inside a field name', () => {
    for (const name of ['a`b', 'a\rb', 'a\nb']) {
      for (const spl of [
        `index=a | rename x AS "${name}"`,
        `index=a | stats count by "${name}"`,
        `index=a | eval "${name}" = 1`,
        `index=a | fields "${name}"`,
      ]) {
        const r = translate(spl);
        expect(r.dql, spl).not.toMatch(/\\`/);
        expect(
          r.dql.split('\n').every((l) => l.startsWith('fetch') || l.startsWith('| ') || l.startsWith('// ')),
          spl,
        ).toBe(true);
        expect(r.stages[1]?.status, spl).toBe('untranslated');
        expect(codes(r), spl).toContain('SPL2012');
      }
    }
  });

  it('still writes other unusual names in backticks', () => {
    expect(translate('index=a | rename x AS "a b"').dql).toContain('fieldsRename `a b` = x');
  });
});
