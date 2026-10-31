import { parseArgs } from "node:util";
import { z } from "zod";
import { ENV_NAME } from "../engine/environments/env.js";
import { UsageError } from "./errors.js";

export const FAIL_ON = ["critical", "high", "medium", "low", "any", "none"] as const;
export type FailOn = (typeof FAIL_ON)[number];

const OPTIONS = {
    // what to run
    url: { type: "string" },
    specs: { type: "string" },
    analyze: { type: "boolean" },
    server: { type: "string" },
    "api-key": { type: "string" },
    "api-key-env": { type: "string" },
    project: { type: "string" },
    // run against a named environment of the project (staging, production...)
    env: { type: "string" },
    "confirm-production": { type: "boolean" },
    // credentials for the tested app: names of environment variables, never values
    "username-env": { type: "string" },
    "password-env": { type: "string" },
    "totp-secret-env": { type: "string" },
    "token-env": { type: "string" },
    "auth-header-env": { type: "string" },
    "api-base-url": { type: "string" },
    // analysis size (generate mode)
    "max-pages": { type: "string" },
    "max-scenarios": { type: "string" },
    timeout: { type: "string" },
    // gate
    "fail-on": { type: "string" },
    "fail-on-failed-validation": { type: "boolean" },
    // outputs
    junit: { type: "string" },
    json: { type: "string" },
    sarif: { type: "string" },
    html: { type: "string" },
    markdown: { type: "string" },
    "evidence-dir": { type: "string" },
    // GitHub pull request comment
    "github-comment": { type: "boolean" },
    pr: { type: "string" },
    "github-repo": { type: "string" },
    "github-token-env": { type: "string" },
    "github-api-url": { type: "string" },
    // export
    out: { type: "string" },
    help: { type: "boolean", short: "h" },
} as const;

const posInt = (name: string, min: number, max: number) => z.coerce.number({ invalid_type_error: `--${name} must be a number` }).int(`--${name} must be a whole number`).min(min, `--${name} must be at least ${min}`).max(max, `--${name} must be at most ${max}`);
const envName = (flag: string) => z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, `--${flag} takes the NAME of an environment variable (like APP_PASSWORD), not the secret itself`);
const httpUrl = (flag: string) =>
    z
        .string({ required_error: `--${flag} is required` })
        .url(`--${flag} must be a full address like https://example.com`)
        .refine((u) => /^https?:/i.test(u), `--${flag} must start with http:// or https://`);

const RunSchema = z
    .object({
        url: httpUrl("url").optional(),
        specs: z.string().min(1).optional(),
        analyze: z.boolean().default(false),
        server: httpUrl("server").optional(),
        "api-key": z.string().min(1).optional(),
        "api-key-env": envName("api-key-env").optional(),
        project: z.string().min(1).max(120).optional(),
        env: z.string().regex(ENV_NAME, "--env takes the name of one of the project’s environments, like staging").optional(),
        "confirm-production": z.boolean().default(false),
        "username-env": envName("username-env").optional(),
        "password-env": envName("password-env").optional(),
        "totp-secret-env": envName("totp-secret-env").optional(),
        "token-env": envName("token-env").optional(),
        "auth-header-env": envName("auth-header-env").optional(),
        "api-base-url": httpUrl("api-base-url").optional(),
        "max-pages": posInt("max-pages", 1, 100).optional(),
        "max-scenarios": posInt("max-scenarios", 1, 100).optional(),
        timeout: posInt("timeout", 30, 21_600).default(1800),
        "fail-on": z.enum(FAIL_ON, { errorMap: () => ({ message: `--fail-on must be one of: ${FAIL_ON.join(", ")}` }) }).default("high"),
        "fail-on-failed-validation": z.boolean().default(true),
        junit: z.string().min(1).optional(),
        json: z.string().min(1).optional(),
        sarif: z.string().min(1).optional(),
        html: z.string().min(1).optional(),
        markdown: z.string().min(1).optional(),
        "evidence-dir": z.string().min(1).optional(),
        "github-comment": z.boolean().default(false),
        pr: posInt("pr", 1, 1_000_000_000).optional(),
        "github-repo": z.string().regex(/^[\w.-]+\/[\w.-]+$/, "--github-repo must look like owner/name").optional(),
        "github-token-env": envName("github-token-env").default("GITHUB_TOKEN"),
        "github-api-url": httpUrl("github-api-url").optional(),
    })
    .superRefine((v, ctx) => {
        const add = (message: string) => ctx.addIssue({ code: "custom", message });
        if (v.specs && v.analyze) add("Choose one of --specs (replay saved tests) or --analyze (generate new tests), not both.");
        if (v.server) {
            if (!v.specs && !v.analyze && !v.project) add("With --server, give --specs or --analyze, or --project to re-run an existing project’s tests.");
        } else {
            if (!v.specs && !v.analyze) add("Say what to run: --specs <file.json> (replay saved tests), --analyze (generate tests), or --server <url> --project <name>.");
            if (v.project) add("--project only applies together with --server.");
            if (v["api-key"] || v["api-key-env"]) add("--api-key only applies together with --server.");
            if (!v.url) add("--url <address of the application to test> is required.");
        }
        if (v.server && (v.specs || v.analyze) && !v.url) add("--url <address of the application to test> is required.");
        if (v["username-env"] && !v["password-env"]) add("--username-env needs --password-env as well.");
        if (v["password-env"] && !v["username-env"]) add("--password-env needs --username-env as well.");
        if (v.pr && !v["github-comment"]) add("--pr only applies together with --github-comment.");
        if (v.env && !v.server) add("--env needs --server and --project: environments are saved in the platform, per project.");
        if (v.env && v.server && !v.project) add("--env needs --project <name>: environments belong to a project.");
        if (v.env && v.analyze) add("--env runs saved tests against an environment; it can’t be combined with --analyze.");
        if (v["confirm-production"] && !v.env) add("--confirm-production only applies together with --env.");
    });
