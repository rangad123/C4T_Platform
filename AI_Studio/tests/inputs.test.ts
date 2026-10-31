/**
 * Input handling checks, really executed in Chromium against a local app: reflected input, server errors, script
 * errors, and — most important — which forms are never submitted.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { generateInputSpecs, formIsProbeable } from "../src/engine/inputs/specs.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PORT = 5380;
const BASE = `http://127.0.0.1:${PORT}`;
const hits: Record<string, number> = {};
const received: Record<string, string[]> = {};
const MARKER = '<i data-aitp-probe="1">aitp</i>';

const shell = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shop</title></head><body><h1>Shop</h1>${body}</body></html>`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const searchForm = (action: string) => `<form action="${action}" method="get"><input type="search" name="q" placeholder="Search"><button type="submit">Search</button></form>`;

const app = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", BASE);
    const p = u.pathname;
    hits[p] = (hits[p] ?? 0) + 1;
    const q = u.searchParams.get("q") ?? "";
    (received[p] ??= []).push(q);
    const send = (status: number, html: string) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
    };
    if (req.method === "POST") {
        req.resume();
        return send(200, shell("<p>Thanks, received.</p>"));
    }
    switch (p) {
        case "/vuln": return send(200, shell(searchForm("/vuln-results")));
        case "/vuln-results": return send(200, shell(`${searchForm("/vuln-results")}<p>Results for: ${q}</p>`)); // unescaped!
        case "/safe": return send(200, shell(searchForm("/safe-results")));
        case "/safe-results": return send(200, shell(`${searchForm("/safe-results")}<p>Results for: ${esc(q)}</p>`));
        case "/crash": return send(200, shell(searchForm("/crash-results")));
        case "/crash-results": return q.length > 1000 ? send(500, "Internal error") : send(200, shell(`${searchForm("/crash-results")}<p>ok</p>`));
        case "/jserr": return send(200, shell(searchForm("/jserr-results")));
        case "/jserr-results": return send(200, shell(`${searchForm("/jserr-results")}<p>ok</p><script>if (/[^\\x00-\\x7f]/.test(decodeURIComponent(location.search))) throw new Error("boom on non-ascii");</script>`));
        case "/contact": return send(200, shell('<form action="/contact-post" method="post"><textarea name="message"></textarea><button type="submit">Send</button></form>'));
        case "/login": return send(200, shell('<form action="/login-post" method="post"><input name="email" type="text"><input name="password" type="password"><button>Log in</button></form>'));
        case "/pay": return send(200, shell('<form action="/pay-post" method="post"><input name="note" type="text"><input name="card_number" type="text"><button>Pay</button></form>'));
    }
    send(200, shell("<p>Hello</p>"));
});

let platform: Platform;
let worker: Worker;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;

beforeAll(async () => {
    await new Promise<void>((r) => app.listen(PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-inputs-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic" }));
    server = await buildServer(platform);
    worker = new Worker(platform, 200);
    worker.start();
}, 30_000);
afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await new Promise((r) => app.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};
async function waitForJob(jobId: string) {
    for (let i = 0; i < 600; i++) {
        const j = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) return j;
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("job did not finish");
}
const inputSpec = (title: string, p: string, mode: "safe" | "all" = "safe") => ({
    title,
    kind: "web",
    category: "Input handling",
    type: "input",
    priority: "medium",
    source: { origin: "input-check" },
    steps: [{ action: "navigate", url: p }, { action: "assert", check: "inputHandling", expected: mode }],
});
type T = { id: string; title: string; validationStatus: string; validationReason: string | null; severity: { severity: string } | null };
const testsOf = async (projectId: string) => Object.fromEntries(((await call("GET", `/api/projects/${projectId}/tests`)).body as T[]).map((t) => [t.title, t]));

describe("which forms are probed (model level)", () => {
    const field = (name: string, type = "text") => ({ type, name, required: false });
    const form = (purpose: string, method: string, fields = [field("q", "search")]) => ({ purpose, method, fields }) as never;
    it("probes GET search forms, and POST forms only when allowed; never login, sign-up, checkout or sensitive fields", () => {
        expect(formIsProbeable(form("search", "get"), false)).toBe(true);
        expect(formIsProbeable(form("contact", "post", [field("message", "textarea")]), false)).toBe(false);
        expect(formIsProbeable(form("contact", "post", [field("message", "textarea")]), true)).toBe(true);
        for (const purpose of ["login", "signup", "checkout"]) expect(formIsProbeable(form(purpose, "get"), true)).toBe(false);
        expect(formIsProbeable(form("other", "post", [field("email"), field("password", "password")]), true)).toBe(false);
        expect(formIsProbeable(form("other", "post", [field("card_number")]), true)).toBe(false);
        expect(formIsProbeable(form("other", "post", [field("otp")]), true)).toBe(false);
        expect(formIsProbeable(form("search", "get", [{ type: "checkbox", name: "x", required: false }]), true)).toBe(false);
    });
    it("generates one spec per page with a probeable form, in the right mode", () => {
        const page = (p: string, forms: unknown[]) => ({ url: BASE + p, path: p, title: p, type: "other", depth: 0, status: 200, headings: [], forms, components: [], links: [], aria: "", text: "", apiCalls: [], revealed: [], consoleErrors: [] });
        const model = { origin: BASE, authentication: { loggedIn: false, required: false, mechanisms: [] }, pages: [page("/s", [form("search", "get")]), page("/c", [form("contact", "post", [field("message", "textarea")])]), page("/l", [form("login", "post", [field("password", "password")])])] } as never;
        const safe = generateInputSpecs(model, { maxPages: 5, allowMutating: false });
        expect(safe.map((s) => s.steps[0]!.action === "navigate" && s.steps[0]!.url)).toEqual(["/s"]);
        expect(safe[0]!.steps[1]).toMatchObject({ check: "inputHandling", expected: "safe" });
        const all = generateInputSpecs(model, { maxPages: 5, allowMutating: true });
        expect(all.map((s) => s.steps[0]!.action === "navigate" && s.steps[0]!.url)).toEqual(["/s", "/c"]);
        expect(all[1]!.steps[1]).toMatchObject({ expected: "all" });
        expect(generateInputSpecs(model, { maxPages: 1, allowMutating: true })).toHaveLength(1);
    });
    it("is on by default", () => {
        expect(DEFAULT_JOB_OPTIONS.inputChecks).toBe(true);
    });
});

describe("on a real app", () => {
    let projectId = "";

    it("flags reflected markup, server errors and script errors; passes the safe form", async () => {
        projectId = (await call("POST", "/api/projects", { name: "Inputs" })).body.id;
        const specs = [inputSpec("Vulnerable search", "/vuln"), inputSpec("Safe search", "/safe"), inputSpec("Crashing search", "/crash"), inputSpec("Script error search", "/jserr")];
        const res = await call("POST", `/api/projects/${projectId}/specs`, { specs, baseUrl: BASE });
        expect(res.status).toBe(202);
        await waitForJob(res.body.jobId);
        const by = await testsOf(projectId);

        const vuln = by["Vulnerable search"]!;
        expect(vuln.validationStatus).toBe("NEEDS_REVIEW");
        expect(vuln.validationReason).toContain("Input handling check failed:");
        expect(vuln.validationReason).toContain("shows what you type as page markup instead of plain text (possible cross-site scripting)");
        expect(vuln.validationReason).toContain("How to fix:");
        expect(vuln.severity!.severity).toBe("high");

        expect(by["Safe search"]!.validationStatus).toBe("VALIDATED");

        const crash = by["Crashing search"]!;
        expect(crash.validationStatus).toBe("NEEDS_REVIEW");
        expect(crash.validationReason).toContain("makes the server fail (HTTP 500) when a very long text (5,000 characters) is entered");
        expect(crash.severity!.severity).toBe("high");

        const js = by["Script error search"]!;
        expect(js.validationStatus).toBe("NEEDS_REVIEW");
        expect(js.validationReason).toMatch(/triggers a script error when emoji and right-to-left text are entered: boom on non-ascii/);
        expect(js.severity!.severity).toBe("medium");
    }, 300_000);

    it("submits only a bounded set of probes per form", () => {
        // 7 fixed probes, one submission each; the empty probe may be skipped by the browser.
        expect(hits["/safe-results"]).toBeGreaterThanOrEqual(6);
        expect(hits["/safe-results"]).toBeLessThanOrEqual(7);
        const values = new Set(received["/safe-results"]);
        expect(values.has(MARKER)).toBe(true);
        expect([...values].filter((v) => v.length > 100)).toEqual(["a".repeat(5000)]);
    });

    it("never submits POST, login or payment forms by default", async () => {
        const specs = [inputSpec("Contact form (safe mode)", "/contact"), inputSpec("Login form (safe mode)", "/login"), inputSpec("Payment form (safe mode)", "/pay")];
        const res = await call("POST", `/api/projects/${projectId}/specs`, { specs });
        await waitForJob(res.body.jobId);
        const by = await testsOf(projectId);
        for (const t of Object.values(by).filter((x) => x.title.includes("(safe mode)"))) expect(t.validationStatus).toBe("VALIDATED");
        expect(hits["/contact-post"] ?? 0).toBe(0);
        expect(hits["/login-post"] ?? 0).toBe(0);
        expect(hits["/pay-post"] ?? 0).toBe(0);
    }, 180_000);

    it("probes the POST contact form only when data-changing tests are enabled — and still never login or payment forms", async () => {
        const specs = [inputSpec("Contact form (all mode)", "/contact", "all"), inputSpec("Login form (all mode)", "/login", "all"), inputSpec("Payment form (all mode)", "/pay", "all")];
        const res = await call("POST", `/api/projects/${projectId}/specs`, { specs });
        await waitForJob(res.body.jobId);
        expect(hits["/contact-post"]).toBeGreaterThanOrEqual(5);
        expect(hits["/contact-post"]).toBeLessThanOrEqual(7);
        expect(hits["/login-post"] ?? 0).toBe(0); // password field
        expect(hits["/pay-post"] ?? 0).toBe(0); // card field
    }, 180_000);

    it("carries no secrets and re-renders from the spec", async () => {
        const by = await testsOf(projectId);
        const detail = (await call("GET", `/api/tests/${by["Vulnerable search"]!.id}`)).body;
        const script = detail.scripts[0].content as string;
        expect(script).toContain("async function inputAssert");
        expect(script).toContain('inputAssert(page, "safe")');
        expect(script).toContain("test.setTimeout(180_000)");
        expect(script).not.toMatch(/sk-|api[_-]?key|TEST_PASSWORD/i);
    });
});
