/**
 * One lane per account through a real job (queue row 181a): HTTP API -> queue -> worker -> real discovery of a local site that signs
 * the test account in -> planning and authoring in real browsers with a scripted model double (never a real model) -> validation
 * replays under Playwright. CONCURRENCY 3; two scenarios sign in as the project's account and open a slow page, two signed-out
 * scenarios open another slow page. The site records every session's span (from sign-in, or the first signed-out page, to its last
 * slow page):
 *   - no two sessions of the account are ever open at the same time: while authoring, validating, in the browser / condition
 *     checks (two asked for) or in the strength check (deliberate faults) after them;
 *   - signed-out sessions still overlap each other;
 *   - the job says it wrote the account's scenarios one at a time; every test is validated.
 * The job's wall clock is printed (lanes cost time: the account's scenarios no longer run side by side).
 * Fixture site: port 9788. Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/orchestrator-account-lanes.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PORT = 9788;
const URL = `http://127.0.0.1:${PORT}`;
const USER = "alice@example.com";
const PASSWORD = "Lanes-Password-4c1e";
/**
 * How long the slow pages take to answer. The account's page is the slower one, so a replay of the account's other test that waits for
 * a free worker (behind a quick signed-out page) still starts while the first one is open, when nothing keeps them apart.
 */
const WORK_MS = 2_000;
const OPEN_MS = 400;

let site: http.Server;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dir: string;

