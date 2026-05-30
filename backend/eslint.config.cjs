const { createTypeScriptConfig } = require('../eslint.shared.cjs');

module.exports = createTypeScriptConfig({
  files: ['src/**/*.ts', 'test/**/*.ts'],
  node: true,
  tsconfigPath: './backend/tsconfig.json'
});
