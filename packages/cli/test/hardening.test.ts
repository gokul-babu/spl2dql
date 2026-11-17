/**
 * Launch hardening (ADR-029), CLI side: one test per finding of the security review of 2026-11-16.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { InputError, readInputs } from '../src/inputs.ts';
import { type CliIO, run, safeText } from '../src/main.ts';
import { loadMappingFile, MappingError } from '../src/mapping.ts';
import { redact } from '../src/report.ts';
import { FileRefused, readRegularFile, writeInside } from '../src/safe-fs.ts';

function io(opts: { stdin?: string; cwd?: string; tty?: boolean; maxRunOutput?: number; maxRunWork?: number; maxReportDetail?: number } = {}) {
  let out = '';
  let err = '';
  const value: CliIO = {
    stdout: { write: (s: string) => (out += s), isTTY: opts.tty ?? false },
    stderr: { write: (s: string) => (err += s), isTTY: opts.tty ?? false },
    stdin: (async function* () {
      if (opts.stdin !== undefined) yield opts.stdin;
    })(),
    env: {},
    cwd: opts.cwd ?? process.cwd(),
    now: () => new Date('2026-11-14T12:00:00Z'),
  };
  if (opts.maxRunOutput !== undefined) value.maxRunOutput = opts.maxRunOutput;
  if (opts.maxRunWork !== undefined) value.maxRunWork = opts.maxRunWork;
  if (opts.maxReportDetail !== undefined) value.maxReportDetail = opts.maxReportDetail;
  return { value, out: () => out, err: () => err };
}

const tmp = (): string => mkdtempSync(join(tmpdir(), 'spl2dql-'));

describe('output folder (finding 10)', () => {
  it('refuses to write through a folder that is a symbolic link out of the output folder', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'out'));
    mkdirSync(join(dir, 'elsewhere'));
    symlinkSync(join(dir, 'elsewhere'), join(dir, 'out', 'dashboards'));
    expect(() => writeInside(join(dir, 'out'), 'dashboards/x.json', '{}')).toThrow(/symbolic link that leads outside the output folder/);
    expect(readdirSync(join(dir, 'elsewhere'))).toEqual([]);
  });

  it('creates nothing outside when a deeper folder would be created behind the link', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'out'));
    mkdirSync(join(dir, 'elsewhere'));
    symlinkSync(join(dir, 'elsewhere'), join(dir, 'out', 'a'));
    expect(() => writeInside(join(dir, 'out'), 'a/b/c.json', '{}')).toThrow(/outside the output folder/);
    expect(existsSync(join(dir, 'elsewhere', 'b'))).toBe(false);
  });

  it('still writes into an ordinary sub-folder', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'out'));
    writeInside(join(dir, 'out'), 'dashboards/x.json', '{}');
    expect(readFileSync(join(dir, 'out', 'dashboards', 'x.json'), 'utf8')).toBe('{}');
  });

  it('batch stops with a plain message when out/dashboards leads elsewhere', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'out'));
    mkdirSync(join(dir, 'elsewhere'));
    symlinkSync(join(dir, 'elsewhere'), join(dir, 'out', 'dashboards'));
    writeFileSync(
      join(dir, 'd.xml'),
      '<dashboard><label>D</label><row><panel><table><search><query>index=a</query></search></table></panel></row></dashboard>',
    );
    const t = io({ cwd: dir });
    expect(await run(['batch', 'd.xml', '--out', 'out'], t.value)).toBe(2);
    expect(t.err()).toContain('symbolic link');
    expect(readdirSync(join(dir, 'elsewhere'))).toEqual([]);
  });
});

describe('input budget (finding 14)', () => {
  it('stops when the inputs together are larger than the budget', () => {
    const dir = tmp();
    for (let i = 0; i < 3; i++) writeFileSync(join(dir, `s${i}.spl`), 'x'.repeat(400));
    expect(() => readInputs([dir], dir, 1000)).toThrow(InputError);
    expect(() => readInputs([dir], dir, 1000)).toThrow(/larger than .* MB in total/);
    expect(readInputs([dir], dir, 1200).searches).toHaveLength(3);
  });
});

describe('note positions (finding 11)', () => {
  it('prints line and column of every note of a long search quickly', async () => {
    // The review's search: 197 KB took 10.7 s when every note rescanned the text.
    const sub = `[search index=b ${'|x\n'.repeat(4900)}]`;
    const spl = `index=a ${`| join h ${sub}\n`.repeat(14)}`;
    const t = io({ stdin: spl });
    const start = performance.now();
    await run(['translate'], t.value);
    expect(performance.now() - start).toBeLessThan(5000);
    const lines = t
      .err()
      .split('\n')
      .filter((l) => /SPL2001/.test(l));
    expect(lines.length).toBeGreaterThan(1000);
    // Positions are right: the first "x" ends line 1 (column 35), the next one starts line 2 ("|x").
    expect(lines[0]).toMatch(/^1:35 /);
    expect(lines[1]).toMatch(/^2:2 /);
  });
});

describe('terminal output (finding 16)', () => {
  it('removes colour escapes, lone carriage returns and bidirectional controls that come from the input', () => {
    const hostile = 'a\u001b[31mred\u001b[0m b\rc d\r\ne ‮evil‬ ⁦x⁩ \u001b]0;title\u0007 \u001b[2J \u001bc';
    const clean = safeText(hostile);
    expect(clean).not.toMatch(/\u001b|‮|‬|⁦|⁩|\u0007/);
    expect(clean).not.toMatch(/\r(?!\n)/);
    expect(clean).toContain('d\r\ne');
    expect(clean).toContain('ared b');
  });

  it('keeps its own colours but never one that came from the input', async () => {
    const t = io({ stdin: 'index=web | mycmd \u001b[32mgreen\u001b[0m', tty: true });
    await run(['translate'], t.value);
    // Only the CLI's own red/yellow tags, each closed, appear; the green from the search is gone.
    expect(t.err()).not.toContain('\u001b[32m');
    expect(t.err()).toContain('\u001b[33mnote\u001b[0m');
  });
});

describe('reports (finding 16)', () => {
  it('give paths relative to the input, never absolute ones', async () => {
    const dir = tmp();
    const app = join(dir, 'my_app');
    mkdirSync(join(app, 'default', 'data', 'ui', 'views'), { recursive: true });
    writeFileSync(join(app, 'default', 'savedsearches.conf'), '[Errors]\nsearch = index=web error\n');
    writeFileSync(
      join(app, 'default', 'data', 'ui', 'views', 'd.xml'),
      '<dashboard><label>D</label><row><panel><table><search><query>index=a</query></search></table></panel></row></dashboard>',
    );
    writeFileSync(join(dir, 'one.spl'), 'index=web');
    const t = io({ cwd: dir });
    await run(['batch', 'my_app', join(dir, 'one.spl'), '--out', 'out'], t.value);
    const json = readFileSync(join(dir, 'out', 'report.json'), 'utf8');
    const html = readFileSync(join(dir, 'out', 'report.html'), 'utf8');
    for (const text of [json, html]) expect(text).not.toContain(dir);
    const report = JSON.parse(json) as { searches: { origin: string }[]; dashboards: { origin: string }[] };
    expect(report.searches.map((s) => s.origin).sort()).toEqual(['my_app/default/savedsearches.conf › Errors', 'one.spl']);
    expect(report.dashboards.map((d) => d.origin)).toEqual(['my_app/default/data/ui/views/d.xml']);
  });
});

describe('redact (finding 16)', () => {
  // The expressions redact() used before; the quoted-string one is now a linear scan.
  const before = (text: string): string =>
    text
      .replace(/"((?:[^"\\]|\\.){0,4000})"/g, (_m, inner: string) => `"${'x'.repeat(inner.length)}"`)
      .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, (m) => m.replace(/\d/g, '0'))
      .replace(/\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}\b/g, (m) => 'x'.repeat(m.length));

  it('redacts exactly what it did before', () => {
    const piece = fc.constantFrom('"', '\\', 'a', ' ', '\n', '\r', '\u2028', 'b@c.de', '10.1.2.3', '\\"');
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 40 }), (parts) => {
        const text = parts.join('');
        expect(redact(text)).toBe(before(text));
      }),
      { numRuns: 3000 },
    );
    const long = `"${'a'.repeat(4000)}" "${'a'.repeat(4001)}"`;
    expect(redact(long)).toBe(before(long));
  });

  it('is fast on text full of escaped quotes (1.4 s per 400 KB before)', () => {
    const text = `"${'\\"'.repeat(2_000_000)}`;
    const start = performance.now();
    redact(text);
    expect(performance.now() - start).toBeLessThan(1500);
  });
});

// ---------------------------------------------------------------------------------------------------
// Second round (ADR-029, re-test of 2026-11-17)

/** A search whose DQL is large (the re-tester's batch inputs, scaled down for a test). */
const bigSearch = (i: number, n = 400): string => `index=a | eval ${Array.from({ length: n }, (_, j) => `x${j}=f${i}_${j}+1`).join(', ')}`;

