/**
 * Test-selection preview, pure parts (src/platform/selection/coverage.ts, preview.ts): what a test is mapped to, how addresses are
 * normalised, and how a change set turns into a recommendation. No platform, no browser, no AI.
 */
import { describe, expect, it } from "vitest";
import { extractCoverage, normalisePath, parseEndpoint, splitAddress, type ObservedRun, type TestFacts } from "../src/platform/selection/coverage.js";
import { observedOf } from "../src/platform/selection/facts.js";
import { MAX_CHANGES, previewSelection, readChanges, RECOMMENDATION_NOTE } from "../src/platform/selection/preview.js";
import type { Evidence } from "../src/engine/evidence/model.js";

const test = (over: Partial<TestFacts> & { steps?: unknown[] }): TestFacts => ({
    id: over.id ?? "t1",
    testKey: over.testKey ?? "WEB-001",
    title: over.title ?? "A test",
    kind: over.kind ?? "web",
    spec: over.spec ?? { steps: over.steps ?? [] },
    runs: over.runs ?? [],
    // By default the newest run given is the test's latest relevant run and is fresh (facts.ts decides this from the stored rows). An API
    // test's runs keep no record: by default its latest run passed on its current version (selection-freshness covers the other cases).
    freshness:
        over.freshness ??
        (over.runs?.[0]
            ? { fresh: true, executionId: over.runs[0].executionId }
            : over.kind === "api"
              ? { fresh: true, executionId: "api-run" }
              : { fresh: false, why: "No run of it has been recorded yet, so what it touches is only known from its steps.", never: true }),
    ...(over.specUnreadable ? { specUnreadable: true } : {}),
});
const run = (over: Partial<ObservedRun> = {}): ObservedRun => ({ executionId: "e1", status: "passed", startedAt: "2026-11-10T10:00:00.000Z", complete: true, requests: [], ...over });

describe("addresses are normalised one way", () => {
    it("templates ids and {{variables}}, keeps query names apart and keeps a hash route", () => {
        expect(splitAddress("/orders/42?tab=details&page=2")).toEqual({ path: "/orders/{}", query: ["page", "tab"] });
        expect(splitAddress("/orders/{{orderId}}/items")).toEqual({ path: "/orders/{}/items", query: [] });
        expect(splitAddress("/users/user-{{unique}}")).toEqual({ path: "/users/{}", query: [] });
        expect(splitAddress("/app#/cart/7?step=2")).toEqual({ path: "/app", query: ["step"], route: "/cart/{}" });
        expect(splitAddress("/docs#top")).toEqual({ path: "/docs", query: [] });
        expect(splitAddress("https://Shop.Example.test/a/123e4567-e89b-12d3-a456-426614174000/")).toEqual({ host: "shop.example.test", path: "/a/{}", query: [] });
        expect(normalisePath("/orders/{id}")).toBe("/orders/{}");
    });

    it("does not merge different endpoints or pages", () => {
        expect(splitAddress("/orders")!.path).not.toBe(splitAddress("/orders/7")!.path);
        expect(splitAddress("/orders/7/items")!.path).not.toBe(splitAddress("/orders/7")!.path);
        expect(splitAddress("/users/alice")!.path).toBe("/users/alice");
        expect(parseEndpoint("GET /orders/{}")).not.toEqual(parseEndpoint("POST /orders/{}"));
    });

    it("refuses what is not an address", () => {
        for (const bad of ["", "   ", "{{url}}", "javascript:alert(1)", "//evil.test/x", "mailto:a@b.test"]) expect(splitAddress(bad), bad).toBeUndefined();
        expect(parseEndpoint("FETCH /x")).toBeUndefined();
        expect(parseEndpoint("/app#/cart")).toBeUndefined();
        expect(parseEndpoint("post /orders/9")).toEqual({ method: "POST", path: "/orders/{}", query: [] });
        expect(parseEndpoint("/orders")).toEqual({ path: "/orders", query: [] });
    });
});

