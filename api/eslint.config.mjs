// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'prisma/migrations/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      // Flag stray console usage; use `// eslint-disable-next-line no-console` at
      // intentional call sites (startup logging, error logging in the central
      // error handler, etc.) so they remain a deliberate, reviewed choice.
      'no-console': 'warn',
    },
  },
  // Prettier must be last to disable stylistic rules that conflict with it.
  eslintConfigPrettier,
);
