/**
 * The AI of an exploration that runs on a runner (round 51): the runner's engine sends each model call here (agent-protocol/explore-llm.ts),
 * and it runs on the job's own model, built exactly as a server-side job builds it (`jobLlm` in job-runner.ts): the project's AI and who
 * pays, routing to the fast model, the usage meter and the AI budgets. The key, the provider and the configuration never leave the platform.
 *
 * One model per task attempt, built at its first call and dropped by `forgetExploreLlm` when the task ends (or when a newer attempt calls),
 * so the job's usage counters, budgets and routing behave as in a job run here. The route in front (routes/agents.ts) has checked the runner,
 * the task and the attempt.
 *
 * Round 52: each call is metered with the purpose the runner's engine gave it (unknown: authoring); an escalation the runner's own agent
 * loop decided is told to the job and counted once, as on the server (the scope of that work is kept per task, so the routed client's
 * own escalation path does it); a call whose request closes before its answer (the runner went away, the task was stopped) stops the
 * provider call; the provider name aliases are kept in the task's row of explore_task_state, so they mean the same after a restart.
 */
import type { LanguageModel } from "ai";
import {
    decodeBytes,
    encodeBytes,
    EXPLORE_LLM_MAX_BYTES,
    EXPLORE_LLM_MAX_CALLS,
    ExploreLlmRequestSchema,
    TEMPERATURE_DETAIL,
    type ExploreLlmAnswer,
    type ExploreLlmError,
} from "../agent-protocol/explore-llm.js";
import type { EngineEvent } from "../engine/context.js";
import { isLlmCallError, LOW_CREDIT_SENTENCE, toLlmCallError } from "../engine/llm/errors.js";
import { modelCallPurpose, type JobMeter } from "../engine/llm/metered.js";
import { addUsage } from "../engine/llm/prompt-cache.js";
import { LlmNotConfiguredError, type LlmClient } from "../engine/llm/provider.js";
import type { ModelV3 } from "../engine/llm/resilience.js";
import { currentRoute, ROUTE_TABLE, withRoute, type RouteScope, type RouteTask } from "../engine/llm/routing.js";
import { isBudgetExceeded, PURPOSES, type LlmPurpose } from "../engine/llm/usage.js";
import { AI_NO_ANSWER, AI_NOT_AVAILABLE, AI_REFUSED, type WorkAi } from "./ai-config.js";
import type { ExploreTaskRef } from "./explore-task.js";
import { HttpError } from "./http-error.js";
import { jobLlm, type JobLlmDeps } from "./job-runner.js";

/** Said when the server has no AI set up at all (the engine's own reason names the provider's key variable). */
export const AI_NOT_SET_UP = "AI is not set up on this platform, so the exploration cannot use it.";

type CallOptions = Parameters<ModelV3["doGenerate"]>[0];
type Result = Awaited<ReturnType<ModelV3["doGenerate"]>>;

interface Built {
    ai: WorkAi;
    meter: JobMeter | null;
    llm: LlmClient;
}
interface TaskState {
    attempt: number;
    jobId: string;
    /** The first platform scope of each piece of the runner's agent work (task + what): bound to the routed client, it tells an escalation once. */
    scopes: Map<string, RouteScope>;
    built: Promise<Built>;
    calls: number;
    /** Provider names in provider metadata, as the runner sees them ("p1"), and back. */
    aliases: Map<string, string>;
}

const tasks = new Map<string, TaskState>();

const finishOf = (s: TaskState): Promise<void> =>
    s.built.then(
        (b) => b.meter?.finish(),
        () => undefined,
    );

/** The task ended (or was given up): its usage is written and its model dropped. Never rejects; awaiting it is optional. */
export function forgetExploreLlm(taskId: string, p?: Pick<JobLlmDeps, "repo">): Promise<void> {
    try {
        p?.repo.db.run("UPDATE explore_task_state SET llm_json = NULL WHERE task_id = ?", taskId);
    } catch {
        // Only bookkeeping.
    }
    const s = tasks.get(taskId);
    if (!s) return Promise.resolve();
    tasks.delete(taskId);
    return finishOf(s);
}

/** A graceful restart hands the job over (runner-handover.ts): the usage of its tasks is written, and the next process builds their model again. */
export async function handOverExploreLlm(jobId: string): Promise<void> {
    for (const [taskId, s] of [...tasks]) {
        if (s.jobId !== jobId) continue;
        tasks.delete(taskId);
        await finishOf(s);
    }
}