describe("coverage of one test", () => {
    it("takes declared pages from navigate steps (1, 6, 7)", () => {
        const c = extractCoverage(test({ steps: [{ action: "navigate", url: "/orders/42?tab=details" }, { action: "click", locator: { strategy: "role", value: "x" } }, { action: "navigate", url: "/app#/cart/7" }] }));
        expect(c.items).toEqual([
            { kind: "page", path: "/app#/cart/{}", query: [], source: "declared", seenIn: ["step 3"] },
            { kind: "page", path: "/orders/{}", query: ["tab"], source: "declared", seenIn: ["step 1"] },
        ]);
        expect(c.completeness).toBe("partial");
    });

    it("takes declared endpoints and methods from request steps, with query names from both forms (2)", () => {
        const c = extractCoverage(test({ kind: "api", testKey: "API-001", spec: { steps: [{ action: "request", method: "POST", path: "/api/orders/{{id}}?dry=1", query: { page: "2" } }, { action: "assertResponse", check: "status", expected: 201 }, { action: "request", method: "get", path: "/api/items" }], testData: { id: "7" } } }));
        expect(c.items).toEqual([
            { kind: "endpoint", method: "GET", path: "/api/items", query: [], source: "declared", seenIn: ["step 3"] },
            { kind: "endpoint", method: "POST", path: "/api/orders/{}", query: ["dry", "page"], source: "declared", seenIn: ["step 1"] },
        ]);
        expect(c.completeness).toBe("declared-complete");
    });

    it("adds observed pages and endpoints from a recorded run, kept apart from declared ones (3, 4)", () => {
        const c = extractCoverage(
            test({
                steps: [{ action: "navigate", url: "/orders/9" }],
                runs: [run({ requests: [{ method: "GET", type: "document", path: "/orders/9" }, { method: "POST", type: "fetch", path: "/api/orders/9?x=[hidden]" }, { method: "GET", type: "script", path: "/app.js" }, { method: "GET", type: "xhr", path: "/collect", host: "analytics.example.test" }] })],
            }),
        );
        // Another site's request is kept, marked external (nothing is dropped); a script file is not a page or an endpoint.
        expect(c.items.map((i) => `${i.source} ${i.kind} ${i.method ?? ""} ${i.host ? `//${i.host}` : ""}${i.path}${i.external ? " external" : ""}`.replace(/\s+/g, " "))).toEqual([
            "observed endpoint POST /api/orders/{}",
            "observed endpoint GET //analytics.example.test/collect external",
            "declared page /orders/{}",
            "observed page /orders/{}",
        ]);
        expect(c.items.find((i) => i.source === "observed" && i.kind === "endpoint")!.query).toEqual(["x"]);
        // While the application's API address is not set, another site's endpoint may be its own API, so the run does not
        // make the test complete; with the API address set, it does.
        expect(c.completeness).toBe("partial");
        expect(c.limits[0]).toBe("A run called endpoints on another site, and the application's API address is not set, so whether they are the application's own API is not known.");
        const withApi = extractCoverage(test({ steps: [{ action: "navigate", url: "/orders/9" }], runs: [run({ requests: [{ method: "GET", type: "document", path: "/orders/9" }, { method: "GET", type: "xhr", path: "/collect", host: "analytics.example.test" }] })] }), { appHost: "shop.example.test", apiHosts: ["api.example-shop.test"] });
        expect(withApi.completeness).toBe("observed-complete");
    });

    it("never repeats a mapping: the same page from two steps or two runs is one item with both places (5)", () => {
        const c = extractCoverage(test({ steps: [{ action: "navigate", url: "/orders/1" }, { action: "navigate", url: "/orders/2?b=1" }], runs: [run({ requests: [{ method: "GET", type: "fetch", path: "/api/x/1" }] }), run({ executionId: "e2", startedAt: "2026-11-09T10:00:00.000Z", requests: [{ method: "GET", type: "fetch", path: "/api/x/2" }] })] }));
        const page = c.items.filter((i) => i.kind === "page");
        expect(page).toHaveLength(1);
        expect(page[0]).toMatchObject({ path: "/orders/{}", query: ["b"], seenIn: ["step 1", "step 2"] });
        expect(c.items.filter((i) => i.kind === "endpoint")).toEqual([{ kind: "endpoint", method: "GET", path: "/api/x/{}", query: [], source: "observed", seenIn: ["run of 2026-11-10", "run of 2026-11-09"] }]);
    });

    it("says coverage is unknown or partial, with why, instead of guessing (8)", () => {
        const clicks = extractCoverage(test({ steps: [{ action: "click", locator: { strategy: "role", value: "Open" } }] }));
        expect(clicks.completeness).toBe("unknown");
        expect(clicks.limits.join(" ")).toMatch(/opens no address of its own/);
        const failed = extractCoverage(test({ steps: [{ action: "navigate", url: "/a" }], runs: [run({ status: "failed" })] }));
        expect(failed.completeness).toBe("partial");
        expect(failed.limits.join(" ")).toMatch(/failed or were cut down/);
        const cut = extractCoverage(test({ steps: [], runs: [run({ complete: false, requests: [{ method: "GET", type: "document", path: "/a" }] })] }));
        expect(cut.completeness).toBe("partial");
        const phone = extractCoverage(test({ kind: "mobile", steps: [{ action: "tap" }] }));
        expect(phone.completeness).toBe("unknown");
        expect(phone.limits.join(" ")).toMatch(/mobile tests touch is not mapped/);
        const dynamic = extractCoverage(test({ kind: "api", steps: [{ action: "request", method: "GET", path: "{{next}}" }] }));
        expect(dynamic.completeness).toBe("unknown");
        const blocks = extractCoverage(test({ kind: "api", steps: [{ action: "request", method: "GET", path: "/a" }, { action: "useBlock", name: "missing" }] }));
        expect(blocks.completeness).toBe("partial");
    });

    it("handles empty and malformed declarations without failing (9)", () => {
        for (const spec of [null, 7, "text", {}, { steps: "no" }, { steps: [null, 3, "x", { action: "navigate" }, { action: "request", method: "GET" }, { action: "request", method: "BREW", path: "/a" }] }]) {
            const c = extractCoverage(test({ spec }));
            expect(c.items, JSON.stringify(spec)).toEqual([]);
            expect(c.completeness).toBe("unknown");
        }
        expect(extractCoverage(test({ specUnreadable: true, spec: undefined })).limits).toContain("The test's stored steps could not be read.");
    });

    it("leaves the facts it is given unchanged", () => {
        const facts = test({ steps: [{ action: "navigate", url: "/orders/1" }], runs: [run({ requests: [{ method: "GET", type: "document", path: "/b" }] })] });
        const before = JSON.stringify(facts);
        extractCoverage(facts);
        expect(JSON.stringify(facts)).toBe(before);
    });

    it("keeps another site's pages apart from the application's own", () => {
        const c = extractCoverage(test({ steps: [{ action: "navigate", url: "https://shop.example.test/orders/1" }, { action: "navigate", url: "https://pay.example.test/checkout" }] }), { appHost: "shop.example.test" });
        expect(c.items.map((i) => [i.host ?? "app", i.path])).toEqual([["app", "/orders/{}"], ["pay.example.test", "/checkout"]]);
    });
});

