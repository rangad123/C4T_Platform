/**
 * The right model for each job, with escalation (docs/features/model-routing.md).
 *
 * A server can name a second, cheaper "fast" model next to the main one (LLM_MODEL_FAST, or Settings, AI model). Routine work goes to
 * the fast model; understanding the application, planning, repairs and anything with images stay on the main model. Empty = no fast
 * model = every call uses the main model exactly as before (the job then gets the plain client, not this wrapper).
 *
 * How a call finds its model:
 *  - the job's client is `routedClient(main, { fast })`, an ordinary `LlmClient` (the usage meter wraps it unchanged). Each call is
 *    routed by its task: the task of the route scope it runs in (`withRoute`, opened by the agent loops), otherwise its purpose label.
 *    `ROUTE_TABLE` is the whole rule set.
 *  - the web authoring agent talks to `client.model` directly; that model is a `RoutedModel` that picks fast or main for every step.
 *
 * Escalation (the fast model's answer is unusable, so the main model takes over):
 *  - a call to the fast model that fails (no valid structured output after the existing re-ask, the fast model unavailable after its
 *    retries, a refused or rejected request) is asked again, the same call, on the main model;
 *  - in an agent loop: the same action failing twice, the same action three times in a row, or four steps without progress
 *    (`ESCALATION_LIMITS`) move the rest of that scope (one scenario, one phone exploration) to the main model.
 * Every escalation is told to the job and counted in AI usage ("escalated to the main model").
 *
 * Per scenario state lives in an AsyncLocalStorage scope, so the scenarios one job authors at the same time never share it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { LanguageModel } from "ai";
import type { Config } from "../../config.js";
import type { EngineEvent } from "../context.js";
import { CLASS_RULES, classifyLlmError } from "./errors.js";
import { createLlmClient, describeFallbacks, LlmNotConfiguredError, parseFallbackModels, type CreateClientOptions, type LlmClient, type LlmProviderId, type Usage } from "./provider.js";
import { answeredSlot, type ModelV3 } from "./resilience.js";
import { modelCallPurpose } from "./metered.js";
import { isBudgetExceeded, normalisePurpose, type LlmPurpose } from "./usage.js";

// ── the table ────────────────────────────────────────────────────────────────

/** What a call is doing: its purpose label, or the task of the agent loop it runs in. */
export type RouteTask = LlmPurpose | "phone-explore";
/** "strong": the planning and review model when one is chosen, else the main model (STRONG_TASKS). */
export type RouteTarget = "fast" | "main" | "strong";

/** The routing rules. Calls with images go to the main model whatever their task, unless the fast model is marked as able to see them. */
export const ROUTE_TABLE: Readonly<Record<RouteTask, { model: "fast" | "main"; what: string }>> = {
    authoring: { model: "fast", what: "Steps of the agent that writes a web test (new scenarios and plain-English web tests)" },
    "phone-explore": { model: "fast", what: "Turns of the phone exploration (one action per screen)" },
    plain: { model: "fast", what: "Choosing the API operation and checks of a plain-English API test" },
    analysis: { model: "main", what: "Understanding the application, reading its documentation" },
    planning: { model: "main", what: "Planning tests (including the pass for what the plan does not cover yet), phone test ideas, reading a requirements document" },
    review: { model: "main", what: "Reviewing each written web test against its scenario" },
    repair: { model: "main", what: "Why a test failed, repairing it (including the agent re-writing a failing web test), phone repair suggestions" },
    vision: { model: "main", what: "Anything with images (screenshot judgements), unless the fast model is marked as able to see images" },
    other: { model: "main", what: "Anything not labelled" },
};

/**
 * Work that goes to the strongest model: the planning and review model when one is chosen (Settings, AI model), otherwise the main model.
 * Never the fast model. A call is strong by the task of the route scope it runs in, else by its purpose; a review is strong in any scope
 * (it runs inside a scenario's authoring scope). The phone explorer's turns, labelled analysis inside their own scope, stay as they were.
 */
export const STRONG_TASKS: ReadonlySet<RouteTask> = new Set<RouteTask>(["analysis", "planning", "review"]);
export function isStrongCall(purpose: unknown, scope: RouteScope | undefined): boolean {
    const p = normalisePurpose(purpose);
    return p === "review" || STRONG_TASKS.has(scope?.task ?? p);
}

