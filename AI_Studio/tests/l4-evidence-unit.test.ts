/**
 * Engine fixes built from recorded L4 ladder trials (no model, no browser): the tests' specs and runs are copies of what the trial
 * databases stored, with only ids shortened.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { generateApiSpecs, TYPE_UNSTATED } from "../src/engine/api/test-specs.js";
import { benchOpenApi } from "./fixtures/bench-openapi.js";
import { fetchClient, probeInvariant, type ProbeEnv } from "../src/engine/api/probes.js";
import { startBenchApp, type RunningBenchApp } from "../src/eval/bench/verify/app.js";
import type { Invariant } from "../src/engine/validation/invariants.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { GENERATED_WRONG_VALUE, scrubSecretValues } from "../src/engine/spec/secret-values.js";
import { renderScript } from "../src/engine/generators/index.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { classifyFailedRun } from "../src/engine/validation/validator.js";
import { confidenceScore } from "../src/engine/findings/score.js";
import { judgeAttempts } from "../src/platform/findings/verify-service.js";

// rbac L4 trial 4, WEB-019: the C11 stored-injection page check made by security/functional.ts storedInjectionSpec.
const web019 = TestSpecSchema.parse({
    testId: "WEB-019",
    title: "Colleague can read a note shared with them: typed markup is shown as text",
    description: "The same workflow, with “<i data-c4t-probe>” markup typed into 2 fields before it saves.",
    kind: "web",
    category: "Security",
    type: "security",
    priority: "high",
    preconditions: ["Data changes are allowed in this environment"],
    steps: [
        { action: "navigate", url: "/notes/new", description: "Open /notes/new" },
        { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.ben.username}}", description: "Sign in as Ana (test account)" },
        { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.ben.password}}", description: 'Enter "{{credentials.ben.password}}" into label "Password"' },
        { action: "click", locator: { by: "role", role: "button", value: "Sign in", exact: true }, description: 'Click button "Sign in"' },
        { action: "fill", locator: { by: "label", value: "Title" }, value: 'C4T <i data-c4t-probe="1">probe</i> {{unique}}', description: 'Enter "Product demo qaxfbr 3" into label "Title", with a marker in markup' },
        { action: "fill", locator: { by: "label", value: "Text" }, value: 'C4T <i data-c4t-probe="2">probe</i> {{unique}}', description: 'Enter "Created by an automated test (qaxfbr 1)." into label "Text", with a marker in markup' },
        { action: "click", locator: { by: "role", role: "button", value: "Save note", exact: true }, description: 'Click button "Save note"' },
        { action: "wait", ms: 500, description: "Let the page show what was saved" },
        { action: "assert", check: "count", locator: { by: "css", value: "[data-c4t-probe]" }, expected: 0, source: "3.15", description: "The marker is shown as text: the page holds no element made from it" },
    ],
    expectedResults: ["Typed text is shown as text (requirement 3.15)"],
    testData: { runTag: "qaxfbr" },
    tags: ["security", "input-injection", "data-changing", "role:ben"],
    source: { origin: "security-check", requirements: ["3.15"] },
});
const markerError = "Error: expect(locator).toHaveCount(expected) failed\n\nLocator:  locator('[data-c4t-probe]')\nExpected: 0\nReceived: 1\nTimeout:  8000ms\n";
function web019Run(failAt = 8, error = markerError): ScriptRun {
    return {
        testId: "WEB-019",
        status: "failed",
        durationMs: 11171,
        error,
        failedStepIndex: failAt,
        steps: web019.steps.slice(0, failAt + 1).map((s, i) => ({ index: i, title: `${i + 1}. ${s.description}`, status: i === failAt ? "failed" : "passed", ...(i === failAt ? { error } : {}) })),
        artifacts: [],
        responses: [],
    };
}

describe("BR-10: a failing engine security check on a page is a finding", () => {
    it("the recorded WEB-019 run (marker rendered as an element) is NEEDS_REVIEW, naming the stated rule", () => {
        const c = classifyFailedRun(web019, web019Run());
        expect(c?.status).toBe("NEEDS_REVIEW");
        expect(c?.reason).toContain("3.15");
        expect(c?.reason).toContain("Received: 1");
    });
    it("a run that broke before the stated check (a field not found) is not a finding", () => {
        expect(classifyFailedRun(web019, web019Run(4, "Error: locator.fill: Timeout 8000ms exceeded"))).toBeUndefined();
    });
    it("a model-written page test with the same failing step is not classed by this rule", () => {
        expect(classifyFailedRun({ ...web019, source: { origin: "generated" } } as never, web019Run())).toBeUndefined();
    });
});

/** An OS-assigned loopback port (the fast tier runs files in parallel). */
const freePort = () =>
    new Promise<number>((resolve) => {
        const srv = net.createServer().listen(0, "127.0.0.1", () => {
            const port = (srv.address() as net.AddressInfo).port;
            srv.close(() => resolve(port));
        });
    });

