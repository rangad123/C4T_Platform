/**
 * Task R, R1: `structured()` with a scripted model (no network, no real provider): an almost-valid answer is used without a re-ask when
 * the same schema passes; a cut-off answer is re-asked for a shorter one; what happened is counted per client and per call (R-f).
 */
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LlmCallError } from "../src/engine/llm/errors.js";
import { JobMeter, type MeterBackend } from "../src/engine/llm/metered.js";
import { llmClientFromModel } from "../src/engine/llm/provider.js";
import { ResilientModel, type ModelV3 } from "../src/engine/llm/resilience.js";

const fast = { baseDelayMs: 1, maxDelayMs: 2, attemptTimeoutMs: 2000, deadlineMs: 10_000, breakerFailures: 3, breakerCooldownMs: 60_000 };

const reply = (text: string, finish: "stop" | "length" = "stop") => ({
    content: [{ type: "text" as const, text }],
    finishReason: { unified: finish, raw: finish },
    usage: { inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } },
    warnings: [],
});

function client(answers: Array<ReturnType<typeof reply>>, prompts: string[] = []) {
    const m = new MockLanguageModelV3({
        doGenerate: async (o) => {
            prompts.push(JSON.stringify(o.prompt));
            return answers.shift() ?? reply("no more answers");
        },
    });
    // Through the resilient model, as in production: it retries transport failures only, never a bad answer.
    return llmClientFromModel(new ResilientModel([{ name: "m", provider: "x", breakerKey: "x", model: m as unknown as ModelV3 }], { policy: fast }), "m");
}

const schema = z.object({ items: z.array(z.object({ id: z.number().int(), name: z.string() })) });
const good = { items: [{ id: 1, name: "a" }, { id: 2, name: "b" }] };

