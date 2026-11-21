/**
 * Task R, R1g (R-g): the JSON Schema sent to the provider never holds `{}` (Anthropic refuses an empty schema: every API-test repair failed
 * before the model answered, W0-2) or `propertyNames`; the answer is still validated by the zod schema itself (scripted model, fast tier).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { JSONSchema7 } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import { llmClientFromModel, requestSchema } from "../src/engine/llm/provider.js";
import { ResilientModel, type ModelV3 } from "../src/engine/llm/resilience.js";
import { StepSchema, TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { repairApi } from "../src/engine/validation/repair.js";

/** Where a JSON Schema holds an empty (any-value) subschema or a `propertyNames` key, as paths. */
function refused(node: unknown, path = "$"): string[] {
    if (node === true) return [`${path} (true)`];
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap((x, i) => refused(x, `${path}[${i}]`));
    const o = node as Record<string, unknown>;
    const out: string[] = [];
    if ("propertyNames" in o) out.push(`${path}.propertyNames`);
    const keys = Object.keys(o).filter((k) => k !== "description" && k !== "default" && k !== "title");
    if (!keys.length) out.push(`${path} ({})`);
    for (const k of ["items", "anyOf", "oneOf", "allOf", "not", "additionalProperties"]) if (o[k] !== undefined && o[k] !== false) out.push(...refused(o[k], `${path}.${k}`));
    for (const k of ["properties", "definitions", "$defs"]) if (o[k]) for (const [n, v] of Object.entries(o[k] as object)) out.push(...refused(v, `${path}.${k}.${n}`));
    return out;
}
const sent = async (s: z.ZodTypeAny) => (await requestSchema(s).jsonSchema) as JSONSchema7;

const reply = (text: string) => ({
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: { inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } },
    warnings: [],
});
const fast = { baseDelayMs: 1, maxDelayMs: 2, attemptTimeoutMs: 2000, deadlineMs: 10_000, breakerFailures: 3, breakerCooldownMs: 60_000 };

describe("the request schema", () => {
    it("the step schema as zod converts it has the refused parts; as sent, it has none", async () => {
        const raw = z.toJSONSchema(z.object({ steps: z.array(StepSchema) }), { target: "draft-7", io: "input" });
        // The premise of R-g: the body (z.unknown()) and the records really do produce them.
        expect(refused(raw).some((p) => p.endsWith("body ({})"))).toBe(true);
        expect(refused(raw).some((p) => p.endsWith("propertyNames"))).toBe(true);
        expect(refused(await sent(z.object({ steps: z.array(StepSchema) })))).toEqual([]);
    });

    it("every zod schema a structured call in src/engine can use converts to a provider-valid request schema", async () => {
        // Every module under src/engine that makes a structured call, with every zod schema it exports (call sites' own consts are
        // reached through the scripted calls below and the step schema above).
        const root = join(__dirname, "../src/engine");
        const files: string[] = [];
        const walk = (d: string) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith(".ts") && files.push(join(d, f))));
        walk(root);
        const callers = files.filter((f) => /\.object\(\{|imageObject\(\{/.test(readFileSync(f, "utf8")) && !f.includes("/llm/"));
        expect(callers.length).toBeGreaterThan(10);
        const bad: string[] = [];
        let n = 0;
        for (const f of [...callers, join(root, "spec/schema.ts"), join(root, "understanding/app-model.ts"), join(root, "intel/model.ts")]) {
            const mod = (await import(f)) as Record<string, unknown>;
            for (const [name, v] of Object.entries(mod)) {
                if (!(v instanceof z.ZodType)) continue;
                let json: JSONSchema7;
                try {
                    json = await sent(v);
                } catch {
                    continue; // not convertible to JSON Schema at all (a transform), so never a structured call's schema
                }
                n++;
                for (const p of refused(json)) bad.push(`${relative(root, f)} ${name}: ${p}`);
            }
        }
        expect(n).toBeGreaterThan(20);
        expect(bad).toEqual([]);
    });
});

describe("an API repair with a request body", () => {
    it("goes out with a provider-valid schema and the fixed body comes back as the model gave it", async () => {
        const formats: unknown[] = [];
        const body = { name: "Mug", qty: 2, gift: false, note: null };
        const steps = [
            { action: "request", method: "POST", path: "/api/cart", body, auth: "default" },
            { action: "assertResponse", check: "status", expected: 201 },
        ];
        const m = new MockLanguageModelV3({
            doGenerate: async (o) => {
                formats.push(o.responseFormat?.type === "json" ? o.responseFormat.schema : undefined);
                const props = Object.keys(((o.responseFormat as { schema?: { properties?: object } }).schema?.properties ?? {}) as object);
                return reply(props.includes("category") ? JSON.stringify({ category: "assertion", fixable: true, reason: "201, not 200" }) : JSON.stringify({ verdict: "fix", reason: "The service answers 201", steps }));
            },
        });
        const llm = llmClientFromModel(new ResilientModel([{ name: "m", provider: "x", breakerKey: "x", model: m as unknown as ModelV3 }], { policy: fast }), "m");
        const ctx: EngineContext = { config: loadConfig({}), llm, emit: () => {} };
        const spec: TestSpec = TestSpecSchema.parse({
            testId: "API-001",
            title: "Add to cart",
            kind: "api",
            expectedResults: ["201"],
            steps: [
                { action: "request", method: "POST", path: "/api/cart", body, auth: "default" },
                { action: "assertResponse", check: "status", expected: 200 },
            ],
        });
        const run = { testId: "API-001", status: "failed" as const, durationMs: 1, failedStepIndex: 1, steps: [], artifacts: [], responses: [], error: "expected 200, got 201" };
        const out = await repairApi(ctx, spec, run, null);
        expect(out.verdict).toBe("fixed");
        expect(out.spec?.steps[0]).toMatchObject({ action: "request", body });
        expect(out.spec?.steps[1]).toMatchObject({ expected: 201 });
        // Both calls (triage, repair) sent a schema the provider accepts.
        expect(formats).toHaveLength(2);
        for (const f of formats) expect(refused(f)).toEqual([]);
    });

    it("validation is unchanged: an answer the zod schema refuses is still refused", async () => {
        const schema = z.object({ steps: z.array(StepSchema) });
        const answers = [JSON.stringify({ steps: [{ action: "request", method: "FETCH", path: "/x" }] }), JSON.stringify({ steps: [{ action: "request", method: "FETCH", path: "/x" }] })];
        const m = new MockLanguageModelV3({ doGenerate: async () => reply(answers.shift()!) });
        const llm = llmClientFromModel(new ResilientModel([{ name: "m", provider: "x", breakerKey: "x", model: m as unknown as ModelV3 }], { policy: fast }), "m");
        await expect(llm.object({ system: "s", prompt: "p", schema })).rejects.toMatchObject({ cls: "bad_output" });
    });
});