// shop L4 trials 1 and 4, requirement 4.1 (SAVE10 takes 10% of the subtotal), as the saved probe tests API-058 show the kept invariants:
// trial 4 named the cart-line setup (and sent it with a sampled "test-productId-{{unique}}"), trial 1 named none. Both probed SAVE10 on
// an empty cart, where BS-01 (discount from the first line only, examples/bench-shop/server.mjs priced()) cannot show.
describe("BS-01: the invariant probe builds the state the stated rule reads", () => {
    const expression = '$code == "SAVE10" implies discount == round(subtotal * 0.1)';
    const trial4: Invariant = { requirementId: "4.1", endpoint: "POST /api/cart/discount", setup: ["POST /api/register", "POST /api/cart/items"], write: "POST /api/cart/discount", expression };
    const trial1: Invariant = { requirementId: "4.1", endpoint: "POST /api/cart/discount", setup: [], write: "POST /api/cart/discount", expression };
    let seeded: RunningBenchApp;
    let clean: RunningBenchApp;
    const envOf = async (app: RunningBenchApp): Promise<ProbeEnv> => {
        const doc = await (await fetch(`${app.base}/openapi.json`)).json();
        return { apis: parseOpenApi(doc, `${app.base}/openapi.json`).operations, dataChanges: true, newClient: async () => fetchClient(app.base) };
    };
    beforeAll(async () => {
        // The trial's seeded app had every seed on; BS-09 (an unknown product answered 200) is why the sampled productId passed as setup.
        seeded = await startBenchApp("bench-shop", await freePort(), "BS-01,BS-09");
        clean = await startBenchApp("bench-shop", await freePort(), "none");
    });
    afterAll(async () => {
        await seeded?.stop();
        await clean?.stop();
    });
    it("with the trial-4 setup: the cart gets two listed products before SAVE10, and BS-01 fails the relation", async () => {
        const r = await probeInvariant(trial4, await envOf(seeded), { seed: 126009625 });
        expect(r.outcome).toBe("failed");
        const setup = r.spec!.steps.filter((s) => s.action === "request" && s.path === "/api/cart/items").map((s) => (s as { body?: { productId?: string } }).body?.productId);
        expect(setup).toHaveLength(2);
        expect(new Set(setup).size).toBe(2);
        expect(setup.every((id) => /^p\d+$/.test(String(id)))).toBe(true);
    });
    it("with no setup named (trial 1): the documented cart-line operation is added, and BS-01 fails the relation", async () => {
        const r = await probeInvariant(trial1, await envOf(seeded), { seed: 1 });
        expect(r.outcome).toBe("failed");
    });
    it("on the clean app the same probe holds", async () => {
        const r = await probeInvariant(trial4, await envOf(clean), { seed: 126009625 });
        expect(r.outcome).toBe("held");
    });
});

