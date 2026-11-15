/**
 * Test-selection preview, coverage rules (pure parts, no platform, no browser, no AI): access checks are read from their settings and never
 * make a test complete; a web test's `request` step with an address that is not fully known keeps it partial; an address that
 * starts with a variable is read as the path after it; endpoints on another site while the API address is not set keep a test partial;
 * a run's hosts are judged against the address it opened, and a changed address makes its coverage out of date. The rule stays:
 * unknown, out-of-date or incomplete coverage requires a full run. Automatic selection stays off: nothing here runs or skips a test.
 */
import { describe, expect, it } from "vitest";
import { accessTarget, extractCoverage, isOwnHost, splitAddress, type ObservedRun, type TestFacts } from "../src/platform/selection/coverage.js";
import { runBaseHost } from "../src/platform/selection/facts.js";
import { ownAppHost } from "../src/shared/app-host.js";
import { previewSelection, readChanges } from "../src/platform/selection/preview.js";

const run = (over: Partial<ObservedRun> = {}): ObservedRun => ({ executionId: "e1", status: "passed", startedAt: "2026-11-13T10:00:00.000Z", complete: true, queryUnknown: true, requests: [], ...over });
const test = (steps: unknown[], over: Partial<TestFacts> = {}): TestFacts => {
    const runs = over.runs ?? [run({ requests: [{ method: "GET", type: "route", path: "/" }] })];
    return { id: "t1", testKey: "WEB-001", title: "A test", kind: "web", spec: { steps }, runs, freshness: runs[0] ? { fresh: true, executionId: runs[0].executionId } : { fresh: false, why: "No run.", never: true }, ...over };
};
const APP = { appHost: "app.test" };

describe("access checks", () => {
    const page = { action: "assert", check: "accessDenied", expected: JSON.stringify({ as: "viewer", path: "/admin/users", marker: "Users", by: "admin", sev: "high" }) };
    const apiCheck = { action: "assert", check: "accessDenied", expected: JSON.stringify({ api: true, as: "b", path: "/api/notes/12", origin: "https://app.test", by: "a", of: "a", sev: "high", pattern: "/api/notes/{}", evidence: [] }) };

    it("reads the page or API address the check opens as declared coverage", () => {
        expect(accessTarget(page.expected)).toEqual({ kind: "page", address: { path: "/admin/users", query: [] } });
        expect(accessTarget(apiCheck.expected)).toEqual({ kind: "endpoint", address: { host: "app.test", path: "/api/notes/{}", query: [] } });
        expect(accessTarget("{not json")).toBeUndefined();
        expect(accessTarget(JSON.stringify({ api: true, path: "//evil.example/x", origin: "https://app.test" }))).toBeUndefined();
        const c = extractCoverage(test([{ action: "navigate", url: "/" }, page, apiCheck]), APP);
        expect(c.items.filter((i) => i.source === "declared").map((i) => `${i.kind} ${i.method ?? ""} ${i.path}`)).toEqual(["endpoint GET /api/notes/{}", "page  /", "page  /admin/users"]);
    });

    it("never makes the test complete, so a change to what the check's page loads is proposed and requires a full run", () => {
        const c = extractCoverage(test([{ action: "navigate", url: "/" }, page]), APP);
        expect(c.completeness).toBe("partial");
        expect(c.limits).toContain("An access check opens its page as another account in a browser of its own, which the run's record does not see, so what that page loads is not known.");
        const p = previewSelection([c], readChanges({ endpoints: ["GET /api/users"] }, APP).changes);
        expect(p.notMatched).toHaveLength(0);
        expect(p.unknown.map((t) => t.testId)).toEqual(["t1"]);
        expect(p.fullRunRequired).toBe(true);
        // The page it opens matches by name, with a reason.
        const q = previewSelection([c], readChanges({ pages: ["/admin/users"] }, APP).changes);
        expect(q.matched[0]!.reasons[0]!.sentence).toBe("The change names /admin/users, and its steps open /admin/users (step 2).");
    });
});

describe("web request steps", () => {
    it("a request step whose address is only a variable keeps a web test partial, even with a complete passing run", () => {
        const c = extractCoverage(test([{ action: "navigate", url: "/" }, { action: "request", method: "POST", path: "{{ordersPath}}" }]), APP);
        expect(c.completeness).toBe("partial");
        expect(c.limits).toContain("A request's address is made only of a variable, so that endpoint is not known.");
        const p = previewSelection([c], readChanges({ endpoints: ["POST /orders"] }, APP).changes);
        expect(p.notMatched).toHaveLength(0);
        expect(p.fullRunRequired).toBe(true);
    });

    it("a request step with a known address is declared coverage and the test can still be complete", () => {
        const c = extractCoverage(test([{ action: "navigate", url: "/" }, { action: "request", method: "POST", path: "/orders" }]), APP);
        expect(c.completeness).toBe("observed-complete");
        const p = previewSelection([c], readChanges({ endpoints: ["POST /orders"] }, APP).changes);
        expect(p.matched[0]!.reasons[0]!.source).toBe("declared");
    });
});

