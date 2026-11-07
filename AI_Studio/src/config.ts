import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** A whole number of tokens, 1 or more; empty or missing = no limit. */
function tokenLimit() {
    return z
        .string()
        .optional()
        .transform((v, ctx): number | undefined => {
            const t = (v ?? "").trim();
            if (!t) return undefined;
            const n = Number(t.replace(/[_,]/g, ""));
            if (!Number.isInteger(n) || n < 1) {
                ctx.addIssue({ code: "custom", message: "must be a whole number of tokens, 1 or more" });
                return z.NEVER;
            }
            return n;
        });
}

const EnvSchema = z.object({
    PORT: z.coerce.number().default(4000),
    HOST: z.string().default("127.0.0.1"),
    /** If set, every /api request must carry `x-api-key: <API_KEY>`. */
    API_KEY: z.string().optional(),
    DATA_DIR: z.string().default("./data"),
    /** 32+ char secret for encrypting stored credentials. Dev default is generated per data dir. */
    SECRET_KEY: z.string().optional(),
    /** A hosted install sets this: the platform then refuses to start without SECRET_KEY instead of keeping a key file in the data folder. */
    SECRET_KEY_REQUIRED: z
        .string()
        .default("false")
        .transform((v) => v === "true"),
    /** Run the queue worker inside the API process. Set false to run `npm run worker` separately. */
    WORKER_EMBEDDED: z
        .string()
        .default("true")
        .transform((v) => v !== "false"),
    WORKER_POLL_MS: z.coerce.number().default(1500),
    /**
     * Where test code runs (docs/features/runner-only-mode.md). "local" (the default, for self-hosted installs and development): jobs run in
     * this process or a worker next to it, and each project chooses this server or a runner, as before. "runners" (the hosted platform):
     * the server never runs test code and never opens a browser for a run; a dispatch worker in the API process hands every run to a runner.
     */
    EXECUTION_MODE: z.enum(["local", "runners"]).default("local"),
    /** EXECUTION_MODE=runners: how many runner jobs the dispatch worker looks after at once (each waits for its runner without holding the others). */
    DISPATCH_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
    /** A job that runs longer than this is stopped and recorded as failed, with the reason (platform/job-runner.ts). 0 = no limit. */
    JOB_MAX_MINUTES: z.coerce.number().min(0).max(10_080).default(120),
    /** Recordings with a browser on this server at once, in all projects (platform/recorder-service.ts). */
    RECORDINGS_MAX: z.coerce.number().int().min(1).max(50).default(2),
    /** Concurrent test authoring/validation tasks inside one job. */
    CONCURRENCY: z.coerce.number().min(1).max(8).default(3),

    LLM_PROVIDER: z.enum(["anthropic", "openai", "google", "openai-compatible"]).default("anthropic"),
    LLM_MODEL: z.string().optional(),
    LLM_API_KEY: z.string().optional(),
    LLM_BASE_URL: z.string().optional(),
    /**
     * AI model reliability (docs/features/ai-model-reliability.md). Kept as plain strings and read by engine/llm/provider.ts, so an empty
     * line or a typo keeps the default. Fallback models: `[provider:]model`, comma-separated, asked in order when the main model is
     * unavailable or out of credit (a list saved in Settings wins).
     */
    LLM_FALLBACK_MODELS: z.string().optional(),
    /** Requests per model for one call, 1-10 (default 6). */
    LLM_RETRY_ATTEMPTS: z.string().optional(),
    /** Time limit of one request to the model in ms (default 120000). */
    LLM_TIMEOUT_MS: z.string().optional(),
    /** Time limit of one whole call, retries and fallbacks included, in ms (default 600000). */
    LLM_CALL_DEADLINE_MS: z.string().optional(),
    /** Prompt caching (docs/features/prompt-caching.md): on unless "false"/"off"/"0"; a choice saved in Settings wins. Plain string, read by engine/llm/prompt-cache.ts. */
    LLM_PROMPT_CACHE: z.string().optional(),
    /** Repair without AI first (docs/features/repair-and-reuse-without-ai.md): on unless "false"/"off"/"0"; a choice saved in Settings wins. Read by engine/llm/without-ai.ts. */
    LLM_DETERMINISTIC_REPAIR: z.string().optional(),
    /** Reuse the earlier understanding of pages that did not change since the last exploration (same doc): on unless "false"/"off"/"0"; Settings wins. */
    LLM_EXPLORATION_REUSE: z.string().optional(),
    /**
     * Fast model for routine steps (docs/features/model-routing.md): `[provider:]model`; empty = the main model does everything (as before).
     * A value saved in Settings wins. LLM_MODEL_FAST_IMAGES=true lets calls with images use it too. Plain strings, read by engine/llm/routing.ts.
     */
    LLM_MODEL_FAST: z.string().optional(),
    LLM_MODEL_FAST_IMAGES: z.string().optional(),
    /** Smaller page snapshots for the AI (docs/features/smaller-snapshots.md): on unless "false"/"off"/"0"; a choice saved in Settings wins. Read by engine/snapshots/setting.ts. */
    LLM_COMPACT_SNAPSHOTS: z.string().optional(),

    /** Emulator (AVD) for mobile tests when a project does not name one. Default: the first AVD found. */
    MOBILE_AVD: z.string().optional(),
    /**
     * How a phone exploration chooses its actions (docs/features/phone-ai-tests.md): "map" (default) maps the app screen by screen at the
     * phone's speed and asks the AI only for forms, when it is stuck, and to name screens; "ai" lets the AI choose every action (the earlier
     * explorer: slower, many more AI calls).
     */
    PHONE_EXPLORER: z.enum(["map", "ai"]).default("map"),
    /** Keep an emulator the platform started running after the job (faster next run, but holds ~2 GB of RAM). */
    MOBILE_KEEP_EMULATOR: z
        .string()
        .default("false")
        .transform((v) => v === "true"),

    /** Scheduled runs: run the scheduler next to the worker, and how often it looks for due schedules. */
    SCHEDULER_ENABLED: z
        .string()
        .default("true")
        .transform((v) => v !== "false"),
    SCHEDULER_TICK_MS: z.coerce.number().min(50).default(30_000),
    /** Address of this platform as people reach it; alert messages link back to it. Falls back to the request host. */
    PUBLIC_URL: z.string().optional(),
    /**
     * Sign in with the Crowd4Test session (see platform/auth/crowd4test.ts): the Crowd4Test API as this server reaches it, and
     * crowd4test.com as people reach it. Both or neither. Plain strings, so an empty line in .env counts as "not set"; checked by
     * `crowd4testFromConfig`.
     */
    C4T_API_ORIGIN: z.string().optional(),
    C4T_SITE_URL: z.string().optional(),
    /**
     * Crowd4Test's service endpoints (organisations, their projects, the people search; platform/c4t-service.ts): the same value as
     * AI_STUDIO_SERVICE_TOKEN on the Crowd4Test API. Off when unset; never returned by any endpoint.
     */
    C4T_SERVICE_TOKEN: z.string().optional(),
    /** Lowest severity of a finding that triggers alerts (a channel can override it). */
    ALERT_MIN_SEVERITY: z.enum(["critical", "high", "medium", "low"]).default("low"),
    /**
     * Mail server for email alert channels (every email channel uses it unless it carries settings of its own). Kept as plain
     * strings here and read by `serverSmtp()` in platform/alert-email.ts, so an empty line in .env counts as "not set".
     */
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.string().optional(),
    SMTP_SECURE: z.string().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM: z.string().optional(),

    /**
     * Platform-wide retention: when set (7-365), projects without a policy of their own remove evidence files (screenshots, recordings,
     * traces) of passed runs after this many days. Kept as a plain string so an empty line or a typo counts as "not set": see
     * engine/retention/policy.ts. Off unless set.
     */
    RETENTION_DEFAULT_DAYS: z.string().optional(),

    MAX_REPAIR_ATTEMPTS: z.coerce.number().min(0).max(5).default(2),
    /**
     * AI token limits (input + output), off unless set. Defaults only: limits set in the app (Settings, AI usage) win.
     * An empty line in .env counts as "not set".
     */
    AI_MONTHLY_TOKEN_LIMIT: tokenLimit(),
    AI_JOB_TOKEN_LIMIT: tokenLimit(),
    HEADLESS: z
        .string()
        .default("true")
        .transform((v) => v !== "false"),
    /**
     * Hand-written (custom) scripts are arbitrary code: they may run on this server only when this is exactly "true" (default off).
     * A runner agent decides for itself (--allow-custom-scripts). See platform/custom-policy.ts.
     */
    ALLOW_CUSTOM_SCRIPTS: z
        .string()
        .optional()
        .transform((v) => (v ?? "").trim().toLowerCase() === "true"),
    /**
     * Agent runs (the AI driving a browser toward an objective) use this server's own browser until runners can take them. That browser runs
     * beside the platform, so agent runs start only when this is exactly "true" (default off). Local development and tests set it; a shared
     * server does not.
     */
    AGENT_RUNS_ON_SERVER: z
        .string()
        .optional()
        .transform((v) => (v ?? "").trim().toLowerCase() === "true"),
    /**
     * Adapter plug-ins (a testing framework added as an ES module) are code that runs inside this server: they load only when this is exactly
     * "true" (default off) AND API_KEY is set, and only from the paths in ADAPTER_PLUGINS. See engine/frameworks/plugin-loader.ts.
     */
    ALLOW_ADAPTER_PLUGINS: z
        .string()
        .optional()
        .transform((v) => (v ?? "").trim().toLowerCase() === "true"),
    /** Semicolon-separated absolute paths of plug-in files or folders. Read from the environment only, never from the API. */
    ADAPTER_PLUGINS: z.string().optional(),
    /**
     * Security Assessment module (src/security, docs/features/security-assessment.md). Plain strings, parsed leniently by
     * src/security/settings.ts (an empty line or a typo keeps the default): on/off switch (default on), private targets (default off),
     * retention days (365), request cap per assessment (2000), bytes read per response (5 MB), time limit in minutes (30).
     */
    SECURITY_ASSESSMENT: z.string().optional(),
    SECURITY_ALLOW_PRIVATE_TARGETS: z.string().optional(),
    SECURITY_RETENTION_DAYS: z.string().optional(),
    SECURITY_MAX_REQUESTS: z.string().optional(),
    SECURITY_MAX_RESPONSE_BYTES: z.string().optional(),
    SECURITY_ASSESSMENT_MINUTES: z.string().optional(),
    /** Assessments through the company proxy (HTTPS_PROXY / HTTP_PROXY / NO_PROXY): on/off, default off; a proxy on a private address needs SECURITY_PROXY_ALLOW_PRIVATE=true. */
    SECURITY_USE_PROXY: z.string().optional(),
    SECURITY_PROXY_ALLOW_PRIVATE: z.string().optional(),
    /**
     * SCAN: external scanners (src/security/scanners). Every one is off unless SECURITY_SCANNERS names it, so installing a tool on
     * the machine never silently makes it runnable from the product. The paths and the ZAP API key are read on the server only and
     * never reach the browser.
     */
    SECURITY_SCANNERS: z.string().optional(),
    SECURITY_SCANNER_MAX_MINUTES: z.string().optional(),
    SECURITY_SCANNER_REQUEST_BUDGET: z.string().optional(),
    SECURITY_SCANNER_MAX_RPS: z.string().optional(),
    /** Where scanner tools may be found when no explicit path is given (a PATH-like list). */
    SECURITY_SCANNER_BIN_DIRS: z.string().optional(),
    SECURITY_ZAP_URL: z.string().optional(),
    SECURITY_ZAP_API_KEY: z.string().optional(),
    SECURITY_NUCLEI_PATH: z.string().optional(),
    SECURITY_NUCLEI_TEMPLATES: z.string().optional(),
    SECURITY_NUCLEI_CONCURRENCY: z.string().optional(),
    SECURITY_SCHEMATHESIS_PATH: z.string().optional(),
    SECURITY_PROMPTFOO_PATH: z.string().optional(),
    /** Read-only fixtures for scanner integration tests (examples/security-fixture). Off unless a test asks for it. */
    SECURITY_TEST_FIXTURE_URL: z.string().optional(),
});

