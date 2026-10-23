const js = require('@eslint/js');
const globals = require('globals');

const { createTypeScriptConfig } = require('./eslint.shared.cjs');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'frontend/node_modules/**',
      'frontend/dist/**',
      'playwright-report/**',
      'test-results/**',
      'desktop/electron/node_modules/**',
      'desktop/electron/test-results/**'
    ]
  },
  js.configs.recommended,
  {
    files: ['*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.node
      }
    }
  },
  ...createTypeScriptConfig({
    files: ['frontend/src/**/*.{ts,tsx}', 'frontend/vite.config.ts'],
    browser: true,
    node: true,
    tsconfigPath: './frontend/tsconfig.json',
    extraIgnores: ['frontend/coverage/**']
  }),
  ...createTypeScriptConfig({
    files: ['playwright.config.ts', 'tests/**/*.ts', 'desktop/electron/*.ts'],
    node: true,
    tsconfigPath: './frontend/tsconfig.json'
  }),
  {
    files: ['desktop/electron/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node
      }
    },
    rules: {
      // Electron's main process loads these files as CommonJS.
      '@typescript-eslint/no-require-imports': 'off'
    }
  }
];
