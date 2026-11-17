/**
 * The gate a commit has to pass before it is published: `pnpm gate`.
 *
 * It runs every check the project has on the exact tree that would go out — secrets in the files
 * and in the whole history, known vulnerabilities, licences, the test suites, the built page's
 * security policy and the contents of the npm packages — and prints one line per check.
 * It changes nothing and publishes nothing.
 *
 *   pnpm gate            everything
 *   pnpm gate --quick    skips coverage and the browser tests
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const quick = process.argv.includes('--quick');

interface Outcome {
  name: string;
  state: 'pass' | 'fail' | 'skipped';
  detail: string;
}
const outcomes: Outcome[] = [];

function run(command: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function has(command: string): boolean {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

function plain(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function lastLine(text: string): string {
  const lines = plain(text).trim().split('\n');
  return (lines[lines.length - 1] ?? '').trim().slice(0, 110);
}

function check(name: string, body: () => Omit<Outcome, 'name'>): void {
  process.stdout.write(`  …  ${name}\r`);
  let outcome: Omit<Outcome, 'name'>;
  try {
    outcome = body();
  } catch (error) {
    outcome = { state: 'fail', detail: error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error) };
  }
  outcomes.push({ name, ...outcome });
  const mark = outcome.state === 'pass' ? 'PASS' : outcome.state === 'fail' ? 'FAIL' : 'SKIP';
  console.log(`${mark}  ${name.padEnd(46)} ${outcome.detail}`);
}

function command(name: string, cmd: string, args: string[]): void {
  check(name, () => {
    const { ok, output } = run(cmd, args);
    return { state: ok ? 'pass' : 'fail', detail: lastLine(output) };
  });
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

console.log(`spl2dql launch gate — ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()}\n`);

check('Everything is committed', () => {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
  return dirty === ''
    ? { state: 'pass', detail: 'clean tree' }
    : { state: 'fail', detail: `${dirty.split('\n').length} uncommitted file(s): the gate must run on what is published` };
});

check('No secrets in the files', () => {
  if (!has('gitleaks')) return { state: 'fail', detail: 'gitleaks is not installed' };
  const { ok, output } = run('gitleaks', ['dir', '.', '--redact', '--no-banner']);
  return { state: ok ? 'pass' : 'fail', detail: lastLine(output) };
});

check('No secrets anywhere in the history', () => {
  if (!has('gitleaks')) return { state: 'fail', detail: 'gitleaks is not installed' };
  const { ok, output } = run('gitleaks', ['git', '.', '--redact', '--no-banner']);
  const commits = execFileSync('git', ['rev-list', '--count', '--all'], { cwd: root, encoding: 'utf8' }).trim();
  return { state: ok ? 'pass' : 'fail', detail: `${lastLine(output)} (${commits} commit${commits === '1' ? '' : 's'})` };
});

check('No personal e-mail address in the history', () => {
  const emails = [...new Set(execFileSync('git', ['log', '--all', '--format=%ae%n%ce'], { cwd: root, encoding: 'utf8' }).trim().split('\n'))];
  const personal = emails.filter((email) => !/@users\.noreply\.github\.com$|^noreply@github\.com$/.test(email));
  return personal.length === 0
    ? { state: 'pass', detail: `${emails.length} address(es), all GitHub no-reply` }
    : { state: 'fail', detail: `${personal.length} address(es) that are not GitHub no-reply` };
});

check('Dependencies: no known vulnerabilities', () => {
  const { ok, output } = run('pnpm', ['audit']);
  return { state: ok ? 'pass' : 'fail', detail: lastLine(output) };
});

check('Dependencies: licences', () => {
  const { ok, output } = run('pnpm', ['licenses', 'list', '--json']);
  if (!ok) return { state: 'fail', detail: lastLine(output) };
  const byLicence = JSON.parse(output) as Record<string, unknown[]>;
  const bad = Object.keys(byLicence).filter((licence) => /GPL|SSPL|BUSL|unknown|unlicensed|proprietary/i.test(licence) && !/\bOR\b/.test(licence));
  const total = Object.values(byLicence).reduce((sum, list) => sum + list.length, 0);
  return bad.length === 0
    ? { state: 'pass', detail: `${total} packages: ${Object.keys(byLicence).sort().join(', ')}` }
    : { state: 'fail', detail: `not allowed: ${bad.join(', ')}` };
});

check('Build', () => {
  const { ok, output } = run('pnpm', ['build']);
  return { state: ok ? 'pass' : 'fail', detail: ok ? 'core, web app, command line' : lastLine(output) };
});
check('Types, lint, tests, boundaries, network scan', () => {
  const { ok, output } = run('pnpm', ['check']);
  const tests = /Tests\s+(\d+ passed) \((\d+)\)/.exec(plain(output));
  return { state: ok ? 'pass' : 'fail', detail: ok && tests ? `${tests[1]} of ${tests[2]} tests` : lastLine(output) };
});
if (quick) {
  outcomes.push({ name: 'Coverage and browser tests', state: 'skipped', detail: '--quick' });
  console.log(`SKIP  ${'Coverage and browser tests'.padEnd(46)} --quick`);
} else {
  check('Coverage thresholds', () => {
    const { ok, output } = run('pnpm', ['test:coverage']);
    const all = /All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*[\d.]+\s*\|\s*([\d.]+)/.exec(plain(output));
    return { state: ok ? 'pass' : 'fail', detail: ok && all ? `${all[3]} % of lines, ${all[2]} % of branches` : lastLine(output) };
  });
  check('Browser tests: offline, accessibility, server', () => {
    const { ok, output } = run('pnpm', ['test:e2e']);
    const passed = /(\d+) passed/.exec(plain(output));
    return { state: ok ? 'pass' : 'fail', detail: ok && passed ? `${passed[1]} passed` : lastLine(output) };
  });
}

check('Built page: security policy and no outside addresses', () => {
  const dist = join(root, 'apps/web/dist');
  if (!existsSync(join(dist, 'index.html'))) return { state: 'fail', detail: 'apps/web/dist is missing' };
  const problems: string[] = [];
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  for (const directive of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'none'"]) {
    if (!html.includes(directive)) problems.push(`index.html policy lacks ${directive}`);
  }
  if (/'unsafe-inline'|'unsafe-eval'/.test(html)) problems.push('the policy allows inline or evaluated code');
  const headers = existsSync(join(dist, '_headers')) ? readFileSync(join(dist, '_headers'), 'utf8') : '';
  for (const needed of ["frame-ancestors 'none'", 'X-Content-Type-Options: nosniff', 'Referrer-Policy: no-referrer']) {
    if (!headers.includes(needed)) problems.push(`_headers lacks ${needed}`);
  }
  const files = walk(dist);
  if (files.some((file) => file.endsWith('.map'))) problems.push('source maps are in the build');
  if (!files.some((file) => file.endsWith('THIRD-PARTY-NOTICES.txt'))) problems.push('THIRD-PARTY-NOTICES.txt is missing');
  // Scripts, styles, images and fonts must all come from the page's own origin.
  const loads =
    /<(?:script|img|iframe|source|video|audio|embed)\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\/|<link\b(?![^>]*\brel\s*=\s*["']?canonical)[^>]*\bhref\s*=\s*["']?(?:https?:)?\/\//i;
  for (const file of files.filter((name) => name.endsWith('.html'))) {
    if (loads.test(readFileSync(file, 'utf8'))) problems.push(`${file.slice(dist.length + 1)} loads something from another site`);
  }
  return problems.length === 0 ? { state: 'pass', detail: `${files.length} files` } : { state: 'fail', detail: problems.join('; ') };
});

command('npm packages contain only what they should', 'node', ['scripts/check-packages.ts']);

check('Workflows', () => {
  if (!has('actionlint') || !has('zizmor')) return { state: 'skipped', detail: 'actionlint or zizmor is not installed' };
  const lint = run('actionlint', []);
  const audit = run('zizmor', ['--offline', '.github/workflows']);
  if (lint.ok && audit.ok) return { state: 'pass', detail: 'actionlint and zizmor: no findings' };
  return { state: 'fail', detail: lint.ok ? lastLine(audit.output) : lastLine(lint.output) };
});

const failed = outcomes.filter((outcome) => outcome.state === 'fail');
const skipped = outcomes.filter((outcome) => outcome.state === 'skipped');
console.log('');
if (failed.length > 0) {
  console.log(`GATE CLOSED — ${failed.length} of ${outcomes.length} checks failed. Do not publish.`);
  process.exit(1);
}
console.log(
  skipped.length > 0
    ? `Gate passed, with ${skipped.length} check(s) skipped. Run it without --quick before publishing.`
    : `GATE OPEN — all ${outcomes.length} checks passed.`,
);
