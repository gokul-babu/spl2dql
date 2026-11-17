/** Copies the built web app into packages/cli/web so `spl2dql serve` can serve it. */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const from = fileURLToPath(new URL('../apps/web/dist/', import.meta.url));
const to = fileURLToPath(new URL('../packages/cli/web/', import.meta.url));
if (!existsSync(`${from}index.html`)) {
  console.error('apps/web/dist is missing; build the web app first (pnpm --filter @spl2dql/web build).');
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true, dereference: false });
console.log(`copied web app → ${to}`);
