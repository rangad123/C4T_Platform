/**
 * Task R, R1 (PHASE_5_7_SPEC §4): reading almost-valid structured answers, without a model (fast tier).
 *
 * The fixture corpus stands for the real bad answers of S13/S14 and the M3 feasibility trial (SHEET8-SAVINGS.md). Their raw text was not
 * kept (the logs say only "not valid JSON" or the zod path), so each fixture is the shape a reasoning model gives there: a `<think>` block,
 * fences, prose, a cut-off answer, one off-schema item (S13's `scenarios.4.type`), an unclosed string, plain garbage.
 * Then a property test: whatever is accepted passes the original schema; and a guard: the schemas R reads with are unchanged.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { candidates, stripWrapping, tolerate } from "../src/engine/llm/json-tolerance.js";
import { PlanSchema } from "../src/engine/planning/planner.js";
import { AnalysisSchema, LinkedAnalysisSchema } from "../src/engine/understanding/app-model.js";

const scenario = (i: number, extra: Record<string, unknown> = {}) => ({
    title: `Scenario ${i}`,
    description: `Checks thing ${i}`,
    category: "Cart",
    type: "functional",
    priority: "high",
    startPath: "/cart",
    preconditions: [],
    expectedResults: [`The cart shows ${i} items`],
    requiresAuth: false,
    requiredData: [],
    requirements: [],
    ...extra,
});
const plan = (n: number) => JSON.stringify({ scenarios: Array.from({ length: n }, (_, i) => scenario(i + 1)) });
const analysis = JSON.stringify({
    siteType: "ecommerce",
    purpose: "A shop",
    features: ["catalogue", "cart"],
    pagePurposes: [{ path: "/", type: "home", purpose: "Home" }],
    journeys: [{ name: "Buy", description: "Buy a product", steps: [{ action: "Add to cart", page: "/", endpoint: "" }], priority: "critical", pages: ["/"], requiresAuth: false }],
    authenticationMechanisms: [],
});

type Expect = { kind: "cleaned" | "salvaged" | "partial"; dropped: number; items?: number } | "refused";
const FIXTURES: Array<{ name: string; standsFor: string; schema: z.ZodTypeAny; items?: string; text: string; expect: Expect }> = [
    { name: "fenced", standsFor: "S14 understanding, not valid JSON", schema: LinkedAnalysisSchema, text: "```json\n" + analysis + "\n```", expect: { kind: "cleaned", dropped: 0 } },
    {
        name: "<think> first",
        standsFor: "S14 understanding (M2.7 reasons before answering)",
        schema: LinkedAnalysisSchema,
        text: `<think>The user wants {pages} and [journeys]; let me list them.</think>\n${analysis}`,
        expect: { kind: "cleaned", dropped: 0 },
    },
    { name: "prose before and after", standsFor: "S13 planning, not valid JSON", schema: PlanSchema, items: "scenarios", text: `Here is the plan [3 ideas]:\n${plan(3)}\nLet me know {if} you need more.`, expect: { kind: "cleaned", dropped: 0, items: 3 } },
    {
        name: "truncated mid-item",
        standsFor: "S13 understanding/planning at the output limit",
        schema: PlanSchema,
        items: "scenarios",
        text: plan(5).slice(0, plan(5).lastIndexOf('"expectedResults"') + 30),
        expect: { kind: "salvaged", dropped: 1, items: 4 },
    },
    { name: "1 bad item of 20", standsFor: "S13 planning, scenarios.4.type", schema: PlanSchema, items: "scenarios", text: JSON.stringify({ scenarios: Array.from({ length: 20 }, (_, i) => scenario(i + 1, i === 4 ? { type: "smoke-ish" } : {})) }), expect: { kind: "partial", dropped: 1, items: 19 } },
    { name: "unclosed string", standsFor: "a cut-off answer inside a value", schema: PlanSchema, items: "scenarios", text: `${plan(2).slice(0, -2)},{"title":"Log in with a wrong passw`, expect: { kind: "salvaged", dropped: 1, items: 2 } },
    { name: "truncated object, no item list", standsFor: "S14 understanding at the output limit", schema: LinkedAnalysisSchema, text: analysis.slice(0, analysis.indexOf('"journeys"') + 20), expect: "refused" },
    { name: "garbage", standsFor: "a refusal or chatter", schema: PlanSchema, items: "scenarios", text: "I'm sorry, I cannot produce that {plan} right now.", expect: "refused" },
    { name: "empty after a cut", standsFor: "cut before the first item ended", schema: PlanSchema, items: "scenarios", text: '{"scenarios":[{"title":"Log in', expect: "refused" },
    { name: "valid JSON, top-level field wrong", standsFor: "off-schema outside the list", schema: LinkedAnalysisSchema, text: analysis.replace('"ecommerce"', "42"), expect: "refused" },
];

describe("the R1 fixture corpus", () => {
    for (const f of FIXTURES) {
        it(`${f.name} (${f.standsFor})`, () => {
            // Each fixture is an answer the schema itself refuses as it stands.
            expect(() => f.schema.parse(JSON.parse(f.text))).toThrow();
            const got = tolerate(f.text, f.schema, f.items);
            if (f.expect === "refused") return expect(got).toBeUndefined();
            expect(got).toMatchObject({ kind: f.expect.kind, dropped: f.expect.dropped });
            expect(f.schema.safeParse(got!.value).success).toBe(true);
            if (f.expect.items !== undefined) expect((got!.value as Record<string, unknown[]>)[f.items!]).toHaveLength(f.expect.items);
        });
    }

    it("keeps the valid items in order and drops exactly the bad one", () => {
        const f = FIXTURES.find((x) => x.name === "1 bad item of 20")!;
        const titles = (tolerate(f.text, f.schema, f.items)!.value as { scenarios: Array<{ title: string }> }).scenarios.map((s) => s.title);
        expect(titles).not.toContain("Scenario 5");
        expect(titles[4]).toBe("Scenario 6");
    });

    it("never keeps half a string or number of a cut-off answer", () => {
        const [c] = candidates('{"scenarios":[{"title":"Done","n":12');
        expect(c).toEqual({ value: { scenarios: [{ title: "Done" }] }, truncated: true });
    });

    it("removes only leading thinking: the same words inside a value stay", () => {
        expect(stripWrapping('<think>a</think>\n{"t":"<think>x</think>"}')).toBe('\n{"t":"<think>x</think>"}');
    });

    it("drops nothing without a declared item list", () => {
        const f = FIXTURES.find((x) => x.name === "1 bad item of 20")!;
        expect(tolerate(f.text, f.schema)).toBeUndefined();
    });
});

/** A small seeded random source, so a failing case can be rerun. */
function rng(seed: number) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("property: anything accepted passes the original schema", () => {
    const schema = z.object({ title: z.string().min(1), items: z.array(z.object({ id: z.number().int(), name: z.string().min(2) })).min(2) });
    const mutate = (r: () => number, text: string): string => {
        const pick = Math.floor(r() * 6);
        if (pick === 0) return text.slice(0, Math.floor(r() * text.length));
        if (pick === 1) return `prose {x} [${Math.floor(r() * 9)}]\n${text}\nbye`;
        if (pick === 2) return "```\n" + text + "\n```";
        if (pick === 3) return `<think>${text.slice(0, 20)}</think>${text}`;
        if (pick === 4) {
            const i = Math.floor(r() * text.length);
            return text.slice(0, i) + ['"', "}", "]", ",", ":", "x"][Math.floor(r() * 6)] + text.slice(i + 1);
        }
        return text;
    };
    it("holds for 3000 mutated answers", () => {
        const r = rng(20261121);
        let accepted = 0;
        for (let n = 0; n < 3000; n++) {
            const count = 1 + Math.floor(r() * 6);
            const value = {
                // Sometimes a field outside the list is wrong, so dropping items alone must not make it pass.
                title: r() < 0.2 ? "" : "t",
                items: Array.from({ length: count }, (_, i) => (r() < 0.25 ? { id: i + 0.5, name: "x" } : { id: i, name: `item ${i}` })),
            };
            let text = JSON.stringify(value);
            for (let k = Math.floor(r() * 3); k >= 0; k--) text = mutate(r, text);
            const got = tolerate(text, schema, r() < 0.7 ? "items" : undefined);
            if (!got) continue;
            accepted++;
            expect(schema.safeParse(got.value).success, text).toBe(true);
            expect(got.dropped).toBeGreaterThanOrEqual(0);
        }
        // The property is only meaningful if many answers were accepted.
        expect(accepted).toBeGreaterThan(300);
    });
});

describe("guard: task R reads with the schemas as they were", () => {
    // Pinned on p47-base (ca8ecf97). A change here must be a deliberate schema change, never a looser one for task R.
    // PlanSchema re-pinned for sheet items 31-32: scenarios gained the optional `caseSteps` and `caseData` (spec/schema.ts); nothing else changed.
    const PINNED = {
        PlanSchema: "1f9d1ed871547000",
        AnalysisSchema: "1139206e28d40aaa",
        LinkedAnalysisSchema: "134cd9ecd737369c",
    };
    const digest = (s: z.ZodTypeAny) => createHash("sha256").update(JSON.stringify(z.toJSONSchema(s, { unrepresentable: "any", io: "output" }))).digest("hex").slice(0, 16);
    it("PlanSchema, AnalysisSchema and LinkedAnalysisSchema are unchanged", () => {
        expect({ PlanSchema: digest(PlanSchema), AnalysisSchema: digest(AnalysisSchema), LinkedAnalysisSchema: digest(LinkedAnalysisSchema) }).toEqual(PINNED);
    });
});
