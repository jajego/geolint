import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Keep runtime dependency edges explicit and reviewable.
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-nested-ternary': 'error',
    },
  },
  {
    files: ['src/workers/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
  {
    files: ['src/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      'no-nested-ternary': 'off',
    },
  },
  {
    // Frozen parser/scanner and measurement hot paths retain compact branches.
    files: [
      'src/benchmark/fixtures.ts',
      'src/benchmark/worker-feasibility.ts',
      'src/parser/indexed-source.ts',
      'src/scanner/scan.ts',
    ],
    rules: { 'no-nested-ternary': 'off' },
  },
  {
    // EventEmitter owns these async worker lifecycle callbacks.
    files: [
      'src/workers/worker-entry.ts',
      'src/benchmark/worker-prototype-entry.ts',
    ],
    rules: {
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false } },
      ],
    },
  },
);