function loadAliases(p: JobLlmDeps, task: ExploreTaskRef): Map<string, string> {
    try {
        const row = p.repo.db.get<{ attempt: number; llm_json: string | null }>("SELECT attempt, llm_json FROM explore_task_state WHERE task_id = ?", task.taskId);
        if (row?.llm_json && row.attempt === task.attempt) return new Map(JSON.parse(row.llm_json) as Array<[string, string]>);
    } catch {
        // None kept: names start again.
    }
    return new Map();
}

function saveAliases(p: JobLlmDeps, task: ExploreTaskRef, aliases: Map<string, string>): void {
    try {
        p.repo.db.run(
            "INSERT INTO explore_task_state (task_id, attempt, llm_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET attempt = excluded.attempt, llm_json = excluded.llm_json, updated_at = excluded.updated_at",
            task.taskId,
            task.attempt,
            JSON.stringify([...aliases]),
            new Date().toISOString(),
        );
    } catch {
        // Best effort: without it, a restart only renames providers again.
    }
}

/** The purpose a call is metered with: one the engine knows, else authoring (what a direct model call is on the server). */
const purposeOf = (p: string | undefined): LlmPurpose => (p && (PURPOSES as readonly string[]).includes(p) ? (p as LlmPurpose) : "authoring");

function stateFor(p: JobLlmDeps, task: ExploreTaskRef): TaskState {
    const known = tasks.get(task.taskId);
    if (known && known.attempt === task.attempt) return known;
    if (known) void finishOf(known);
    const job = p.repo.getJob(task.jobId);
    if (!job || job.projectId !== task.projectId) throw new HttpError(404, "This job no longer exists.");
    // Events of the model (retries, fallbacks, escalations) go to the job, as for a job run here.
    const emit = (e: EngineEvent) => {
        try {
            p.repo.addEvent(task.jobId, e);
        } catch {
            // Telling the job is best effort.
        }
    };
    const built = jobLlm(p, job, emit).then((b) => {
        b.rawLlm.setEventSink?.(emit);
        return { ai: b.ai, meter: b.meter, llm: b.llm };
    });
    const s: TaskState = {
        attempt: task.attempt,
        jobId: task.jobId,
        scopes: new Map(),
        built,
        calls: 0,
        aliases: loadAliases(p, task),
    };
    tasks.set(task.taskId, s);
    return s;
}

/** The most pieces of agent work one task keeps a scope for (an exploration has a few dozen scenarios). */
const MAX_SCOPES = 2000;

/**
 * One model call of a runner's exploration. Throws HttpError 400/404/413/429; a failed model call is an answer (`ok: false`). `signal`: the
 * request closed before its answer, so the provider call is stopped.
 */
export async function handleExploreLlm(p: JobLlmDeps, task: ExploreTaskRef, body: unknown, signal?: AbortSignal): Promise<ExploreLlmAnswer> {
    if (JSON.stringify(body ?? null).length > EXPLORE_LLM_MAX_BYTES) throw new HttpError(413, "This AI call is larger than the platform accepts.");
    const parsed = ExploreLlmRequestSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(400, "This AI call could not be read.");
    const state = stateFor(p, task);
    if (++state.calls > EXPLORE_LLM_MAX_CALLS) throw new HttpError(429, `This exploration made more than ${EXPLORE_LLM_MAX_CALLS} AI calls, the most one exploration may make.`);
    const { ai, llm } = await state.built;
    if (ai.blocked) return { ok: false, error: { kind: "unavailable", message: ai.blocked } };
    if (llm.modelName === "unavailable")
        return {
            ok: false,
            error: { kind: "unavailable", message: AI_NOT_SET_UP },
        };
    const options = { ...(renameProviderKeys(decodeBytes(parsed.data.options), reverse(state.aliases)) as CallOptions), ...(signal ? { abortSignal: signal } : {}) };
    const hint = parsed.data.hint;
    const task_ = hint?.task && hint.task in ROUTE_TABLE ? (hint.task as RouteTask) : undefined;
    const aliasCount = state.aliases.size;
    try {
        const model = llm.model as LanguageModel as ModelV3;
        const generate = () => modelCallPurpose.run(purposeOf(parsed.data.purpose), () => model.doGenerate(options));
        let escalated: string | undefined;
        const result: Result = task_
            ? await withRoute({ task: task_, what: hint?.what ?? "" }, async () => {
                  const scope = currentRoute()!;
                  const key = `${task_}\u0000${hint?.what ?? ""}`;
                  const first = state.scopes.get(key);
                  if (hint?.escalated) {
                      // The runner's agent loop moved this work to the main model: told to the job and counted once, through the scope the
                      // routed client knows (a scope it moved itself is escalated already, and says nothing again).
                      if (first && !first.escalated) first.escalate(hint.reason ?? "moved to the main model");
                      scope.escalated = true;
                  }
                  const r = await generate();
                  if (!hint?.escalated && scope.escalated) escalated = scope.reason ?? "moved to the main model";
                  if (!first) {
                      if (state.scopes.size < MAX_SCOPES) state.scopes.set(key, scope);
                  } else if (scope.escalated) first.escalated = true;
                  return r;
              })
            : await generate();
        // The engine counts the tokens of a call it makes itself; this call's are counted here, so the job's meter sees them (metered.ts).
        const u = result.usage;
        addUsage(llm.usage, {
            inputTokens: u.inputTokens.total ?? 0,
            outputTokens: u.outputTokens.total ?? 0,
            inputTokenDetails: {
                cacheReadTokens: u.inputTokens.cacheRead ?? 0,
                cacheWriteTokens: u.inputTokens.cacheWrite ?? 0,
            },
        });
        const cleaned = cleanResult(result, state.aliases);
        if (state.aliases.size !== aliasCount) saveAliases(p, task, state.aliases);
        return {
            ok: true,
            result: cleaned as never,
            ...(escalated ? { escalated } : {}),
        };
    } catch (e) {
        return { ok: false, error: errorOf(e, ai) };
    }
}