describe("the preview", () => {
    const api = extractCoverage(test({ id: "a1", testKey: "API-001", kind: "api", spec: { steps: [{ action: "request", method: "POST", path: "/orders/{{id}}" }], testData: { id: "3" } } }));
    const apiOther = extractCoverage(test({ id: "a2", testKey: "API-002", kind: "api", steps: [{ action: "request", method: "GET", path: "/health" }] }));
    const webObserved = extractCoverage(test({ id: "w1", testKey: "WEB-001", steps: [{ action: "navigate", url: "/" }], runs: [run({ requests: [{ method: "POST", type: "fetch", path: "/api/orders/3" }] })] }));
    const webPartial = extractCoverage(test({ id: "w2", testKey: "WEB-002", steps: [{ action: "navigate", url: "/cart" }] }));
    const webUnknown = extractCoverage(test({ id: "w3", testKey: "WEB-003", steps: [] }));
    const all = [webUnknown, webPartial, webObserved, apiOther, api];

    it("proposes matched tests with a reason per page or endpoint and where it came from (11)", () => {
        const { changes, ignored } = readChanges({ endpoints: ["POST /orders/{orderId}"] });
        const p = previewSelection(all, changes, ignored, "/api");
        expect(p.recommendationOnly).toBe(true);
        expect(p.note).toBe(RECOMMENDATION_NOTE);
        expect(p.matched.map((t) => t.testKey)).toEqual(["API-001", "WEB-001"]);
        const [declared, observed] = [p.matched[0]!.reasons[0]!, p.matched[1]!.reasons[0]!];
        expect(declared).toMatchObject({ change: "POST /orders/{}", matched: "POST /orders/{}", source: "declared", seenIn: ["step 1"] });
        expect(declared.sentence).toBe("The change names POST /orders/{}, and its steps call POST /orders/{} (step 1).");
        // The page's own traffic uses the API's full path (/api/orders/3); the request step uses the path under the API base.
        expect(observed).toMatchObject({ matched: "POST /api/orders/{}", source: "observed" });
        expect(observed.sentence).toMatch(/a recorded run called POST \/api\/orders\/\{\}/);
        expect(p.notMatched.map((t) => t.testKey)).toEqual(["API-002"]);
        expect(p.uncoveredChanges).toEqual([]);
    });

    it("never leaves out a test because its coverage is missing or partial: it is proposed as unknown (12)", () => {
        const { changes } = readChanges({ pages: ["/checkout"] });
        const p = previewSelection(all, changes);
        expect(p.unknown.map((t) => t.testKey).sort()).toEqual(["WEB-002", "WEB-003"]);
        for (const t of p.unknown) expect(t.why).toMatch(/^Proposed because what it touches is not fully known: /);
        // Only tests with complete coverage can be "not matched"; every other test is in matched or unknown.
        for (const t of p.notMatched) expect(["declared-complete", "observed-complete"]).toContain(t.completeness);
        expect(p.counts).toEqual({ tests: 5, matched: 0, unknown: 2, proposed: 2, notMatched: 3, cannotRun: 0 });
        expect(p.uncoveredChanges).toEqual(["/checkout"]);
    });

    it("matches any method when the change names none, and reports entries it cannot read", () => {
        const { changes, ignored } = readChanges({ endpoints: ["/health", "FETCH /x", "GET /health"], pages: ["{{x}}"] });
        expect(changes.map((c) => `${c.method ?? "*"} ${c.path}`)).toEqual(["* /health", "GET /health"]);
        expect(ignored.map((i) => i.given)).toEqual(["{{x}}", "FETCH /x"]);
        expect(previewSelection(all, changes).matched.map((t) => t.testKey)).toEqual(["API-002"]);
    });

    it("is the same for the same input, whatever the order of the tests", () => {
        const { changes } = readChanges({ endpoints: ["POST /orders/{}"], pages: ["/cart"] });
        expect(previewSelection([...all].reverse(), changes)).toEqual(previewSelection(all, changes));
    });
});