describe("an address that starts with a variable", () => {
    it("is read as the path after the variable, and says the address is not fully known", () => {
        expect(splitAddress("{{base}}/orders")).toEqual({ path: "/orders", query: [], leadingVariable: true });
        expect(splitAddress("{{base}}/orders/{{id}}?x=1")).toEqual({ path: "/orders/{}", query: ["x"], leadingVariable: true });
        expect(splitAddress("{{sub}}.example.test/x")).toBeUndefined();
        expect(splitAddress("{{base}}//evil.test/x")!.path).toBe("/evil.test/x");
    });

    it("matches a change to that path, and an API test using it is partial, never not matched", () => {
        const c = extractCoverage(test([{ action: "request", method: "GET", path: "{{base}}/orders" }], { kind: "api", testKey: "API-001", runs: [], freshness: { fresh: true, executionId: "api-run" } }), APP);
        expect(c.items).toEqual([expect.objectContaining({ kind: "endpoint", method: "GET", path: "/orders", source: "declared" })]);
        expect(c.completeness).toBe("partial");
        expect(c.limits).toContain("A request's address starts with a variable, so where it is sent is not fully known.");
        const p = previewSelection([c], readChanges({ endpoints: ["GET /orders"] }, APP).changes);
        expect(p.matched.map((t) => t.testId)).toEqual(["t1"]);
        expect(p.fullRunRequired).toBe(true);
        const q = previewSelection([c], readChanges({ endpoints: ["GET /items"] }, APP).changes);
        expect(q.notMatched).toHaveLength(0);
        expect(q.fullRunRequired).toBe(true);
    });
});

describe("endpoints on another site while the API address is not set", () => {
    const apiElsewhere = run({ requests: [{ method: "GET", type: "route", path: "/" }, { method: "GET", type: "fetch", path: "/v1/orders", host: "api.other-site.test" }] });

    it("keep the test partial, so a change without a host is proposed and a full run is required", () => {
        const c = extractCoverage(test([{ action: "navigate", url: "/" }], { runs: [apiElsewhere] }), APP);
        expect(c.completeness).toBe("partial");
        expect(c.limits[0]).toBe("A run called endpoints on another site, and the application's API address is not set, so whether they are the application's own API is not known.");
        const p = previewSelection([c], readChanges({ endpoints: ["GET /v1/orders"] }, APP).changes);
        expect(p.notMatched).toHaveLength(0);
        expect(p.unknown.map((t) => t.testId)).toEqual(["t1"]);
        expect(p.fullRunRequired).toBe(true);
    });

    it("the preview names the reason for the full run: other-site endpoints and no API address set", () => {
        const SITE_REASON = (n: string, them: string) =>
            `${n} recorded runs called endpoints on another site (analytics, or the application's own API at another address), and the application's API address is not set, so whether a change to an endpoint reaches ${them} is not known. Set the API address in the application's settings to tell them apart.`;
        const analytics = run({ requests: [{ method: "GET", type: "route", path: "/" }, { method: "POST", type: "fetch", path: "/collect", host: "analytics.tracker.test" }] });
        const c = extractCoverage(test([{ action: "navigate", url: "/" }], { runs: [analytics] }), APP);
        const p = previewSelection([c], readChanges({ endpoints: ["POST /collect"] }, APP).changes);
        expect(p.fullRunReasons).toContain(SITE_REASON("1 test's", "it"));
        const c2 = extractCoverage(test([{ action: "navigate", url: "/" }], { id: "t2", testKey: "WEB-002", runs: [apiElsewhere] }), APP);
        expect(previewSelection([c, c2], readChanges({ endpoints: ["GET /v1/orders"] }, APP).changes).fullRunReasons).toContain(SITE_REASON("2 tests'", "them"));
        // With the API address set, there is no such reason.
        const app = { ...APP, apiHosts: ["api.app.test"] };
        const set = previewSelection([extractCoverage(test([{ action: "navigate", url: "/" }], { runs: [analytics] }), app)], readChanges({ endpoints: ["POST /collect"] }, app).changes);
        expect(set.fullRunReasons.join(" ")).not.toContain("another site");
    });

    it("with the API address set to that site, it is the application's own and the test can be complete", () => {
        const app = { ...APP, apiHosts: ["api.other-site.test"] };
        const c = extractCoverage(test([{ action: "navigate", url: "/" }], { runs: [apiElsewhere] }), app);
        expect(c.completeness).toBe("observed-complete");
        expect(previewSelection([c], readChanges({ endpoints: ["GET /v1/orders"] }, app).changes).matched).toHaveLength(1);
    });

    it("with the API address set elsewhere, another site is another site: complete, and not matched by a change without a host", () => {
        const app = { ...APP, apiHosts: ["api.app.test"] };
        const c = extractCoverage(test([{ action: "navigate", url: "/" }], { runs: [apiElsewhere] }), app);
        expect(c.completeness).toBe("observed-complete");
        expect(previewSelection([c], readChanges({ endpoints: ["GET /v1/orders"] }, app).changes).notMatched).toHaveLength(1);
    });
});

