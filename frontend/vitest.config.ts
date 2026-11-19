import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src')
    }
  },
  test: {
    environment: 'node',
    include: [
      'test/**/*.test.ts',
      'test/**/*.test.tsx',
      'src/**/*.test.ts',
      'src/**/*.test.tsx'
    ],
    // Keep CI fast: tests are pure and need no DOM unless a file asks for one.
    globals: false,
    setupFiles: ['test/noNetwork.ts'],
    // This package imports its own files without extensions, which Node
    // refuses; inlined, Vite resolves them as it does in the app.
    server: { deps: { inline: ['@material/material-color-utilities'] } },
    reporters: ['default']
  }
});
