import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION as CORE_VERSION } from '@spl2dql/core';
import { describe, expect, it } from 'vitest';
import { type CliIO, run } from '../src/main.ts';

/** The version in a workspace package's package.json. */
function packageVersion(dir: string): string {
  const file = fileURLToPath(new URL(`../../../${dir}/package.json`, import.meta.url));
  return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version;
}

function io(opts: { stdin?: string; env?: Record<string, string>; cwd?: string } = {}) {
  let out = '';
  let err = '';
  const value: CliIO = {
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: (s: string) => (err += s) },
    stdin: (async function* () {
      if (opts.stdin !== undefined) yield opts.stdin;
    })(),
    env: opts.env ?? {},
    cwd: opts.cwd ?? process.cwd(),
    now: () => new Date('2026-11-14T12:00:00Z'),
  };
  return { value, out: () => out, err: () => err };
}

const tmp = (): string => mkdtempSync(join(tmpdir(), 'spl2dql-'));

const MAPPING = `version: 1
indexes:
  web:
    buckets: [web_logs]
fields:
  status: http.status
fieldTypes:
  http.status: number
`;

describe('translate', () => {
  it('reads standard input and prints only DQL on stdout', async () => {
    const t = io({ stdin: 'index=web | stats count by host' });
    expect(await run(['translate'], t.value)).toBe(0);
    expect(t.out()).toBe('fetch logs\n| filter isNotNull(host.name)\n| summarize count = count(), by:{host.name}\n');
    expect(t.err()).toContain('SPL4001');
  });

  it('uses a mapping file and prints JSON', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'm.yaml'), MAPPING);
    writeFileSync(join(dir, 'q.spl'), 'index=web status>=500');
    const t = io({ cwd: dir });
    expect(await run(['translate', 'q.spl', '-m', 'm.yaml', '-o', 'json'], t.value)).toBe(0);
    const json = JSON.parse(t.out());
    expect(json.dql).toBe('fetch logs, bucket:{"web_logs"}\n| filter http.status >= 500');
    expect(json.confidence).toBe('high');
  });

  it('picks up spl2dql.mapping.yaml from the working directory', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'spl2dql.mapping.yaml'), MAPPING);
    const t = io({ cwd: dir, stdin: 'index=web' });
    await run(['translate'], t.value);
    expect(t.out()).toContain('bucket:{"web_logs"}');
  });

  it('exits 1 with --fail-on when confidence is too low', async () => {
    const t = io({ stdin: 'index=web | iplocation ip' });
    expect(await run(['translate', '--fail-on', 'low'], t.value)).toBe(1);
  });

  it('exits 2 for a bad mapping file and lists the problems', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'm.yaml'), 'version: 1\nindexes:\n  web:\n    buckets: ["bad bucket"]\nnope: 1\n');
    const t = io({ cwd: dir, stdin: 'index=web' });
    expect(await run(['translate', '-m', 'm.yaml'], t.value)).toBe(2);
    expect(t.err()).toContain('/indexes/web/buckets/0');
    expect(t.err()).toContain('/nope');
  });

  it('refuses YAML alias bombs', async () => {
    const dir = tmp();
    const bomb = `a: &a ["x","x","x","x","x","x","x","x","x"]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]\ne: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]\nf: [*e,*e,*e,*e,*e,*e,*e,*e,*e]\n`;
    writeFileSync(join(dir, 'm.yaml'), bomb);
    const t = io({ cwd: dir, stdin: 'index=web' });
    expect(await run(['translate', '-m', 'm.yaml'], t.value)).toBe(2);
  });

  it('has no online options or commands in this release', async () => {
    const a = io({ stdin: 'index=web', env: { DT_ENVIRONMENT: 'https://x.apps.dynatrace.com', DT_PLATFORM_TOKEN: 't', AI_API_KEY: 'k' } });
    expect(await run(['translate', '--verify'], a.value)).toBe(2);
    expect(a.err()).toContain("unknown option '--verify'");
    expect(await run(['translate', '--ai'], io({ stdin: 'index=web' }).value)).toBe(2);
    expect(await run(['verify'], io({ stdin: 'fetch logs' }).value)).toBe(2);
  });
});

