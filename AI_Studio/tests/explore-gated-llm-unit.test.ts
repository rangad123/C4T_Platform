/**
 * The objective stage's gated AI client (CP2 L-5): every model call of a pursuit passes the gate, including the test writer's tool-loop
 * steps, which go through `model` directly. A model the gate cannot wrap (not an AI SDK v3 model: an older interface or a bare model
 * id) is refused when it is used, instead of being handed out ungated. No browser, no paid AI.
 */
import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { gatedLlm } from "../src/engine/orchestrator.js";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const v3 = () => new MockLanguageModelV3({ doGenerate: async () => ({ content: [{ type: "text" as const, text: "ok" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] }) });
const client = (model: unknown): LlmClient => ({ modelName: "m", model: model as LlmClient["model"], usage: { inputTokens: 0, outputTokens: 0 }, text: async () => "t", object: async () => ({}) as never });

describe("gatedLlm", () => {
    it("passes every call of a v3 model through the gate", async () => {
        let gated = 0;
        const g = gatedLlm(client(v3()), () => void gated++);
        expect((await generateText({ model: g.model, prompt: "p" })).text).toBe("ok");
        expect((await generateText({ model: g.model, prompt: "p" })).text).toBe("ok");
        expect(gated).toBe(2);
    });

    it("refuses a model it cannot gate (an older interface, a bare model id) instead of handing it out ungated", async () => {
        for (const model of [{ ...v3(), specificationVersion: "v2" }, "anthropic/claude-haiku", { doGenerate: async () => ({}) }]) {
            let gated = 0;
            const g = gatedLlm(client(model), () => void gated++);
            expect(() => g.model).toThrow(/cannot be counted/);
            // The client's own calls are still gated.
            expect(await g.text({ system: "s", prompt: "p" })).toBe("t");
            expect(gated).toBe(1);
        }
    });
});
