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
      'test-results/**'
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
    files: ['playwright.config.ts', 'tests/**/*.ts'],
    node: true,
    tsconfigPath: './frontend/tsconfig.json'
  })
];