describe('batch', () => {
  it('translates a folder, savedsearches.conf and a CSV, and writes reports', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'in'));
    writeFileSync(join(dir, 'in', 'errors.spl'), 'index=web error | stats count by host');
    writeFileSync(join(dir, 'in', 'ignored.md'), 'not a search');
    writeFileSync(
      join(dir, 'savedsearches.conf'),
      '[Daily errors]\nsearch = index=web error \\\n| stats count\n\n[../../escape attempt]\nsearch = index=web\n',
    );
    writeFileSync(join(dir, 'list.csv'), 'name,search\n"top <hosts>","index=web | top host"\nquoted,"index=web ""a b"""\n');
    const t = io({ cwd: dir });
    const code = await run(['batch', 'in', 'savedsearches.conf', 'list.csv', '--out', 'out'], t.value);
    expect(code).toBe(0);
    const files = readdirSync(join(dir, 'out')).sort();
    expect(files).toEqual(['Daily_errors.dql', 'errors.dql', 'escape_attempt.dql', 'quoted.dql', 'report.html', 'report.json', 'top_hosts_.dql']);
    expect(readFileSync(join(dir, 'out', 'Daily_errors.dql'), 'utf8')).toContain('summarize count = count()');
    const report = JSON.parse(readFileSync(join(dir, 'out', 'report.json'), 'utf8'));
    expect(report.searches).toHaveLength(5);
    expect(report.generated).toBe('2026-11-14T12:00:00.000Z');
    expect(t.err()).toContain('5 searches');
  });

  it('writes an HTML report with no scripts and escaped content', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'x.spl'), 'index=web "<script>alert(1)</script>" | eval a="</pre><img src=x onerror=alert(1)>"');
    const t = io({ cwd: dir });
    await run(['batch', 'x.spl', '--out', 'out', '--report', 'html'], t.value);
    const html = readFileSync(join(dir, 'out', 'report.html'), 'utf8');
    expect(html).toContain('not affiliated with, endorsed by or supported by Splunk Inc., Cisco or Dynatrace');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Content-Security-Policy" content="default-src \'none\'');
  });

  it('redacts values in reports', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'x.spl'), 'index=web user="alice@example.com" src=10.1.2.3 "secret phrase"');
    const t = io({ cwd: dir });
    await run(['batch', 'x.spl', '--out', 'out', '--report', 'json', '--redact'], t.value);
    const json = readFileSync(join(dir, 'out', 'report.json'), 'utf8');
    expect(json).not.toMatch(/alice|10\.1\.2\.3|secret phrase/);
  });

  it('refuses to write through a symbolic link in the output directory', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'out'));
    writeFileSync(join(dir, 'victim.txt'), 'keep me');
    symlinkSync(join(dir, 'victim.txt'), join(dir, 'out', 'q.dql'));
    writeFileSync(join(dir, 'q.spl'), 'index=web');
    const t = io({ cwd: dir });
    expect(await run(['batch', 'q.spl', '--out', 'out'], t.value)).toBe(2);
    expect(readFileSync(join(dir, 'victim.txt'), 'utf8')).toBe('keep me');
  });

  it('does not follow symbolic links while walking directories', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'in'));
    mkdirSync(join(dir, 'secret'));
    writeFileSync(join(dir, 'secret', 'hidden.spl'), 'index=secret');
    symlinkSync(join(dir, 'secret'), join(dir, 'in', 'link'));
    writeFileSync(join(dir, 'in', 'a.spl'), 'index=web');
    const t = io({ cwd: dir });
    await run(['batch', 'in', '--out', 'out', '--report', 'json'], t.value);
    expect(readdirSync(join(dir, 'out')).sort()).toEqual(['a.dql', 'report.json']);
  });

  it('reports an empty input as a usage error', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'empty'));
    const t = io({ cwd: dir });
    expect(await run(['batch', 'empty', '--out', 'out'], t.value)).toBe(2);
  });
});

describe('mapping, commands, explain', () => {
  it('writes a mapping skeleton for unresolved names', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.spl'), 'index=web sourcetype=access `errs` | lookup geo ip OUTPUT city | stats count by uri');
    const t = io({ cwd: dir });
    expect(await run(['mapping', 'init', 'a.spl'], t.value)).toBe(0);
    expect(t.out()).toContain('indexes:\n  web:');
    expect(t.out()).toContain('sourcetypes:\n  access:');
    expect(t.out()).toContain('errs:');
    expect(t.out()).toContain('path: /lookups/geo');
    expect(t.out()).toContain('uri: uri');
  });

  it('checks a mapping file', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'ok.yaml'), MAPPING);
    expect(await run(['mapping', 'check', 'ok.yaml'], io({ cwd: dir }).value)).toBe(0);
  });

  it('prints the support matrix and explains codes', async () => {
    const a = io();
    await run(['commands', '-o', 'json'], a.value);
    expect(JSON.parse(a.out()).some((c: { name: string }) => c.name === 'stats')).toBe(true);
    const b = io();
    expect(await run(['explain', 'spl3001'], b.value)).toBe(0);
    expect(b.out()).toContain('Case sensitivity');
    expect(await run(['explain', 'nope'], io().value)).toBe(2);
  });

  it('carries one version number everywhere', () => {
    // A release sets the number in four package.json files and two constants; none may lag behind.
    const version = packageVersion('packages/cli');
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const dir of ['packages/core', 'apps/web', 'packages/conformance']) expect(packageVersion(dir), dir).toBe(version);
    expect(CORE_VERSION).toBe(version);
  });

  it('shows help and version', async () => {
    const h = io();
    expect(await run(['--help'], h.value)).toBe(0);
    expect(h.out()).toContain('translate');
    const v = io();
    expect(await run(['--version'], v.value)).toBe(0);
    expect(v.out().trim()).toBe(packageVersion('packages/cli'));
    expect(await run(['nonsense'], io().value)).toBe(2);
  });
});