describe("a run's hosts are judged against the address it opened", () => {
    it("the address in force when the run started; a run older than every address took the first", () => {
        const addresses = [
            { host: "old.test", at: "2026-11-01T00:00:00.000Z" },
            { host: "new-site.test", at: "2026-11-10T00:00:00.000Z" },
        ];
        expect(runBaseHost(addresses, "2026-11-05T00:00:00.000Z")).toBe("old.test");
        expect(runBaseHost(addresses, "2026-11-12T00:00:00.000Z")).toBe("new-site.test");
        expect(runBaseHost(addresses, "2026-10-01T00:00:00.000Z")).toBe("old.test");
        expect(runBaseHost([], "2026-11-12T00:00:00.000Z")).toBeUndefined();
    });

    it("an API host of the old address stays the application's own after the address moved to another site", () => {
        const app = { appHost: "new-site.test" };
        const r = run({ baseHost: "old.test", requests: [{ method: "GET", type: "route", path: "/" }, { method: "GET", type: "fetch", path: "/orders", host: "api.old.test" }] });
        const c = extractCoverage(test([{ action: "navigate", url: "/" }], { runs: [r] }), app);
        const item = c.items.find((i) => i.path === "/orders")!;
        expect(item.external).toBeUndefined();
        expect(previewSelection([c], readChanges({ endpoints: ["GET /orders"] }, app).changes).matched).toHaveLength(1);
        // Without the run's own address it would be judged against today's and be another site's.
        const before = extractCoverage(test([{ action: "navigate", url: "/" }], { runs: [{ ...r, baseHost: undefined }] }), app);
        expect(before.items.find((i) => i.path === "/orders")!.external).toBe(true);
    });
});

describe("held tests require a full run (approved policy)", () => {
    it("any test held back because a shared part changed after its approval makes a full run required, naming it", () => {
        const c = extractCoverage(test([{ action: "navigate", url: "/checkout" }]), APP);
        const other = { ...extractCoverage(test([{ action: "navigate", url: "/" }]), APP), testId: "t2", testKey: "WEB-002", title: "Home" };
        const changes = readChanges({ pages: ["/elsewhere"] }, APP).changes;
        // Without held tests: both complete, none matched, no full run.
        expect(previewSelection([c, other], changes).fullRunRequired).toBe(false);
        const held = new Map([["t1", { why: "Cannot run: the reusable steps “Log in” changed after its approval, so runs hold it back until it is approved again.", nowhere: true, held: true }]]);
        const p = previewSelection([c, other], changes, [], { cannotRun: held });
        expect(p.cannotRun.map((t) => t.testId)).toEqual(["t1"]);
        expect(p.fullRunRequired).toBe(true);
        expect(p.fullRunReasons).toEqual([
            "1 test is held back because a shared part it uses changed after its approval, so runs leave it out until approved again and the deploy tests less than the project has: WEB-001 “A test” (the reusable steps “Log in” changed after its approval, so runs hold it back until it is approved again).",
        ]);
        // A test with no approved version (nowhere, not held) still adds no reason by itself.
        const unapproved = new Map([["t1", { why: "Cannot run: it has no approved version yet, and runs leave it out until one is approved.", nowhere: true }]]);
        expect(previewSelection([c, other], changes, [], { cannotRun: unapproved }).fullRunRequired).toBe(false);
    });
});