/** When the fast model is taken off an agent loop. */
export const ESCALATION_LIMITS = { sameActionFails: 2, sameActionRepeats: 3, stepsWithoutProgress: 4 } as const;

/** Pure: which model a call uses. */
export function chooseModel(r: { task: RouteTask; images: boolean; escalated: boolean; fastImages: boolean }): RouteTarget {
    if (r.escalated) return "main";
    if (r.images) return r.fastImages ? "fast" : "main";
    return ROUTE_TABLE[r.task]?.model ?? "main";
}

// ── scopes (one scenario, one exploration) ───────────────────────────────────

/** One action of an agent step: `key` identifies it (tool and arguments), `progress` = it moved something (defaults to `ok`). */
export interface AgentAction {
    key: string;
    ok: boolean;
    progress?: boolean;
}

type ScopeOwner = (scope: RouteScope, reason: string) => void;

export class RouteScope {
    escalated = false;
    reason?: string;
    private owner?: ScopeOwner;
    private readonly fails = new Map<string, number>();
    private lastKey = "";
    private repeats = 0;
    private idle = 0;

    constructor(
        readonly task: RouteTask,
        /** How the job log names this piece of work ("Scenario S-001", "The phone exploration"). */
        readonly what: string,
    ) {}

    /** The routed client this scope's calls go through (the first one wins: one job, one client). */
    bind(owner: ScopeOwner): void {
        this.owner ??= owner;
    }

    /** Move the rest of this scope to the main model. Only the first reason counts. */
    escalate(reason: string): void {
        if (this.escalated) return;
        this.escalated = true;
        this.reason = reason;
        this.owner?.(this, reason);
    }

    /** One agent step's actions, checked against ESCALATION_LIMITS. */
    observe(actions: readonly AgentAction[]): void {
        if (this.escalated) return;
        const L = ESCALATION_LIMITS;
        let progressed = false;
        for (const a of actions) {
            if (!a.ok) {
                const n = (this.fails.get(a.key) ?? 0) + 1;
                this.fails.set(a.key, n);
                if (n >= L.sameActionFails) return this.escalate("tried the same action twice and it failed both times");
            }
            this.repeats = a.key === this.lastKey ? this.repeats + 1 : 1;
            this.lastKey = a.key;
            if (this.repeats >= L.sameActionRepeats) return this.escalate(`repeated the same action ${L.sameActionRepeats} times in a row`);
            if (a.ok && (a.progress ?? true)) progressed = true;
        }
        this.idle = progressed ? 0 : this.idle + 1;
        if (this.idle >= L.stepsWithoutProgress) this.escalate(`made no progress for ${L.stepsWithoutProgress} steps`);
    }
}

const scopes = new AsyncLocalStorage<RouteScope>();

/** Run one piece of agent work (a scenario, an exploration) in its own route scope. */
export function withRoute<T>(o: { task: RouteTask; what: string }, fn: () => Promise<T>): Promise<T> {
    return scopes.run(new RouteScope(o.task, o.what), fn);
}

export const currentRoute = (): RouteScope | undefined => scopes.getStore();

/** Report actions of the current scope's agent (no-op outside a scope). */
export function noteRouteActions(actions: readonly AgentAction[]): void {
    currentRoute()?.observe(actions);
}

/** Move the rest of the current scope to the main model (no-op outside a scope). */
export function escalateRoute(reason: string): void {
    currentRoute()?.escalate(reason);
}

/** A tool call's identity: its name and arguments, without the free-text description the model may word differently each time. */
export function actionKey(toolName: string, input: unknown): string {
    const strip = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(strip);
        if (v && typeof v === "object") {
            return Object.fromEntries(
                Object.entries(v as Record<string, unknown>)
                    .filter(([k]) => k !== "why" && k !== "description")
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([k, x]) => [k, strip(x)]),
            );
        }
        return v;
    };
    let parsed = input;
    if (typeof input === "string") {
        try {
            parsed = JSON.parse(input);
        } catch {
            parsed = input;
        }
    }
    return `${toolName} ${JSON.stringify(strip(parsed)) ?? ""}`.slice(0, 600);
}