describe('run budget (re-test finding 3)', () => {
  it('stops before writing past the budget, keeps what was written, and says so in the report', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'savedsearches.conf'), Array.from({ length: 40 }, (_, i) => `[s${i}]\nsearch = ${bigSearch(i)}\n`).join(''));
    const t = io({ cwd: dir, maxRunOutput: 100_000 });
    expect(await run(['batch', 'savedsearches.conf', '--out', 'out', '-q'], t.value)).toBe(2);
    expect(t.err()).toMatch(/The run was cut short: It would write more than/);
    const files = readdirSync(join(dir, 'out')).filter((f) => f.endsWith('.dql'));
    expect(files.length).toBeGreaterThan(0);
    expect(files.length).toBeLessThan(40);
    const total = files.reduce((n, f) => n + readFileSync(join(dir, 'out', f), 'utf8').length, 0);
    expect(total).toBeLessThanOrEqual(100_000);
    for (const f of files) expect(readFileSync(join(dir, 'out', f), 'utf8').endsWith('\n')).toBe(true);
    const report = JSON.parse(readFileSync(join(dir, 'out', 'report.json'), 'utf8')) as { cutShort?: string; searches: unknown[] };
    expect(report.cutShort).toMatch(/more than/);
    expect(report.searches).toHaveLength(files.length);
    expect(readFileSync(join(dir, 'out', 'report.html'), 'utf8')).toContain('This run was cut short.');
  });

  it('shows at most 20,000 characters of one query in a report and says where the rest is', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'big.spl'), bigSearch(0, 1500));
    const t = io({ cwd: dir });
    await run(['batch', 'big.spl', '--out', 'out', '-q'], t.value);
    const dql = readFileSync(join(dir, 'out', 'big.dql'), 'utf8');
    expect(dql.length).toBeGreaterThan(20_000);
    const report = JSON.parse(readFileSync(join(dir, 'out', 'report.json'), 'utf8')) as { searches: { dql: string }[] };
    const shownDql = report.searches[0]?.dql ?? '';
    expect(shownDql.length).toBeLessThan(20_200);
    expect(shownDql).toMatch(/more characters; the full text is in big\.dql\.$/);
  });
});

