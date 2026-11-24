/**
 * Every structured answer the engine asks for (LlmClient.object / imageObject) is sent to Anthropic as `output_config.format`, which
 * compiles the schema into a grammar and refuses a schema past its documented limits with a 400 (structured-outputs docs, "Schema
 * complexity limits"): at most 24 optional parameters (each property not in `required`, at any depth) and 16 parameters with union types
 * (`anyOf`, or a type array), counted over the whole schema. N2 (practice store): the API test repair schema had 437 optional
 * parameters, so every repair failed. This file checks each schema as sent (requestSchema), and that the list below names every call.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiPlanSchema } from "../src/engine/authoring/api.js";
import { ProposalAnswerSchema } from "../src/engine/authoring/suite-plan.js";
import { ProposalSchema as RowRelationSchema } from "../src/engine/database/propose.js";
import { PageDocumentation } from "../src/engine/discovery/docs.js";
import { ExplainAnswerSchema } from "../src/engine/findings/explain.js";
import { HypothesisAnswerSchema } from "../src/engine/findings/root-cause.js";
import { AiLinks } from "../src/engine/impact/analyze.js";
import { ExtractionAnswerSchema } from "../src/engine/intel/extract/rules.js";
import { requestSchema } from "../src/engine/llm/provider.js";
import { AnswerSchema } from "../src/engine/manual/generate.js";
import { TurnReply } from "../src/engine/mobile/explore/explorer.js";
import { FieldsReply, NameReply, RiskReply } from "../src/engine/mobile/explore/map-explorer.js";
import { PlanReply } from "../src/engine/mobile/explore/planner.js";
import { RepairReply } from "../src/engine/mobile/repair/phone-repair.js";
import { PlanSchema } from "../src/engine/planning/planner.js";
import { StepSchema } from "../src/engine/spec/schema.js";
import { NormalisedSchema } from "../src/engine/requirements/parse.js";
import { AnalysisSchema, LinkedAnalysisSchema } from "../src/engine/understanding/app-model.js";
import { ProposalSchema as InvariantProposalSchema } from "../src/engine/validation/invariants.js";
import { ApiRepairSchema, TriageSchema } from "../src/engine/validation/repair.js";
import { VerdictSchema } from "../src/engine/vision/verdict.js";

/** The documented explicit limits (they apply per request; the engine sends one schema per request and no strict tools). */
const MAX_OPTIONAL = 24;
const MAX_UNION = 16;

type Node = Record<string, unknown>;
const isUnion = (n: unknown) => !!n && typeof n === "object" && ("anyOf" in n || "oneOf" in n || Array.isArray((n as Node).type));

/** Optional parameters and parameters with union types in a JSON Schema, counted the way the API counts them (437 for the old repair schema). */
export function complexity(schema: unknown): { optional: number; union: number } {
    let optional = 0;
    let union = 0;
    const walk = (n: unknown): void => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(walk);
        const props = (n as Node).properties as Record<string, unknown> | undefined;
        if (props) {
            const required = new Set((n as Node).required as string[] | undefined);
            for (const [k, v] of Object.entries(props)) {
                if (!required.has(k)) optional++;
                if (isUnion(v)) union++;
            }
        }
        Object.values(n).forEach(walk);
    };
    walk(schema);
    return { optional, union };
}

const sent = async (schema: z.ZodTypeAny) => complexity(await requestSchema(schema).jsonSchema);