describe("a broken-links check and a variable inside a request path", () => {
    const links = { action: "assert", check: "noBrokenLinks" };
    const LINKS_LIMIT = "A broken-links check asks for every link on its page outside the page itself, which the run's record does not see, so the pages it depends on are not all known.";
    const PATH_LIMIT = "A request's address has a variable inside its path that is missing from the test data or whose value is not one part of a path, so that endpoint is not fully known.";

    it("a test with a broken-links check is partial, never observed-complete, so a change to a linked page proposes it", () => {
        const c = extractCoverage(test([{ action: "navigate", url: "/" }, links]), APP);
        expect(c.completeness).toBe("partial");
        expect(c.limits).toContain(LINKS_LIMIT);
        const p = previewSelection([c], readChanges({ pages: ["/pricing"] }, APP).changes);
        expect(p.notMatched).toHaveLength(0);
        expect(p.unknown.map((t) => t.testId)).toEqual(["t1"]);
        expect(p.fullRunRequired).toBe(true);
        // The other page checks read only what the page itself loaded: still complete.
        const other = extractCoverage(test([{ action: "navigate", url: "/" }, { action: "assert", check: "noConsoleErrors" }, { action: "assert", check: "pageBasics" }]), APP);
        expect(other.completeness).toBe("observed-complete");
        expect(other.limits).not.toContain(LINKS_LIMIT);
    });

    it("an API test whose path variable stands for several parts of the path is partial, not 'not matched'", () => {
        const api = (path: string, testData: Record<string, string>) => extractCoverage(test([{ action: "request", method: "GET", path }], { kind: "api", testKey: "API-001", spec: { steps: [{ action: "request", method: "GET", path }], testData }, runs: [], freshness: { fresh: true, executionId: "api-run" } }), APP);
        for (const [path, data] of [["/{{p}}", { p: "orders/list" }], ["/api/{{resource}}", { resource: "orders/list?x=1" }], ["/api/{{ empty }}/list", { empty: "" }], ["https://api.app.test/v1/{{p}}", { p: "a/b" }]] as Array<[string, Record<string, string>]>) {
            const c = api(path, data);
            expect(c.completeness, path).toBe("partial");
            expect(c.limits, path).toContain(PATH_LIMIT);
            const p = previewSelection([c], readChanges({ endpoints: ["GET /orders/list"] }, APP).changes);
            expect(p.notMatched, path).toHaveLength(0);
            expect(p.fullRunRequired, path).toBe(true);
        }
        // One part of a path from the test data (an id) is the known case: still complete. A variable after `?` is not in the path.
        for (const [path, data] of [["/orders/{{id}}", { id: "12" }], ["/orders?next={{p}}", { p: "a/b" }]] as Array<[string, Record<string, string>]>) {
            const c = api(path, data);
            expect(c.completeness, path).toBe("declared-complete");
            expect(c.limits, path).not.toContain(PATH_LIMIT);
        }
    });

    it("a path variable missing from the test data (set while the test runs, or a data-set column) is partial", () => {
        const api = (path: string, testData: Record<string, string>) => extractCoverage(test([{ action: "request", method: "GET", path }], { kind: "api", testKey: "API-001", spec: { steps: [{ action: "request", method: "GET", path }], testData }, runs: [], freshness: { fresh: true, executionId: "api-run" } }), APP);
        for (const [path, data] of [["/orders/{{orderId}}/items", {}], ["/{{next}}", { other: "x" }]] as Array<[string, Record<string, string>]>) {
            const c = api(path, data);
            expect(c.completeness, path).toBe("partial");
            expect(c.limits, path).toContain(PATH_LIMIT);
            expect(previewSelection([c], readChanges({ endpoints: ["GET /orders/list"] }, APP).changes).fullRunRequired, path).toBe(true);
        }
        const steps = [{ action: "navigate", url: "/" }, { action: "request", method: "POST", path: "/{{next}}" }];
        expect(extractCoverage(test(steps, { spec: { steps, testData: {} } }), APP).completeness).toBe("partial");
        expect(extractCoverage(test(steps), APP).completeness).toBe("partial");
    });

    it("a web test's request step with such a variable keeps it partial, even with a complete passing run", () => {
        const steps = [{ action: "navigate", url: "/" }, { action: "request", method: "POST", path: "/{{ordersPath}}" }];
        const c = extractCoverage(test(steps, { spec: { steps, testData: { ordersPath: "orders/list" } } }), APP);
        expect(c.completeness).toBe("partial");
        expect(c.limits).toContain(PATH_LIMIT);
        expect(extractCoverage(test(steps, { spec: { steps, testData: { ordersPath: "orders" } } }), APP).completeness).toBe("observed-complete");
    });
});

