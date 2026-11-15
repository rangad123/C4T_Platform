/**
 * Clean variant: no check-family finding. With no defect switched on, the benchmark applications must give the engine's own passive checks
 * nothing to report — the security checks (exactly the helper the generated scripts carry, through evaluateSecurity) and the page health
 * checks (generated, rendered and run under Playwright as the pipeline does) — so every finding in a benchmark run comes from a seeded
 * defect or is a real false positive. Ports 9460-9461 (files run one at a time).
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { renderScript } from "../src/engine/generators/index.js";
import { generateHealthSpecs, healthFinding } from "../src/engine/health/specs.js";
import { EXPOSED_FILE_GROUPS, LISTING_PATHS, PROBE_ORIGIN, SECURITY_CHECKS, evaluateSecurity, type SecurityCall } from "../src/engine/security/checks.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { runScripts } from "../src/engine/validation/runner.js";
import { startBenchApp, type BenchApp } from "../src/eval/bench/verify/app.js";
import { modelFor } from "./fixtures/checks-app.js";

const PAGES: Record<BenchApp, Array<{ path: string; type: "home" | "login" | "content" | "detail" }>> = {
    "bench-shop": [
        { path: "/", type: "home" },
        { path: "/login", type: "login" },
        { path: "/register", type: "content" },
        { path: "/products/p1", type: "detail" },
        { path: "/cart", type: "content" },
    ],
    "bench-rbac": [
        { path: "/", type: "home" },
        { path: "/login", type: "login" },
        { path: "/register", type: "content" },
        { path: "/notes", type: "content" },
    ],
};
const ACCOUNT: Record<BenchApp, string> = { "bench-shop": "alice@example.test", "bench-rbac": "ana@example.test" };

async function call(url: string, init: RequestInit & { sentOrigin?: string } = {}): Promise<SecurityCall> {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (init.sentOrigin) headers.origin = init.sentOrigin;
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    const h: Record<string, string> = {};
    res.headers.forEach((v, k) => (h[k] = v));
    return { status: res.status, headers: h, text: await res.text(), url, ...(init.sentOrigin ? { sent: { origin: init.sentOrigin } } : {}), setCookies: res.headers.getSetCookie() };
}

describe.each(["bench-shop", "bench-rbac"] as const)("%s, nothing switched", (app) => {
    it("passes every passive security check the engine has", async () => {
        const running = await startBenchApp(app, app === "bench-shop" ? 9460 : 9461, "none");
        try {
            const b = running.base;
            const login = await call(`${b}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: ACCOUNT[app], password: "Password1!" }).toString() });
            const sid = login.setCookies?.[0]?.split(";")[0] ?? "";
            const pages = await Promise.all([...PAGES[app].map((p) => call(`${b}${p.path}`)), ...PAGES[app].map((p) => call(`${b}${p.path}`, { headers: { cookie: sid } }))]);
            const apis = await Promise.all(["/api/products", "/api/cart", "/api/notes", "/api/me", "/openapi.json", "/app.js", "/styles.css"].map((p) => call(`${b}${p}`, { headers: { cookie: sid }, sentOrigin: PROBE_ORIGIN })));
            const probes = await Promise.all([...EXPOSED_FILE_GROUPS.secrets, ...EXPOSED_FILE_GROUPS.other, ...LISTING_PATHS].map((p) => call(`${b}${p}`)));
            const findings: string[] = [];
            for (const check of SECURITY_CHECKS) {
                if (check === "tlsCertificate") continue; // plain http on loopback: nothing to check
                const sets: SecurityCall[][] =
                    check === "securityHeaders" ? [...pages, ...apis].map((c) => [c]) : check === "cookieFlags" ? [[login]] : check === "corsPolicy" ? [apis] : [[...pages, ...apis, ...probes]];
                for (const calls of sets) {
                    const m = await evaluateSecurity(check, calls);
                    if (m) findings.push(`${check} ${calls.at(-1)?.url}: ${m}`);
                }
            }
            expect(login.status).toBe(303);
            expect(login.setCookies?.[0]).toMatch(/HttpOnly; SameSite=Lax/);
            expect(findings).toEqual([]);
        } finally {
            await running.stop();
        }
    }, 60_000);

    it("passes the generated page health checks under Playwright", async () => {
        const running = await startBenchApp(app, app === "bench-shop" ? 9460 : 9461, "none");
        try {
            const specs = generateHealthSpecs(modelFor(running.base, PAGES[app]), { maxPages: 8 }).map((d, i) => TestSpecSchema.parse({ ...d, testId: `WEB-${String(i + 1).padStart(3, "0")}` }));
            expect(specs.length).toBeGreaterThanOrEqual(3);
            const scripts = specs.map((spec) => {
                const r = renderScript(spec, "playwright", { baseUrl: running.base });
                return { testId: spec.testId, filename: r.filename, content: r.content };
            });
            const runs = await runScripts(loadConfig({}).scratchDir, scripts, { baseUrl: running.base, headless: true }, { workers: 3 });
            const findings = specs.map((s) => [s.title, healthFinding(s, runs.find((r) => r.testId === s.testId)!)] as const).filter(([, f]) => f);
            expect(runs.map((r) => [r.testId, r.status, r.error?.slice(0, 300)])).toEqual(specs.map((s) => [s.testId, "passed", undefined]));
            expect(findings).toEqual([]);
        } finally {
            await running.stop();
        }
    }, 120_000);
});
