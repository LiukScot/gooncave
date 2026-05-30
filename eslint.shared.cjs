const js = require('@eslint/js');
const globals = require('globals');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const importX = require('eslint-plugin-import-x');

function createTypeScriptConfig(options) {
  const {
    files,
    browser = false,
    node = false,
    tsconfigPath,
    extraIgnores = [],
    extraGlobals = {}
  } = options;

  return [
    {
      ignores: ['dist/**', 'node_modules/**', ...extraIgnores]
    },
    js.configs.recommended,
    ...tsPlugin.configs['flat/recommended'],
    importX.flatConfigs.recommended,
    importX.flatConfigs.typescript,
    {
      files,
      languageOptions: {
        parser: tsParser,
        ecmaVersion: 'latest',
        sourceType: 'module',
        parserOptions: {
          tsconfigRootDir: __dirname,
          ecmaFeatures: {
            jsx: true
          }
        },
        globals: {
          ...globals.es2021,
          ...(browser ? globals.browser : {}),
          ...(node ? globals.node : {}),
          ...extraGlobals
        }
      },
      settings: {
        'import-x/parsers': {
          '@typescript-eslint/parser': ['.ts', '.tsx']
        },
        'import-x/resolver': {
          typescript: {
            project: tsconfigPath
          },
          node: {
            extensions: ['.js', '.ts', '.tsx']
          }
        }
      },
      rules: {
        '@typescript-eslint/no-unused-vars': 'warn',
        'import-x/default': 'off',
        'import-x/no-unresolved': 'off',
        'import-x/order': [
          'warn',
          {
            'newlines-between': 'always',
            alphabetize: { order: 'asc', caseInsensitive: true }
          }
        ]
      }
    }
  ];
}

module.exports = { createTypeScriptConfig };