interface StepPart {
    type: string;
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
}

/**
 * Read-only looks of the web agent (the whole page again, a look at the screen): neither an action nor a lack of progress, so the
 * escalation rules do not see them at all (two looks in a row are not "repeating itself").
 */
export const LOOK_TOOLS: ReadonlySet<string> = new Set(["seeWholePage", "lookAtScreen"]);

/** The actions of one finished step of an AI SDK tool loop: a result with `success: false` or a tool error is a failed action. Looks are left out. */
export function actionsOfStep(step: { content?: readonly unknown[] }): AgentAction[] {
    const parts = ((step.content ?? []) as StepPart[]).filter((p) => !LOOK_TOOLS.has(p.toolName ?? ""));
    const calls = parts.filter((p) => p.type === "tool-call");
    const outcome = new Map<string, boolean>();
    for (const p of parts) {
        if (!p.toolCallId) continue;
        if (p.type === "tool-error") outcome.set(p.toolCallId, false);
        else if (p.type === "tool-result") outcome.set(p.toolCallId, !(p.output && typeof p.output === "object" && (p.output as { success?: unknown }).success === false));
    }
    const out: AgentAction[] = calls.map((c) => ({ key: actionKey(c.toolName ?? "?", c.input), ok: outcome.get(c.toolCallId ?? "") ?? true }));
    // A tool error without its call (an invalid call the SDK reports on its own) is a failed action too.
    for (const p of parts) if (p.type === "tool-error" && !calls.some((c) => c.toolCallId === p.toolCallId)) out.push({ key: actionKey(p.toolName ?? "?", p.input), ok: false });
    return out;
}

/** For an AI SDK `onStepFinish`: report the step to the current scope. */
export function noteAgentStep(step: { content?: readonly unknown[] }): void {
    const scope = currentRoute();
    if (!scope) return;
    // A step that only looked (called look tools and nothing else) is neutral: not counted as a step without progress either.
    const parts = (step.content ?? []) as StepPart[];
    const tools = parts.filter((p) => p.type === "tool-call" || p.type === "tool-error");
    if (tools.length > 0 && tools.every((p) => LOOK_TOOLS.has(p.toolName ?? ""))) return;
    scope.observe(actionsOfStep(step));
}

// ── the routed client ────────────────────────────────────────────────────────

export interface Escalation {
    from: string;
    to: string;
    reason: string;
    /** The scope's name, or undefined for a single call outside any scope. */
    what?: string;
    task: RouteTask;
    /** The call that failed was asked again on the main model (false: the main model takes over from the next step). */
    retried: boolean;
}

export interface RoutingSetup {
    /** The fast model; absent = no fast model (only the planning and review model is routed). */
    fast?: LlmClient;
    /** The planning and review model (STRONG_TASKS); absent = the main model does that work. */
    strong?: LlmClient;
    /** The fast model can look at images: calls with images may go to it. Default false. */
    fastImages?: boolean;
    /** Called once per escalation (the platform counts it in AI usage). */
    onEscalation?: (e: Escalation) => void;
}

/** Escalation events told to one job at most (the usage count is never capped). */
const MAX_ESCALATION_EVENTS = 20;

/** Errors no other model would change: the job was stopped, the AI limit was reached, no model is set up. */
function final(e: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) return true;
    if (isBudgetExceeded(e) || e instanceof LlmNotConfiguredError) return true;
    return e instanceof Error && e.name === "AbortError";
}

function reasonOf(e: unknown): string {
    const info = classifyLlmError(e);
    if (info.cls === "bad_output") return "gave no usable answer";
    if (CLASS_RULES[info.cls].fallback) return `was unavailable (${CLASS_RULES[info.cls].label.toLowerCase()})`;
    return `failed (${CLASS_RULES[info.cls].label.toLowerCase()})`;
}

/**
 * One usage counter object over several clients: reading a field gives the sum, writing one (the authoring agent adds each step's
 * numbers to `client.usage`) changes only the part that belongs to no inner client. Works for any numeric field.
 */