describe('one bad file never ends a run (re-test finding 5)', () => {
  const good = '<dashboard><label>Good</label><row><panel><table><search><query>index=a | stats count</query></search></table></panel></row></dashboard>';

  it('dashboard <folder> skips a malformed dashboard with a note and converts the rest', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'views'));
    writeFileSync(join(dir, 'views', 'bad.xml'), '<dashboard><row><');
    writeFileSync(join(dir, 'views', 'good.xml'), good);
    writeFileSync(join(dir, 'views', 'odd.json'), '{"visualizations":{"a":{"type":{"toString":1}}},"dataSources":{}}');
    const t = io({ cwd: dir });
    expect(await run(['dashboard', 'views', '--out', 'out'], t.value)).toBe(0);
    expect(t.err()).toMatch(/bad\.xml: .* It was skipped\./);
    expect(readdirSync(join(dir, 'out')).sort()).toEqual(['Good.json', 'odd.json']);
  });

  it('dashboard fails only when nothing could be converted', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'bad.xml'), '<dashboard><row><');
    const t = io({ cwd: dir });
    expect(await run(['dashboard', 'bad.xml'], t.value)).toBe(2);
  });

  it('mapping init writes a mapping that reads back, whatever the configuration files hold', async () => {
    const dir = tmp();
    const app = join(dir, 'app', 'default');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'props.conf'), '[s]\nEXTRACT-a = (?<f>x)(?:(?:(?:abcdefghijklmnopqrst){8}){8}){8}\nEXTRACT-b = id=(?<id>\\d+)\n');
    writeFileSync(join(app, 'tags.conf'), Array.from({ length: 10_050 }, (_, i) => `[host=h${i}]\nt${i} = enabled\n`).join(''));
    writeFileSync(join(app, 'macros.conf'), `[big]\ndefinition = ${'x'.repeat(10_001)}\n[ok]\ndefinition = index=a\n`);
    writeFileSync(join(app, 'savedsearches.conf'), `[s]\nsearch = index=a ${Array.from({ length: 50 }, (_, i) => `| eval "f\`${i}"=1`).join(' ')}\n`);
    const t = io({ cwd: dir });
    expect(await run(['mapping', 'init', 'app'], t.value)).toBe(0);
    writeFileSync(join(dir, 'skeleton.yaml'), t.out());
    const check = io({ cwd: dir });
    expect(await run(['mapping', 'check', 'skeleton.yaml'], check.value)).toBe(0);
  });
});

