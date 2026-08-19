import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

/**
 * ESLint flat config.
 *
 * Formatting is Prettier's job — `eslint-config-prettier` goes last and turns
 * off every stylistic rule so the two never disagree. What is left here is
 * correctness and consistency: the things a formatter cannot see.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.uploads/**', 'prisma/migrations/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // Type-aware linting without hand-maintaining a project list.
        // Config files sit outside tsconfig's `include`, so they are linted
        // against the default project rather than erroring.
        projectService: {
          allowDefaultProject: ['eslint.config.js', 'vitest.config.ts', 'ecosystem.config.cjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },

    rules: {
      // ─── Correctness ───────────────────────────────────────────────────────

      /**
       * The single most valuable rule in an async Express codebase. A dropped
       * promise means a write that silently never happened. Where a promise is
       * deliberately not awaited (the throttled session touch, notification
       * fan-out) mark it `void` so the intent is explicit and reviewable.
       */
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        // Express 5 forwards rejected promises from handlers to the error
        // middleware, so an async handler passed where void is expected is
        // correct here rather than a bug.
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'off', // too noisy against Prisma's optionals
      '@typescript-eslint/require-await': 'error',
      'no-return-await': 'off',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],

      // ─── Type hygiene ──────────────────────────────────────────────────────

      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'off', // Prisma JSON columns are inherently unsafe
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none', // `catch {}` with an ignored error is intentional in places
        },
      ],

      // ─── Project conventions ───────────────────────────────────────────────

      /**
       * Everything user-facing goes through Pino so it lands in CloudWatch as
       * structured JSON. `console` in a request path produces unsearchable text.
       * Scripts and the seed are exempted below.
       */
      'no-console': 'error',

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'object-shorthand': ['error', 'properties'],
      'no-param-reassign': ['error', { props: false }],

      /**
       * `process.exit()` inside request handling kills in-flight requests. It is
       * legitimate at boot and in scripts, which are exempted below.
       */
      'no-process-exit': 'error',
    },
  },

  // Boot code and one-off scripts print to stdout and exit by design.
  {
    files: [
      'src/index.ts',
      'src/config/env.ts',
      'scripts/**/*.ts',
      'prisma/seed.ts',
      'prisma/seed-catalog.ts',
      'prisma/backfill-builds.ts',
    ],
    rules: {
      'no-console': 'off',
      'no-process-exit': 'off',
    },
  },

  // PM2's config is CommonJS and reads process.env directly.
  {
    files: ['ecosystem.config.cjs'],
    languageOptions: {
      globals: { module: 'writable', process: 'readonly', __dirname: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  /**
   * Tests get a longer leash.
   *
   * The unsafe-* rules are off because supertest types `response.body` as
   * `any` — that is the point of an integration test, which asserts against
   * the untyped JSON a real client would receive. Typing it would only be
   * asserting against our own types rather than the wire format.
   */
  {
    files: ['tests/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      'no-console': 'off',
    },
  },

  // Must stay last: disables everything Prettier owns.
  prettier,
)
