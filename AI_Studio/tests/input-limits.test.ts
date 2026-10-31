/**
 * Client-side limits of the input check (maxlength, required, email/number types), really executed in Chromium against a
 * local app: findings and severities, no false positive on a clean form, and — most important — nothing is submitted
 * by the limit checks and ineligible (login / POST) forms are never touched.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadInputRuntime } from "../src/engine/inputs/checks.js";
import { parseInputReason } from "../src/engine/inputs/specs.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PORT = 5400;
const BASE = `http://127.0.0.1:${PORT}`;
const hits: Record<string, number> = {};

const shell = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shop</title></head><body><h1>Shop</h1>${body}</body></html>`;

const PAGES: Record<string, string> = {
    // Everything enforced: maxlength, required, email type, number type. Must produce no finding.
    "/clean": '<form action="/clean-results" method="get"><input type="search" name="q" maxlength="20" required placeholder="Search"><input type="email" name="email"><input type="number" name="qty"><button type="submit">Go</button></form>',
    // A script strips the limit as soon as the field is focused, and a custom widget appends characters itself.
    "/leaky": `<form action="/leaky-results" method="get"><input type="text" name="title" maxlength="20" id="t"><input type="text" name="note" maxlength="10" id="n"><button type="submit">Go</button></form>
<script>
document.getElementById("t").addEventListener("focus", function (e) { e.target.removeAttribute("maxlength"); });
document.getElementById("n").addEventListener("keydown", function (e) { if (e.key.length === 1) { e.preventDefault(); e.target.value += e.key; } });
</script>`,
    // Browser checks switched off for the whole form.
    "/novalidate": '<form action="/nv-results" method="get" novalidate><input type="text" name="q" required><input type="email" name="mail"><button type="submit">Go</button></form>',
    // Browser checks switched off only for the submit button.
    "/fnv": '<form action="/fnv-results" method="get"><input type="text" name="q" required><button type="submit" formnovalidate>Go</button></form>',
    // Submitted by script, no action: limits are honoured, so still clean. Must never be submitted by the limit checks.
    "/spa": `<form><input type="text" name="q" required maxlength="15"><button type="submit">Go</button></form>
<script>document.querySelector("form").addEventListener("submit", function (e) { e.preventDefault(); fetch("/api/spa?q=" + encodeURIComponent(document.querySelector("input").value)); });</script>`,
    // POST forms: only with "all"; a login form (password field, login-ish address) is never touched in any mode.
    "/contact": '<form action="/contact-post" method="post"><textarea name="message" maxlength="30" required></textarea><button type="submit">Send</button></form>',
    "/login": '<form action="/login-post" method="post"><input name="email" type="text" maxlength="10" required><input name="password" type="password"><button>Log in</button></form>',
};

const app = http.createServer((req, res) => {
    const p = new URL(req.url ?? "/", BASE).pathname;
    hits[p] = (hits[p] ?? 0) + 1;
    req.resume();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(shell(PAGES[p] ?? "<p>ok</p>"));
});

const SUBMIT_TARGETS = ["/clean-results", "/leaky-results", "/nv-results", "/fnv-results", "/api/spa", "/contact-post", "/login-post"];

let browser: Browser;
let platform: Platform;
let worker: Worker;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;

beforeAll(async () => {
    await new Promise<void>((r) => app.listen(PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    browser = await chromium.launch();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-input-limits-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic" }));
    server = await buildServer(platform);
    worker = new Worker(platform, 200);
    worker.start();
}, 60_000);
afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    await browser?.close();
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
const inputSpec = (title: string, p: string, expected: string) => ({
    title,
    kind: "web",
    category: "Input handling",
    type: "input",
    priority: "medium",
    source: { origin: "input-check" },
    steps: [{ action: "navigate", url: p }, { action: "assert", check: "inputHandling", expected }],
});
type T = { id: string; title: string; validationStatus: string; validationReason: string | null; severity: { severity: string } | null };
const testsOf = async (projectId: string) => Object.fromEntries(((await call("GET", `/api/projects/${projectId}/tests`)).body as T[]).map((t) => [t.title, t]));

describe("the limit checks on their own (no submission)", () => {
    const limitsOf = async (p: string, mode = "safe") => {
        const page = await browser.newPage();
        try {
            await page.goto(BASE + p);
            const rt = loadInputRuntime();
            const forms = await rt.inputForms(page, mode);
            return { forms, limits: await rt.inputLimits(page, forms) };
        } finally {
            await page.close();
        }
    };

    it("finds nothing on a form that enforces everything it declares", async () => {
        const r = await limitsOf("/clean");
        expect(r.forms).toHaveLength(1);
        expect(r.limits).toEqual([]);
    }, 60_000);

    it("flags a maxlength that is not honoured while typing, as medium, per field", async () => {
        const { limits } = await limitsOf("/leaky");
        expect(limits.map((l) => [l.kind, l.severity])).toEqual([["maxlength", "medium"], ["maxlength", "medium"]]);
        expect(limits[0]!.text).toBe("“title” says it takes at most 20 characters but accepts more (typed 30, it kept 30)");
        expect(limits[1]!.text).toBe("“note” says it takes at most 10 characters but accepts more (typed 20, it kept 20)");
    }, 60_000);

    it("flags a required field that can be left empty when the browser checks are switched off, as low advice", async () => {
        const nv = (await limitsOf("/novalidate")).limits;
        expect(nv.map((l) => [l.kind, l.severity])).toEqual([["required", "low"], ["type", "low"]]);
        expect(nv[0]!.text).toContain("“q” field is marked required, but the form can be submitted with it empty");
        expect(nv[0]!.text).toContain("switches off the browser’s own checks");
        expect(nv[1]!.text).toContain("“mail” is an email field");
        const fnv = (await limitsOf("/fnv")).limits;
        expect(fnv.map((l) => [l.kind, l.severity])).toEqual([["required", "low"]]);
    }, 60_000);

    it("is clean for a script-submitted form that honours its limits", async () => {
        const r = await limitsOf("/spa");
        expect(r.forms).toHaveLength(1);
        expect(r.limits).toEqual([]);
    }, 60_000);

    it("never considers login forms, and POST forms only in 'all' mode", async () => {
        expect((await limitsOf("/login", "all")).forms).toEqual([]);
        expect((await limitsOf("/contact", "safe")).forms).toEqual([]);
        const contact = await limitsOf("/contact", "all");
        expect(contact.forms).toHaveLength(1);
        expect(contact.limits).toEqual([]); // textarea limit and required are honoured
    }, 60_000);

    it("submitted nothing: no form target was requested by any of the above", () => {
        for (const t of SUBMIT_TARGETS) expect(hits[t] ?? 0, t).toBe(0);
    });
});

describe("through the platform (generated script, validation, finding)", () => {
    let projectId = "";

    it("reports the limit problems with severities, and passes the clean form and the 'nolimits' variant", async () => {
        projectId = (await call("POST", "/api/projects", { name: "Input limits" })).body.id;
        const specs = [
            inputSpec("Clean form", "/clean", "safe"),
            inputSpec("Leaky limits", "/leaky", "safe"),
            inputSpec("Leaky limits switched off", "/leaky", "safe nolimits"),
            inputSpec("Novalidate form", "/novalidate", "safe"),
            inputSpec("Script form", "/spa", "safe"),
        ];
        const res = await call("POST", `/api/projects/${projectId}/specs`, { specs, baseUrl: BASE });
        expect(res.status).toBe(202);
        await waitForJob(res.body.jobId);
        const by = await testsOf(projectId);

        expect(by["Clean form"]!.validationStatus).toBe("VALIDATED");
        expect(by["Script form"]!.validationStatus).toBe("VALIDATED");
        expect(by["Leaky limits switched off"]!.validationStatus).toBe("VALIDATED");

        const leaky = by["Leaky limits"]!;
        expect(leaky.validationStatus).toBe("NEEDS_REVIEW");
        expect(leaky.validationReason).toContain("Input handling check failed:");
        expect(leaky.validationReason).toContain("- [medium] In the form with the “title” field, “title” says it takes at most 20 characters but accepts more");
        expect(leaky.validationReason).toContain("How to fix:");
        expect(leaky.validationReason).toContain("enforce it on the server too");
        expect(leaky.severity!.severity).toBe("medium");

        const nv = by["Novalidate form"]!;
        expect(nv.validationStatus).toBe("NEEDS_REVIEW");
        expect(nv.validationReason).toContain("- [low] In the form with the “q” field, the “q” field is marked required");
        expect(nv.severity!.severity).toBe("low");
    }, 300_000);

    it("old-style steps ('safe' / 'all') keep the limit checks on, and the script carries the helper", async () => {
        const by = await testsOf(projectId);
        const detail = (await call("GET", `/api/tests/${by["Leaky limits"]!.id}`)).body;
        const script = detail.scripts[0].content as string;
        expect(script).toContain("async function inputLimits");
        expect(script).toContain('inputAssert(page, "safe")');
        const off = (await call("GET", `/api/tests/${by["Leaky limits switched off"]!.id}`)).body.scripts[0].content as string;
        expect(off).toContain('inputAssert(page, "safe nolimits")');
    });

    it("never submits or probes POST and login forms with the limit checks (safe and all modes)", async () => {
        const specs = [
            inputSpec("Contact safe", "/contact", "safe"),
            inputSpec("Login safe", "/login", "safe"),
            inputSpec("Login all", "/login", "all"),
        ];
        const res = await call("POST", `/api/projects/${projectId}/specs`, { specs });
        await waitForJob(res.body.jobId);
        const by = await testsOf(projectId);
        for (const t of ["Contact safe", "Login safe", "Login all"]) expect(by[t]!.validationStatus, t).toBe("VALIDATED");
        expect(hits["/contact-post"] ?? 0).toBe(0);
        expect(hits["/login-post"] ?? 0).toBe(0);
    }, 180_000);
});

describe("severity reading", () => {
    it("takes the worst per-line tag and treats an untagged limit message as low", () => {
        expect(parseInputReason("Input handling check failed: 2 problems\n- [low] a\n- [medium] b\nHow to fix: x")).toBe("medium");
        expect(parseInputReason("Input handling check failed: 1 problem\n- [low] a\nHow to fix: medium [medium] advice")).toBe("low");
        expect(parseInputReason("Something else")).toBeUndefined();
    });
});
