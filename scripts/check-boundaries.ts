/**
 * Package boundaries (ADR-002). dependency-cruiser cannot read TypeScript 7 sources yet, so the rules
 * are checked here by reading every import specifier.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const problems: string[] = [];

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(e) && !e.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function imports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g)) out.push(m[1] as string);
  for (const m of text.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) out.push(m[1] as string);
  for (const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1] as string);
  return out;
}

const rules: { dir: string; allow: (spec: string, file: string) => string | undefined }[] = [
  {
    dir: 'packages/core/src',
    allow: (spec, file) => {
      if (!spec.startsWith('.')) return 'core may not import packages or Node built-ins';
      if (!resolve(dirname(file), spec).startsWith(join(root, 'packages/core/src'))) return 'core may not reach outside its src folder';
      return undefined;
    },
  },
  {
    dir: 'apps/web/src',
    allow: (spec, file) => {
      if (spec.startsWith('node:')) return 'the web app may not use Node built-ins';
      if (/^@spl2dql\/(?!core$)|^spl2dql$/.test(spec)) return 'the web app may only use @spl2dql/core';
      // The sample Splunk app is data, bundled as text: it cannot pull code from another package in.
      if (spec.endsWith('?raw') && resolve(dirname(file), spec).startsWith(join(root, 'examples/splunk-app/'))) return undefined;
      if (spec.startsWith('.') && !resolve(dirname(file), spec).startsWith(join(root, 'apps/web/src')))
        return 'the web app may not import files outside its src folder';
      return undefined;
    },
  },
  {
    dir: 'packages/conformance/src',
    allow: (spec) => (spec.startsWith('node:') || spec.startsWith('.') ? undefined : 'the corpus loader imports nothing but Node built-ins'),
  },
];

for (const rule of rules) {
  for (const f of files(join(root, rule.dir))) {
    for (const spec of imports(f)) {
      const why = rule.allow(spec, f);
      if (why) problems.push(`${relative(root, f)} imports "${spec}": ${why}`);
    }
  }
}

const corePkg = JSON.parse(readFileSync(join(root, 'packages/core/package.json'), 'utf8')) as Record<string, unknown>;
for (const key of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
  if (corePkg[key] && Object.keys(corePkg[key] as object).length > 0) problems.push(`packages/core/package.json has ${key}; core must have none`);
}

if (problems.length > 0) {
  console.error(`Boundary check failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('Boundary check passed.');
