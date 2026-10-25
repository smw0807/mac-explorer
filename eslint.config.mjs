import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default defineConfig([
  globalIgnores(['node_modules/**', 'dist/**', 'release/**', 'coverage/**', '**/*.timestamp-*.mjs']),
  {
    files: ['**/*.{js,cjs,mjs,jsx}'],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 'latest' },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.cjs', '*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // ESLint 10 tracks JSX component references in its core scope analysis.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: ['test/**/*.cjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
]);
