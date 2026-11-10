/**
 * Runbooks: the definition of a small ordered workflow ("run the smoke tests; if they pass run everything, otherwise tell the
 * team and stop"). Pure: no I/O, no clock. The platform (platform/runbook-runner.ts) executes a definition through the jobs it
 * already has; this file only says what a valid definition is.
 *
 * A runbook always terminates: a step may route only to a LATER step (or "next" / "stop"), so there are no loops, and the list
 * is short (12 steps) with a time cap on the whole run.
 */
import { z } from "zod";
import { ENV_NAME } from "../environments/env.js";
import { isUnknownKind } from "../zod-issue.js";

export const RUNBOOK_VERSION = 1;
export const MAX_STEPS = 12;
export const MAX_NAME = 80;
export const MAX_WAIT_SECONDS = 300;
export const MAX_MESSAGE = 500;
/** Runbooks per project (a list longer than this is hard to keep tidy). */
export const MAX_RUNBOOKS = 20;

/** Step ids are short names the routes refer to ("smoke", "everything"). "next" and "stop" are routing words, not ids. */
export const STEP_ID = /^[a-z][a-z0-9_-]{0,31}$/;
export const RESERVED_IDS = ["next", "stop"];

/** The only placeholders a notify message may use. Anything else is rejected when the runbook is saved. */
export const PLACEHOLDERS = ["project", "status", "passRate", "failed", "runUrl"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

export const STEP_TYPES = ["run", "analyze", "condition", "notify", "wait"] as const;
export type StepType = (typeof STEP_TYPES)[number];

const Route = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, "A route is “next”, “stop” or the id of a later step");

const Scope = z.union([
    z.literal("all"),
    z
        .object({
            suite: z.string().trim().min(1).max(80).optional(),
            tag: z.string().trim().min(1).max(60).optional(),
            /** The kind of test: smoke, functional, security... */
            type: z.string().trim().min(1).max(40).optional(),
            testIds: z.array(z.string().trim().min(1).max(80)).min(1).max(200).optional(),
        })
        .strict()
        .refine((s) => s.suite !== undefined || s.tag !== undefined || s.type !== undefined || s.testIds !== undefined, { message: "Choose a suite, a tag, a type of test or specific tests, or run all tests" }),
]);
export type Scope = z.infer<typeof Scope>;

const base = {
    id: z.string().regex(STEP_ID, "A step id starts with a lowercase letter and uses letters, digits, - or _ (up to 32 characters)"),
    /** Shown in the editor and in the run; a default is made from the step when it is left out. */
    title: z.string().trim().min(1).max(80).optional(),
    onPass: Route.optional(),
    onFail: Route.optional(),
};

export const RunStep = z
    .object({
        ...base,
        type: z.literal("run"),
        scope: Scope.default("all"),
        /** A named environment of the project (staging...). Omitted: the project's own address. */
        environment: z.string().regex(ENV_NAME, "Use an environment name from this project").optional(),
        /** Run a failing test again this many times straight away; a pass after a fail is a flaky pass. */
        retries: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(1),
        /** Needed when the environment is a production one. */
        confirmProduction: z.boolean().optional(),
        /** Include mobile tests (only when this machine can run them). Off unless asked for. */
        includeMobile: z.boolean().optional(),
    })
    .strict();

export const AnalyzeStep = z
    .object({
        ...base,
        type: z.literal("analyze"),
        /** Analyze again may create POST/PUT/PATCH/DELETE tests that change data. Off unless the runbook says so. */
        allowMutatingApiTests: z.boolean().optional(),
        /** Include the basic load check. Off unless the runbook says so. */
        loadChecks: z.boolean().optional(),
    })
    .strict();

export const Condition = z.discriminatedUnion("check", [
    z.object({ check: z.literal("passRate"), atLeast: z.number().min(0).max(100) }).strict(),
    z.object({ check: z.literal("noFailures") }).strict(),
    z.object({ check: z.literal("noHighSeverity") }).strict(),
    z.object({ check: z.literal("noApiBreakingChange") }).strict(),
    z.object({ check: z.literal("readiness") }).strict(),
]);
export type Condition = z.infer<typeof Condition>;
export const CONDITION_CHECKS = ["passRate", "noFailures", "noHighSeverity", "noApiBreakingChange", "readiness"] as const;

export const ConditionStep = z.object({ ...base, type: z.literal("condition"), condition: Condition }).strict();

export const NotifyStep = z
    .object({
        ...base,
        type: z.literal("notify"),
        channelId: z.string().trim().min(1).max(64),
        message: z.string().trim().min(1).max(MAX_MESSAGE),
    })
    .strict();

export const WaitStep = z.object({ ...base, type: z.literal("wait"), seconds: z.number().int().min(1).max(MAX_WAIT_SECONDS) }).strict();

export const Step = z.discriminatedUnion("type", [RunStep, AnalyzeStep, ConditionStep, NotifyStep, WaitStep]);
export type Step = z.infer<typeof Step>;
export type RunStepT = z.infer<typeof RunStep>;
export type AnalyzeStepT = z.infer<typeof AnalyzeStep>;
export type ConditionStepT = z.infer<typeof ConditionStep>;
export type NotifyStepT = z.infer<typeof NotifyStep>;
export type WaitStepT = z.infer<typeof WaitStep>;

/** Every `{{name}}` in a text, and anything that looks like a placeholder but is not well formed. */
const TOKEN = /\{\{\s*([^{}\s]*)\s*\}\}/g;