/** The failure in the few words the runner may see (ai-config.ts: no key, label, provider or provider text). */
export function errorOf(e: unknown, ai?: Pick<WorkAi, "blocked">): ExploreLlmError {
    if (isBudgetExceeded(e)) return { kind: "budget", hit: e.hit };
    if (e instanceof LlmNotConfiguredError)
        return {
            kind: "unavailable",
            message: ai?.blocked ?? (e.message === AI_NOT_AVAILABLE ? AI_NOT_AVAILABLE : AI_NOT_SET_UP),
        };
    const err = isLlmCallError(e) ? e : toLlmCallError(e);
    const sentence = [AI_REFUSED, AI_NO_ANSWER, LOW_CREDIT_SENTENCE].find((s) => err.message.startsWith(s));
    return {
        kind: "llm",
        cls: err.cls,
        ...(err.info.status !== undefined ? { status: err.info.status } : {}),
        ...(err.info.retryAfterMs !== undefined ? { retryAfterMs: err.info.retryAfterMs } : {}),
        ...(sentence ? { sentence } : {}),
        ...(/temperature/i.test(err.message) ? { detail: TEMPERATURE_DETAIL } : {}),
    };
}

/** The result without the raw request, response, headers and provider usage record, provider names aliased, bytes encoded. */
function cleanResult(r: Result, aliases: Map<string, string>): unknown {
    const count = (n: number | undefined) => n ?? null;
    return encodeBytes({
        content: r.content.map((c) => renameProviderKeys(c, aliases, true)),
        finishReason: { unified: r.finishReason.unified },
        usage: {
            inputTokens: {
                total: count(r.usage.inputTokens.total),
                noCache: count(r.usage.inputTokens.noCache),
                cacheRead: count(r.usage.inputTokens.cacheRead),
                cacheWrite: count(r.usage.inputTokens.cacheWrite),
            },
            outputTokens: {
                total: count(r.usage.outputTokens.total),
                text: count(r.usage.outputTokens.text),
                reasoning: count(r.usage.outputTokens.reasoning),
            },
        },
        warnings: (r.warnings ?? []).map((w) => ({
            type: w.type,
            ...("feature" in w && typeof w.feature === "string" ? { feature: w.feature } : {}),
        })),
        ...(r.providerMetadata ? { providerMetadata: aliasKeys(r.providerMetadata, aliases, true) } : {}),
    });
}

const reverse = (m: Map<string, string>) => new Map([...m].map(([k, v]) => [v, k]));

/** Rename the top-level keys of a provider metadata/options record; `add` makes a new alias for a name not seen yet. */
function aliasKeys(rec: Record<string, unknown>, map: Map<string, string>, add = false): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(rec).map(([k, v]) => {
            if (add && !map.has(k)) map.set(k, `p${map.size + 1}`);
            return [map.get(k) ?? k, v];
        }),
    );
}

/** `providerMetadata` (answers) and `providerOptions` (calls) anywhere in a value, with their provider keys renamed. */
function renameProviderKeys(v: unknown, map: Map<string, string>, add = false): unknown {
    if (Array.isArray(v)) return v.map((x) => renameProviderKeys(x, map, add));
    if (!v || typeof v !== "object" || v instanceof Uint8Array) return v;
    return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [
            k,
            (k === "providerMetadata" || k === "providerOptions") && x && typeof x === "object"
                ? aliasKeys(x as Record<string, unknown>, map, add)
                : renameProviderKeys(x, map, add),
        ]),
    );
}
