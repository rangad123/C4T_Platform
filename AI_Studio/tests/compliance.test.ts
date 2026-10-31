/** Compliance control mapping: whole-word matching, path params ignored, web tests, report statuses, API. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { CONTROLS } from "../src/engine/compliance/controls.js";
import { complianceReport, mapControls, words } from "../src/engine/compliance/map.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

const api = (method: string, p: string, category = "API · General", title = "t") =>
    ({ title, category, tags: [] as string[], steps: [{ action: "request", method, path: p } as const] }) as never;
const ids = (spec: never, fw?: never) => mapControls(spec, fw).map((c) => c.id);

describe("control library", () => {
    it("has the 21 upstream controls across three frameworks", () => {
        expect(CONTROLS).toHaveLength(21);
        expect(new Set(CONTROLS.map((c) => c.framework))).toEqual(new Set(["NIST-800-53", "HIPAA", "ISO-27001"]));
    });
});

describe("mapping", () => {
    it("tokenizes words, camelCase and simple plurals", () => {
        expect([...words("/api/userAccounts")].sort()).toEqual(expect.arrayContaining(["api", "user", "account", "accounts"]));
    });
    it("matches whole words, not substrings", () => {
        // upstream's substring matching tags "catalog" as audit logging ("log") and "comments" as authentication ("me")
        const catalog = ids(api("GET", "/api/catalog"));
        expect(catalog).not.toContain("NIST-AU-2");
        const comments = ids(api("GET", "/api/comments"));
        expect(comments).not.toContain("NIST-IA-2");
    });
    it("maps authentication and audit topics", () => {
        expect(ids(api("POST", "/api/auth/login"))).toEqual(expect.arrayContaining(["NIST-IA-2"]));
        expect(ids(api("GET", "/api/audit/logs"))).toEqual(expect.arrayContaining(["NIST-AU-2"]));
    });
    it("ignores path parameters", () => {
        const a = ids(api("GET", "/api/products/{id}"));
        const b = ids(api("GET", "/api/products/{userId}"));
        expect(a).toEqual(b);
    });
    it("honours method filters", () => {
        for (const c of CONTROLS.filter((c) => c.methods.length)) {
            const wrong = ["GET", "POST", "PUT", "PATCH", "DELETE"].find((m) => !c.methods.includes(m))!;
            const hit = mapControls(api(wrong, "/" + (c.pathKeywords[0] ?? "x")), [c.framework]).some((x) => x.id === c.id);
            // a method outside the filter never maps, whatever the path says
            expect(hit).toBe(false);
        }
    });
    it("maps web tests from their title, area and submitted input", () => {
        const login = {
            title: "Login fails with an incorrect password",
            category: "Authentication",
            tags: [],
            steps: [{ action: "navigate", url: "/login" }, { action: "fill", target: { role: "textbox", name: "Password" }, value: "x" }],
        } as never;
        expect(ids(login)).toEqual(expect.arrayContaining(["NIST-IA-2"]));
    });
    it("respects the framework filter", () => {
        expect(mapControls(api("POST", "/api/auth/login"), ["HIPAA"]).every((c) => c.framework === "HIPAA")).toBe(true);
    });
});

describe("coverage report", () => {
    const test = (id: string, spec: never, validationStatus: string) => ({ id, testKey: id.toUpperCase(), spec, validationStatus });
    it("derives covered / attention / gap per control", () => {
        const login = api("POST", "/api/auth/login");
        const control = (r: ReturnType<typeof complianceReport>, id: string) => r.flatMap((f) => f.controls).find((c) => c.id === id)!;

        expect(control(complianceReport([test("a", login, "VALIDATED")]), "NIST-IA-2").status).toBe("covered");
        expect(control(complianceReport([test("a", login, "VALIDATED"), test("b", login, "NEEDS_REVIEW")]), "NIST-IA-2").status).toBe("attention");
        expect(control(complianceReport([test("a", login, "FAILED_VALIDATION")]), "NIST-IA-2").status).toBe("attention");
        expect(control(complianceReport([test("a", login, "PENDING")]), "NIST-IA-2").status).toBe("gap");
        expect(control(complianceReport([]), "NIST-IA-2").status).toBe("gap");
    });
    it("summarises each framework", () => {
        const r = complianceReport([test("a", api("POST", "/api/auth/login"), "VALIDATED")]);
        for (const f of r) expect(f.summary.total).toBe(f.summary.covered + f.summary.attention + f.summary.gap);
    });
});

describe("API", () => {
    let platform: Platform;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let dir: string;
    beforeAll(async () => {
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-compl-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic" }));
        server = await buildServer(platform);
    });
    afterAll(async () => {
        await server.close();
        platform.db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const call = async (method: string, url: string, payload?: unknown) => {
        const r = await server.inject({ method: method as "GET", url, payload: payload as never });
        return { status: r.statusCode, body: r.json() as any };
    };

    it("reports coverage, validates the framework filter and tags test detail", async () => {
        const project = (await call("POST", "/api/projects", { name: "Compliance" })).body;
        expect((await call("GET", `/api/projects/${project.id}/compliance`)).body.testCount).toBe(0);

        const spec = { title: "Login rejects a bad password", kind: "api", category: "API · Authentication", steps: [{ action: "request", method: "POST", path: "/api/auth/login" }, { action: "assertResponse", check: "statusClass", expected: "4xx" }] };
        expect((await call("POST", `/api/projects/${project.id}/specs`, { specs: [spec], baseUrl: "http://127.0.0.1:9", validate: false })).status).toBe(202);

        const report = (await call("GET", `/api/projects/${project.id}/compliance`)).body;
        expect(report.testCount).toBe(1);
        expect(report.disclaimer).toMatch(/not a compliance/i);
        const ia2 = report.frameworks.flatMap((f: any) => f.controls).find((c: any) => c.id === "NIST-IA-2");
        expect(ia2.tests.total).toBe(1);
        expect(ia2.status).toBe("gap"); // mapped, but not validated yet

        const hipaaOnly = (await call("GET", `/api/projects/${project.id}/compliance?frameworks=HIPAA`)).body;
        expect(hipaaOnly.frameworks.map((f: any) => f.framework)).toEqual(["HIPAA"]);
        expect((await call("GET", `/api/projects/${project.id}/compliance?frameworks=SOX`)).status).toBe(400);

        const tests = (await call("GET", `/api/projects/${project.id}/tests`)).body;
        const detail = (await call("GET", `/api/tests/${tests[0].id}`)).body;
        expect(detail.controls.map((c: any) => c.id)).toContain("NIST-IA-2");
    });
});