export function combinedUsage(parts: readonly Usage[]): Usage {
    const own: Record<string, number> = {};
    for (const p of parts) for (const [k, v] of Object.entries(p)) if (typeof v === "number") own[k] = 0;
    const sum = (k: string) => parts.reduce((s, p) => s + (typeof (p as unknown as Record<string, unknown>)[k] === "number" ? ((p as unknown as Record<string, number>)[k] ?? 0) : 0), 0);
    return new Proxy(own, {
        // A counter an inner client starts later (prompt-cache reads, for example) is listed too, so a copy (`{ ...usage }`) has it.
        ownKeys(t) {
            for (const p of parts) for (const [k, v] of Object.entries(p)) if (typeof v === "number" && !(k in t)) t[k] = 0;
            return Reflect.ownKeys(t);
        },
        get(t, k) {
            if (typeof k !== "string") return Reflect.get(t, k);
            const v = t[k];
            const others = sum(k);
            if (typeof v === "number") return v + others;
            return others === 0 ? v : others;
        },
        set(t, k, v) {
            if (typeof k === "string" && typeof v === "number") {
                t[k] = v - sum(k);
                return true;
            }
            return Reflect.set(t, k, v);
        },
    }) as unknown as Usage;
}

const isV3 = (m: unknown): m is ModelV3 => typeof m === "object" && m !== null && (m as { specificationVersion?: string }).specificationVersion === "v3";

/** Tell the usage meter which model this call goes to (a resilient model overwrites it with the one that really answered). */
function tellSlot(name: string): void {
    const slot = answeredSlot.getStore();
    if (slot) slot.model = name;
}

/** The model the web authoring agent steps through: every step goes to fast or main as its scope says. */
export class RoutedModel implements ModelV3 {
    readonly specificationVersion = "v3" as const;
    constructor(
        private readonly main: ModelV3,
        private readonly fast: ModelV3,
        private readonly names: { main: string; fast: string },
        private readonly decide: (scope: RouteScope | undefined) => RouteTarget,
        private readonly escalate: (scope: RouteScope | undefined, reason: string, retried: boolean) => void,
        /** The planning and review model, for direct calls whose purpose is one of STRONG_TASKS (a runner's proxied calls); absent: main. */
        private readonly strong?: { model: ModelV3; name: string; fellBack: (reason: string) => void },
    ) {}
    get provider() {
        return this.main.provider;
    }
    get modelId() {
        return this.main.modelId;
    }
    get supportedUrls() {
        return this.main.supportedUrls;
    }

    doGenerate(options: Parameters<ModelV3["doGenerate"]>[0]): ReturnType<ModelV3["doGenerate"]> {
        return this.run(options, (m, o) => m.doGenerate(o));
    }
    doStream(options: Parameters<ModelV3["doStream"]>[0]): ReturnType<ModelV3["doStream"]> {
        return this.run(options, (m, o) => m.doStream(o));
    }

    private async run<R>(options: Parameters<ModelV3["doGenerate"]>[0], call: (m: ModelV3, o: Parameters<ModelV3["doGenerate"]>[0]) => PromiseLike<R>): Promise<R> {
        const scope = currentRoute();
        const target = this.decide(scope);
        if (target === "strong" && this.strong) {
            tellSlot(this.strong.name);
            try {
                return await call(this.strong.model, options);
            } catch (e) {
                if (final(e, options.abortSignal)) throw e;
                this.strong.fellBack(reasonOf(e));
                tellSlot(this.names.main);
                return call(this.main, options);
            }
        }
        if (target !== "fast") {
            tellSlot(this.names.main);
            return call(this.main, options);
        }
        tellSlot(this.names.fast);
        try {
            return await call(this.fast, options);
        } catch (e) {
            if (final(e, options.abortSignal)) throw e;
            // The same step, asked again on the main model.
            this.escalate(scope, reasonOf(e), true);
            tellSlot(this.names.main);
            return call(this.main, options);
        }
    }
}

/**
 * The job's client with a fast model next to the main one. Same interface as any client: the meter, the engine and the tests use it
 * unchanged. Without a fast model the job is given `main` itself (see `withModelRouting`), never this wrapper.
 */
