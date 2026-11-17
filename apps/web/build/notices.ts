/**
 * Emits THIRD-PARTY-NOTICES.txt: the licence of every package the web app ships.
 *
 * The list is the production dependency closure of this package (what `dependencies` pulls in),
 * plus the packages named in EXTRA whose output ends up in the stylesheet. That is a superset of
 * what the bundler keeps, which is the safe side for attribution, and it does not depend on how
 * the bundler reports its module graph. The output is sorted and carries no date, so two builds
 * of the same lockfile give the same file (ADR-031).
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/** Build-time packages whose own code is copied into the output (Tailwind's base styles). */
const EXTRA = ['tailwindcss'];
/** Workspace packages are this project, not third parties. */
const OWN = /^@spl2dql\//;
const LICENCE_FILE = /^(licen[cs]e|copying|ofl)(\.(md|txt))?$/i;

interface Manifest {
  name: string;
  version: string;
  license?: string;
  homepage?: string;
  repository?: string | { url?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface Found {
  manifest: Manifest;
  dir: string;
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
}

/** Node's own lookup: the nearest `node_modules/<name>` above `from`. */
function locate(from: string, name: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) return undefined;
  }
}

function closure(root: string): Found[] {
  const seen = new Map<string, Found>();
  const queue: { from: string; name: string; required: boolean }[] = [];
  const rootManifest = readManifest(root);
  for (const name of Object.keys(rootManifest.dependencies ?? {})) queue.push({ from: root, name, required: true });
  for (const name of EXTRA) queue.push({ from: root, name, required: true });

  while (queue.length > 0) {
    const next = queue.pop();
    if (!next || OWN.test(next.name)) continue;
    const dir = locate(next.from, next.name);
    if (!dir) {
      if (next.required) throw new Error(`third-party notices: cannot find "${next.name}" from ${next.from}`);
      continue;
    }
    const manifest = readManifest(dir);
    const key = `${manifest.name}@${manifest.version}`;
    if (seen.has(key)) continue;
    seen.set(key, { manifest, dir });
    // A build-time extra contributes its own code only; what it depends on stays on the build machine.
    if (EXTRA.includes(next.name) && next.from === root) continue;
    for (const name of Object.keys(manifest.dependencies ?? {})) queue.push({ from: dir, name, required: true });
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) queue.push({ from: dir, name, required: false });
  }
  return [...seen.values()].sort((a, b) => {
    const left = `${a.manifest.name}@${a.manifest.version}`;
    const right = `${b.manifest.name}@${b.manifest.version}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function licenceText(dir: string): string | undefined {
  const file = readdirSync(dir)
    .filter((name) => LICENCE_FILE.test(name))
    .sort()[0];
  return file ? readFileSync(join(dir, file), 'utf8').replace(/\r\n?/g, '\n').trim() : undefined;
}

function source(manifest: Manifest): string {
  const repo = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  return (repo ?? manifest.homepage ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
}

export function buildNotices(root: string): string {
  const rule = '-'.repeat(78);
  const parts = [
    'THIRD-PARTY NOTICES',
    '',
    'spl2dql itself is licensed under the Apache License, Version 2.0 (see LICENSE and NOTICE).',
    'The web app includes the third-party packages below. Each is listed with the licence its',
    'authors publish it under.',
    '',
  ];
  for (const { manifest, dir } of closure(root)) {
    const text = licenceText(dir);
    if (!manifest.license || !text) {
      throw new Error(`third-party notices: ${manifest.name}@${manifest.version} has no licence ${text ? 'identifier' : 'file'}`);
    }
    parts.push(rule, `${manifest.name} ${manifest.version}`, `Licence: ${manifest.license}`);
    const from = source(manifest);
    if (from) parts.push(`Source: ${from}`);
    parts.push(rule, '', text, '');
  }
  return `${parts.join('\n')}\n`;
}

/** Vite plugin: writes the notices next to the built app. */
export function thirdPartyNotices(): Plugin {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  return {
    name: 'spl2dql-third-party-notices',
    apply: 'build',
    buildStart() {
      this.emitFile({ type: 'asset', fileName: 'THIRD-PARTY-NOTICES.txt', source: buildNotices(root) });
    },
  };
}
