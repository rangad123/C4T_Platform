/**
 * C10 database checks wired into the engine (Phase 4 T23), against the real bench apps through the D-a back end (the token-gated data
 * routes), run as the validator runs scripts (Playwright, the run's database check service on loopback). No real model: the stored-data
 * rule proposal is answered by a scripted double.
 *   - The generated checks: persistence after each 2xx write of the C9 chains, orphans and duplicates along the declared keys, and the
 *     proposed rules over rows. On the clean apps every test is green; each stored-data seed of T20 turns its test red:
 *       BS-18 (the order leaves its cart's item rows) on the orphan check, BS-06 (the profile is not stored) on the persistence check,
 *       BS-12 (the newest order is missing from the list) on the C9 list check after the database showed the order stored,
 *       BS-17 (a second account for an e-mail in another case) on the duplicate check, BR-11 (a deleted note leaves its shares) on the
 *       orphan check. BS-17 and BR-11 need a write the C9 chains do not make (C6 and the explorer make them in a full run), so their
 *       tests are that write followed by the checks withDatabaseChecks adds.
 *   - Through runGeneration (API only, data changes on, BS-18): the layer report counts the database checks, a test fails on one, and
 *     the rule proposal's prompt carries names only; without read-only access no proposal is made and the report says why.
 * Ports 9611-9614. Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/db-checks-wiring.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { generateApiWorkflowSpecs } from "../src/engine/api/workflows.js";
import { benchDataProbe, registerBenchProbe } from "../src/engine/database/bench-data.js";
import { integrityChecks, withDatabaseChecks } from "../src/engine/database/checks.js";
import type { DatabaseProbe } from "../src/engine/database/probe.js";
import { proposeRowRelations } from "../src/engine/database/propose.js";
import { startDbCheckService } from "../src/engine/database/service.js";
import { renderScript } from "../src/engine/generators/index.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import type { GenerationSink, GenerationSummary } from "../src/engine/orchestrator.js";
import { TestSpecSchema, type Step, type TestSpec } from "../src/engine/spec/schema.js";
import { runScripts } from "../src/engine/validation/runner.js";
import { BENCH_DATA_TEST_TOKEN, startBenchApp, type BenchApp } from "../src/eval/bench/verify/app.js";
import { benchOpenApi } from "./fixtures/bench-openapi.js";

beforeAll(() => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
});

const REQUIREMENTS = [
    { id: "3.8", text: "Each cart line shows the item, its unit price, the quantity and the line total; the line total is the unit price times the quantity." },
    { id: "3.10", text: "The cart shows the subtotal, the discount, the shipping charge and the total; the total is the subtotal minus the discount plus the shipping charge." },
];
const RULES = {
    relations: [
        { requirementId: "3.8", table: "order_lines", expression: "lineTotal == unitPrice * quantity" },
        { requirementId: "3.10", table: "orders", expression: "total == subtotal - discount + shipping" },
    ],
};
/** The scripted model: the stored-data rules above; nothing else is proposed. Every prompt is kept. */
function scripted(prompts: Array<{ system: string; prompt: string }>): LlmClient {
    return {
        modelName: "scripted",
        usage: { inputTokens: 0, outputTokens: 0 },
        text: (async () => "no") as LlmClient["text"],
        imageObject: async () => {
            throw new Error("no image calls in this test");
        },
        object: (async ({ system, prompt, purpose }: { system: string; prompt: string; purpose?: string }) => {
            prompts.push({ system, prompt });
            if (/rules each stored row/.test(system)) return RULES;
            if (/business invariants/.test(system)) return { invariants: [] };
            if (/analysing a web application/.test(system)) return { siteType: "ecommerce", purpose: "A small shop", features: [], pagePurposes: [], journeys: [], authenticationMechanisms: ["form"] };
            if (purpose === "planning") return { scenarios: [] };
            throw new Error(`not scripted: ${purpose ?? system.slice(0, 60)}`);
        }) as LlmClient["object"],
    } as unknown as LlmClient;
}

