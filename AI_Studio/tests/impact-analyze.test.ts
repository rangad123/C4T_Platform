/**
 * Impact analysis of a PR (src/engine/impact/analyze.ts). Pure, no AI: the optional AI link is tested with a scripted client.
 *
 * Seed PRs (tests/fixtures/seed-prs.ts) each turn one seeded defect on in examples/bench-shop or examples/bench-rbac. The routes each one
 * must reach were written by reading the sources by hand (the same truth as tests/impact-routes-unit.test.ts). The test suite here has one
 * test per route, written the way a test's footprint records it, so "the tests that cover it" are known by construction.
 */
import { describe, expect, it, vi } from "vitest";
import { analyzeImpact, type ImpactInput } from "../src/engine/impact/analyze.js";
import type { CoverageItem, TestCoverage } from "../src/platform/selection/coverage.js";
import { seedIds, seedPr, type BenchApp } from "./fixtures/seed-prs.js";

const ep = (method: string, path: string): CoverageItem => ({ kind: "endpoint", method: method as CoverageItem["method"], path, query: [], source: "declared", seenIn: ["step 1"] });
const pg = (path: string): CoverageItem => ({ kind: "page", path, query: [], source: "observed", seenIn: ["run of 12 Nov"] });
const test = (id: string, items: CoverageItem[]): TestCoverage => ({ testId: id, testKey: id, title: id, kind: "api", items, completeness: "declared-complete", limits: [] });
/** The test that covers a route: an any-method route under /api is called with GET, any other any-method route is a page. */
const testFor = (route: string): TestCoverage => {
    const [m, p] = route.split(" ") as [string, string];
    return test(`T ${route}`, [m === "*" ? (p.startsWith("/api") ? ep("GET", p) : pg(p)) : ep(m, p)]);
};

/** `tests`: covering tests beyond one per route (another route's test that an any-method route also serves). */
const SHOP: Record<string, { exact: boolean; routes: string[]; tests?: string[] }> = {
    "BS-06": { exact: true, routes: ["PUT /api/profile"] },
    "BS-09": { exact: true, routes: ["POST /api/cart/items"] },
    "BS-03": { exact: true, routes: ["POST /api/cart/items", "PATCH /api/cart/items/{}"] },
    "BS-10": { exact: true, routes: ["POST /api/orders", "* /checkout/review"] },
    "BS-07": { exact: true, routes: ["POST /api/orders"] },
    // the any-method cancel route also serves BS-05's POST cancel test
    "BS-08": { exact: true, routes: ["* /api/orders/{}", "* /api/orders/{}/cancel", "* /api/orders/{}/pay", "* /orders/{}"], tests: ["POST /api/orders/{}/cancel"] },
    "BS-05": { exact: true, routes: ["POST /api/orders/{}/cancel"] },
    "BS-01": { exact: false, routes: ["POST /api/cart/discount", "GET /api/cart"] },
    "BS-02": { exact: false, routes: ["GET /api/cart"] },
    "BS-11": { exact: false, routes: ["GET /api/cart", "POST /api/orders", "POST /api/cart/items", "PATCH /api/cart/items/{}", "DELETE /api/cart/items/{}"] },
    "BS-12": { exact: false, routes: ["GET /api/orders", "* /orders"] },
    "BS-04": { exact: false, routes: ["POST /api/register", "POST /register"] },
};
const RBAC: typeof SHOP = {
    "BR-08": { exact: true, routes: ["POST /api/notes"] },
    "BR-06": { exact: true, routes: ["DELETE /api/notes/{}/share/{}"] },
    "BR-03": { exact: true, routes: ["GET /api/admin/users"] },
    "BR-04": { exact: true, routes: ["PATCH /api/admin/users/{}"] },
    "BR-01": { exact: false, routes: ["* /api/notes/{}", "* /api/notes/{}/share", "* /api/notes/{}/share/{}", "* /notes/{}"] },
    "BR-02": { exact: false, routes: ["PUT /api/notes/{}"] },
    "BR-07": { exact: false, routes: ["POST /api/register", "POST /register"] },
};
const suiteOf = (truth: typeof SHOP) => [...new Set(Object.values(truth).flatMap((t) => t.routes))].map(testFor).concat(test("T unrelated", [ep("GET", "/api/version"), pg("/about")]));
const keyOf = (e: { method: string; path: string }) => `${e.method} ${e.path}`;

async function seed(app: BenchApp, id: string, extra: Partial<ImpactInput> = {}) {
    const pr = seedPr(app, id);
    return analyzeImpact({ files: pr.files, sources: pr.sources, tests: suiteOf(app === "bench-shop" ? SHOP : RBAC), ...extra });
}