export type RunArgs = z.infer<typeof RunSchema>;

const ExportSchema = z.object({
    server: httpUrl("server"),
    "api-key": z.string().min(1).optional(),
    "api-key-env": envName("api-key-env").optional(),
    project: z.string({ required_error: "--project is required" }).min(1, "--project is required"),
    out: z.string().min(1).default("ai-tests.json"),
});
export type ExportArgs = z.infer<typeof ExportSchema>;

export type Parsed = { command: "run"; args: RunArgs } | { command: "export"; args: ExportArgs } | { command: "help"; topic?: "run" | "export" };

/** Parse and validate `argv` (everything after the program name). Throws UsageError with a helpful sentence. */
export function parseCli(argv: string[]): Parsed {
    const [first, ...rest] = argv;
    if (!first || first === "help" || first === "--help" || first === "-h") return { command: "help", topic: rest[0] === "run" || rest[0] === "export" ? rest[0] : undefined };
    if (first !== "run" && first !== "export") throw new UsageError(`Unknown command “${first}”. Commands: run, export. Try “ai-test --help”.`);

    let values: Record<string, string | boolean | undefined>;
    try {
        values = parseArgs({ args: rest, options: { ...OPTIONS, "fail-on-failed-validation": { type: "boolean" } }, allowNegative: true, strict: true, allowPositionals: false }).values as typeof values;
    } catch (e) {
        throw new UsageError(`${e instanceof Error ? e.message.replace(/\. To specify a positional.*$/, "") : String(e)}. Try “ai-test ${first} --help”.`);
    }
    if (values.help) return { command: "help", topic: first };

    const schema = first === "run" ? RunSchema : ExportSchema;
    const r = schema.safeParse(values);
    if (!r.success) throw new UsageError(r.error.issues.map((i) => i.message).join("\n") + `\nTry “ai-test ${first} --help”.`);
    return first === "run" ? { command: "run", args: r.data as RunArgs } : { command: "export", args: r.data as ExportArgs };
}

export const HELP = {
    main: `ai-test — run the AI Testing Platform from a pipeline

Usage:
  ai-test run [options]        run tests and gate the pipeline on the result
  ai-test export [options]     download a project's tests as a file for "run --specs"
  ai-test api-diff <old> <new> list breaking changes between two OpenAPI descriptions
  ai-test help <command>

Exit codes (run):
  0  everything is fine (the gate passed)
  1  the gate failed: findings at or above --fail-on, or tests that could not be validated
  2  usage or infrastructure error (bad flags, server unreachable, nothing could run)

Try “ai-test run --help”.
`,
    run: `ai-test run — run tests and gate a pipeline

What to run (pick one):
  --specs <file.json> --url <app>      Replay saved tests against the app. No AI, fast, repeatable: the usual CI mode.
  --analyze --url <app>                Generate new tests with AI first (needs an AI key, like the server), then validate.
  --server <url> --project <name>      Drive a running platform instead of running locally (add --specs or --analyze,
                                       or neither to re-run the project's existing tests). --url is the app to test.
  --api-key <key> | --api-key-env NAME The platform's API key (default: the AI_TEST_API_KEY variable). Prefer the variable.
  --project <name>                     Project to create or reuse on the server (default: a new ci-<time> project).
  --env <name>                         Run the project's tests against one of its named environments (staging, ...), with that
                                       environment's address, sign-in and variables. Results are kept for that environment.
  --confirm-production                 Required for an environment flagged "production". Production is read-only: tests that
                                       change data are skipped and reported as not run.

Credentials for the application under test (names of environment variables, never the secrets themselves):
  --username-env NAME --password-env NAME    sign-in for web tests
  --totp-secret-env NAME                     authenticator secret, for logins that ask for a one-time code
  --token-env NAME                           bearer token for API tests
  --auth-header-env NAME                     a complete Authorization header value
  --api-base-url <url>                       where the API lives, if not the app's address

The gate:
  --fail-on <critical|high|medium|low|any|none>   fail on findings at or above this severity (default: high)
  --no-fail-on-failed-validation                  do not fail when a test itself could not be made to pass
                                                  (default: fail; --fail-on-failed-validation is the default)

Outputs (all optional):
  --junit <file>       JUnit XML           --json <file>      machine-readable report (schema in docs/features/ci.md)
  --sarif <file>       SARIF 2.1.0         --html <file>      one self-contained, readable report
  --markdown <file>    summary text        --evidence-dir <dir>  screenshots and traces of failing tests
  The summary is also appended to $GITHUB_STEP_SUMMARY when that variable is set.

GitHub pull request comment:
  --github-comment                 post or update ONE comment on the pull request (reruns update it)
  --pr <number>                    pull request number (default: read from $GITHUB_EVENT_PATH)
  --github-repo <owner/name>       default: $GITHUB_REPOSITORY
  --github-token-env NAME          default: GITHUB_TOKEN
  --github-api-url <url>           default: $GITHUB_API_URL, else https://api.github.com
  A comment that cannot be posted (missing permission...) is a warning, never a failure.

Other:
  --max-pages <n> --max-scenarios <n>   size of an --analyze run
  --timeout <seconds>                   give up waiting for the run (default 1800)
`,
    export: `ai-test export — download a project's tests

  ai-test export --server <url> --project <name or id> [--out ai-tests.json] [--api-key-env NAME]

The file can be committed to your repository and replayed with “ai-test run --specs”.
`,
};