const req = (method: string, path: string, extra: Record<string, unknown> = {}): Step => ({ action: "request", method, path, auth: "default", description: `${method} ${path}`, ...extra }) as Step;
const handSpec = (testId: string, title: string, steps: Step[]): TestSpec => TestSpecSchema.parse({ testId, title, kind: "api", type: "functional", priority: "high", steps });

type Plan = { app: BenchApp; port: number; credentials: { username: string; password: string }; specs: (probe: DatabaseProbe) => Promise<Record<string, TestSpec>> };

async function chains(app: BenchApp, port: number) {
    return generateApiWorkflowSpecs(parseOpenApi(await benchOpenApi(app), `http://127.0.0.1:${port}/openapi.json`).operations, { allowMutating: true, maxWorkflows: 50 }).specs;
}
const pick = (all: Awaited<ReturnType<typeof chains>>, title: string) => {
    const d = all.find((s) => s.title.startsWith(title));
    if (!d) throw new Error(`no workflow "${title}"`);
    return d;
};
/** The checks the engine adds for this app (its schema's keys, and the scripted rule proposal over its names). */
async function checksFor(probe: DatabaseProbe) {
    const schema = await probe.schema();
    const rules = await proposeRowRelations({ llm: scripted([]) }, { requirements: REQUIREMENTS, schema, secrets: [] });
    return { schema, absence: [...integrityChecks(schema).map((name) => ({ name })), ...rules.checks], budget: { left: 40 } };
}
const withChecks = (testId: string, d: { title: string; steps: Step[] } & Record<string, unknown>, c: Awaited<ReturnType<typeof checksFor>>) => TestSpecSchema.parse({ ...d, testId, steps: withDatabaseChecks(d.steps, c.schema, c.absence, c.budget) });

const SHOP: Plan = {
    app: "bench-shop",
    port: 9611,
    credentials: { username: "alice@example.test", password: "Password1!" },
    specs: async (probe) => {
        const all = await chains("bench-shop", 9611);
        const c = await checksFor(probe);
        return {
            profile: withChecks("API-001", pick(all, "Workflow: what is written is read back (PUT /api/profile"), c),
            orders: withChecks("API-002", pick(all, "Workflow: order lifecycle"), c),
            registerAgain: handSpec("API-003", "Register an existing e-mail in another case", withDatabaseChecks([req("POST", "/api/register", { auth: "none", body: { name: "Alice Again", email: "ALICE@example.test", password: "Password1!" } })], c.schema, c.absence, c.budget)),
        };
    },
};
const RBAC: Plan = {
    app: "bench-rbac",
    port: 9612,
    credentials: { username: "ben@example.test", password: "Password1!" },
    specs: async (probe) => {
        // The note lifecycle chain is left out: on the clean app its PUT (sent without a body) is refused, before any database check.
        const c = await checksFor(probe);
        const ok = { action: "assertResponse", check: "statusClass", expected: "2xx", description: "" } as Step;
        return {
            deleteShared: handSpec("API-001", "Delete a note that is shared", withDatabaseChecks([req("DELETE", "/api/notes/n3"), ok], c.schema, c.absence, c.budget)),
        };
    },
};

/** Per test: "green", or "red at <the failed step>: <its first error line>". */
async function runOn(plan: Plan, defects: string): Promise<{ verdicts: Record<string, string>; specs: Record<string, TestSpec> }> {
    const app = await startBenchApp(plan.app, plan.port, defects);
    const probe = benchDataProbe({ url: app.base, token: BENCH_DATA_TEST_TOKEN });
    const service = await startDbCheckService(probe);
    try {
        const specs = await plan.specs(probe);
        const list = Object.values(specs);
        const scripts = list.map((spec) => ({ testId: spec.testId, ...renderScript(spec, "playwright-api", { baseUrl: app.base }) }));
        for (const s of scripts) expect(s.content).not.toContain(BENCH_DATA_TEST_TOKEN);
        const runs = await runScripts(loadConfig({}).scratchDir, scripts, { baseUrl: app.base, credentials: plan.credentials, headless: true, dbCheck: { url: service.url, token: service.token } }, { workers: 1 });
        const verdict = (spec: TestSpec, i: number) => {
            const r = runs[i]!;
            if (r.status === "passed") return "green";
            const step = r.failedStepIndex === undefined ? undefined : spec.steps[r.failedStepIndex];
            const at = step?.action === "assertResponse" ? (step.check === "dbCheck" ? `dbCheck ${step.name}` : step.check) : step?.action;
            return `red at ${at}: ${(r.error ?? r.status).split("\n")[0]} [step ${(r.failedStepIndex ?? -1) + 1}]`;
        };
        return { verdicts: Object.fromEntries(Object.keys(specs).map((k, i) => [k, verdict(list[i]!, i)])), specs };
    } finally {
        await service.close();
        await app.stop();
    }
}