export function routedClient(main: LlmClient, setup: RoutingSetup): LlmClient {
    const { fast, strong } = setup;
    // Images go to the fast model only when it is marked as able to see them and its client can send them.
    const fastImages = setup.fastImages === true && typeof fast?.imageObject === "function";
    let sink: ((e: EngineEvent) => void) | undefined;
    let events = 0;

    const tell = (e: Escalation) => {
        try {
            setup.onEscalation?.(e);
        } catch {
            // Counting is best effort: never a reason for the call to fail.
        }
        if (!sink || events >= MAX_ESCALATION_EVENTS) return;
        events++;
        const message = e.what
            ? `${e.what}: the fast AI model ${e.from} ${e.reason}, so the main model ${e.to} ${e.retried ? "answered that step again and " : ""}does the rest of it.`
            : `The fast AI model ${e.from} ${e.reason}, so the main model ${e.to} answered that call instead.`;
        try {
            sink({ stage: "orchestration", kind: "ai_model_escalated", level: "info", message, data: { from: e.from, to: e.to, reason: e.reason, task: e.task, ...(e.what ? { what: e.what } : {}) } });
        } catch {
            // Telling the job is best effort.
        }
    };

    /** Which model a call in this scope uses (escalation is only meaningful while the scope is on the fast model). */
    const targetOf = (scope: RouteScope | undefined, task: RouteTask, images: boolean): RouteTarget => (fast ? chooseModel({ task, images, escalated: scope?.escalated === true, fastImages }) : "main");

    /** The planning and review model failed a call (not for a final reason): the main model answered it. Told to the job, bounded. */
    const strongFellBack = (reason: string) => {
        if (!sink || !strong || events >= MAX_ESCALATION_EVENTS) return;
        events++;
        try {
            sink({ stage: "orchestration", kind: "ai_planning_model_fallback", level: "warn", message: `The planning and review model ${strong.modelName} ${reason}, so the main model ${main.modelName} answered that call instead.`, data: { from: strong.modelName, to: main.modelName, reason } });
        } catch {
            // Telling the job is best effort.
        }
    };

    /** A scope's owner: called when its agent loop asks for the main model. */
    const owner: ScopeOwner = (scope, reason) => {
        if (!fast || chooseModel({ task: scope.task, images: false, escalated: false, fastImages }) !== "fast") return;
        tell({ from: fast.modelName, to: main.modelName, reason, what: scope.what, task: scope.task, retried: false });
    };

    /** A failed fast call: the scope (if any) moves to the main model; the call itself is asked again there. */
    const escalateCall = (scope: RouteScope | undefined, task: RouteTask, reason: string) => {
        if (scope && !scope.escalated) {
            // Marked first, so the owner callback does not tell it a second time.
            scope.escalated = true;
            scope.reason = reason;
        }
        if (fast) tell({ from: fast.modelName, to: main.modelName, reason, what: scope?.what, task, retried: true });
    };

    async function route<R>(purpose: unknown, images: boolean, call: (c: LlmClient) => Promise<R>): Promise<R> {
        // Analysis, planning and review: the strongest model, whatever scope the call runs in.
        if (isStrongCall(purpose, currentRoute())) {
            if (!strong || (images && typeof strong.imageObject !== "function")) {
                tellSlot(main.modelName);
                return call(main);
            }
            tellSlot(strong.modelName);
            try {
                return await call(strong);
            } catch (e) {
                if (final(e)) throw e;
                strongFellBack(reasonOf(e));
                tellSlot(main.modelName);
                return call(main);
            }
        }
        const scope = currentRoute();
        scope?.bind(owner);
        const task: RouteTask = scope?.task ?? normalisePurpose(purpose);
        if (!fast || targetOf(scope, task, images) !== "fast") {
            tellSlot(main.modelName);
            return call(main);
        }
        tellSlot(fast.modelName);
        try {
            return await call(fast);
        } catch (e) {
            if (final(e)) throw e;
            escalateCall(scope, task, reasonOf(e));
            tellSlot(main.modelName);
            return call(main);
        }
    }

    let routedModel: LanguageModel | undefined;
    const client: LlmClient = {
        modelName: main.modelName,
        get model(): LanguageModel {
            if (routedModel) return routedModel;
            const m = main.model;
            const f = fast?.model;
            const s = strong?.model;
            // A model given as a plain id cannot be stepped through: the agent then uses the main model, as without routing.
            const fastOk = isV3(f);
            const strongOk = isV3(s);
            if (!isV3(m) || (!fastOk && !strongOk)) return (routedModel = m);
            routedModel = new RoutedModel(
                m,
                fastOk ? f : m,
                { main: main.modelName, fast: fast?.modelName ?? main.modelName },
                (scope) => {
                    // A direct call that says it is analysis, planning or review (a runner's proxied call): the strongest model.
                    if (isStrongCall(modelCallPurpose.getStore(), scope)) return "strong";
                    if (!fastOk) return "main";
                    scope?.bind(owner);
                    // Agent steps outside a scope have no escalation to protect them: they stay on the main model.
                    return scope ? targetOf(scope, scope.task, false) : "main";
                },
                (scope, reason) => escalateCall(scope, scope?.task ?? "authoring", reason),
                strongOk ? { model: s, name: strong!.modelName, fellBack: strongFellBack } : undefined,
            );
            return routedModel;
        },
        usage: combinedUsage([main.usage, ...(fast ? [fast.usage] : []), ...(strong ? [strong.usage] : [])]),
        object: ((args: Parameters<LlmClient["object"]>[0]) => route(args.purpose, false, (c) => c.object(args))) as LlmClient["object"],
        text: (args) => route(args.purpose, false, (c) => c.text(args)),
        setEventSink(fn) {
            sink = fn;
            main.setEventSink?.(fn);
            fast?.setEventSink?.(fn);
            strong?.setEventSink?.(fn);
        },
    };
    // "Can this client look at images" stays exactly what the main client says; a fast model without images never gets them.
    if (typeof main.imageObject === "function") {
        client.imageObject = ((args: Parameters<NonNullable<LlmClient["imageObject"]>>[0]) => route(args.purpose ?? "vision", true, (c) => c.imageObject!(args))) as NonNullable<LlmClient["imageObject"]>;
    }
    return client;
}