/** Corrections from a review of the selection preview: each numbered point, and the probes P1-P7 of the earlier review. */
describe("selection preview corrections", () => {
    const APP = { appHost: "shop.example.test", apiHosts: ["api.example.test"] };
    const keys = (tests: Array<{ testKey: string }>) => tests.map((t) => t.testKey);
    const one = (facts: TestFacts, change: { pages?: string[]; endpoints?: string[] }, app: typeof APP | { appHost: string } = APP, apiPrefix?: string) => {
        const { changes, ignored, notProcessed } = readChanges(change, app);
        return previewSelection([extractCoverage(facts, app)], changes, ignored, { notProcessed, ...(apiPrefix ? { apiPrefix } : {}) });
    };

    it("1. keeps requests to the application's other hosts and records a third-party host as external, never dropped (P1)", () => {
        const facts = test({ steps: [{ action: "navigate", url: "/" }], runs: [run({ requests: [{ method: "POST", type: "fetch", path: "/orders", host: "api.example.test" }, { method: "GET", type: "fetch", path: "/pixel", host: "tracker.other.test" }] })] });
        const c = extractCoverage(facts, APP);
        expect(c.items.filter((i) => i.kind === "endpoint")).toEqual([
            { kind: "endpoint", method: "POST", host: "api.example.test", path: "/orders", query: [], source: "observed", seenIn: ["run of 2026-11-10"] },
            { kind: "endpoint", method: "GET", host: "tracker.other.test", external: true, path: "/pixel", query: [], source: "observed", seenIn: ["run of 2026-11-10"] },
        ]);
        expect(c.completeness).toBe("observed-complete");
        // P1: the API on its own host is the application's: an endpoint change without a host matches it.
        expect(keys(one(facts, { endpoints: ["POST /orders"] }).matched)).toEqual(["WEB-001"]);
        // Without the API host in the settings, a sibling host under a shared parent domain is not proof of the application's own API:
        // the relationship is unclear, so the test is proposed and a full run is required, never "not matched".
        const unset = one(facts, { endpoints: ["POST /orders"] }, { appHost: "shop.example.test" });
        expect(keys(unset.unknown)).toEqual(["WEB-001"]);
        expect(unset.notMatched).toHaveLength(0);
        expect(unset.fullRunRequired).toBe(true);
        // The external host is matched only by a change that names it.
        expect(keys(one(facts, { endpoints: ["GET /pixel"] }).notMatched)).toEqual(["WEB-001"]);
        const named = one(facts, { endpoints: ["GET https://tracker.other.test/pixel"] });
        expect(named.matched[0]!.reasons[0]!.sentence).toBe("The change names GET //tracker.other.test/pixel (external), and a recorded run called GET //tracker.other.test/pixel (external) (run of 2026-11-10).");
    });

    it("2. records pages reached inside a single-page app, by path and by hash route (P2)", () => {
        const fp: Evidence = { v: 1, durationMs: 1, counts: { requests: 1, requestsKept: 0, console: 0, consoleKept: 0 }, steps: [], requests: [], console: [], footprint: { pages: [{ path: "/", step: 1 }, { path: "/orders", step: 2 }, { path: "/app#/cart/7", step: 3 }], endpoints: [] } };
        const facts = test({ steps: [{ action: "navigate", url: "/" }, { action: "click", locator: { strategy: "role", value: "Orders" } }], runs: [run({ ...observedOf(fp) })] });
        expect(extractCoverage(facts, APP).completeness).toBe("observed-complete");
        const p = one(facts, { pages: ["/orders"] });
        expect(p.matched[0]!.reasons.map((r) => r.sentence)).toEqual(["The change names /orders, and a recorded run opened /orders (run of 2026-11-10)."]);
        expect(keys(one(facts, { pages: ["/app#/cart/{id}"] }).matched)).toEqual(["WEB-001"]);
        // A hash route is compared as a path: the page /cart of a hash-routed app.
        expect(keys(one(facts, { pages: ["/cart/{}"] }).matched)).toEqual(["WEB-001"]);
        expect(keys(one(facts, { pages: ["/app#/checkout"] }).notMatched)).toEqual(["WEB-001"]);
    });

    it("3. records a form sent to the server as an endpoint and the page, and WebSocket, event stream and beacon traffic; unclassified traffic is never complete (P3)", () => {
        const facts = test({
            steps: [{ action: "navigate", url: "/login" }],
            runs: [run({ requests: [{ method: "POST", type: "document", path: "/login" }, { method: "GET", type: "websocket", path: "/live" }, { method: "GET", type: "eventsource", path: "/events" }, { method: "POST", type: "ping", path: "/beacon" }] })],
        });
        const c = extractCoverage(facts, APP);
        expect(c.completeness).toBe("observed-complete");
        expect(c.items.filter((i) => i.kind === "endpoint").map((i) => `${i.method} ${i.path} ${i.type}`)).toEqual(["POST /beacon beacon", "GET /events eventsource", "GET /live websocket", "POST /login form"]);
        expect(one(facts, { endpoints: ["POST /login"] }).matched[0]!.reasons[0]!.sentence).toBe("The change names POST /login, and a recorded run called POST /login (form) (run of 2026-11-10).");
        expect(keys(one(facts, { endpoints: ["GET /live"] }).matched)).toEqual(["WEB-001"]);
        expect(keys(one(facts, { endpoints: ["/beacon"] }).matched)).toEqual(["WEB-001"]);
        // A request of a kind the mapping does not know, or one the recorder could not classify: the run is not complete.
        for (const r of [run({ requests: [{ method: "GET", type: "other", path: "/x" }] }), run({ unclassified: 2, requests: [{ method: "GET", type: "document", path: "/login" }] })]) {
            const partial = extractCoverage(test({ steps: [{ action: "navigate", url: "/login" }], runs: [r] }), APP);
            expect(partial.completeness).toBe("partial");
            expect(partial.limits.join(" ")).toMatch(/could not classify/);
            const p = previewSelection([partial], readChanges({ endpoints: ["DELETE /account"] }, APP).changes);
            expect(keys(p.unknown)).toEqual(["WEB-001"]);
            expect(p.fullRunRequired).toBe(true);
        }
    });

    it("4. lists tests that cannot run, with why, and a not-matched test with its own reason", () => {
        const api = extractCoverage(test({ id: "a1", testKey: "API-001", kind: "api", steps: [{ action: "request", method: "GET", path: "/health" }] }));
        const broken = extractCoverage(test({ id: "b1", testKey: "API-002", kind: "api", specUnreadable: true, spec: undefined }));
        const phone = extractCoverage(test({ id: "m1", testKey: "MOB-001", kind: "mobile", steps: [{ action: "tap" }] }));
        const { changes } = readChanges({ endpoints: ["POST /orders"] });
        const cannotRun = new Map([
            ["b1", { why: "Cannot run: its stored steps cannot be read. Open it to fix or delete it.", unreadable: true }],
            ["m1", { why: "Cannot run on your runner: mobile tests need a device or a runner set up for them." }],
        ]);
        const p = previewSelection([api, broken, phone], changes, [], { cannotRun });
        expect(p.cannotRun.map((t) => [t.testKey, t.why])).toEqual([
            ["API-002", "Cannot run: its stored steps cannot be read. Open it to fix or delete it."],
            ["MOB-001", "Cannot run on your runner: mobile tests need a device or a runner set up for them."],
        ]);
        expect(p.counts).toEqual({ tests: 3, matched: 0, unknown: 0, proposed: 0, notMatched: 1, cannotRun: 2 });
        expect(p.notMatched[0]!.why).toBe("Not proposed: what it touches is fully known from its steps (1 page or endpoint), and none of it is in the change.");
        // The phone test was not judged (another runner may run it): a full run is required. The unreadable one cannot run anywhere.
        expect(p.fullRunReasons).toEqual(["1 test cannot run on your runner, so the preview did not judge it; a deploy run on another runner may still run it."]);
    });

    it("5. never cuts the change list silently: entries past the limit are listed and a full run is required (P4)", () => {
        const api = extractCoverage(test({ id: "a1", testKey: "API-001", kind: "api", steps: [{ action: "request", method: "POST", path: "/orders" }] }));
        const pages = Array.from({ length: MAX_CHANGES }, (_, i) => `/page-${i}`);
        const { changes, ignored, notProcessed } = readChanges({ pages, endpoints: ["POST /orders"] });
        expect(changes).toHaveLength(MAX_CHANGES);
        expect(notProcessed).toEqual(["POST /orders"]);
        const p = previewSelection([api], changes, ignored, { notProcessed });
        expect(p.notProcessed).toEqual(["POST /orders"]);
        expect(p.fullRunRequired).toBe(true);
        expect(p.fullRunReasons[0]).toBe(`The change names ${MAX_CHANGES + 1} pages and endpoints; the preview compares at most ${MAX_CHANGES}, so 1 was not compared with any test.`);
        // The complete test is not "not matched": the entry it touches may be the one not compared.
        expect(p.notMatched).toEqual([]);
        expect(p.unknown.map((t) => [t.testKey, t.why])).toEqual([["API-001", "Proposed because the change list was not read in full, so the entry it touches may be among those not compared."]]);
        // An entry that cannot be read is not a silent gap either.
        expect(previewSelection([api], readChanges({ endpoints: ["POST /orders", "FETCH /x"] }).changes, [{ given: "FETCH /x", why: "x" }]).fullRunRequired).toBe(true);
        // Nothing incomplete: no full run required.
        const clean = previewSelection([api], readChanges({ endpoints: ["POST /orders"] }).changes);
        expect(clean).toMatchObject({ fullRunRequired: false, fullRunReasons: [], notProcessed: [] });
    });

    it("6. matches a change that names the API's host with the API test's requests (P5)", () => {
        const facts = test({ id: "a1", testKey: "API-001", kind: "api", steps: [{ action: "request", method: "POST", path: "/orders" }] });
        expect(keys(one(facts, { endpoints: ["POST https://api.example.test/orders"] }).matched)).toEqual(["API-001"]);
        expect(keys(one(facts, { endpoints: ["POST https://SHOP.example.test/orders"] }).matched)).toEqual(["API-001"]);
        // Another site's endpoint of the same path is not this test's.
        const other = one(facts, { endpoints: ["POST https://payments.other.test/orders"] });
        expect(keys(other.notMatched)).toEqual(["API-001"]);
        expect(other.uncoveredChanges).toEqual(["POST //payments.other.test/orders (external)"]);
        // A request step to an absolute address names the test's own API host.
        const absolute = test({ id: "a2", testKey: "API-002", kind: "api", steps: [{ action: "request", method: "GET", path: "https://partner.other.test/v1/items" }] });
        expect(extractCoverage(absolute, APP).items[0]).toMatchObject({ host: "partner.other.test", path: "/v1/items" });
        expect(extractCoverage(absolute, APP).items[0]!.external).toBeUndefined();
        expect(keys(one(absolute, { endpoints: ["GET https://partner.other.test/v1/items"] }).matched)).toEqual(["API-002"]);
    });

    it("7. matches dynamic route patterns against concrete paths (P6)", () => {
        const facts = test({ steps: [{ action: "navigate", url: "/products/blue-shirt/reviews" }], runs: [run({ requests: [{ method: "GET", type: "document", path: "/products/blue-shirt/reviews" }] })] });
        for (const change of ["/products/{slug}/reviews", "/products/:slug/reviews", "/products/*/reviews", "/products/blue-shirt/reviews"]) expect(keys(one(facts, { pages: [change] }).matched), change).toEqual(["WEB-001"]);
        for (const change of ["/products/{slug}", "/products/{slug}/reviews/{id}", "/items/{slug}/reviews"]) expect(keys(one(facts, { pages: [change] }).notMatched), change).toEqual(["WEB-001"]);
        // A variable in the test matches a concrete change, too.
        const declared = test({ kind: "api", testKey: "API-001", steps: [{ action: "request", method: "GET", path: "/products/{{slug}}" }] });
        expect(keys(one(declared, { endpoints: ["GET /products/blue-shirt"] }).matched)).toEqual(["API-001"]);
    });

    it("8. follows the written URL semantics: host case and default port, case-sensitive path, unreserved escapes, trailing slash, query, hash", () => {
        expect(splitAddress("HTTPS://Shop.Example.Test:443/a/")).toEqual({ host: "shop.example.test", path: "/a", query: [] });
        expect(splitAddress("wss://Shop.Example.Test/live")!.host).toBe("shop.example.test");
        expect(normalisePath("/%7Euser/a%2db")).toBe("/~user/a-b");
        expect(normalisePath("/a%2fb")).toBe("/a%2Fb");
        expect(normalisePath("/Orders")).not.toBe(normalisePath("/orders"));
        const facts = test({ kind: "api", testKey: "API-001", steps: [{ action: "request", method: "GET", path: "/search?q=shoes" }, { action: "request", method: "GET", path: "/Orders/" }] });
        expect(keys(one(facts, { endpoints: ["GET /search"] }).matched)).toEqual(["API-001"]);
        expect(keys(one(facts, { endpoints: ["GET /search?q=x"] }).matched)).toEqual(["API-001"]);
        expect(keys(one(facts, { endpoints: ["GET /search?sort=x"] }).notMatched)).toEqual(["API-001"]);
        expect(keys(one(facts, { endpoints: ["GET /orders"] }).notMatched)).toEqual(["API-001"]);
        expect(keys(one(facts, { endpoints: ["GET https://shop.example.test/Orders/"] }).matched)).toEqual(["API-001"]);
        // A record that keeps no query names (a footprint) is matched by a change that names one: unknown never leaves a test out.
        const web = test({ steps: [{ action: "navigate", url: "/" }], runs: [run({ queryUnknown: true, requests: [{ method: "GET", type: "fetch", path: "/search" }] })] });
        expect(keys(one(web, { endpoints: ["GET /search?sort=x"] }).matched)).toEqual(["WEB-001"]);
    });

    it("treats a cut footprint and an older record without one as incomplete, never as complete (P7)", () => {
        const base: Evidence = { v: 1, durationMs: 1, counts: { requests: 1, requestsKept: 0, console: 0, consoleKept: 0 }, steps: [], requests: [], console: [], footprint: { pages: [{ path: "/", step: 1 }], endpoints: [], truncated: true } };
        const cut = extractCoverage(test({ steps: [{ action: "navigate", url: "/" }], runs: [run(observedOf(base))] }), APP);
        expect(cut.completeness).toBe("partial");
        expect(cut.limits.join(" ")).toMatch(/cut to its size limit/);
        const legacy: Evidence = { ...base, footprint: undefined, counts: { requests: 1, requestsKept: 1, console: 0, consoleKept: 0 }, requests: [{ t: 1, step: 1, method: "GET", type: "document", path: "/" }] };
        const old = extractCoverage(test({ steps: [{ action: "navigate", url: "/" }], runs: [run(observedOf(legacy))] }), APP);
        expect(old.completeness).toBe("partial");
        expect(old.limits.join(" ")).toMatch(/before runs kept their full footprint/);
        const nothing = extractCoverage(test({ steps: [{ action: "click", locator: { strategy: "role", value: "x" } }], runs: [run({ requests: [] })] }), APP);
        expect(nothing.completeness).toBe("unknown");
        expect(nothing.limits.join(" ")).toMatch(/recorded no page or endpoint/);
    });
});