/** Problems in a notify message's placeholders, in plain words (empty = fine). */
export function templateProblems(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(TOKEN)) {
        const name = m[1] ?? "";
        if (!(PLACEHOLDERS as readonly string[]).includes(name)) out.push(`“{{${name}}}” is not a placeholder you can use. Use ${PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")}.`);
    }
    // A brace pair that never closed (or closed wrongly) would be sent as written: catch the typo now.
    const rest = text.replace(TOKEN, "");
    if (/\{\{|\}\}/.test(rest)) out.push("A {{placeholder}} is missing a brace. Write it as {{name}}.");
    return [...new Set(out)];
}

/** The text with each placeholder replaced; unknown names are left as written (they cannot get past saving). */
export function renderTemplate(text: string, values: Record<Placeholder, string>): string {
    return text.replace(TOKEN, (whole, name: string) => ((PLACEHOLDERS as readonly string[]).includes(name) ? values[name as Placeholder] : whole));
}

export const RunbookDefinition = z
    .object({
        version: z.literal(RUNBOOK_VERSION),
        name: z.string().trim().min(1, "Give the runbook a name").max(MAX_NAME, `A name can be up to ${MAX_NAME} characters`),
        description: z.string().trim().max(300).optional(),
        steps: z.array(Step).min(1, "A runbook needs at least one step").max(MAX_STEPS, `A runbook can have up to ${MAX_STEPS} steps`),
    })
    .strict()
    .superRefine((def, ctx) => {
        const add = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
        const index = new Map<string, number>();
        def.steps.forEach((s, i) => {
            if (RESERVED_IDS.includes(s.id)) add(["steps", i, "id"], `“${s.id}” is a routing word; give the step another id`);
            else if (index.has(s.id)) add(["steps", i, "id"], `Two steps use the id “${s.id}”`);
            else index.set(s.id, i);
        });

        let sawRun = false;
        def.steps.forEach((s, i) => {
            const at = (f: string) => ["steps", i, f];
            const label = `Step ${i + 1}`;
            for (const key of ["onPass", "onFail"] as const) {
                const target = s[key];
                if (target === undefined || target === "next" || target === "stop") continue;
                const to = index.get(target);
                if (to === undefined) add(at(key), `${label}: there is no step with the id “${target}”`);
                else if (to === i) add(at(key), `${label}: a step cannot send the run back to itself`);
                else if (to < i) add(at(key), `${label}: “${target}” comes before this step. A runbook only moves forward, so it can never loop`);
            }
            // These two never fail the run, so a failure route would silently do nothing.
            if ((s.type === "wait" || s.type === "notify") && s.onFail !== undefined) add(at("onFail"), `${label}: a ${s.type} step always moves on; remove “if it fails”`);

            if (s.type === "run" || s.type === "analyze") sawRun = true;
            if (s.type === "condition" && !sawRun) add(["steps", i], `${label}: a check needs a “run tests” or “analyze” step before it to look at`);
            if (s.type === "notify") for (const problem of templateProblems(s.message)) add(at("message"), `${label}: ${problem}`);
            if (s.type === "run" && s.confirmProduction && !s.environment) add(at("confirmProduction"), `${label}: confirmProduction only applies to a step that names an environment`);
        });
    });
export type RunbookDefinition = z.infer<typeof RunbookDefinition>;

export type ParseResult = { ok: true; definition: RunbookDefinition } | { ok: false; errors: Array<{ path: string; message: string }> };

/** Validate untrusted JSON. Messages are written for a person; `path` is where in the definition they apply. */
export function parseDefinition(input: unknown): ParseResult {
    const r = RunbookDefinition.safeParse(input);
    if (r.success) return { ok: true, definition: r.data };
    return {
        ok: false,
        errors: r.error.issues.map((i) => ({ path: i.path.join("."), message: friendly(i) })),
    };
}

function friendly(i: z.ZodIssue): string {
    const where = i.path[0] === "steps" && typeof i.path[1] === "number" ? `Step ${i.path[1] + 1}: ` : "";
    if (i.code === "custom") return i.message;
    if (i.code === "unrecognized_keys") return `${where}${i.keys.map((k) => `“${k}”`).join(", ")} ${i.keys.length === 1 ? "is" : "are"} not a setting of this step`;
    if (isUnknownKind(i)) return `${where}the step type must be one of ${STEP_TYPES.join(", ")}`;
    if (i.path.length === 1 && i.path[0] === "version") return `The runbook version must be ${RUNBOOK_VERSION}`;
    const field = i.path.slice(2).join(".");
    return `${where}${field ? `${field}: ` : ""}${i.message}`;
}

/** What the project looks like, for the checks that need it. Injected so this file stays free of I/O. */
export interface ProjectLookups {
    /** The named environment, or undefined when the project has none by that name. */
    environment(name: string): { production: boolean } | undefined;
    /** Does the project have this alert channel? */
    channelExists(id: string): boolean;
}

/** Checks that need to know the project: environments that exist, production confirmation, alert channels that exist. */
export function projectProblems(def: RunbookDefinition, lookups: ProjectLookups): Array<{ path: string; message: string; requiresConfirmation?: boolean }> {
    const out: Array<{ path: string; message: string; requiresConfirmation?: boolean }> = [];
    def.steps.forEach((s, i) => {
        const label = `Step ${i + 1}`;
        if (s.type === "run" && s.environment) {
            const env = lookups.environment(s.environment);
            if (!env) out.push({ path: `steps.${i}.environment`, message: `${label}: this project has no environment called “${s.environment}”` });
            else if (env.production && !s.confirmProduction) {
                out.push({ path: `steps.${i}.confirmProduction`, message: `${label}: “${s.environment}” is a production environment. Confirm that this step may run there (confirmProduction: true).`, requiresConfirmation: true });
            }
        }
        if (s.type === "notify" && !lookups.channelExists(s.channelId)) out.push({ path: `steps.${i}.channelId`, message: `${label}: this project has no alert channel with that id` });
    });
    return out;
}
