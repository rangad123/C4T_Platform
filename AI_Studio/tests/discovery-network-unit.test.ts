import { EventEmitter } from "node:events";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { documentedApiModels, isDocumentationPath, looksLikeDocumentation } from "../src/engine/discovery/docs.js";
import { NetworkInterceptor, normalizeApiPath, redactQuery } from "../src/engine/discovery/network.js";

/** Just enough of a Playwright request/response pair for the interceptor. */
function exchange(o: { url: string; method?: string; type?: string; status?: number; body?: unknown; sent?: string; headers?: Record<string, string> }) {
    const request = {
        url: () => o.url,
        method: () => o.method ?? "GET",
        resourceType: () => o.type ?? "fetch",
        headers: () => o.headers ?? {},
        postData: () => o.sent ?? null,
    };
    const response = {
        url: () => o.url,
        status: () => o.status ?? 200,
        request: () => request,
        headers: () => (o.body === undefined ? { "content-type": "text/html" } : { "content-type": "application/json; charset=utf-8" }),
        json: async () => o.body,
    };
    return { request, response };
}

async function watch(onPage: string, calls: Array<Parameters<typeof exchange>[0]>) {
    const page = new EventEmitter();
    const net = new NetworkInterceptor();
    net.attach(page as unknown as Page);
    net.setCurrentPage(onPage);
    for (const c of calls) {
        const { request, response } = exchange(c);
        page.emit("request", request);
        page.emit("response", response);
        await new Promise((r) => setTimeout(r, 0)); // each call finishes before the next starts
    }
    return net;
}

describe("API calls seen while exploring", () => {
    it("templates record ids in paths", () => {
        expect(normalizeApiPath("/api/users/12/orders/5f1d7c2e9b1e8a3d4c6f0a12")).toBe("/api/users/{id}/orders/{id}");
        expect(normalizeApiPath("/api/items/0b8e3c1a-4d2f-4e5a-9b6c-7d8e9f0a1b2c")).toBe("/api/items/{id}");
        expect(normalizeApiPath("/api/v2/users/me")).toBe("/api/v2/users/me");
        expect(normalizeApiPath("/")).toBe("/");
    });

    it("hides short secret names only when they are the whole name", () => {
        expect(redactQuery(new URL("https://a.test/x?code=123&zipcode=9&pin=1&spinner=on"))).toBe("?code=redacted&zipcode=9&pin=redacted&spinner=on");
        expect(redactQuery(new URL("https://a.test/x"))).toBe("");
    });

    it("folds calls into one endpoint per method and template, keeping no secrets", async () => {
        const net = await watch("https://shop.test/account", [
            { url: "https://shop.test/api/users/1?session_id=S1&page=1", body: { id: 1, password: "p", tags: ["a"] }, headers: { authorization: "Bearer abc" } },
            { url: "https://shop.test/api/users/2?sort=name", status: 404 },
            { url: "https://shop.test/api/users/2", method: "PUT", type: "xhr", sent: '{"name":"Ann","card":"4111"}' },
            { url: "https://cdn.other.test/lib.js", type: "script" },
            { url: "https://shop.test/account?_rsc=1x" },
        ]);
        const eps = net.getDiscoveredEndpoints();
        expect(eps.map((e) => `${e.method} ${e.path}`)).toEqual(["GET /api/users/{id}", "PUT /api/users/{id}"]);
        const get = eps[0]!;
        expect(get.statuses).toEqual([200, 404]);
        expect(get.examplePath).toBe("/api/users/1?session_id=redacted&page=1");
        expect(get.queryParams).toEqual(["session_id", "page", "sort"]);
        expect(get.requiresAuth).toBe(true);
        expect(get.usedIn).toEqual(["/account"]);
        expect(get.responseSchema).toEqual({ type: "object", properties: { id: { type: "number" }, password: { type: "string" }, tags: { type: "array", items: { type: "string" } } } });
        const put = eps[1]!;
        expect(put.sampleRequestBody).toEqual({ name: "Ann", card: "[redacted]" });
        expect(put.requiresAuth).toBeUndefined();
        expect(net.getAuthSchemes()).toEqual(["bearer"]);
        expect(net.getExternalHosts()).toEqual(["cdn.other.test"]);
    });
});

describe("documentation pages", () => {
    it("knows documentation addresses", () => {
        for (const p of ["/docs", "/docs/intro", "/readme", "/swagger-ui.html", "/test_cases", "/test-cases", "/api_list", "/api", "/api/v1", "/api/docs/"]) expect(isDocumentationPath(p), p).toBe(true);
        for (const p of ["/", "/about", "/api/users", "/products/docs", "/doctor"]) expect(isDocumentationPath(p), p).toBe(false);
    });

    it("only sends test or API documentation to the model", () => {
        expect(looksLikeDocumentation("Test scenario: checkout with an empty cart")).toBe(true);
        expect(looksLikeDocumentation("Our API is fast.")).toBe(false);
        expect(looksLikeDocumentation("Every API endpoint needs a key.")).toBe(true);
    });

    it("turns :id and <id> into templates and keeps concrete addresses as examples", () => {
        const models = documentedApiModels(
            [
                { name: "One order", method: "get", endpoint: "GET /api/orders/:orderId" },
                { name: "One user", method: "DELETE", endpoint: "api/users/<id>", expectedStatus: 204 },
                { name: "Feed", method: "GET", endpoint: "https://shop.test/api/feed?page=2", description: "The feed" },
            ],
            "https://shop.test",
        );
        expect(models.map((m) => [m.method, m.path, m.examplePath, m.statuses, m.summary])).toEqual([
            ["GET", "/api/orders/{orderId}", undefined, [], "One order"],
            ["DELETE", "/api/users/{id}", undefined, [204], "One user"],
            ["GET", "/api/feed", "/api/feed?page=2", [], "The feed"],
        ]);
        expect(models[2]!.queryParams).toEqual(["page"]);
    });
});