describe('writing a file (re-test finding 8)', () => {
  // Windows refuses to rename a folder that holds an open file, so the swap itself cannot happen there.
  it.skipIf(process.platform === 'win32')('writes nothing when the folder is swapped for a link between opening and writing', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'out', 'dashboards'), { recursive: true });
    mkdirSync(join(dir, 'elsewhere'));
    const swap = (): void => {
      renameSync(join(dir, 'out', 'dashboards'), join(dir, 'out', 'moved'));
      symlinkSync(join(dir, 'elsewhere'), join(dir, 'out', 'dashboards'));
    };
    expect(() => writeInside(join(dir, 'out'), 'dashboards/x.json', 'secret', swap)).toThrow(/changed while the file was being created; nothing was written/);
    expect(readFileSync(join(dir, 'out', 'moved', 'x.json'), 'utf8')).toBe('');
    expect(readdirSync(join(dir, 'elsewhere'))).toEqual([]);
  });

  it('writes nothing when the file it opened is not the one inside the output folder', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'out', 'dashboards'), { recursive: true });
    const replace = (): void => {
      renameSync(join(dir, 'out', 'dashboards', 'x.json'), join(dir, 'out', 'dashboards', 'y.json'));
      writeFileSync(join(dir, 'out', 'dashboards', 'x.json'), 'other');
    };
    expect(() => writeInside(join(dir, 'out'), 'dashboards/x.json', 'secret', replace)).toThrow(/nothing was written/);
    expect(readFileSync(join(dir, 'out', 'dashboards', 'y.json'), 'utf8')).toBe('');
  });
});

describe('the HTML report (re-test finding 11)', () => {
  it('keeps no control characters from names', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'savedsearches.conf'), '[bad\u001b[31m\u0007name]\nsearch = index=a\n');
    const t = io({ cwd: dir });
    await run(['batch', 'savedsearches.conf', '--out', 'out', '-q', '--report', 'html'], t.value);
    const html = readFileSync(join(dir, 'out', 'report.html'), 'utf8');
    expect(html).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(html).toContain('bad[31mname');
  });
});

// ---------------------------------------------------------------------------------------------------
// Third round (ADR-029, second re-test of 2026-11-17)

describe('run budget for work and for the report (re-test 2 finding D)', () => {
  it('charges SPL translated after macro expansion and stops with a plain message', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'macros.conf'), `[big]\ndefinition = index=a ${'x=1 '.repeat(2000)}\n`);
    writeFileSync(join(dir, 'savedsearches.conf'), Array.from({ length: 20 }, (_, i) => `[s${i}]\nsearch = \`big\`\n`).join(''));
    // Each 5-character search expands to about 8,000 characters: 5 fit in 40,000.
    const t = io({ cwd: dir, maxRunWork: 40_000 });
    expect(await run(['batch', '.', '--out', 'out', '-q'], t.value)).toBe(2);
    expect(t.err()).toMatch(/The run was cut short: It would translate more than/);
    expect(readdirSync(join(dir, 'out')).filter((f) => f.endsWith('.dql'))).toHaveLength(4);
    expect(JSON.parse(readFileSync(join(dir, 'out', 'report.json'), 'utf8')).cutShort).toMatch(/translate more than/);
  });

  it('counts a search that ends "too large" as the full input cap', async () => {
    const dir = tmp();
    const huge = `index=a ${'| eventstats count by host '.repeat(40)}`;
    writeFileSync(join(dir, 'savedsearches.conf'), `[a]\nsearch = ${huge}\n[b]\nsearch = ${huge}\n`);
    const t = io({ cwd: dir, maxRunWork: 1_000_500 });
    expect(await run(['batch', 'savedsearches.conf', '--out', 'out', '-q'], t.value)).toBe(2);
    expect(readdirSync(join(dir, 'out')).filter((f) => f.endsWith('.dql'))).toEqual(['a.dql']);
  });

  it('lists searches without detail once the report is large, and says so', async () => {
    const dir = tmp();
    writeFileSync(
      join(dir, 'savedsearches.conf'),
      Array.from({ length: 10 }, (_, i) => `[s${i}]\nsearch = index=a | eval ${'x=1, '.repeat(200)}y=${i}\n`).join(''),
    );
    const t = io({ cwd: dir, maxReportDetail: 10_000 });
    expect(await run(['batch', 'savedsearches.conf', '--out', 'out', '-q'], t.value)).toBe(0);
    const report = JSON.parse(readFileSync(join(dir, 'out', 'report.json'), 'utf8')) as {
      withoutDetail?: string;
      searches: { detail?: boolean; dql?: string }[];
    };
    expect(report.withoutDetail).toMatch(/search\(es\) and 0 dashboard\(s\) are listed without detail/);
    expect(report.searches.filter((x) => x.detail === false).length).toBeGreaterThan(0);
    expect(report.searches.filter((x) => x.dql !== undefined).length).toBeGreaterThan(0);
    expect(readFileSync(join(dir, 'out', 'report.html'), 'utf8')).toContain('Listed without detail');
  });

  it('ends with a plain message when the report cannot be written, and keeps the files', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.spl'), 'index=a');
    mkdirSync(join(dir, 'out', 'report.json'), { recursive: true });
    const t = io({ cwd: dir });
    expect(await run(['batch', 'a.spl', '--out', 'out', '-q'], t.value)).toBe(2);
    expect(t.err()).toMatch(/The report could not be written: .* The translated files are in /);
    expect(readFileSync(join(dir, 'out', 'a.dql'), 'utf8')).toContain('fetch logs');
  });
});

