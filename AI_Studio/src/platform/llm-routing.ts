/**
 * The platform side of model routing (docs/features/model-routing.md):
 *  - the fast model saved in Settings, AI model (wins over LLM_MODEL_FAST from the environment),
 *  - each job's client: the main model alone, or the routed client with the fast model, whose escalations are counted in AI usage.
 *
 * Storage: the key/value table `ai_settings` of the AI usage feature (row `llm_fast_model`), no migration. Escalations are rows of the
 * usage table under the label "escalation" (engine/llm/usage.ts ESCALATION_PURPOSE): a count, never a prompt or an answer.
 */
import { z } from "zod";
import type { Config } from "../config.js";
import type { EngineEvent } from "../engine/context.js";
import type { CreateClientOptions, LlmClient } from "../engine/llm/provider.js";
import { configuredFastModel, configuredPlanningModel, ESCALATION_LIMITS, ROUTE_TABLE, setFastModelSource, setPlanningModelSource, STRONG_TASKS, withModelRouting, type FastModelSetting, type FastModelView, type PlanningModelView, type RouteTask } from "../engine/llm/routing.js";
import { ESCALATION_PURPOSE } from "../engine/llm/usage.js";
import type { Db } from "./db.js";
import { SettingsCache } from "./settings-cache.js";
import { HttpError } from "./http-error.js";
import type { RouteCtx } from "./routes/types.js";
import { usageStoreFor } from "./usage-store.js";

const FAST_KEY = "llm_fast_model";
/** The planning and review model (round 53): a model name, "" or no row = the main model plans and reviews. */
const PLANNING_KEY = "llm_planning_model";

export function savedPlanningModel(db: Db): string | undefined {
    try {
        const raw = db.get<{ value: string | null }>("SELECT value FROM ai_settings WHERE key = ?", PLANNING_KEY)?.value;
        return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
    } catch {
        return undefined;
    }
}

/** Save the planning and review model; "" or null = none (the main model plans and reviews). */
export function savePlanningModel(db: Db, config: Config, model: string | null): PlanningModelView {
    const v = (model ?? "").trim();
    if (!v) db.run("DELETE FROM ai_settings WHERE key = ?", PLANNING_KEY);
    else db.run("INSERT INTO ai_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", PLANNING_KEY, v);
    void planningCache?.refresh();
    return configuredPlanningModel(config);
}
let planningCache: SettingsCache<string | undefined> | undefined;

/** The value saved in the app, or undefined when nobody saved one (then LLM_MODEL_FAST is used). An empty model = "no fast model". */
export function savedFastModel(db: Db): FastModelSetting | undefined {
    let raw: string | null | undefined;
    try {
        raw = db.get<{ value: string | null }>("SELECT value FROM ai_settings WHERE key = ?", FAST_KEY)?.value;
    } catch {
        return undefined;
    }
    if (raw === undefined || raw === null) return undefined;
    try {
        const v = JSON.parse(raw) as { model?: unknown; images?: unknown };
        return typeof v.model === "string" ? { model: v.model, images: v.images === true } : undefined;
    } catch {
        return undefined;
    }
}

/** Save the fast model (`null` = forget it and use the server's LLM_MODEL_FAST again). An empty model switches routing off. */
export function saveFastModel(db: Db, config: Config, value: FastModelSetting | null): FastModelView {
    if (value === null) db.run("DELETE FROM ai_settings WHERE key = ?", FAST_KEY);
    else db.run("INSERT INTO ai_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", FAST_KEY, JSON.stringify({ model: value.model.trim(), images: value.images }));
    void fastCache?.refresh();
    return configuredFastModel(config);
}

/** What the engine reads (settings-cache.ts): a save here is seen at once, one on another process within the refresh interval. */
let fastCache: SettingsCache<FastModelSetting | undefined> | undefined;

/** Called once per process (bootstrap): the Settings value becomes the fast model's source. */
export function installLlmRouting(db: Db): void {
    const c = (fastCache = new SettingsCache(() => savedFastModel(db)));
    setFastModelSource(() => c.get());
    const pc = (planningCache = new SettingsCache(() => savedPlanningModel(db)));
    setPlanningModelSource(() => pc.get());
}

/**
 * One job's client. Without a fast model this is `main` itself (exactly today's behaviour). A fast model that is set but cannot be used
 * here (no key for its provider, for example) is said once in the job's log, and the job runs on the main model.
 * Each escalation adds 1 to the job's "escalation" usage row under the main model (no tokens: those are counted with the calls).
 */
