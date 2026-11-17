/**
 * Looks inside the npm packages before they are published.
 *
 *   node scripts/check-packages.ts            packs both packages into a temporary folder
 *   node scripts/check-packages.ts <folder>   checks the .tgz files already in <folder>
 *
 * Fails when a package carries a file it should not (sources, tests, maps, notes for tools,
 * anything that looks like local configuration), misses one it must have (licence, notice,
 * third-party notices for the bundled web app), or still has a workspace-only dependency range.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

interface Rule {
  /** Every file must match one of these. */
  allowed: RegExp[];
  required: string[];
  /** Upper bound for the packed size, in bytes: a sudden jump means something extra got in. */
  maxBytes: number;
}

const COMMON = [/^package\.json$/, /^README\.md$/, /^LICENSE$/, /^NOTICE$/];
const RULES: Record<string, Rule> = {
  '@spl2dql/core': {
    allowed: [...COMMON, /^dist\/[\w./-]+\.(js|d\.ts)$/],
    required: ['package.json', 'README.md', 'LICENSE', 'NOTICE', 'dist/index.js', 'dist/index.d.ts'],
    maxBytes: 400_000,
  },
  spl2dql: {
    allowed: [
      ...COMMON,
      /^bin\/spl2dql\.js$/,
      /^dist\/[\w./-]+\.(js|d\.ts)$/,
      /^web\/[\w./-]+\.(html|js|css|svg|png|woff2|webmanifest|txt)$/,
      /^web\/_headers$/,
    ],
    required: [
      'package.json',
      'README.md',
      'LICENSE',
      'NOTICE',
      'bin/spl2dql.js',
      'dist/main.js',
      'web/index.html',
      'web/sw.js',
      'web/THIRD-PARTY-NOTICES.txt',
    ],
    maxBytes: 1_500_000,
  },
};
/** Never in a package, whatever the allow-list says. */
const FORBIDDEN = /(^|\/)(\.[^/]*|node_modules|src|test|e2e|coverage)(\/|$|\.)|\.map$|\.tsbuildinfo$|\.pem$|\.key$/i;

function tar(args: string[]): string {
  return execFileSync('tar', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function check(file: string): string[] {
  const problems: string[] = [];
  const manifest = JSON.parse(tar(['-xOzf', file, 'package/package.json'])) as {
    name: string;
    version: string;
    license?: string;
    repository?: { url?: string };
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  const rule = RULES[manifest.name];
  if (!rule) return [`${manifest.name}: not a package this project publishes`];

  const files = tar(['-tzf', file])
    .split('\n')
    .filter((line) => line !== '' && !line.endsWith('/'))
    .map((line) => line.replace(/^package\//, ''));
  for (const name of files) {
    if (FORBIDDEN.test(name)) problems.push(`must not be published: ${name}`);
    else if (!rule.allowed.some((pattern) => pattern.test(name))) problems.push(`not on the allow-list: ${name}`);
  }
  for (const name of rule.required) if (!files.includes(name)) problems.push(`missing: ${name}`);

  const size = statSync(file).size;
  if (size > rule.maxBytes) problems.push(`packed size ${size} bytes is over the ${rule.maxBytes} byte limit`);

  if (manifest.license !== 'Apache-2.0') problems.push(`licence field is ${manifest.license}`);
  if (manifest.repository?.url !== 'git+https://github.com/gokul-babu/spl2dql.git')
    problems.push('repository.url does not name this repository (npm provenance needs an exact match)');
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    if (/^(workspace|link|file):/.test(range)) problems.push(`dependency ${name} has the local range "${range}"`);
  }
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (manifest.scripts?.[hook]) problems.push(`has an install-time script: ${hook}`);
  }

  const licence = tar(['-xOzf', file, 'package/LICENSE']);
  if (!licence.includes('Apache License') || !licence.includes('Version 2.0, January 2004')) problems.push('LICENSE is not the Apache-2.0 text');
  if (/Copyright \d{4} (?!\[)/.test(licence))
    problems.push('LICENSE names a copyright holder; it must be the unmodified licence text (the holder is in NOTICE)');

  console.log(`${manifest.name}@${manifest.version}: ${files.length} files, ${size} bytes${problems.length === 0 ? ', ok' : ''}`);
  return problems.map((problem) => `${manifest.name}: ${problem}`);
}

let folder = process.argv[2] ? resolve(process.argv[2]) : undefined;
let temporary: string | undefined;
if (!folder) {
  temporary = mkdtempSync(join(tmpdir(), 'spl2dql-pack-'));
  folder = temporary;
  for (const name of Object.keys(RULES)) {
    execFileSync('pnpm', ['--filter', name, 'pack', '--pack-destination', folder], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  }
}

try {
  const tarballs = readdirSync(folder)
    .filter((name) => name.endsWith('.tgz'))
    .sort();
  const problems = tarballs.flatMap((name) => check(join(folder, name)));
  if (tarballs.length !== Object.keys(RULES).length) problems.push(`expected ${Object.keys(RULES).length} packages in ${folder}, found ${tarballs.length}`);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(`Package check failed: ${problems.length} problem${problems.length === 1 ? '' : 's'}.`);
    process.exit(1);
  }
  console.log('Package check passed.');
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