describe('unreadable files inside a folder (re-test 2 finding E)', () => {
  const canTest = process.platform !== 'win32' && process.getuid?.() !== 0;
  it.skipIf(!canTest)('skips a file and a folder that cannot be read, with a note', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'app', 'locked'), { recursive: true });
    writeFileSync(join(dir, 'app', 'ok.spl'), 'index=a');
    writeFileSync(join(dir, 'app', 'locked.spl'), 'index=b');
    writeFileSync(join(dir, 'app', 'locked', 'x.spl'), 'index=c');
    chmodSync(join(dir, 'app', 'locked.spl'), 0o000);
    chmodSync(join(dir, 'app', 'locked'), 0o000);
    try {
      const t = io({ cwd: dir });
      expect(await run(['batch', 'app', '--out', 'out', '-q'], t.value)).toBe(0);
      expect(t.err()).toContain('app/locked.spl could not be read (EACCES); it was skipped.');
      expect(t.err()).toContain('app/locked could not be read (EACCES); it was skipped.');
      expect(readdirSync(join(dir, 'out')).filter((f) => f.endsWith('.dql'))).toEqual(['ok.dql']);
      // Named on the command line, it is still an error.
      expect(await run(['batch', 'app/locked.spl', '--out', 'out2'], io({ cwd: dir }).value)).toBe(2);
    } finally {
      chmodSync(join(dir, 'app', 'locked.spl'), 0o644);
      chmodSync(join(dir, 'app', 'locked'), 0o755);
    }
  });
});

describe('reading through one handle (CodeQL js/file-system-race)', () => {
  const posix = process.platform !== 'win32';

  it('reads a regular file within the limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spl2dql-read-'));
    writeFileSync(join(dir, 'a.spl'), 'index=web');
    expect(readRegularFile(join(dir, 'a.spl'), 100).toString('utf8')).toBe('index=web');
  });

  it('refuses a file over the limit, checked on the open file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spl2dql-read-'));
    writeFileSync(join(dir, 'a.spl'), 'x'.repeat(101));
    expect(() => readRegularFile(join(dir, 'a.spl'), 100)).toThrow(FileRefused);
    expect(() => readRegularFile(join(dir, 'a.spl'), 100)).toThrow('too large');
  });

  it('refuses a folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spl2dql-read-'));
    mkdirSync(join(dir, 'sub'));
    expect(() => readRegularFile(join(dir, 'sub'), 100)).toThrow();
  });

  it.skipIf(!posix)('does not follow a symbolic link at the name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spl2dql-read-'));
    writeFileSync(join(dir, 'secret.txt'), 'secret');
    symlinkSync(join(dir, 'secret.txt'), join(dir, 'a.spl'));
    expect(() => readRegularFile(join(dir, 'a.spl'), 100)).toThrow();
  });

  it.skipIf(!posix)('the mapping file is not read through a symbolic link', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spl2dql-read-'));
    writeFileSync(join(dir, 'elsewhere.yaml'), 'version: 1\n');
    symlinkSync(join(dir, 'elsewhere.yaml'), join(dir, 'spl2dql.mapping.yaml'));
    expect(() => loadMappingFile(undefined, dir)).toThrow(MappingError);
    expect(() => loadMappingFile(undefined, dir)).toThrow('is not a regular file');
  });

  it('a mapping file that is not there is optional by default and an error when named', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spl2dql-read-'));
    expect(loadMappingFile(undefined, dir)).toBeUndefined();
    expect(() => loadMappingFile('missing.yaml', dir)).toThrow('Cannot read the mapping file');
  });
});