export type Config = z.infer<typeof EnvSchema> & {
    dataDir: string;
    dbPath: string;
    artifactsDir: string;
    scratchDir: string;
    /** ALLOW_CUSTOM_SCRIPTS was asked for in the environment. `ALLOW_CUSTOM_SCRIPTS` itself is the EFFECTIVE value (see CUSTOM_SCRIPTS_NEEDS_API_KEY). */
    customScriptsRequested: boolean;
    /** Why a requested switch is not in force (set only then). */
    customScriptsReason?: string;
    /** ALLOW_ADAPTER_PLUGINS was asked for in the environment. `ALLOW_ADAPTER_PLUGINS` itself is the EFFECTIVE value (see ADAPTER_PLUGINS_NEED_API_KEY). */
    adapterPluginsRequested: boolean;
    /** Why a requested switch is not in force (set only then). */
    adapterPluginsReason?: string;
};

/**
 * Running hand-written scripts on the server is running code for whoever can reach the API. Without an API_KEY that is everybody who can
 * reach the port, so the switch is then ignored (and the platform says so, loudly, at start and in GET /api/config).
 */
export const CUSTOM_SCRIPTS_NEEDS_API_KEY =
    "ALLOW_CUSTOM_SCRIPTS=true is ignored because API_KEY is not set: anyone who can reach this server could run code on it. Set API_KEY (and keep it secret), or run hand-written tests on a runner agent started with --allow-custom-scripts.";

