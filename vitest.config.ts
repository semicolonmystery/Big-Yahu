import path from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve('src/client'), '@shared': path.resolve('src/shared') } },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
    // Every test file gets a migrated database of its own, so nothing reads the
    // developer's dev database and nothing depends on migrations having been run by hand.
    setupFiles: ['tests/setup/database.ts'],
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    testTimeout: 10_000,
    hookTimeout: 20_000,
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/server/**/*.ts', 'src/shared/**/*.ts', 'src/client/{hooks,lib,routes}/**/*.{ts,tsx}'],
      exclude: ['src/server/plugins/**', 'src/server/index.ts'],
    },
  },
});