describe("structured answers made usable without a re-ask", () => {
    it("uses a fenced answer after <think>, counted as cleaned, with no second call", async () => {
        const prompts: string[] = [];
        const c = client([reply(`<think>plan {it}</think>\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``)], prompts);
        expect(await c.object({ system: "s", prompt: "p", schema })).toEqual(good);
        expect(prompts).toHaveLength(1);
        expect(c.usage.structured).toMatchObject({ cleaned: 1, failed: 0 });
        expect(c.usage.repairs ?? 0).toBe(0);
    });

    it("keeps the valid items of a declared list, tells the caller how many it dropped", async () => {
        const dropped: number[] = [];
        const c = client([reply(JSON.stringify({ items: [{ id: 1, name: "a" }, { id: "two", name: "b" }, { id: 3, name: "c" }] }))]);
        const out = await c.object({ system: "s", prompt: "p", schema, items: { key: "items", onDropped: (n) => dropped.push(n) } });
        expect(out.items.map((i) => i.id)).toEqual([1, 3]);
        expect(dropped).toEqual([1]);
        expect(c.usage.structured).toMatchObject({ partial: 1, itemsDropped: 1 });
    });

    it("closes a cut-off list after its last whole item", async () => {
        const text = JSON.stringify({ items: [{ id: 1, name: "a" }, { id: 2, name: "b" }, { id: 3, name: "c" }] }).slice(0, -12);
        const c = client([reply(text, "length")]);
        const out = await c.object({ system: "s", prompt: "p", schema, items: { key: "items" } });
        expect(out.items.map((i) => i.id)).toEqual([1, 2]);
        expect(c.usage.structured).toMatchObject({ salvaged: 1, itemsDropped: 1 });
    });
});

describe("the re-ask when nothing can be used", () => {
    it("asks a cut-off answer again for a shorter one", async () => {
        const prompts: string[] = [];
        const c = client([reply('{"items":[{"id":1,"na', "length"), reply(JSON.stringify(good))], prompts);
        expect(await c.object({ system: "s", prompt: "p", schema })).toEqual(good);
        expect(prompts).toHaveLength(2);
        expect(prompts[1]).toContain("it was cut off before the end (too long)");
        expect(prompts[1]).toContain("at most half as many items");
        expect(c.usage.repairs).toBe(1);
    });

    it("names the zod path for an off-schema answer, and does not ask for a shorter one", async () => {
        const prompts: string[] = [];
        const c = client([reply(JSON.stringify({ items: [{ id: "x", name: "a" }] })), reply(JSON.stringify(good))], prompts);
        await c.object({ system: "s", prompt: "p", schema });
        expect(prompts[1]).toContain("items.0.id");
        expect(prompts[1]).not.toContain("half as many");
    });

    it("garbage twice still fails, counted as failed", async () => {
        const c = client([reply("no idea"), reply("still no idea")]);
        const err = await c.object({ system: "s", prompt: "p", schema }).catch((e) => e);
        expect(err).toBeInstanceOf(LlmCallError);
        expect(err.cls).toBe("bad_output");
        expect(c.usage.structured).toMatchObject({ failed: 1 });
    });

    it("never returns a value the schema refuses (the answer a scripted model gives is checked whole)", async () => {
        const strict = z.object({ title: z.string().min(1), items: schema.shape.items.min(2) });
        const answers = [reply(JSON.stringify({ title: "", items: good.items })), reply(JSON.stringify({ title: "t", items: [{ id: 1, name: "a" }, { id: 2.5, name: "b" }] }))];
        const c = client(answers);
        // Dropping item 2.5 would leave one item, under the list's minimum: refused, not shortened.
        await expect(c.object({ system: "s", prompt: "p", schema: strict, items: { key: "items" } })).rejects.toThrow(LlmCallError);
    });
});

describe("each call's repair reaches the usage rows (R-f)", () => {
    it("records cleaned, reasked and failed per call", async () => {
        const rows: Array<{ repair?: string; itemsDropped?: number; failedCalls: number }> = [];
        const backend: MeterBackend = {
            addUsage: (d) => void (d.calls && rows.push({ repair: d.repair, itemsDropped: d.itemsDropped, failedCalls: d.failedCalls })),
            totalsFor: () => ({ job: 0, project: 0, month: 0 }),
            capsFor: () => ({ caps: {}, warnPercent: 80 }),
            recordStop: () => {},
        };
        const inner = client([
            reply(JSON.stringify(good)),
            reply("```\n" + JSON.stringify(good) + "\n```"),
            reply(JSON.stringify({ items: [{ id: 1, name: "a" }, { id: "x", name: "b" }] })),
            reply("nope"),
            reply(JSON.stringify(good)),
            reply("nope"),
            reply("nope"),
        ]);
        const c = new JobMeter({ backend, jobId: "j", projectId: "p" }).wrap(inner);
        await c.object({ system: "s", prompt: "p", schema });
        await c.object({ system: "s", prompt: "p", schema });
        await c.object({ system: "s", prompt: "p", schema, items: { key: "items" } });
        await c.object({ system: "s", prompt: "p", schema });
        await c.object({ system: "s", prompt: "p", schema }).catch(() => undefined);
        expect(rows).toEqual([
            { repair: undefined, itemsDropped: undefined, failedCalls: 0 },
            { repair: "cleaned", itemsDropped: undefined, failedCalls: 0 },
            { repair: "partial", itemsDropped: 1, failedCalls: 0 },
            { repair: "reasked", itemsDropped: undefined, failedCalls: 0 },
            { repair: "failed", itemsDropped: undefined, failedCalls: 1 },
        ]);
    });
});

describe("a bad answer is told to the job with how it ended (R-f)", () => {
    it("gives finishReason, length and the masked first 200 characters", async () => {
        const events: Array<{ kind: string; data?: Record<string, unknown> }> = [];
        const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
        const text = `Thinking about it, the key ${secret} and then ` + "x".repeat(400);
        const c = client([reply(text, "length"), reply("still not JSON")]);
        c.setEventSink!((e) => void events.push(e));
        await c.object({ system: "s", prompt: "p", schema, purpose: "planning" }).catch(() => undefined);
        const bad = events.filter((e) => e.kind === "ai_answer_unusable");
        expect(bad.map((e) => e.data?.outcome)).toEqual(["reasked", "failed"]);
        expect(bad[0]!.data).toMatchObject({ purpose: "planning", finishReason: "length", length: text.length });
        expect(String(bad[0]!.data!.head)).toHaveLength(200);
        expect(String(bad[0]!.data!.head)).not.toContain(secret);
        expect(bad[1]!.data).toMatchObject({ finishReason: "stop", length: 14, head: "still not JSON" });
    });
});
