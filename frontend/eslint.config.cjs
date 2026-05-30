const { createTypeScriptConfig } = require('../eslint.shared.cjs');
const reactHooks = require('eslint-plugin-react-hooks');

module.exports = [
  ...createTypeScriptConfig({
    files: ['src/**/*.{ts,tsx}', 'vite.config.ts'],
    browser: true,
    node: true,
    tsconfigPath: './frontend/tsconfig.json',
    extraIgnores: ['coverage/**']
  }),
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks
    },
    rules: {
      'no-useless-catch': 'off',
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/rules-of-hooks': 'error'
    }
  }
];