/**
 * Which hosts are the application's own: the same strict rule as the API checks (ownApiHost in src/engine/identity/access.ts). A shared
 * parent domain or hosting provider proves nothing; a host whose relationship is unclear is another site's, which keeps a test partial
 * while the API address is not set, so the preview requires a full run instead of calling the test "not matched".
 */
describe("own hosts: the API checks' strict rule, never a shared parent domain", () => {
    it("the app's own host on any port, a host under its name (www. dropped), a configured API host; nothing else", () => {
        expect(isOwnHost("shop.example:8443", { appHost: "shop.example" })).toBe(true);
        expect(isOwnHost("www.shop.example", { appHost: "shop.example" })).toBe(true);
        expect(isOwnHost("api.shop.example", { appHost: "www.shop.example" })).toBe(true);
        expect(isOwnHost("api.shop.example", { appHost: "app.shop.example" })).toBe(false);
        expect(isOwnHost("api.shop.example", { appHost: "app.shop.example", apiHosts: ["api.shop.example"] })).toBe(true);
        expect(isOwnHost("b.vercel.app", { appHost: "a.vercel.app" })).toBe(false);
        expect(isOwnHost("y.herokuapp.com", { appHost: "x.herokuapp.com" })).toBe(false);
        expect(isOwnHost("api.shop.example", { appHost: "shop.example.net" })).toBe(false);
        expect(isOwnHost("shop.example.net", { appHost: "shop.example" })).toBe(false);
        expect(isOwnHost("10.0.0.6", { appHost: "10.0.0.5" })).toBe(false);
        expect(isOwnHost("10.0.0.5:8080", { appHost: "10.0.0.5" })).toBe(true);
        expect(isOwnHost("a.localhost", { appHost: "localhost" })).toBe(false);
    });

    const called = (host: string) =>
        run({ requests: [{ method: "GET", type: "route", path: "/" }, { method: "POST", type: "fetch", path: "/orders", host }] });
    const preview = (appHost: string, host: string, apiHosts?: string[]) => {
        const app = { appHost, ...(apiHosts ? { apiHosts } : {}) };
        const c = extractCoverage(test([{ action: "navigate", url: "/" }], { runs: [called(host)] }), app);
        return { c, p: previewSelection([c], readChanges({ endpoints: ["POST /orders"] }, app).changes) };
    };

    for (const [appHost, host] of [["app.shop.example", "api.shop.example"], ["a.vercel.app", "b.vercel.app"], ["x.herokuapp.com", "y.herokuapp.com"], ["shop.example.net", "api.shop.example"]] as const) {
        it(`${host} called from ${appHost}: unclear, so the test is partial and a full run is required, never "not matched"`, () => {
            const { c, p } = preview(appHost, host);
            expect(c.items.find((i) => i.path === "/orders")!.external).toBe(true);
            expect(c.completeness).toBe("partial");
            expect(p.notMatched).toHaveLength(0);
            expect(p.unknown.map((t) => t.testId)).toEqual(["t1"]);
            expect(p.fullRunRequired).toBe(true);
        });
    }

    it("api.shop.example set as the API address of app.shop.example: the application's own, matched and complete", () => {
        const { c, p } = preview("app.shop.example", "api.shop.example", ["api.shop.example"]);
        expect(c.items.find((i) => i.path === "/orders")!.external).toBeUndefined();
        expect(c.completeness).toBe("observed-complete");
        expect(p.matched.map((t) => t.testId)).toEqual(["t1"]);
    });

    it("www.shop.example from shop.example is the same application: matched and complete with no API address set", () => {
        const { c, p } = preview("shop.example", "www.shop.example");
        expect(c.items.find((i) => i.path === "/orders")!.external).toBeUndefined();
        expect(c.completeness).toBe("observed-complete");
        expect(p.matched.map((t) => t.testId)).toEqual(["t1"]);
        expect(p.fullRunRequired).toBe(false);
    });

    it("a look-alike name is never the application's own: under the app's name means a dot boundary, API hosts match exactly", () => {
        expect(isOwnHost("evilshop.example", { appHost: "shop.example" })).toBe(false);
        expect(isOwnHost("evil-api.example", { appHost: "shop.example", apiHosts: ["api.example"] })).toBe(false);
        expect(isOwnHost("evil.10.0.0.5", { appHost: "10.0.0.5" })).toBe(false);
        expect(ownAppHost("WWW.Shop.Example", "shop.EXAMPLE")).toBe(true);
        expect(ownAppHost("Api.Example", "shop.example", ["API.example"])).toBe(true);
    });
});