/** Every session the site saw: who (the account, or "anon"), the span from its sign-in or first signed-out page to its last slow page, and when it began (epoch ms). */
const sessions = new Map<string, { who: string; start: number; end: number; at: number }>();
let nextId = 0;

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main>${body}</main></body></html>`;
const LOGIN = page("Sign in", `<h1>Sign in</h1><form method="post" action="/login"><label>Email <input type="email" name="email"></label><label>Password <input type="password" name="password"></label><button type="submit">Sign in</button></form>`);
const cookie = (req: http.IncomingMessage, name: string) => new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? "")?.[1];

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
type Call = { tool: string; input: Record<string, unknown> };
const signIn: Call[] = [
    { tool: "navigate", input: { url: "/login" } },
    { tool: "fill", input: { target: { by: "label", value: "Email" }, value: "{{credentials.username}}" } },
    { tool: "fill", input: { target: { by: "label", value: "Password" }, value: "{{credentials.password}}" } },
    { tool: "click", input: { target: { by: "role", role: "button", value: "Sign in" } } },
];
const visit = (url: string, heading: string): Call[] => [
    { tool: "navigate", input: { url } },
    { tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: heading }, source: "expected:1" } },
    { tool: "finish", input: { result: "complete", explanation: `${heading} is shown` } },
];
/** What each scenario's test writer does, by title. */
const SCRIPTS: Record<string, Call[]> = {
    "Account work A": [...signIn, ...visit("/work/a", "Work A")],
    "Account work B": [...signIn, ...visit("/work/b", "Work B")],
    "Open page C": visit("/open/c", "Open C"),
    "Open page D": visit("/open/d", "Open D"),
};
const scenario = (title: string, startPath: string, requiresAuth: boolean, heading: string) =>
    ScenarioSchema.omit({ scenarioId: true }).parse({ title, description: title, category: "Work", priority: "high", startPath, requiresAuth, expectedResults: [`${heading} is shown`] });
const PLAN = [
    scenario("Account work A", "/login", true, "Work A"),
    scenario("Account work B", "/login", true, "Work B"),
    scenario("Open page C", "/", false, "Open C"),
    scenario("Open page D", "/", false, "Open D"),
];

/** Each authoring agent is told its scenario; its next move is the script's step after the ones it already took. */
const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
        const text = JSON.stringify(options.prompt);
        const title = Object.keys(SCRIPTS).find((t) => text.includes(`: ${t}\\n`));
        const taken = options.prompt.filter((m) => m.role === "assistant").length;
        const next = title ? SCRIPTS[title]![taken] : undefined;
        if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
        return { content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
    },
});
const scripted: LlmClient = {
    modelName: "scripted",
    model,
    usage: { inputTokens: 0, outputTokens: 0 },
    imageObject: async () => {
        throw new Error("no image calls in this test");
    },
    // The test review asks for no change.
    text: (async () => "OK") as LlmClient["text"],
    object: (async ({ system, purpose }: { system: string; purpose?: string }) => {
        if (/analysing a web application/.test(system)) {
            return { siteType: "other", purpose: "Work pages", features: ["Work"], pagePurposes: [], journeys: [], authenticationMechanisms: ["form"] };
        }
        if (purpose === "planning") return { scenarios: PLAN };
        throw new Error(`not scripted: ${purpose ?? system.slice(0, 40)}`);
    }) as LlmClient["object"],
};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = http.createServer((req, res) => {
        const url = new globalThis.URL(req.url ?? "/", URL);
        const html = (body: string, headers: Record<string, string> = {}) => {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers });
            res.end(body);
        };
        if (url.pathname === "/login" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                const form = new URLSearchParams(body);
                if (form.get("email") !== USER || form.get("password") !== PASSWORD) return html(LOGIN.replace("<h1>Sign in</h1>", "<h1>Sign in</h1><p role=alert>Wrong email or password</p>"));
                const sid = `s${++nextId}`;
                sessions.set(sid, { who: USER, start: performance.now(), end: performance.now(), at: Date.now() });
                res.writeHead(303, { location: "/account", "set-cookie": `sid=${sid}; Path=/; HttpOnly` });
                res.end();
            });
            return;
        }
        if (url.pathname === "/login") return html(LOGIN);
        if (url.pathname === "/account") return cookie(req, "sid") ? html(page("Account", "<h1>Your account</h1><p>Signed in.</p>")) : (res.writeHead(303, { location: "/login" }), res.end());
        const work = /^\/work\/([ab])$/.exec(url.pathname);
        if (work) {
            const s = sessions.get(cookie(req, "sid") ?? "");
            if (!s) return void (res.writeHead(303, { location: "/login" }), res.end());
            return void setTimeout(() => {
                s.end = performance.now();
                html(page(`Work ${work[1]}`, `<h1>Work ${work[1]!.toUpperCase()}</h1>`));
            }, WORK_MS);
        }
        const open = /^\/open\/([cd])$/.exec(url.pathname);
        if (open) {
            let v = cookie(req, "v");
            const headers: Record<string, string> = {};
            if (!v || !sessions.has(v)) {
                v = `v${++nextId}`;
                sessions.set(v, { who: "anon", start: performance.now(), end: performance.now(), at: Date.now() });
                headers["set-cookie"] = `v=${v}; Path=/`;
            }
            const s = sessions.get(v)!;
            return void setTimeout(() => {
                s.end = performance.now();
                html(page(`Open ${open[1]}`, `<h1>Open ${open[1]!.toUpperCase()}</h1>`), headers);
            }, OPEN_MS);
        }
        html(page("Home", `<h1>Home</h1><p>Welcome.</p><a href="/login">Sign in</a>`));
    });
    await new Promise<void>((r) => site.listen(PORT, "127.0.0.1", r));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-orchestrator-lanes-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", CONCURRENCY: "3" }));
    server = await buildServer(platform);
    worker = new Worker({ ...platform, makeLlm: () => scripted }, 100);
    worker.start();
}, 60_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    site?.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body.startsWith("{") || res.body.startsWith("[") ? JSON.parse(res.body) : res.body };
};
type Span = { id: string; who: string; start: number; end: number; at: number };
const overlap = (a: Span, b: Span) => a.start < b.end && b.start < a.end;
const pairs = (spans: Span[]) => spans.flatMap((a, i) => spans.slice(i + 1).filter((b) => overlap(a, b)).map((b) => `${a.id}+${b.id}`));

describe("one lane per account", () => {
    it("sessions of one account never overlap while authoring or replaying; signed-out sessions still do", async () => {
        const projectId = (await call("POST", "/api/projects", { name: "Lanes" })).body.id as string;
        const started = performance.now();
        const queued = await call("POST", `/api/projects/${projectId}/test-generation`, {
            url: URL, targets: ["web"], maxPages: 5, credentials: { username: USER, password: PASSWORD }, variants: ["dark", "locale"],
            accessibility: false, healthChecks: false, securityChecks: false, inputChecks: false, contractChecks: false, accessChecks: false,
        });
        expect(queued.status, JSON.stringify(queued.body)).toBe(202);
        let job: { status: string } | undefined;
        for (let i = 0; i < 4000; i++) {
            job = (await call("GET", `/api/test-generation/${queued.body.jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job!.status)) break;
            await new Promise((r) => setTimeout(r, 200));
        }
        const wallMs = Math.round(performance.now() - started);
        const events = platform.repo.listEvents(queued.body.jobId) as Array<{ kind: string; message: string; createdAt: string }>;
        // Every session of the job counts: authoring, validation, the browser / condition checks and the strength check after them.
        const at = (kind: string) => {
            const e = events.find((x) => x.kind === kind);
            return e ? Date.parse(e.createdAt.includes("T") ? e.createdAt : `${e.createdAt.replace(" ", "T")}Z`) : Infinity;
        };
        const later = Math.min(at("variants_started"), at("strength_started"));
        const spans: Span[] = [...sessions].map(([id, s]) => ({ id, ...s }));
        const account = spans.filter((s) => s.who === USER && s.end > s.start);
        const anon = spans.filter((s) => s.who === "anon");
        console.log(`[r189] job ${job!.status} in ${wallMs} ms; account sessions ${account.length}, ${account.filter((s) => s.at >= later).length} of them in the browser and strength checks (overlapping pairs: ${pairs(account).join(", ") || "none"}); signed-out sessions ${anon.length} (overlapping pairs: ${pairs(anon).length})`);

        expect(events.some((e) => e.kind === "auth_succeeded"), events.filter((e) => /auth/.test(e.kind)).map((e) => e.message).join("; ")).toBe(true);
        const tests = platform.repo.listTests(projectId).filter((t) => (t.generationMeta as { scenario?: unknown } | null)?.scenario);
        expect(tests.map((t) => `${t.title}: ${t.validationStatus}`).sort()).toEqual(["Account work A: VALIDATED", "Account work B: VALIDATED", "Open page C: VALIDATED", "Open page D: VALIDATED"]);

        // Authoring, the replays while authoring, validation, the browser / condition checks and the strength check all opened
        // sessions of the account: none of them at the same time.
        expect(account.filter((s) => s.at < later).length).toBeGreaterThanOrEqual(4);
        expect(account.filter((s) => s.at >= later).length).toBeGreaterThanOrEqual(4);
        expect(pairs(account)).toEqual([]);
        // The signed-out pages are not held back by the lane: their sessions overlap.
        expect(pairs(anon).length).toBeGreaterThan(0);
        expect(events.find((e) => e.kind === "account_lanes" && /^2 scenarios that sign in as the same account are written one at a time$/.test(e.message))).toBeDefined();
    }, 1_200_000);
});
