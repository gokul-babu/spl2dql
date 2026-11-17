/**
 * Fails when a file is tracked outside the places this repository publishes on purpose.
 *
 * Everything under the source folders is free. A new file at the top level, or a new document
 * under docs/, has to be added to the list below first: nothing reaches the public repository
 * just because it was lying in the working folder when someone ran `git add`.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Folders whose whole content is published. */
const FOLDERS = ['.githooks/', '.github/', 'apps/', 'docs/images/', 'docs/spec/', 'examples/', 'packages/', 'scripts/', 'third_party/'];

/** Single files, by exact path. */
const FILES = new Set([
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  '.gitleaks.toml',
  'CHANGELOG.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'NOTICE',
  'PRIVACY.md',
  'README.md',
  'SECURITY.md',
  'biome.json',
  'docs/ARCHITECTURE.md',
  'docs/RELEASING.md',
  'mise.toml',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'vitest.config.ts',
]);

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0')
  .filter((path) => path !== '');

const unexpected = tracked.filter((path) => !FILES.has(path) && !FOLDERS.some((folder) => path.startsWith(folder)));

if (unexpected.length > 0) {
  console.error('These tracked files are outside the published set (scripts/check-tree.ts):');
  for (const path of unexpected) console.error(`  ${path}`);
  console.error('Remove them from the commit, or add them to the list on purpose.');
  process.exit(1);
}
console.log(`Tree check passed: ${tracked.length} tracked files, all in the published set.`);
