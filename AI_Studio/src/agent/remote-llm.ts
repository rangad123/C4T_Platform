/**
 * The AI of an exploration that runs on this runner (round 51): an ordinary `LlmClient` whose model sends every call to the platform
 * (agent-protocol/explore-llm.ts), which runs it on the job's own model. The engine's `object`/`text`/`imageObject` and the tool-calling
 * agents work unchanged; tools still run here. No key, provider or configuration is ever on this machine.
 *
 * The model is a `ResilientModel` in type only: the platform already retried, fell back and paused providers, so the client around it must
 * not retry again (provider.ts retries only around models that are not resilient). Failures come back as the same error classes the
 * engine knows (`LlmCallError`, `BudgetExceeded`, `LlmNotConfiguredError`), so its retry and stop logic works as on the platform.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { decodeBytes, encodeBytes, ExploreLlmAnswerSchema, type ExploreLlmError } from "../agent-protocol/explore-llm.js";
import { LlmCallError, type LlmErrorClass } from "../engine/llm/errors.js";
import { llmClientFromModel, LlmNotConfiguredError, type LlmClient } from "../engine/llm/provider.js";
import { ResilientModel, type ModelV3 } from "../engine/llm/resilience.js";
import { currentRoute } from "../engine/llm/routing.js";
import { BudgetExceeded, type CapHit } from "../engine/llm/usage.js";
import { retrying, type ExplorePost } from "./explore-transport.js";

type CallOptions = Parameters<ModelV3["doGenerate"]>[0];
type Result = Awaited<ReturnType<ModelV3["doGenerate"]>>;

/** The purpose of the client call a model call belongs to (routing on the platform reads it when no agent scope is open). */
const purposeOf = new AsyncLocalStorage<{
    purpose?: string;
    images: boolean;
}>();

const never = (): never => {
    throw new Error("Not used: a remote model answers through the platform.");
};

/** Rebuild the engine's own error from the platform's answer. */
export function errorFromAnswer(e: ExploreLlmError, modelName: string): Error {
    if (e.kind === "budget") return new BudgetExceeded(e.hit as CapHit);
    if (e.kind === "unavailable") return new LlmNotConfiguredError(e.message);
    return new LlmCallError(
        {
            cls: e.cls as LlmErrorClass,
            ...(e.status !== undefined ? { status: e.status } : {}),
            ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
            ...(e.detail ? { detail: e.detail } : {}),
        },
        { modelName, ...(e.sentence ? { sentence: e.sentence } : {}) },
    );
}

class RemoteModel extends ResilientModel {
    constructor(
        private readonly post: ExplorePost,
        private readonly name: string,
        private readonly signal?: AbortSignal,
    ) {
        super(
            [
                {
                    name,
                    provider: "remote",
                    breakerKey: "remote",
                    model: {
                        specificationVersion: "v3",
                        provider: "remote",
                        modelId: name,
                        supportedUrls: {},
                        doGenerate: never,
                        doStream: never,
                    },
                },
            ],
            { policy: { attempts: 1 } },
        );
    }

    override async doGenerate(options: CallOptions): Promise<Result> {
        const { abortSignal, headers: _headers, includeRawChunks: _raw, ...rest } = options;
        const route = currentRoute();
        const p = purposeOf.getStore();
        // As routing on the platform would decide (engine/llm/routing.ts): images go to the main model, an agent scope wins over a purpose.
        const hint = p?.images
            ? { task: "vision" }
            : route
              ? { task: route.task, what: route.what, escalated: route.escalated, ...(route.escalated && route.reason ? { reason: route.reason.slice(0, 300) } : {}) }
              : p?.purpose
                ? { task: p.purpose }
                : undefined;
        // What the call is for, as the meter on the platform labels it (an agent's own steps have none: authoring).
        const purpose = p?.images ? (p.purpose ?? "vision") : p?.purpose;
        const signals = [this.signal, abortSignal].filter((s): s is AbortSignal => !!s);
        const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
        signal?.throwIfAborted();
        const raw = await this.post("llm", { options: encodeBytes(rest), ...(hint ? { hint } : {}), ...(purpose ? { purpose: purpose.slice(0, 40) } : {}) }, signal ? { signal } : {});
        const answer = ExploreLlmAnswerSchema.parse(raw);
        if (!answer.ok) throw errorFromAnswer(answer.error, this.name);
        // The platform moved this work to the main model: the rest of it stays there.
        if (answer.escalated) route?.escalate(answer.escalated);
        const r = decodeBytes(answer.result) as typeof answer.result;
        const n = (v: number | null | undefined) => v ?? undefined;
        return {
            content: r.content as Result["content"],
            finishReason: { unified: r.finishReason.unified, raw: undefined },
            usage: {
                inputTokens: {
                    total: n(r.usage.inputTokens.total),
                    noCache: n(r.usage.inputTokens.noCache),
                    cacheRead: n(r.usage.inputTokens.cacheRead),
                    cacheWrite: n(r.usage.inputTokens.cacheWrite),
                },
                outputTokens: {
                    total: n(r.usage.outputTokens.total),
                    text: n(r.usage.outputTokens.text),
                    reasoning: n(r.usage.outputTokens.reasoning),
                },
            },
            warnings: r.warnings as Result["warnings"],
            ...(r.providerMetadata ? { providerMetadata: r.providerMetadata as Result["providerMetadata"] } : {}),
        };
    }

    override async doStream(): Promise<never> {
        throw new Error("Streaming is not supported for an exploration on a runner.");
    }
}

/** The exploration's AI client on a runner. `modelName` comes from the task offer; `signal` (the job's) cancels a call in flight. A call is tried again while the platform restarts. */
export function remoteLlmClient(o: { post: ExplorePost; modelName: string; signal?: AbortSignal; /** How long a call is tried again while the platform is away (explore-transport.ts). */ retryMs?: number }): LlmClient {
    const inner = llmClientFromModel(new RemoteModel(retrying(o.post, o.retryMs), o.modelName, o.signal), o.modelName);
    const client: LlmClient = {
        modelName: inner.modelName,
        model: inner.model,
        usage: inner.usage,
        object: ((args: Parameters<LlmClient["object"]>[0]) => purposeOf.run({ purpose: args.purpose, images: false }, () => inner.object(args))) as LlmClient["object"],
        text: (args) => purposeOf.run({ purpose: args.purpose, images: false }, () => inner.text(args)),
        imageObject: ((args: Parameters<NonNullable<LlmClient["imageObject"]>>[0]) =>
            purposeOf.run({ purpose: args.purpose, images: true }, () => inner.imageObject!(args))) as NonNullable<LlmClient["imageObject"]>,
    };
    return client;
}
