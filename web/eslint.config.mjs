import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import next from 'eslint-config-next'
import prettier from 'eslint-config-prettier'

/**
 * Mirrors api/eslint.config.js where it makes sense, plus the Next rules.
 *
 * ORDER MATTERS. `eslint-config-next` ships its own parser, which silently
 * displaces @typescript-eslint/parser and breaks every type-aware rule with
 * "you have used a rule which requires type information". So Next goes first,
 * and the typed block below re-asserts the parser for .ts/.tsx only.
 *
 * Type-aware linting is scoped to src/ and scripts/. Config files at the root
 * sit outside tsconfig's `include` and are linted untyped.
 */
export default tseslint.config(
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'out/**',
      'next-env.d.ts',
      /**
       * Read-only design handoff. These are the browser prototype and the
       * design-system sources we port FROM — someone else's code, in a
       * different module system, deliberately kept byte-identical so it stays
       * diffable against future handoff revisions. Linting them produces
       * hundreds of findings we must not act on.
       */
      // The design handoff: prototype JSX and reference sources, not app
      // code. Linting it fails on rules it was never written against.
      'design-handoff/**',
    ],
  },

  js.configs.recommended,

  // Next's rules and parser first, so the block below can override the parser.
  ...next,

  {
    files: ['src/**/*.{ts,tsx}', 'scripts/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      // Re-assert the TypeScript parser that eslint-config-next replaced.
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A dropped promise in a Server Component is a fetch that silently never
      // happened. Same reasoning as the API.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        // Server Actions and event handlers legitimately return promises where
        // a void return is expected.
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],

      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',

      // console.error in the error boundary is intended until a real error
      // tracker is wired up.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // Scripts run at a terminal and are allowed to print.
  {
    files: ['scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  // PM2's config is CommonJS and reads __dirname directly — mirrors the
  // equivalent block in api/eslint.config.js.
  {
    files: ['ecosystem.config.cjs'],
    languageOptions: {
      globals: { module: 'writable', process: 'readonly', __dirname: 'readonly' },
    },
  },

  prettier,
)
