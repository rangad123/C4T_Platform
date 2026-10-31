/** Test-quality rules: weak tests are flagged with plain reasons; deliberately minimal families are not. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { assessProjectQuality, assessQuality, EXEMPT_TYPES } from "../src/engine/quality/rules.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

const web = (steps: unknown[], type = "functional") => ({ kind: "web", type, steps }) as never;
const api = (steps: unknown[], type = "functional") => ({ kind: "api", type, steps }) as never;
const nav = { action: "navigate", url: "/" };
const click = { action: "click", locator: { by: "role", role: "button", value: "Add to cart" } };
const text = (v: string) => ({ action: "assert", check: "text", locator: { by: "css", value: "#cart-count" }, expected: v });

describe("web tests", () => {
    it("flags a test with no assertions", () => {
        const q = assessQuality(web([nav, click]));
        expect(q.level).toBe("weak");
        expect(q.reasons[0]).toMatch(/never checks anything/);
    });
    it("flags tests that only check the page loaded", () => {
        for (const check of [
            { action: "assert", check: "url", expected: "/" },
            { action: "assert", check: "title", expected: "Shop" },
            { action: "assert", check: "visible", locator: { by: "css", value: "body" } },
            { action: "assert", check: "visible", locator: { by: "css", value: "main" } },
        ]) {
            expect(assessQuality(web([nav, check])).reasons.join(" ")).toMatch(/only checks that a page loaded/);
        }
    });
    it("accepts a specific assertion about the feature", () => {
        expect(assessQuality(web([nav, click, text("1")]))).toEqual({ level: "good", reasons: [] });
        expect(assessQuality(web([nav, { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Welcome" } }])).level).toBe("good");
    });
    it("flags interactions whose result is never verified", () => {
        const q = assessQuality(web([nav, text("0"), click]));
        expect(q.level).toBe("weak");
        expect(q.reasons.join(" ")).toMatch(/before the first click/);
        expect(assessQuality(web([nav, text("0"), click, text("1")])).level).toBe("good");
    });
});

describe("API tests", () => {
    const get = { action: "request", method: "GET", path: "/api/products" };
    it("flags checking only that a data call succeeded", () => {
        for (const check of [{ action: "assertResponse", check: "status", expected: 200 }, { action: "assertResponse", check: "statusClass", expected: "2xx" }, { action: "assertResponse", check: "statusBelow", expected: 500 }]) {
            expect(assessQuality(api([get, check])).reasons.join(" ")).toMatch(/only checks that the request succeeded/);
        }
    });
    it("accepts a body check, an error-path status check, and a value reused later", () => {
        expect(assessQuality(api([get, { action: "assertResponse", check: "status", expected: 200 }, { action: "assertResponse", check: "jsonType", expected: "array" }])).level).toBe("good");
        // a 404 test's whole point is the status
        expect(assessQuality(api([{ ...get, path: "/api/products/999999" }, { action: "assertResponse", check: "status", expected: 404 }])).level).toBe("good");
        expect(assessQuality(api([{ ...get, extract: { id: "0.id" } }, { action: "assertResponse", check: "status", expected: 200 }, { action: "request", method: "GET", path: "/api/products/{{id}}" }, { action: "assertResponse", check: "status", expected: 200 }])).level).toBe("good");
    });
});

describe("exemptions and duplicates", () => {
    it("does not judge single-purpose families", () => {
        expect([...EXEMPT_TYPES].sort()).toEqual(["accessibility", "health", "performance", "security", "visual"]);
        for (const type of EXEMPT_TYPES) expect(assessQuality(web([nav], type)).level).toBe("good");
    });
    it("marks the later of two identical tests as a duplicate and names the earlier", () => {
        const a = { id: "1", testKey: "WEB-001", spec: web([nav, click, text("1")]) };
        const b = { id: "2", testKey: "WEB-002", spec: web([nav, { ...click, description: "different words" }, text("1")]) };
        const c = { id: "3", testKey: "WEB-003", spec: web([nav, click, text("2")]) };
        const q = assessProjectQuality([a, b, c]);
        expect(q.get("1")!.level).toBe("good");
        expect(q.get("2")!.level).toBe("weak");
        expect(q.get("2")!.reasons.join(" ")).toContain("WEB-001");
        expect(q.get("3")!.level).toBe("good");
    });
});

describe("API", () => {
    let platform: Platform;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let dir: string;
    beforeAll(async () => {
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-quality-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic" }));
        server = await buildServer(platform);
    });
    afterAll(async () => {
        await server.close();
        platform.db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    it("returns quality on the list and detail, judging duplicates against the whole project", async () => {
        const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
            const r = await server.inject({ method, url, payload: payload as never });
            return { status: r.statusCode, body: r.json() as any };
        };
        const project = (await call("POST", "/api/projects", { name: "Quality" })).body.id as string;
        const good = { title: "Cart count updates", kind: "web", steps: [nav, click, text("1")] };
        const specs = [good, { ...good, title: "Cart count updates again" }, { title: "Opens the page", kind: "web", steps: [nav] }];
        expect((await call("POST", `/api/projects/${project}/specs`, { specs, baseUrl: "http://127.0.0.1:9", validate: false })).status).toBe(202);

        const list = (await call("GET", `/api/projects/${project}/tests`)).body as Array<{ testId: string; quality: { level: string; reasons: string[] } }>;
        const by = Object.fromEntries(list.map((t) => [t.testId, t.quality]));
        expect(by["WEB-001"]!.level).toBe("good");
        expect(by["WEB-002"]!.reasons.join(" ")).toContain("WEB-001");
        expect(by["WEB-003"]!.reasons.join(" ")).toMatch(/never checks anything/);

        // a filtered list still judges the duplicate against the test it duplicates
        const filtered = (await call("GET", `/api/projects/${project}/tests?q=again`)).body;
        expect(filtered).toHaveLength(1);
        expect(filtered[0].quality.level).toBe("weak");

        const weakId = (await call("GET", `/api/projects/${project}/tests`)).body.find((t: { testId: string }) => t.testId === "WEB-003").id;
        const detail = (await call("GET", `/api/tests/${weakId}`)).body;
        expect(detail.quality.level).toBe("weak");
    });
});
