import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',
    },
  },
  {
    // Hooks called in order, effects listing what they read.
    files: ['apps/web/src/**/*.tsx', 'apps/web/src/**/*.ts', 'packages/renderer/src/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // A promise nobody awaits loses its error (an unhandled rejection that ends the process
    // in Node): await it, return it, or mark it `void` on purpose.
    files: ['apps/api/src/**/*.ts', 'apps/web/src/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}'],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
    },
  },
  {
    // The logic engine must run unchanged in browsers, offline tablets and Node.
    files: ['packages/logic/src/**/*.ts', 'packages/schema/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['node:*', 'fs', 'path', 'crypto', 'os', 'react', 'react-dom'] },
      ],
      'no-restricted-globals': ['error', 'window', 'document', 'process', 'Buffer', 'require'],
    },
  },
);