const linked = LinkedAnalysisSchema;
/** Each structured call of the engine: `file` + the schema expression it passes, as the scan below finds it. */
const CALLS: Array<[string, string, z.ZodTypeAny]> = [
    ["src/engine/authoring/api.ts", "ApiPlanSchema", ApiPlanSchema],
    ["src/engine/authoring/suite-plan.ts", "ProposalAnswerSchema", ProposalAnswerSchema],
    ["src/engine/database/propose.ts", "ProposalSchema", RowRelationSchema],
    ["src/engine/discovery/docs.ts", "PageDocumentation", PageDocumentation],
    ["src/engine/findings/explain.ts", "ExplainAnswerSchema", ExplainAnswerSchema],
    ["src/engine/findings/root-cause.ts", "HypothesisAnswerSchema", HypothesisAnswerSchema],
    ["src/engine/impact/analyze.ts", "AiLinks", AiLinks],
    ["src/engine/intel/extract/rules.ts", "ExtractionAnswerSchema", ExtractionAnswerSchema],
    ["src/engine/manual/generate.ts", "AnswerSchema", AnswerSchema],
    ["src/engine/mobile/explore/explorer.ts", "TurnReply", TurnReply],
    ["src/engine/mobile/explore/map-explorer.ts", "FieldsReply", FieldsReply],
    ["src/engine/mobile/explore/map-explorer.ts", "RiskReply", RiskReply],
    ["src/engine/mobile/explore/map-explorer.ts", "NameReply", NameReply],
    ["src/engine/mobile/explore/planner.ts", "PlanReply", PlanReply],
    ["src/engine/mobile/repair/phone-repair.ts", "RepairReply", RepairReply],
    ["src/engine/planning/planner.ts", "PlanSchema", PlanSchema],
    ["src/engine/requirements/parse.ts", "NormalisedSchema", NormalisedSchema],
    // analyzer.ts: `schema` is LinkedAnalysisSchema or AnalysisSchema; the split asks for slices of the linked one.
    ["src/engine/understanding/analyzer.ts", "schema", LinkedAnalysisSchema],
    ["src/engine/understanding/analyzer.ts", "schema", AnalysisSchema],
    ["src/engine/understanding/analyzer.ts", "screensSchema", linked.pick({ siteType: true, purpose: true, features: true, pagePurposes: true, authenticationMechanisms: true })],
    ["src/engine/understanding/analyzer.ts", "linked.pick({ journeys: true })", linked.pick({ journeys: true })],
    ["src/engine/validation/invariants.ts", "ProposalSchema", InvariantProposalSchema],
    ["src/engine/validation/repair.ts", "TriageSchema", TriageSchema],
    ["src/engine/validation/repair.ts", "ApiRepairSchema", ApiRepairSchema],
    ["src/engine/vision/judge.ts", "VerdictSchema", VerdictSchema],
];

/** `<client>.object({ … schema: X … })` and `imageObject` calls in the engine's source (not `z.object` / `Output.object`). */
function scanCalls(): string[] {
    const files = execSync("git ls-files src", { encoding: "utf8" })
        .split("\n")
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const out: string[] = [];
    for (const f of files) {
        const text = readFileSync(f, "utf8");
        for (const m of text.matchAll(/([\w.]+)\.(?:object|imageObject)!?\??\.?\(\{/g)) {
            if (m[1] === "z" || m[1]!.endsWith("Output")) continue;
            const s = /\bschema(?::\s*([\w.]+(?:\([^)]*\))?))?[,\s}]/.exec(text.slice(m.index, m.index + 3000));
            out.push(`${f} ${s ? (s[1] ?? "schema") : "?"}`);
        }
    }
    return out.sort();
}

describe("structured-output schemas stay within Anthropic's documented limits", () => {
    it("counts optional and union parameters as the API does", () => {
        // The docs' example: four strict schemas with six optional parameters each reach 24. Nested and union members count too.
        const six = { type: "object", properties: Object.fromEntries(["a", "b", "c", "d", "e", "f", "g"].map((k) => [k, { type: "string" }])), required: ["a"] };
        expect(complexity({ type: "object", properties: { w: six, x: six, y: six, z: six }, required: ["w", "x", "y", "z"] })).toEqual({ optional: 24, union: 0 });
        expect(complexity({ type: "object", properties: { u: { anyOf: [six, { type: "null" }] }, t: { type: ["string", "null"] } } })).toEqual({ optional: 8, union: 2 });
    });

    it("the repair schema N2 sent (every step kind) is over the limit, as the API said: 437 optional parameters", async () => {
        const old = (await sent(z.object({ verdict: z.string(), reason: z.string(), steps: z.array(StepSchema).optional() }))).optional;
        expect(old).toBeGreaterThan(MAX_OPTIONAL);
    });

    it("the list names every structured call of the engine", () => {
        expect(scanCalls()).toEqual([...new Set(CALLS.map(([f, s]) => `${f} ${s}`))].sort());
    });

    it.each(CALLS.map(([f, s, schema], i) => [`#${i} ${f} ${s}`, schema] as const))("%s", async (_name, schema) => {
        const c = await sent(schema);
        expect(c.optional, "optional parameters").toBeLessThanOrEqual(MAX_OPTIONAL);
        expect(c.union, "parameters with union types").toBeLessThanOrEqual(MAX_UNION);
    });
});