describe("the stored-data seeds through the generated database checks", () => {
    it("bench-shop clean: every test is green, and each carries its database checks", async () => {
        const { verdicts, specs } = await runOn(SHOP, "none");
        expect(verdicts).toEqual({ profile: "green", orders: "green", registerAgain: "green" });
        const names = (s: TestSpec) => s.steps.flatMap((x) => (x.action === "assertResponse" && x.check === "dbCheck" ? [x.name] : []));
        expect(names(specs.profile!)).toContain("exists users where name = 'Test name {{unique}}w', address = 'test-address-{{unique}}w'");
        expect(names(specs.orders!)).toEqual(expect.arrayContaining(["exists orders where id = '{{orderId}}'", "exists orders where id = '{{orderId2}}'", "orphans cart_items(cartId) -> carts(id)", "duplicates users(email) any case", "relation order_lines: lineTotal == unitPrice * quantity", "relation orders: total == subtotal - discount + shipping"]));
    }, 300_000);

    it("BS-18: the order chain is red on the orphan check (cart_items → carts)", async () => {
        const { verdicts } = await runOn(SHOP, "BS-18");
        expect(verdicts.orders).toMatch(/^red at dbCheck orphans cart_items\(cartId\) -> carts\(id\): .*Database check failed/);
    }, 300_000);

    it("BS-06: the profile chain is red on the persistence check, before the API read-back", async () => {
        const { verdicts } = await runOn(SHOP, "BS-06");
        expect(verdicts.profile).toMatch(/^red at dbCheck exists users where name = .*no stored row matches/);
        expect(verdicts.orders).toBe("green");
    }, 300_000);

    it("BS-12: the order is stored (the database check passed) but missing from the list: red at the list check", async () => {
        const { verdicts, specs } = await runOn(SHOP, "BS-12");
        expect(verdicts.orders).toMatch(/^red at relation: /);
        // The stored-row check of the second order comes before the list check, so it passed.
        const steps = specs.orders!.steps;
        const stored = steps.findIndex((s) => s.action === "assertResponse" && s.check === "dbCheck" && s.name === "exists orders where id = '{{orderId2}}'");
        const list = steps.findIndex((s) => s.action === "assertResponse" && s.check === "relation");
        expect(stored).toBeGreaterThan(-1);
        expect(stored).toBeLessThan(list);
    }, 300_000);

    it("BS-17: registering an existing e-mail in another case is red on the duplicate check", async () => {
        const { verdicts } = await runOn(SHOP, "BS-17");
        expect(verdicts.registerAgain).toMatch(/^red at dbCheck duplicates users\(email\) any case: .*1 more row/);
    }, 300_000);

    it("bench-rbac: green clean; BR-11 is red on the orphan check (note_shares → notes)", async () => {
        expect((await runOn(RBAC, "none")).verdicts).toEqual({ deleteShared: "green" });
        const { verdicts } = await runOn(RBAC, "BR-11");
        expect(verdicts.deleteShared).toMatch(/^red at dbCheck orphans note_shares\(noteId\) -> notes\(id\): /);
    }, 400_000);
});