export function routedLlmForJob(
    deps: { db: Db; config: Config; emit: (e: EngineEvent) => void },
    job: { id: string; projectId: string },
    main: LlmClient,
    o: { fast?: LlmClient; strong?: LlmClient; clientOptions?: CreateClientOptions } = {},
): LlmClient {
    const usage = (() => {
        try {
            return usageStoreFor(deps.db, deps.config);
        } catch {
            return undefined;
        }
    })();
    const { client, note } = withModelRouting(deps.config, main, {
        ...o,
        onEscalation: (e) => {
            try {
                usage?.addUsage({ jobId: job.id, projectId: job.projectId, purpose: ESCALATION_PURPOSE, model: e.to, at: new Date(), calls: 1, failedCalls: 0, inputTokens: 0, outputTokens: 0, images: 0, estimatedCalls: 0 });
            } catch {
                // Counting must never break a job.
            }
        },
    });
    if (note) deps.emit({ stage: "orchestration", kind: "ai_fast_model_unused", level: "warn", message: note });
    return client;
}

// ── routes (Settings, AI model) ──────────────────────────────────────────────
//
//   GET /api/llm/fast-model    the fast model in force, where it comes from, whether it can be used here, and what goes to which model
//   PUT /api/llm/fast-model    { model: string | null, images?: boolean }   "" = no fast model, null = follow LLM_MODEL_FAST again

export interface FastModelAnswer extends FastModelView {
    configured: boolean;
    mainModel: string;
    /** The fast model as Settings writes it: `provider:model` when it is not the main model's provider, "" for none. */
    entry: string;
    /** In force: a fast model is set and can be used. */
    active: boolean;
    fastFor: string[];
    mainFor: string[];
    limits: typeof ESCALATION_LIMITS;
    /** The planning and review model: `entry` as Settings writes it ("" = none, the main model), whether it is in force, and what it does. */
    planning: PlanningModelView & { entry: string; active: boolean; for: string[] };
}

export function fastModelAnswer(config: Config, mainModel: string): FastModelAnswer {
    const view = configuredFastModel(config);
    const rows = Object.values(ROUTE_TABLE);
    return {
        ...view,
        configured: mainModel !== "unavailable",
        mainModel,
        entry: view.model ? (view.provider === config.LLM_PROVIDER ? view.model : `${view.provider}:${view.model}`) : "",
        active: mainModel !== "unavailable" && view.ready && Boolean(view.model),
        fastFor: rows.filter((r) => r.model === "fast").map((r) => r.what),
        mainFor: rows.filter((r) => r.model === "main").map((r) => r.what),
        limits: ESCALATION_LIMITS,
        planning: planningAnswer(config, mainModel),
    };
}

function planningAnswer(config: Config, mainModel: string): FastModelAnswer["planning"] {
    const v = configuredPlanningModel(config);
    return {
        ...v,
        entry: v.model ? (v.provider === config.LLM_PROVIDER ? v.model : `${v.provider}:${v.model}`) : "",
        active: mainModel !== "unavailable" && v.ready && Boolean(v.model),
        for: [...STRONG_TASKS].map((t) => ROUTE_TABLE[t as RouteTask].what),
    };
}

const FastBody = z
    .object({
        model: z
            .string()
            .trim()
            .max(220, "A model name is at most 200 characters")
            .regex(/^[^\s,\u0000-\u001f<>]*$/, "One model name, without spaces or commas (like claude-haiku-4-5 or openai:gpt-5.4-mini)")
            .nullable(),
        images: z.boolean().optional(),
    })
    .strict();

const PlanningBody = z.object({ model: FastBody.shape.model }).strict();

export function registerLlmRoutingRoutes(ctx: RouteCtx): void {
    const { app, p } = ctx;
    app.get("/api/llm/fast-model", async () => fastModelAnswer(p.config, p.llm.modelName));
    app.put("/api/llm/fast-model", async (req) => {
        const parsed = FastBody.safeParse(req.body ?? {});
        if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Send { model: \"name\" }, { model: \"\" } or { model: null }");
        const { model, images } = parsed.data;
        saveFastModel(p.db, p.config, model === null ? null : { model, images: images ?? false });
        return fastModelAnswer(p.config, p.llm.modelName);
    });
    //   PUT /api/llm/planning-model  { model: string | null }   "" or null = none: the main model plans and reviews
    app.put("/api/llm/planning-model", async (req) => {
        const parsed = PlanningBody.safeParse(req.body ?? {});
        if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Send { model: \"name\" } or { model: \"\" }");
        savePlanningModel(p.db, p.config, parsed.data.model);
        return fastModelAnswer(p.config, p.llm.modelName);
    });
}