/**
 * With Crowd4Test sign-in on, everyone who can edit tests is someone else's account on a shared server: a code test would run with this server's
 * rights for all of them. So the switch is refused there, whatever else is set (the platform says so at start, in GET /api/config and in a refused run).
 */
export const CUSTOM_SCRIPTS_NOT_WITH_CROWD4TEST =
    "ALLOW_CUSTOM_SCRIPTS=true is refused because Crowd4Test sign-in is on (C4T_API_ORIGIN): a code test would run with this server's rights for everyone who can edit tests. Remove the setting, and run code tests on a runner agent started with --allow-custom-scripts.";

/**
 * A plug-in is code that runs inside the server with all its power. Without an API_KEY anybody who can reach the port could be affected by whatever
 * it does, so the switch is then ignored (and the platform says so, loudly, at start and in GET /api/config).
 */
export const ADAPTER_PLUGINS_NEED_API_KEY =
    "ALLOW_ADAPTER_PLUGINS=true is ignored because API_KEY is not set: a plug-in is code that runs inside this server. Set API_KEY (and keep it secret) to load adapter plug-ins.";

/** Repo root (this file is src/config.ts). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const parsed = EnvSchema.parse(env);
    const dataDir = path.resolve(parsed.DATA_DIR);
    const customScriptsRequested = parsed.ALLOW_CUSTOM_SCRIPTS === true;
    const hasKey = Boolean(parsed.API_KEY);
    const adapterPluginsRequested = parsed.ALLOW_ADAPTER_PLUGINS === true;
    const crowd4testOn = Boolean(parsed.C4T_API_ORIGIN?.trim() || parsed.C4T_SITE_URL?.trim());
    return {
        ...parsed,
        // Same rule as hand-written scripts: the switch only counts when the API is protected by a key.
        ALLOW_ADAPTER_PLUGINS: adapterPluginsRequested && hasKey,
        adapterPluginsRequested,
        ...(adapterPluginsRequested && !hasKey ? { adapterPluginsReason: ADAPTER_PLUGINS_NEED_API_KEY } : {}),
        // The effective value: the switch only counts when the API is protected by a key.
        ALLOW_CUSTOM_SCRIPTS: customScriptsRequested && hasKey && !crowd4testOn,
        customScriptsRequested,
        ...(customScriptsRequested && crowd4testOn ? { customScriptsReason: CUSTOM_SCRIPTS_NOT_WITH_CROWD4TEST } : customScriptsRequested && !hasKey ? { customScriptsReason: CUSTOM_SCRIPTS_NEEDS_API_KEY } : {}),
        dataDir,
        dbPath: path.join(dataDir, "platform.db"),
        artifactsDir: path.join(dataDir, "generated-tests"),
        // Must live inside the repo tree so generated specs resolve @playwright/test from node_modules.
        scratchDir: path.join(REPO_ROOT, ".validation"),
    };
}