describe("through the engine (runGeneration, API only, data changes on)", () => {
    type Saved = { testId: string; steps: Step[]; validation?: string; reason?: string | null };
    async function generate(port: number, defects: string, withProbe: boolean): Promise<{ summary: GenerationSummary; tests: Saved[]; prompts: Array<{ system: string; prompt: string }> }> {
        const app = await startBenchApp("bench-shop", port, defects);
        const forget = withProbe ? registerBenchProbe(app.base, benchDataProbe({ url: app.base, token: BENCH_DATA_TEST_TOKEN })) : undefined;
        const prompts: Array<{ system: string; prompt: string }> = [];
        const tests: Saved[] = [];
        let n = 0;
        const sink: GenerationSink = {
            phase: async () => undefined,
            counters: async () => undefined,
            saveModel: async () => undefined,
            nextTestKey: async (prefix) => `${prefix}-${String(++n).padStart(3, "0")}`,
            createTest: async ({ spec }) => {
                tests.push({ testId: spec.testId, steps: spec.steps });
                return { id: spec.testId, testId: spec.testId };
            },
            updateTest: async (h, patch) => {
                const t = tests.find((x) => x.testId === h.testId);
                if (t && patch.validation) Object.assign(t, { validation: patch.validation, reason: patch.reason });
            },
            saveScript: async (h) => `script-${h.testId}`,
            recordExecution: async () => undefined,
            saveTextArtifact: async () => undefined,
            saveBaselines: async () => undefined,
            loadBaselines: async () => [],
            startAgentRun: async (_role, subject) => `run-${subject.split(" ")[0]}`,
            agentAction: () => undefined,
            finishAgentRun: async () => undefined,
        };
        try {
            const { runGeneration } = await import("../src/engine/orchestrator.js");
            const summary = await runGeneration(
                { config: loadConfig({ CONCURRENCY: "1", MAX_REPAIR_ATTEMPTS: "0" } as never), llm: scripted(prompts), emit: () => undefined },
                {
                    url: app.base, targets: ["api"], maxPages: 3, maxDepth: 1, maxScenarios: 0, allowMutatingApiTests: true, useMemory: false,
                    credentials: { username: "alice@example.test", password: "Password1!" },
                    requirements: { name: "requirements.md", text: REQUIREMENTS.map((r) => `- ${r.id} ${r.text}`).join("\n") },
                    functionalTests: false, accessibility: false, healthChecks: false, securityChecks: false, inputChecks: false, contractChecks: false, accessChecks: false, visionChecks: false,
                } as never,
                sink,
            );
            return { summary, tests, prompts };
        } finally {
            forget?.();
            await app.stop();
        }
    }

    it("with read-only access: the layer report counts the database checks, BS-18 fails one, and the rule prompt carries names only", async () => {
        const { summary, tests, prompts } = await generate(9613, "BS-18", true);
        const dbSteps = tests.flatMap((t) => t.steps.filter((s) => s.action === "assertResponse" && s.check === "dbCheck"));
        const dbTests = tests.filter((t) => t.steps.some((s) => s.action === "assertResponse" && s.check === "dbCheck"));
        expect(dbSteps.length).toBeGreaterThan(0);
        expect(dbSteps.length).toBeLessThanOrEqual(40);
        expect(summary.layers?.database).toEqual({ status: "ran", tests: dbTests.length, checks: dbSteps.length });
        expect(tests.some((t) => /Database check failed.*orphans cart_items\(cartId\) -> carts\(id\)/.test(t.reason ?? ""))).toBe(true);
        const rules = prompts.filter((p) => /rules each stored row/.test(p.system));
        expect(rules).toHaveLength(1);
        const tables = rules[0]!.prompt.slice(rules[0]!.prompt.indexOf("<<<TABLES"));
        expect(tables).toContain("cart_items: cartId, productId, quantity");
        // Names only: no stored value (the seeded users, products and orders), no count, never the data token.
        for (const v of ["alice@example.test", "Pocket Notebook", "ord-1000", "Harbour", BENCH_DATA_TEST_TOKEN]) expect(rules[0]!.prompt).not.toContain(v);
        expect(tables).not.toMatch(/\d/);
    }, 1_500_000);

    it("without read-only access: no rule proposal, no database check, and the report says why", async () => {
        const { summary, tests, prompts } = await generate(9614, "none", false);
        expect(prompts.filter((p) => /rules each stored row/.test(p.system))).toEqual([]);
        expect(tests.some((t) => t.steps.some((s) => s.action === "assertResponse" && s.check === "dbCheck"))).toBe(false);
        expect(summary.layers?.database).toEqual({ status: "unavailable", reason: "Not checked: no read-only database access is set up." });
    }, 1_500_000);
});