describe("each seed PR of the PR bench reaches its endpoint and the tests that cover it", () => {
    for (const [app, truth] of [["bench-shop", SHOP], ["bench-rbac", RBAC]] as const) {
        it(`${app}: every seed but the session check`, async () => {
            // every seed of the app is in the truth (BR-05 is the session check, below)
            expect(seedIds(app).filter((s) => s !== "BR-05").sort()).toEqual(Object.keys(truth).sort());
            for (const [id, t] of Object.entries(truth)) {
                const r = await seed(app, id);
                const endpoints = r.endpoints.map(keyOf).sort();
                const tests = r.tests.map((x) => x.id.replace(/^T /, "")).sort();
                if (t.exact) {
                    expect(endpoints, id).toEqual([...t.routes].sort());
                    expect(tests, id).toEqual([...t.routes, ...(t.tests ?? [])].sort());
                } else {
                    expect(endpoints, id).toEqual(expect.arrayContaining(t.routes));
                    expect(tests, id).toEqual(expect.arrayContaining(t.routes));
                }
                expect(tests, id).not.toContain("unrelated");
                // every link says how it gets there
                for (const e of r.endpoints) expect(e.evidence[0], id).toMatch(/^examples\/bench-\w+\/server\.mjs:\d+ is (inside the handler of|in \w+\(\))/);
                for (const x of r.tests) expect(x.evidence.join(" "), id).toMatch(/^(its steps call|a recorded run opened) .*, handled by (GET|POST|PUT|PATCH|DELETE|ANY) \//);
                expect(r.unmapped, id).toEqual([]);
                expect(r.shared, id).toEqual([]);
            }
        });
    }

    it("bench-rbac BR-05: the session check before routing is a shared part and unmapped, never tied to a guessed route", async () => {
        const r = await seed("bench-rbac", "BR-05");
        expect(r.endpoints).toEqual([]);
        expect(r.tests).toEqual([]);
        expect(r.shared).toHaveLength(1);
        expect(r.shared[0]).toMatch(/is in userOf\(\).*outside every route handler\.$/);
        expect(r.unmapped.map((u) => u.path)).toEqual(["examples/bench-rbac/server.mjs"]);
    });

    it("hands the reached routes to the preview as pages and endpoints", async () => {
        const r = await seed("bench-shop", "BS-10");
        expect(r.changes.endpoints.sort()).toEqual(["/checkout/review", "POST /api/orders"]);
        expect(r.changes.pages).toEqual(["/checkout/review"]);
    });
});

describe("no link from a similar name", () => {
    const decoy = "examples/bench-shop/cart-routes.mjs";
    const decoySrc = "export function postApiCartItems(req) {\n    return req.body;\n}\n";

    it("a renamed file whose name looks like a route, and whose function is named like one, reaches nothing", async () => {
        const pr = seedPr("bench-shop", "BS-09");
        const r = await analyzeImpact({
            files: [{ path: decoy, previousPath: "examples/bench-shop/cart.mjs", status: "renamed", patch: "@@ -2,1 +2,1 @@\n-    return req;\n+    return req.body;" }],
            sources: { ...pr.sources, [decoy]: decoySrc },
            tests: suiteOf(SHOP),
            model: { pages: [], workflows: [{ id: "W1", name: "Cart items", steps: [{ order: 1, action: "Add to cart", endpoint: "POST /api/cart/items" }], preconditions: [], postconditions: [], roles: [], sourceType: "observed", evidence: [] }] },
            rules: [{ ref: "R-1", description: "Cart routes add items", endpoints: ["POST /api/cart/items"], workflows: [], entities: ["Cart"] }],
            findings: [{ id: "F-1", title: "cart-routes", endpoint: "POST /api/cart/items" }],
        });
        expect(r.endpoints).toEqual([]);
        expect([r.tests, r.workflows, r.rules, r.entities, r.findings, r.requirements]).toEqual([[], [], [], [], [], []]);
        expect(r.files).toEqual([{ path: decoy, functions: ["postApiCartItems"], mapped: false }]);
        expect(r.unmapped[0]!.path).toBe(decoy);
        expect(r.unmapped[0]!.why.join(" ")).toMatch(/postApiCartItems is not used in any file given/);
    });

    it("a pure rename (no patch) links nothing and is listed as unmapped", async () => {
        const pr = seedPr("bench-shop", "BS-09");
        const r = await analyzeImpact({ files: [{ path: "examples/bench-shop/app.mjs", previousPath: "examples/bench-shop/server.mjs", status: "renamed" }], sources: { "examples/bench-shop/app.mjs": Object.values(pr.sources)[0]! }, tests: suiteOf(SHOP) });
        expect(r.endpoints).toEqual([]);
        expect(r.tests).toEqual([]);
        expect(r.unmapped).toEqual([{ path: "examples/bench-shop/app.mjs", why: [expect.stringMatching(/^No patch/)] }]);
    });

    it("a changed file that is not code is unmapped, with why", async () => {
        const r = await analyzeImpact({ files: [{ path: "README.md", status: "modified", patch: "@@ -1,1 +1,1 @@\n-a\n+b" }], sources: { "README.md": "b\n" } });
        expect(r.unmapped).toEqual([{ path: "README.md", why: [expect.stringMatching(/not a JavaScript or TypeScript file/)] }]);
    });
});

describe("from endpoints to workflows, rules, entities, requirements and past findings", () => {
    const model: ImpactInput["model"] = {
        pages: [{ id: "p-products", path: "/products", purpose: "", elements: [], forms: [], structures: [], interactions: [] }, { id: "p-review", path: "/checkout/review", purpose: "", elements: [], forms: [], structures: [], interactions: [] }],
        workflows: [
            { id: "W-checkout", name: "Checkout", steps: [{ order: 1, action: "Review", page: "p-review" }, { order: 2, action: "Place the order", endpoint: "POST /api/orders" }], preconditions: [], postconditions: [], roles: [], sourceType: "observed", evidence: [] },
            { id: "W-browse", name: "Browse", steps: [{ order: 1, action: "Look", page: "p-products" }], preconditions: [], postconditions: [], roles: [], sourceType: "observed", evidence: [] },
            { id: "W-orders", name: "Orders", steps: [], preconditions: [], postconditions: [], roles: [], sourceType: "observed", evidence: [] },
        ],
    };
    const rules: ImpactInput["rules"] = [
        { ref: "R-1", description: "An order needs a delivery address", endpoints: ["POST /api/orders"], workflows: [], entities: ["Order"] },
        { ref: "R-2", description: "Checkout keeps the cart", endpoints: [], workflows: ["W-checkout"], entities: ["Cart"] },
        { ref: "R-3", description: "Orders list newest first", endpoints: ["GET /api/products"], workflows: ["W-browse"], entities: ["Product"] },
    ];
    const findings = [
        { id: "F-1", title: "Order total wrong", endpoint: "POST /api/orders" },
        { id: "F-2", title: "Review page blank", page: "/checkout/review" },
        { id: "F-3", title: "Cart add fails", endpoint: "POST /api/cart/items" },
    ];
    const requirementLinks = [
        { requirement: "REQ-1", testId: "T POST /api/orders" },
        { requirement: "REQ-2", testId: "T unrelated" },
    ];

    it("links each with its evidence, and only what a reached endpoint or page backs", async () => {
        const r = await seed("bench-shop", "BS-07", { model, rules, findings, requirementLinks });
        expect(r.workflows.map((w) => w.id)).toEqual(["W-checkout"]);
        expect(r.workflows[0]!.evidence).toEqual([expect.stringMatching(/^step 2 sends POST \/api\/orders, handled by POST \/api\/orders \(examples\/bench-shop\/server\.mjs:\d+\)$/)]);
        expect(r.rules.map((x) => x.id)).toEqual(["R-1", "R-2"]);
        expect(r.rules[1]!.evidence).toEqual(["belongs to the reached workflow Checkout"]);
        expect(r.entities.map((x) => x.id)).toEqual(["Order", "Cart"]);
        expect(r.requirements).toEqual([{ id: "REQ-1", name: "REQ-1", evidence: ["linked to the reached test T POST /api/orders T POST /api/orders"] }]);
        expect(r.findings.map((x) => x.id)).toEqual(["F-1"]);
    });

    it("a page step and a page finding link through a reached page route", async () => {
        const r = await seed("bench-shop", "BS-10", { model, findings });
        expect(r.workflows[0]!.evidence.map((e) => e.split(",")[0])).toEqual(["step 1 happens on /checkout/review", "step 2 sends POST /api/orders"]);
        expect(r.findings.map((x) => x.id).sort()).toEqual(["F-1", "F-2"]);
    });
});

describe("the optional AI link to requirements", () => {
    const requirements = [{ ref: "REQ-1", text: "Orders need a delivery address." }];

    it("is off by default: no call", async () => {
        const r = await seed("bench-shop", "BS-07");
        expect(r.ai).toBeUndefined();
    });

    it("makes one call, keeps only cited ids and files it was given, and marks its links as suggestions", async () => {
        const object = vi.fn(async () => ({
            links: [
                { requirement: "req-1", file: "examples/bench-shop/server.mjs", line: 200, why: "The order check changed." },
                { requirement: "REQ-9", file: "examples/bench-shop/server.mjs", why: "invented id" },
                { requirement: "REQ-1", file: "src/invented.ts", why: "invented file" },
            ],
        }));
        const pr = seedPr("bench-shop", "BS-07");
        const secret = "sk_" + "live_0123456789abcdefghijKLMN";
        const files = [{ ...pr.files[0]!, patch: `${pr.files[0]!.patch}\n@@ -1,0 +1,1 @@\n+const KEY = "${secret}";` }];
        const r = await analyzeImpact({ files, sources: pr.sources, ai: { client: { object } as never, requirements } });
        expect(object).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(object.mock.calls[0])).not.toContain(secret);
        expect(r.ai).toEqual({ links: [{ id: "REQ-1", name: "REQ-1", evidence: ["AI suggestion, not verified: examples/bench-shop/server.mjs:200: The order check changed."] }], dropped: 2 });
        // never mixed into the evidence-backed links
        expect(r.requirements).toEqual([]);
    });
});
