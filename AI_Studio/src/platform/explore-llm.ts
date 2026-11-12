/**
 * The AI of an exploration that runs on a runner (round 51): the runner's engine sends each model call here (agent-protocol/explore-llm.ts),
 * and it runs on the job's own model, built exactly as a server-side job builds it (`jobLlm` in job-runner.ts): the project's AI and who
 * pays, routing to the fast model, the usage meter and the AI budgets. The key, the provider and the configuration never leave the platform.
 *
 * One model per task attempt, built at its first call and dropped by `forgetExploreLlm` when the task ends (or when a newer attempt calls),
 * so the job's usage counters, budgets and routing behave as in a job run here. The route in front (routes/agents.ts) has checked the runner,
 * the task and the attempt.
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
import { isLlmCallError, toLlmCallError } from "../engine/llm/errors.js";
import type { JobMeter } from "../engine/llm/metered.js";
import { addUsage } from "../engine/llm/prompt-cache.js";
import { LlmNotConfiguredError, type LlmClient } from "../engine/llm/provider.js";
import type { ModelV3 } from "../engine/llm/resilience.js";
import { currentRoute, ROUTE_TABLE, withRoute, type RouteTask } from "../engine/llm/routing.js";
import { isBudgetExceeded } from "../engine/llm/usage.js";
import { AI_NO_ANSWER, AI_NOT_AVAILABLE, AI_REFUSED, type ProjectAi } from "./ai-config.js";
import type { ExploreTaskRef } from "./explore-task.js";
import { HttpError } from "./http-error.js";
import { jobLlm, type JobLlmDeps } from "./job-runner.js";

/** Said when the server has no AI set up at all (the engine's own reason names the provider's key variable). */
export const AI_NOT_SET_UP = "AI is not set up on this platform, so the exploration cannot use it.";

type CallOptions = Parameters<ModelV3["doGenerate"]>[0];
type Result = Awaited<ReturnType<ModelV3["doGenerate"]>>;

interface Built {
    ai: ProjectAi;
    meter: JobMeter | null;
    llm: LlmClient;
}
interface TaskState {
    attempt: number;
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
export function forgetExploreLlm(taskId: string): Promise<void> {
    const s = tasks.get(taskId);
    if (!s) return Promise.resolve();
    tasks.delete(taskId);
    return finishOf(s);
}

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
        built,
        calls: 0,
        aliases: new Map(),
    };
    tasks.set(task.taskId, s);
    return s;
}

/** One model call of a runner's exploration. Throws HttpError 400/404/413/429; a failed model call is an answer (`ok: false`). */
export async function handleExploreLlm(p: JobLlmDeps, task: ExploreTaskRef, body: unknown): Promise<ExploreLlmAnswer> {
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
    const options = renameProviderKeys(decodeBytes(parsed.data.options), reverse(state.aliases)) as CallOptions;
    const hint = parsed.data.hint;
    const task_ = hint?.task && hint.task in ROUTE_TABLE ? (hint.task as RouteTask) : undefined;
    try {
        const model = llm.model as LanguageModel as ModelV3;
        let escalated: string | undefined;
        const result: Result = task_
            ? await withRoute({ task: task_, what: hint?.what ?? "" }, async () => {
                  const scope = currentRoute()!;
                  if (hint?.escalated) scope.escalated = true;
                  const r = await model.doGenerate(options);
                  if (!hint?.escalated && scope.escalated) escalated = scope.reason ?? "moved to the main model";
                  return r;
              })
            : await model.doGenerate(options);
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
        return {
            ok: true,
            result: cleanResult(result, state.aliases) as never,
            ...(escalated ? { escalated } : {}),
        };
    } catch (e) {
        return { ok: false, error: errorOf(e, ai) };
    }
}

/** The failure in the few words the runner may see (ai-config.ts: no key, label, provider or provider text). */
export function errorOf(e: unknown, ai?: Pick<ProjectAi, "blocked">): ExploreLlmError {
    if (isBudgetExceeded(e)) return { kind: "budget", hit: e.hit };
    if (e instanceof LlmNotConfiguredError)
        return {
            kind: "unavailable",
            message: ai?.blocked ?? (e.message === AI_NOT_AVAILABLE ? AI_NOT_AVAILABLE : AI_NOT_SET_UP),
        };
    const err = isLlmCallError(e) ? e : toLlmCallError(e);
    const sentence = [AI_REFUSED, AI_NO_ANSWER].find((s) => err.message.startsWith(s));
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