// Item 3: page false positives that verification Confirmed on L4 (they fail on the clean app too), judged again from their stored
// attempts; seeded catches of the same trials must stay Confirmed. The rows are copies of the trial databases (fixtures/l4-confirmed-findings.json).
describe("L4 page false positives are not Confirmed; seeded catches stay Confirmed", () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/l4-confirmed-findings.json"), "utf8")) as {
        cases: Array<{ trial: string; testKey: string; label: string; finding: Record<string, any>; attempts: any[]; test: Record<string, any>; requirements: Record<string, string> }>;
    };
    const judge = (c: (typeof fixture.cases)[number]) => {
        const rec = { ...c.finding, projectId: "p", status: "candidate", firstJobId: null, lastJobId: null, seenCount: 1, lastSeenAt: c.finding.firstSeenAt, state: "verification_pending", findingClass: null, severity: null, confidenceDetail: null, groupId: null, attempts: [], appVersion: null, rootCause: null };
        const test = { ...c.test, testKey: c.testKey, framework: "playwright" };
        const { tried, view, verdict } = judgeAttempts(rec as never, test as never, c.attempts, { clean: true, note: "on a newly registered account each time" }, new Map(Object.entries(c.requirements)));
        // As verifyOne then confirmAndGroup: Reproduced at high confidence becomes Confirmed.
        return verdict.to === "reproduced" && confidenceScore({ ...view, attempts: tried, independence: "independent" }).confidence === "high";
    };
    for (const c of fixture.cases)
        it(`${c.trial} ${c.testKey} (${c.label === "fp" ? "false positive" : `seed ${c.label}`}) ${c.label === "fp" ? "is not" : "stays"} Confirmed`, () => {
            expect(judge(c)).toBe(c.label !== "fp");
        });
});

// Item 4 (lead decision): the C2 wrong-type cases the clean bench apps accept (shop API-008/021/022/046, rbac API-004/017/018 in every
// L4 trial) are expectation issues unless the API document or a requirement states that refusal.
describe("C2 wrong-type cases: a defect only where the refusal is stated", () => {
    const docs: Record<string, any> = {};
    beforeAll(async () => {
        docs.shop = await benchOpenApi("bench-shop");
        docs.rbac = await benchOpenApi("bench-rbac");
    });
    const typeCases = (app: "shop" | "rbac", requirementsText?: string) =>
        generateApiSpecs(parseOpenApi(docs[app], "http://127.0.0.1/openapi.json").operations, { allowMutating: true, maxPerEndpoint: 6, contractChecks: false, ...(requirementsText ? { requirementsText } : {}) })
            .specs.filter((s) => s.title.includes("rejects an invalid type"))
            .map((s) => [s.title, s.tags.includes(TYPE_UNSTATED)] as const);
    it("the L4 false-positive cases are marked unstated; a documented 'Invalid quantity' keeps quantity's case stated", () => {
        const shop = new Map(typeCases("shop"));
        const rbac = new Map(typeCases("rbac"));
        for (const t of ['POST /api/register: rejects an invalid type for "name"', 'PUT /api/profile: rejects an invalid type for "name"', 'PUT /api/profile: rejects an invalid type for "address"', 'POST /api/checkout/address: rejects an invalid type for "address"'])
            expect(shop.get(t), t).toBe(true);
        expect(shop.get('POST /api/cart/items: rejects an invalid type for "quantity"')).toBe(false);
        for (const t of ['POST /api/register: rejects an invalid type for "name"', 'POST /api/notes: rejects an invalid type for "title"', 'POST /api/notes: rejects an invalid type for "body"']) expect(rbac.get(t), t).toBe(true);
    });
    it("a requirement that says wrong types are refused makes them stated", () => {
        expect(typeCases("shop", "9.1 A request with a value of the wrong type is refused (API: 400).").every(([, unstated]) => !unstated)).toBe(true);
    });
    it("the recorded shop-1 API-008 run (12345 for name, answered 2xx) is an expectation issue, not a finding", () => {
        const spec = TestSpecSchema.parse({
            testId: "API-008",
            title: 'POST /api/register: rejects an invalid type for "name"',
            kind: "api",
            category: "API · Register",
            type: "negative",
            priority: "medium",
            steps: [
                { action: "request", method: "POST", path: "/api/register", body: { name: 12345, email: "qa+{{unique}}@example.com", password: "test-password-{{unique}}" }, auth: "default", description: "Send 12345 for name" },
                { action: "assertResponse", check: "statusClass", expected: "4xx", description: "Validation error" },
            ],
            expectedResults: ["Type validation error (4xx)"],
            tags: ["api", "validation", TYPE_UNSTATED],
            source: { origin: "openapi" },
        });
        const err = "Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 4\nReceived: 2";
        const run: ScriptRun = { testId: "API-008", status: "failed", durationMs: 40, error: err, failedStepIndex: 1, steps: [{ index: 0, title: "1. Send 12345 for name", status: "passed" }, { index: 1, title: "2. Validation error", status: "failed", error: err }], artifacts: [], responses: [{ method: "POST", path: "/api/register", status: 201 }] };
        const c = classifyFailedRun(spec, run);
        expect(c?.status).toBe("FAILED_VALIDATION");
        expect(c?.reason).toMatch(/^Expectation issue/);
        // The same case where the refusal is stated stays with the repair loop (and its documented-status rules), as before.
        expect(classifyFailedRun({ ...spec, tags: ["api", "validation"] }, run)).toBeUndefined();
    });
});

