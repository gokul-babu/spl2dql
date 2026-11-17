import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@spl2dql/core': src('./packages/core/src/index.ts'),
      '@spl2dql/conformance': src('./packages/conformance/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/web/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**/*.ts', 'packages/cli/src/**/*.ts'],
      exclude: ['**/catalog.generated.ts'],
      thresholds: {
        'packages/core/src/**': { lines: 90, branches: 80 },
      },
    },
  },
});
