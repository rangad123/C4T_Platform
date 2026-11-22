/**
 * C8 controlled concurrency (Phase 4 T24) without a browser. The gate refuses without data changes, without a gate, and for a bench
 * gate on an address that is not this computer. The pasted helper never sends more than k (2 to 5) at once nor more than 10 in a
 * test, counted before anything is sent. From bench-shop's API document, the checks are "pay" (req 6.11) and the order create (req
 * 5.7), at most 3 a run. The stored step round-trips as text and renders; the live interpreter refuses it with one sentence. The job
 * runner takes the bench gate from the server's own setting only, never from a job's options.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONCURRENCY_MAX_CHECKS, concurrencyAllowed, generateConcurrencySpecs, PARALLEL_HELPER_SOURCE, PARALLEL_MAX, PARALLEL_MAX_PER_TEST } from "../src/engine/api/concurrency.js";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import type { DraftSpec } from "../src/engine/api/test-specs.js";
import { comparableSpec, parseDsl, printSpec } from "../src/engine/dsl/index.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema, type Step } from "../src/engine/spec/schema.js";
import type { ApiEndpointModel } from "../src/engine/understanding/app-model.js";
import { executeStep } from "../src/engine/web/interpreter.js";
import { riskyChecksGateOf } from "../src/platform/job-runner.js";
import { benchOpenApi } from "./fixtures/bench-openapi.js";

const SHOP = parseOpenApi(await benchOpenApi("bench-shop"), "http://127.0.0.1:9604/openapi.json").operations;
const LOCAL = { dataChanges: true, appUrl: "http://127.0.0.1:9604", gate: "bench" as const };
const requests = (s: DraftSpec) => s.steps.filter((x): x is Extract<Step, { action: "request" }> => x.action === "request");

type Sent = { status: number };
const helper = new Function(`${PARALLEL_HELPER_SOURCE}\nreturn parallelCall;`) as () => (k: unknown, send: () => Promise<Sent>) => Promise<{ status: number; json: Record<string, unknown> }>;

describe("C8 gate", () => {
    it("refuses without data changes, without a gate, and for a bench gate off this computer", () => {
        expect(concurrencyAllowed({ ...LOCAL, dataChanges: false })).toEqual({ allowed: false, reason: "not checked: data changes are off" });
        expect(concurrencyAllowed({ dataChanges: true, appUrl: LOCAL.appUrl })).toEqual({ allowed: false, reason: "not checked: needs the client's authorization" });
        for (const appUrl of ["https://shop.example.com", "http://10.0.0.5:9604", "not an address"]) expect(concurrencyAllowed({ ...LOCAL, gate: "fixture", appUrl }).allowed).toBe(false);
        expect(concurrencyAllowed(LOCAL)).toEqual({ allowed: true });
        expect(concurrencyAllowed({ dataChanges: true, appUrl: "https://shop.example.com", gate: "authorization" })).toEqual({ allowed: true });
    });
    it("generates nothing when the gate is shut, and says why", () => {
        expect(generateConcurrencySpecs(SHOP, { dataChanges: true, appUrl: LOCAL.appUrl })).toEqual({ specs: [], refused: "not checked: needs the client's authorization" });
        expect(generateConcurrencySpecs(SHOP, { ...LOCAL, dataChanges: false }).specs).toEqual([]);
    });
    it("the job runner takes the bench gate from the server's own setting, never from the job's options", () => {
        expect(riskyChecksGateOf({ BENCH_RISKY_CHECKS: true })).toBe("bench");
        expect(riskyChecksGateOf({ BENCH_RISKY_CHECKS: false })).toBeUndefined();
        // A current client authorization (read by the security module, Q4) gives "authorization"; the bench setting still wins.
        expect(riskyChecksGateOf({ BENCH_RISKY_CHECKS: false }, true)).toBe("authorization");
        expect(riskyChecksGateOf({ BENCH_RISKY_CHECKS: true }, true)).toBe("bench");
        // The request's gate is that function of the server's setting and the project's records, and no job option of that name is ever read.
        const src = readFileSync(new URL("../src/platform/job-runner.ts", import.meta.url), "utf8");
        expect(src).toContain("riskyChecksGate: riskyChecksGateOf(config, deps.hasCurrentAuthorization?.(job.projectId, app.url) ?? false)");
        expect(src).not.toMatch(/\b(o|options|job\.options)\.riskyChecksGate\b/);
    });
});

describe("C8 helper caps (counted before anything is sent)", () => {
    const counter = () => {
        let n = 0;
        const statuses = [200, 409, 409, 409, 409];
        return { send: async () => ({ status: statuses[n++ % 5]! }), sent: () => n };
    };
    it("sends exactly k at once and answers a summary", async () => {
        const c = counter();
        const r = await helper()(3, c.send);
        expect(c.sent()).toBe(3);
        expect(r.status).toBe(200);
        expect(r.json).toEqual({ ok: 1, refused: 2, failed: 0, statuses: [200, 409, 409] });
    });
    it(`refuses k outside 2..${PARALLEL_MAX} and sends nothing`, async () => {
        for (const k of [1, 0, PARALLEL_MAX + 1, 100, "3; send(); //", Number.NaN]) {
            const c = counter();
            await expect(helper()(k, c.send)).rejects.toThrow(/Nothing was sent/);
            expect(c.sent()).toBe(0);
        }
    });
    it(`never sends more than ${PARALLEL_MAX_PER_TEST} in one test`, async () => {
        const c = counter();
        const call = helper();
        await call(5, c.send);
        await call(5, c.send);
        await expect(call(2, c.send)).rejects.toThrow(/at most 10/);
        expect(c.sent()).toBe(PARALLEL_MAX_PER_TEST);
    });
});

describe("C8 checks from bench-shop's API document", () => {
    const { specs } = generateConcurrencySpecs(SHOP, LOCAL);
    it("pays an order 3 times at once (one succeeds), then creates orders 3 times at once (one record)", () => {
        expect(specs.map((s) => s.title)).toEqual(["Concurrency: pay sent 3 times at once succeeds once (POST /api/orders/{id}/pay)", "Concurrency: 3 identical creates at once make one record (POST /api/orders)"]);
        const pay = specs[0]!;
        expect(requests(pay).map((r) => `${r.method} ${r.path}${r.parallel ? ` ×${r.parallel}` : ""}`)).toEqual([
            "POST /api/register", "GET /api/products", "POST /api/cart/items", "POST /api/checkout/address", "POST /api/orders", "POST /api/orders/{{orderId}}/pay ×3", "GET /api/orders/{{orderId}}",
        ]);
        expect(pay.steps).toContainEqual(expect.objectContaining({ check: "relation", expression: "ok == 1 and refused == 2" }));
        expect(specs[1]!.steps.at(-1)).toMatchObject({ check: "relation", expression: "count(orders) == count($listBefore) + 1" });
    });
    it("k is clamped to 2..5", () => {
        expect(requests(generateConcurrencySpecs(SHOP, { ...LOCAL, k: 9 }).specs[0]!).find((r) => r.parallel)!.parallel).toBe(PARALLEL_MAX);
        expect(requests(generateConcurrencySpecs(SHOP, { ...LOCAL, k: 1 }).specs[0]!).find((r) => r.parallel)!.parallel).toBe(2);
    });
    it(`at most ${CONCURRENCY_MAX_CHECKS} checks a run, one per workflow`, () => {
        const many: ApiEndpointModel[] = ["a", "b", "c", "d", "e"].flatMap((r) => SHOP.filter((e) => e.path.startsWith("/api/orders")).map((e) => ({ ...e, path: e.path.replace("/api/orders", `/api/${r}orders`) })));
        const out = generateConcurrencySpecs(many, LOCAL).specs;
        expect(out).toHaveLength(CONCURRENCY_MAX_CHECKS);
        expect(new Set(out.map((s) => s.title)).size).toBe(CONCURRENCY_MAX_CHECKS);
    });
    it("each check is a valid stored test, round-trips as text and renders with the capped helper", () => {
        for (const d of specs) {
            const spec = TestSpecSchema.parse({ ...d, testId: "API-001" });
            const printed = printSpec(spec);
            expect(printed.reasons, printed.text).toEqual([]);
            expect(printed.text).toContain("sent 3 times at once");
            const back = parseDsl(printed.text);
            expect(back.diagnostics, printed.text).toEqual([]);
            expect(comparableSpec(back.spec!)).toBe(comparableSpec(spec));
            const script = renderScript(spec, "playwright-api", { baseUrl: "http://127.0.0.1:9604" }).content;
            expect(script).toContain("await parallelCall(3, () => call(request,");
            expect(script).toContain("const PARALLEL_MAX_PER_TEST = 10;");
        }
    });
    it("the text form refuses a count outside 2..5", () => {
        const r = parseDsl('Test: Too many\nKind: api\nSend a POST request to /api/orders sent 6 times at once\n');
        expect(r.spec).toBeNull();
    });
    it("the live interpreter refuses a parallel request with one sentence", async () => {
        const step = TestSpecSchema.parse({ testId: "API-001", title: "Pay at once", kind: "api", steps: [{ action: "request", method: "POST", path: "/api/orders", parallel: 3 }] }).steps[0]!;
        await expect(executeStep({} as never, step, {}, "http://127.0.0.1:9604", 1000)).rejects.toThrow("A request sent several times at once runs only in a saved API script, not step by step.");
    });
});