// ── the setting ──────────────────────────────────────────────────────────────

export interface FastModelSetting {
    /** `[provider:]model`; empty = no fast model. */
    model: string;
    /** The fast model can look at images. */
    images: boolean;
}

/** Where the Settings value comes from (installed by platform/llm-routing.ts); undefined from it = nobody saved one in the app. */
let fastSource: (() => FastModelSetting | undefined) | undefined;
export function setFastModelSource(fn: (() => FastModelSetting | undefined) | undefined): void {
    fastSource = fn;
}

/** Where the saved planning and review model comes from (platform/llm-routing.ts); undefined or "" = none (the main model does that work). */
let planningSource: (() => string | undefined) | undefined;
export function setPlanningModelSource(fn: (() => string | undefined) | undefined): void {
    planningSource = fn;
}

export interface PlanningModelView {
    /** The planning and review model in force; null = none (the main model plans and reviews). */
    provider: LlmProviderId | null;
    model: string | null;
    /** Whether this server can use it (a key for its provider, not the main model itself), and why not. */
    ready: boolean;
    reason?: string;
}

/** The planning and review model saved in Settings (no environment variable: without one, the main model does that work). */
export function configuredPlanningModel(cfg: Config): PlanningModelView {
    let raw = "";
    try {
        raw = (planningSource?.() ?? "").trim();
    } catch {
        raw = "";
    }
    const entry = parseFallbackModels(raw, cfg.LLM_PROVIDER)[0];
    if (!entry) return { provider: null, model: null, ready: false, ...(raw ? { reason: "The model name could not be read." } : {}) };
    const [d] = describeFallbacks(cfg, [entry]);
    return { provider: entry.provider, model: entry.model, ready: d!.ready, ...(d!.reason ? { reason: d!.reason } : {}) };
}

/** The reason provider.ts gives for an entry that names the main model itself. */
const MAIN_ALREADY = "This is the main model already.";

const truthy = (v: string | undefined) => ["true", "1", "yes", "on"].includes((v ?? "").trim().toLowerCase());

export interface FastModelView {
    /** The fast model in force; null = none (every call uses the main model). */
    provider: LlmProviderId | null;
    model: string | null;
    images: boolean;
    /** app = saved in Settings, environment = LLM_MODEL_FAST, none = not set. */
    source: "app" | "environment" | "none";
    /** Whether this server can use it (a key for its provider, not the main model itself), and why not. */
    ready: boolean;
    reason?: string;
    /** What the server's environment says, shown next to the Settings value. */
    environment: string;
}

