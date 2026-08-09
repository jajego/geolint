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
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false } },
      ],
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
    // Parser/scanner and benchmark measurement hot paths keep compact branches.
    files: ['src/{benchmark,parser,scanner}/**/*.ts'],
    rules: { 'no-nested-ternary': 'off' },
  },
);