describe('a whole Splunk app: saved searches, dashboards and configuration files', () => {
  const app = fileURLToPath(new URL('../../../examples/splunk-app', import.meta.url));

  it('batch translates the searches, converts the dashboards and uses the .conf files', async () => {
    const dir = tmp();
    const t = io({ cwd: dir });
    expect(await run(['batch', app, '--out', 'out', '-q'], t.value)).toBe(0);
    expect(t.err()).toContain('Using 3 macro(s), 8 field extraction(s), 2 eventtype(s), 3 tag(s) from the Splunk configuration files.');
    expect(t.err()).toContain('2 definition(s) could not be carried over');
    expect(t.err()).toContain('9 searches');
    expect(t.err()).toContain('2 dashboards');
    expect(t.err()).toContain('11 panels converted, 1 need manual work');
    expect(readdirSync(join(dir, 'out', 'dashboards')).sort()).toEqual(['Security_posture.json', 'Web_overview.json']);
    expect(readdirSync(join(dir, 'out')).filter((f) => f.endsWith('.dql'))).toHaveLength(9);

    // The saved time range of each search is in its DQL; a macro and an extraction came from the .conf files.
    const slow = readFileSync(join(dir, 'out', 'Web_-_slow_requests.dql'), 'utf8');
    expect(slow.split('\n')[0]).toBe('fetch logs, from:-60m@m');
    expect(slow).toContain(`parse content, "DATA? 'duration=' LONG:'duration_ms'"`);
    expect(readFileSync(join(dir, 'out', 'Auth_-_failed_SSH_logins_by_source.dql'), 'utf8')).toContain('preserveFieldsOnFailure:true');

    const report = JSON.parse(readFileSync(join(dir, 'out', 'report.json'), 'utf8'));
    expect(report.searches.find((s: { name: string }) => s.name === 'Web - slow requests')).toMatchObject({
      earliest: '-60m@m',
      latest: 'now',
      schedule: '*/15 * * * *',
    });
    expect(report.searches.find((s: { name: string }) => s.name === 'Old weekly report').disabled).toBe(true);
    expect(report.dashboards.map((d: { title: string; tiles: unknown }) => [d.title, d.tiles])).toEqual([
      ['Security posture', { live: 5, manual: 0, text: 2 }],
      ['Web overview', { live: 6, manual: 1, text: 2 }],
    ]);
    // The dashboard panel that runs a saved search found it in savedsearches.conf.
    const web = JSON.parse(readFileSync(join(dir, 'out', 'dashboards', 'Web_overview.json'), 'utf8'));
    const slowTile = Object.values(web.content.tiles as Record<string, { title?: string; query?: string }>).find((x) => x.title === 'Slow requests');
    expect(slowTile?.query).toContain('from:-60m@m');

    const html = readFileSync(join(dir, 'out', 'report.html'), 'utf8');
    expect(html).toContain('<h2>Dashboards</h2>');
    expect(html).toContain('Needs manual work');
    expect(html).toContain('Time range -60m@m to now');
    expect(html).not.toMatch(/<script/i);
  });

  it('the mapping file wins over the .conf files, and --earliest over the saved range', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'm.yaml'), 'version: 1\nmacros:\n  web_index:\n    definition: index=mine\nindexes:\n  mine:\n    buckets: [mine_logs]\n');
    const t = io({ cwd: dir });
    expect(await run(['batch', join(app, 'default'), '--out', 'out', '-q', '-m', 'm.yaml', '--earliest', '-7d', '--skip-disabled'], t.value)).toBe(0);
    expect(readFileSync(join(dir, 'out', 'Web_-_slow_requests.dql'), 'utf8').split('\n')[0]).toBe('fetch logs, bucket:{"mine_logs"}, from:-7d');
    expect(readdirSync(join(dir, 'out')).filter((f) => f.endsWith('.dql'))).toHaveLength(8);
  });

  it('dashboard prints one Dynatrace dashboard, and writes several with --out', async () => {
    const one = io();
    expect(await run(['dashboard', join(app, 'default/data/ui/views/web_overview.xml'), join(app, 'default/macros.conf')], one.value)).toBe(0);
    const json = JSON.parse(one.out());
    expect(json).toMatchObject({ name: 'Web overview', type: 'dashboard' });
    expect(json.content.variables.map((v: { key: string }) => v.key)).toEqual(['host_tok', 'status_tok', 'uri_tok']);
    expect(one.err()).toContain('Web overview: 5 panels converted, 2 need manual work, 2 text; 3 variable(s)');
    expect(one.err()).toContain('Session length: transaction with options has no DQL equivalent.');

    const many = io();
    expect(await run(['dashboard', app], many.value)).toBe(2);
    expect(many.err()).toContain('2 dashboards found; give --out <dir>');

    const dir = tmp();
    const out = io({ cwd: dir });
    expect(await run(['dashboard', app, '--out', 'd', '-q'], out.value)).toBe(0);
    expect(readdirSync(join(dir, 'd')).sort()).toEqual(['Security_posture.json', 'Web_overview.json']);
    expect(out.out()).toBe('');
  });

  it('dashboard refuses a file that is not one', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'nav.xml'), '<nav><collection label="x"/></nav>');
    writeFileSync(join(dir, 'broken.xml'), '<dashboard><row>');
    const a = io({ cwd: dir });
    expect(await run(['dashboard', 'nav.xml'], a.value)).toBe(2);
    expect(a.err()).toContain('is not a Splunk dashboard');
    const b = io({ cwd: dir });
    expect(await run(['dashboard', 'broken.xml'], b.value)).toBe(2);
    expect(b.err()).toContain('is not closed');
    const c = io({ cwd: dir });
    expect(await run(['dashboard', dir], c.value)).toBe(2);
  });

  it('mapping init writes a skeleton that is itself a valid mapping, filled from the .conf files', async () => {
    const dir = tmp();
    const t = io({ cwd: dir });
    expect(await run(['mapping', 'init', app], t.value)).toBe(0);
    const text = t.out();
    expect(text).toContain('# Read from Splunk configuration files: 3 macro(s), 8 extraction(s), 2 eventtype(s), 3 tag(s).');
    expect(text).toContain('#   macros business_hours: It is an eval-based macro');
    expect(text).toContain('security_content_ctime(1):');
    expect(text).toMatch(/datamodels:\n {2}Authentication:\n {4}dataObject: logs\n {4}filter: "true"\n {4}fields:\n {6}action: action/);
    expect(text).toContain('Endpoint.Processes:');
    writeFileSync(join(dir, 'skeleton.yaml'), text);
    const check = io({ cwd: dir });
    expect(await run(['mapping', 'check', 'skeleton.yaml'], check.value)).toBe(0);
    // With the skeleton in place nothing the .conf files define is still missing.
    const again = io({ cwd: dir });
    expect(await run(['mapping', 'init', join(app, 'default/savedsearches.conf'), '-m', 'skeleton.yaml'], again.value)).toBe(0);
    expect(again.out()).not.toContain('macros:');
  });
});

