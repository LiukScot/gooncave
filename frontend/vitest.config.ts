import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Keep CI fast: tests are pure, no DOM, no global setup overhead.
    globals: false,
    reporters: ['default']
  }
});