/** The fast model in force: Settings first, then the environment. */
export function configuredFastModel(cfg: Config): FastModelView {
    let fromApp: FastModelSetting | undefined;
    try {
        fromApp = fastSource?.();
    } catch {
        fromApp = undefined;
    }
    const environment = (cfg.LLM_MODEL_FAST ?? "").trim();
    const raw = fromApp ? fromApp.model : environment;
    const images = fromApp ? fromApp.images : truthy(cfg.LLM_MODEL_FAST_IMAGES);
    const source = fromApp ? "app" : environment ? "environment" : "none";
    const entry = parseFallbackModels(raw, cfg.LLM_PROVIDER)[0];
    if (!entry) return { provider: null, model: null, images, source, ready: false, environment, ...(raw.trim() ? { reason: "The model name could not be read." } : {}) };
    const [d] = describeFallbacks(cfg, [entry]);
    return { provider: entry.provider, model: entry.model, images, source, ready: d!.ready, environment, ...(d!.reason ? { reason: d!.reason } : {}) };
}

/** The fast model's own client: no fallback models (a fast model that is unavailable escalates to the main model and its fallbacks). */
export function createFastClient(cfg: Config, view: Pick<FastModelView, "provider" | "model">, opts: CreateClientOptions = {}): LlmClient {
    const provider = view.provider!;
    const fastCfg: Config = { ...cfg, LLM_PROVIDER: provider, LLM_MODEL: view.model!, LLM_API_KEY: provider === cfg.LLM_PROVIDER ? cfg.LLM_API_KEY : undefined, LLM_FALLBACK_MODELS: undefined };
    return createLlmClient(fastCfg, { ...opts, fallbacks: [] });
}

/**
 * The job's client: `main` itself when neither a fast model nor a planning and review model is set (today's behaviour, byte for byte),
 * the routed client otherwise. `note` says in words why a model that is set is not used.
 */
export function withModelRouting(
    cfg: Config,
    main: LlmClient,
    o: { fast?: LlmClient; strong?: LlmClient; clientOptions?: CreateClientOptions; onEscalation?: (e: Escalation) => void } = {},
): { client: LlmClient; note?: string } {
    if (main.modelName === "unavailable") return { client: main };
    const notes: string[] = [];
    const fast = pick(cfg, main, configuredFastModel(cfg), o.fast, o.clientOptions, "fast model", notes);
    const strong = pick(cfg, main, configuredPlanningModel(cfg), o.strong, o.clientOptions, "planning and review model", notes);
    const note = notes.length ? notes.join(" ") : undefined;
    if (!fast && !strong) return { client: main, ...(note ? { note } : {}) };
    const view = configuredFastModel(cfg);
    return { client: routedClient(main, { ...(fast ? { fast } : {}), ...(strong ? { strong } : {}), fastImages: view.images, onEscalation: o.onEscalation }), ...(note ? { note } : {}) };
}

/** One routed model's client, or undefined (not set, the main model itself, or not usable here: then a sentence is added to `notes`). */
function pick(
    cfg: Config,
    main: LlmClient,
    view: { provider: LlmProviderId | null; model: string | null; ready: boolean; reason?: string },
    given: LlmClient | undefined,
    clientOptions: CreateClientOptions | undefined,
    what: string,
    notes: string[],
): LlmClient | undefined {
    // The setting decides; a client handed in (tests' scripted double) only replaces building one, so it needs no key.
    if (!view.model) return undefined;
    // The main model named again: nothing to route, nothing to warn about.
    if (!given && !view.ready && view.reason === MAIN_ALREADY) return undefined;
    const unused = (why: string) => notes.push(`The ${what} ${view.model} is not used: ${why} ${what === "fast model" ? "Every AI call uses the main model." : "The main model plans and reviews."}`);
    if (!given && !view.ready) return void unused(view.reason ?? "it cannot be used here.");
    let client = given;
    if (!client) {
        try {
            client = createFastClient(cfg, view, clientOptions);
        } catch (e) {
            return void unused(e instanceof Error ? e.message : String(e));
        }
    }
    return client.modelName === main.modelName ? undefined : client;
}