describe('security review regressions', () => {
  it('strips terminal escape sequences from everything it prints (finding 7)', async () => {
    const t = io({ stdin: 'index=web "\u001b]52;c;cHduZWQ=\u0007" | iplocation \u001b[2J' });
    await run(['translate', '-o', 'pretty'], t.value);
    expect(t.out() + t.err()).not.toMatch(/\u001b\]|\u0007|\u001b\[2J/);
  });

  it('replaces a hard-linked output file instead of writing through it', async () => {
    const { linkSync } = await import('node:fs');
    const dir = tmp();
    mkdirSync(join(dir, 'out'));
    writeFileSync(join(dir, 'victim.txt'), 'keep me');
    linkSync(join(dir, 'victim.txt'), join(dir, 'out', 'q.dql'));
    writeFileSync(join(dir, 'q.spl'), 'index=web');
    expect(await run(['batch', 'q.spl', '--out', 'out', '--report', 'json'], io({ cwd: dir }).value)).toBe(0);
    expect(readFileSync(join(dir, 'victim.txt'), 'utf8')).toBe('keep me');
    expect(readFileSync(join(dir, 'out', 'q.dql'), 'utf8')).toContain('fetch logs');
  });
});

describe('the published binary', () => {
  const bin = join(import.meta.dirname, '..', 'bin', 'spl2dql.js');
  const built = existsSync(join(import.meta.dirname, '..', 'dist', 'main.js'));

  // Needs a POSIX shell and `head`; Windows has neither by default.
  it.skipIf(!built || process.platform === 'win32')('stops quietly when the reader closes the pipe early (spl2dql commands | head)', () => {
    const r = spawnSync('/bin/sh', ['-c', `"${process.execPath}" "${bin}" commands | head -n 1`], { encoding: 'utf8' });
    expect(r.stdout.split('\n')[0]).toMatch(/^abstract\s/);
    expect(r.stderr).not.toContain('EPIPE');
    expect(r.stderr).not.toContain('Unhandled');
  });
});