// Item 5 (L12): rbac L4 trial 5, WEB-037, as the model wrote it, with a stand-in for the bench password: a wrong-password test typed
// "Wrong" + the real password, kept in the spec, the script and every step title.
describe("L12: written values never hold the run's secrets", () => {
    const PASSWORD = "Stand-in-Pa55!";
    const web037 = () =>
        TestSpecSchema.parse({
            testId: "WEB-037",
            title: "Five failed sign-ins lock the email for one minute",
            kind: "web",
            category: "Sign in",
            type: "security",
            priority: "high",
            steps: [
                { action: "navigate", url: "/login", description: "Open /login" },
                { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}", description: 'Enter "{{credentials.username}}" into label "Email"' },
                ...Array.from({ length: 5 }, () => [
                    { action: "fill", locator: { by: "label", value: "Password" }, value: `Wrong${PASSWORD}`, description: `Enter "Wrong${PASSWORD}" into label "Password"` },
                    { action: "click", locator: { by: "role", role: "button", value: "Sign in", exact: true }, description: 'Click button "Sign in"' },
                ]).flat(),
                { action: "fill", locator: { by: "label", value: "Password" }, value: PASSWORD, description: "Enter the password" },
                { action: "assert", check: "visible", locator: { by: "text", value: "Too many failed sign-ins. Try again in a minute." }, source: "expected:1", description: "The lock-out message is shown" },
            ],
            expectedResults: [`Signing in with Wrong${PASSWORD} five times shows "Too many failed sign-ins. Try again in a minute." (requirement 2.14)`],
            tags: ["security", "high"],
            source: { origin: "browser-agent", requirements: ["2.14"] },
        });
    it("the wrong password becomes a generated value and no stored text holds the real one", () => {
        const spec = web037();
        expect(scrubSecretValues(spec, [PASSWORD])).toBeGreaterThan(0);
        const fills = spec.steps.filter((s) => s.action === "fill" && (s.locator as { value: string }).value === "Password").map((s) => (s as { value: string }).value);
        expect(fills.slice(0, 5)).toEqual(Array(5).fill(GENERATED_WRONG_VALUE));
        // The sign-in typed as it is stays the sign-in (placeholders handle it); everything else, the rendered script included, is clean.
        const { value: _signIn, ...rest } = spec.steps[12] as { value: string };
        expect(_signIn).toBe(PASSWORD);
        const stored = JSON.stringify({ ...spec, steps: spec.steps.map((s, i) => (i === 12 ? rest : s)) });
        expect(stored).not.toContain(PASSWORD);
        const script = renderScript({ ...spec, steps: spec.steps.slice(0, 12) }, "playwright", { baseUrl: "http://127.0.0.1:1" } as never).content;
        expect(script).not.toContain(PASSWORD);
        expect(script).toContain("wrong-");
    });
    it("a spec without a secret is left as it is", () => {
        const spec = web037();
        const before = JSON.stringify(spec);
        expect(scrubSecretValues(spec, ["not-in-the-test"])).toBe(0);
        expect(JSON.stringify(spec)).toBe(before);
    });
});
