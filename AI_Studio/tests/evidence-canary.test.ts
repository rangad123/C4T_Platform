/**
 * The evidence audit with canary secrets (Phase 5 task E1). A fixture app (examples/canary-app) plants seven kinds of fake secret
 * (password, bearer token, session cookie, API key, personal data = e-mail + phone + address, card number, database connection string)
 * in nine channels (form fields, headers, cookies, JSON bodies, URLs, console, page text, an iframe, a downloaded file), one value per
 * channel and kind. Through the real API, queue, worker and browser:
 *   1. a test generation with a scripted model double (discovery, understanding, planning, authoring, validation; page health checks on);
 *   2. imported tests that fail on the app (a web test that types the run's password, waits for the profile call and downloads the
 *      export; an API test), so evidence, traces, screenshots and videos are kept;
 *   3. an issue filed for the failing web test (a local GitHub-shaped tracker keeps what it was sent) and the project report;
 *   4. a candidate finding made of what the app showed (page text, request lines, console lines), through the finding contract.
 * Then every stored row (per table), every stored file (traces unpacked, screenshots by a covered-box check), the runs' scratch files,
 * the API answers, the issue, the report and what was sent to the AI are searched for every canary.
 *
 * What leaks today is listed in KNOWN_LEAKS, each with its line in .scratch/ai-testing-engine/P5-EVIDENCE-AUDIT.md, and shown as a
 * todo. A leak not on the list fails; a listed leak that no longer happens fails too, so the list stays the truth (E2 closes them).
 * The matrix of what was found is written to .validation/evidence-canary-matrix.json.
 *
 * Ports: canary app 5760, issue tracker 5761. Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/evidence-canary.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { MockLanguageModelV3 } from "ai/test";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import canaries from "../examples/canary-app/canaries.json" with { type: "json" };
import { loadConfig, REPO_ROOT } from "../src/config.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { ScenarioSchema } from "../src/engine/spec/schema.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const APP_PORT = 5760;
const GH_PORT = 5761;
const APP = `http://127.0.0.1:${APP_PORT}`;
const GH_TOKEN = "ghp_canaryTrackerToken1234567890ab";

type Channel = keyof typeof canaries.channels;
type Kind = keyof (typeof canaries.channels)["field"];
const C = canaries.channels;
const CHANNELS = Object.keys(C) as Channel[];
const KINDS = Object.keys(C.field) as Kind[];
/** The seven kinds of the plan (personal data is three values). */
export const KIND_GROUP: Record<Kind, string> = { password: "password", bearer: "bearer token", cookie: "cookie", apiKey: "API key", email: "personal data", phone: "personal data", address: "personal data", card: "card number", dbUrl: "DB connection string" };
const PASSWORD = C.field.password;

/** The forms a value can be stored in: as is, URL-encoded, HTML-escaped; a card or phone also as bare digits; a connection string by its password. */
function needles(kind: Kind, v: string): string[] {
    if (kind === "dbUrl") v = /:([^:@/]+)@/.exec(v)![1]!;
    const out = new Set([v, encodeURIComponent(v), v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"), JSON.stringify(v).slice(1, -1)]);
    if (kind === "card" || kind === "phone") out.add(v.replace(/\D/g, ""));
    if (kind === "email") out.add(v.replace("@", "%40"));
    return [...out];
}
/**
 * KNOWN-LIMITS-P3 T-9 (E2): the run's password in the forms the app echoes it in (`t9.<form>`, searched as written, JSON-escaped and
 * HTML-escaped), and a field named "Clave1" holding its own value (`clave.field`, searched as any value).
 */
const { _note: _t9note, claveField: CLAVE, ...T9 } = canaries.t9;
const bytes = (forms: string[]) => forms.flatMap((n) => [Buffer.from(n, "latin1"), Buffer.from(n, "utf16le")]);
const NEEDLES: Array<{ pair: string; forms: Buffer[] }> = [
    ...CHANNELS.flatMap((ch) => KINDS.map((k) => ({ pair: `${ch}.${k}`, forms: bytes(needles(k, C[ch][k])) }))),
    ...Object.entries(T9).map(([form, v]) => ({ pair: `t9.${form}`, forms: bytes([...new Set([v, JSON.stringify(v).slice(1, -1), v.replace(/&/g, "&amp;")])]) })),
    { pair: "clave.field", forms: bytes(needles("password", CLAVE)) },
];
const pairsIn = (bytes: Buffer | Uint8Array | string): string[] => {
    const b = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
    return NEEDLES.filter((n) => n.forms.some((f) => b.includes(f))).map((n) => n.pair);
};

/**
 * What is still kept, by evidence type: the (channel.kind) pairs found, and the audit line (P5-EVIDENCE-AUDIT.md) that explains them.
 * Every pair left is a value that nothing marks as secret: a password, token or session id written on the page as plain text (in the
 * page itself or in its iframe), with no key word, field or format around it. The redaction cannot tell it from other words, and page
 * text stays in what the engine keeps so it can understand the app; screenshots show page text as it is (only fields are covered).
 * Remove a pair when it no longer happens.
 */
const P = (s: string) => s.split(" ");
const KNOWN_LEAKS: Record<string, { audit: string; pairs: string[] }> = {
    // The finding's observed text quotes the page (step 4): the same bare page-text values as the application model, nothing else.
    "findings (API)": { audit: "L-6", pairs: P("text.bearer text.cookie text.password") },
    "row: applications": { audit: "L-2", pairs: P("text.bearer text.cookie text.password") },
    "row: candidate_findings": { audit: "L-6", pairs: P("text.bearer text.cookie text.password") },
    "screenshot (covered-box check)": { audit: "L-7", pairs: P("iframe.address iframe.apiKey iframe.bearer iframe.card iframe.cookie iframe.dbUrl iframe.email iframe.password iframe.phone text.address text.apiKey text.bearer text.card text.cookie text.dbUrl text.email text.password text.phone") },
    "sent to the AI": { audit: "L-3", pairs: P("text.bearer text.cookie text.password") },
    "stored database file": { audit: "L-2, L-6", pairs: P("text.bearer text.cookie text.password") },
    "stored file application-model.json": { audit: "L-2", pairs: P("text.bearer text.cookie text.password") },
    "stored trace": { audit: "L-1", pairs: P("iframe.cookie iframe.password text.cookie text.password") },
};

const found = new Map<string, Set<string>>();
const record = (evidence: string, bytes: Buffer | Uint8Array | string) => {
    const p = pairsIn(bytes);
    if (p.length === 0) return;
    const set = found.get(evidence) ?? new Set<string>();
    p.forEach((x) => set.add(x));
    found.set(evidence, set);
};
/** Evidence types that were looked at, found or not (the audit names each). */
const searched = new Set<string>();
const search = (evidence: string, bytes: Buffer | Uint8Array | string) => {
    searched.add(evidence);
    record(evidence, bytes);
};

let dataDir = "";
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let app: ChildProcess;
let tracker: http.Server;
let startedAt = 0;
let projectId = "";
const issuesSent: string[] = [];
const ids: Record<string, string> = {};
/** Everything the scripted model was sent: what the AI provider would see. */
const sentToAi: string[] = [];

// ── the scripted model ────────────────────────────────────────────────────────
const toolQueue: Array<{ tool: string; input: Record<string, unknown> }> = [];
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
        sentToAi.push(JSON.stringify(options.prompt));
        const next = toolQueue.shift();
        if (!next) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
        return { content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName: next.tool, input: JSON.stringify(next.input) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] };
    },
});
const scripted: LlmClient = {
    modelName: "scripted",
    model,
    usage: { inputTokens: 0, outputTokens: 0 },
    text: (async ({ system, prompt }: { system?: string; prompt?: string }) => {
        sentToAi.push(`${system ?? ""}\n${prompt ?? ""}`);
        return "";
    }) as LlmClient["text"],
    imageObject: async () => {
        throw new Error("no image calls in this test");
    },
    object: (async ({ system, prompt }: { system: string; prompt: string }) => {
        sentToAi.push(`${system}\n${prompt}`);
        if (/analysing a web application/.test(system)) {
            return {
                siteType: "saas",
                purpose: "An account page",
                features: ["Profile"],
                pagePurposes: [],
                journeys: [{ name: "Look at the account", description: "Open the account page", steps: ["Open the account"], priority: "high", pages: ["/"], requiresAuth: false }],
                authenticationMechanisms: [],
            };
        }
        if (/normalise software requirements/.test(system)) return { requirements: [] };
        toolQueue.push({ tool: "assert", input: { check: "visible", target: { by: "role", role: "heading", value: "Canary account" } } });
        toolQueue.push({ tool: "finish", input: { result: "complete", explanation: "checked" } });
        return {
            scenarios: [ScenarioSchema.omit({ scenarioId: true }).parse({ title: "Open the account page", description: "Open the account page", category: "Account", priority: "high", journey: "Look at the account", startPath: "/", expectedResults: ["Canary account is shown"] })],
        };
    }) as LlmClient["object"],
};

beforeAll(async () => {
    startedAt = Date.now() - 1000;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    app = spawn(process.execPath, [path.join(REPO_ROOT, "examples/canary-app/server.mjs"), String(APP_PORT)], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve, reject) => {
        app.stdout!.on("data", (d) => String(d).includes("canary-app on") && resolve());
        app.on("exit", (code) => reject(new Error(`canary app exited (${code})`)));
    });
    tracker = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (d) => (raw += d));
        req.on("end", () => {
            res.setHeader("content-type", "application/json");
            if (req.method === "POST" && req.url === "/repos/acme/canary/issues") {
                issuesSent.push(raw);
                res.writeHead(201).end(JSON.stringify({ number: issuesSent.length, html_url: `https://github.example/acme/canary/issues/${issuesSent.length}` }));
            } else res.writeHead(200).end(JSON.stringify({ full_name: "acme/canary", has_issues: true, archived: false }));
        });
    });
    await new Promise<void>((r) => tracker.listen(GH_PORT, "127.0.0.1", r));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-canary-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "canary-test-secret-key-0123456789", LLM_PROVIDER: "anthropic", CONCURRENCY: "2", SCHEDULER_ENABLED: "false" }));
    server = await buildServer(platform);
    worker = new Worker({ ...platform, makeLlm: () => scripted }, 100);
    worker.start();
}, 60_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    if (app?.pid) app.kill();
    tracker?.close();
    platform?.db.close();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, text: res.body, body: res.body && res.headers["content-type"]?.toString().includes("json") ? JSON.parse(res.body) : null };
};
async function waitJob(jobId: string) {
    for (let i = 0; i < 900; i++) {
        const job = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) return job;
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`job ${jobId} did not finish`);
}
const filesUnder = (dir: string, since = 0): string[] =>
    fs.existsSync(dir)
        ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
              const full = path.join(dir, e.name);
              return e.isDirectory() ? filesUnder(full, since) : fs.statSync(full).mtimeMs >= since ? [full] : [];
          })
        : [];
/** A stored file's evidence type, by what it is. */
const typeOf = (f: string): string => {
    const b = path.basename(f);
    if (/\.(db|db-wal|db-shm|sqlite)$/.test(b)) return "database file";
    if (b.endsWith(".zip")) return "trace";
    if (/\.(png|jpe?g)$/.test(b)) return "screenshot";
    if (b.endsWith(".webm")) return "video";
    if (/evidence.*\.json$/.test(b)) return "evidence json";
    if (b === "report.json") return "playwright report";
    if (/\.spec\.ts$/.test(b)) return "script";
    if (/\.(md|txt|log)$/.test(b)) return "text artifact";
    return `file ${b.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "<id>").replace(/\d{6,}/g, "<n>")}`;
};
/** Unpacks a zip's parts (a trace) and searches each; a zip that cannot be read is searched as bytes. */
function searchFile(evidence: string, f: string) {
    const bytes = fs.readFileSync(f);
    if (evidence.endsWith("trace")) {
        try {
            for (const part of Object.values(unzipSync(new Uint8Array(bytes)))) search(evidence, part);
            return;
        } catch {
            /* not a zip: search it whole */
        }
    }
    search(evidence, bytes);
}

const KEY = (i: number) => 70 + i * 44;
/** On-screen boxes of the home page (examples/canary-app/server.mjs): field and text columns, and the iframe's lines. */
const BOXES: Array<{ pair: string; x: number; y: number; w: number; h: number }> = KINDS.flatMap((k, i) => [
    { pair: `field.${k}`, x: 22, y: KEY(i) + 2, w: 390, h: 24 },
    { pair: `text.${k}`, x: 470, y: KEY(i), w: 300, h: 20 },
    { pair: `iframe.${k}`, x: 880, y: 60 + i * 44 + 10, w: 300, h: 20 },
]).concat({ pair: "clave.field", x: 22, y: 562, w: 390, h: 24 });

/** The boxes a screenshot shows: each box whose pixels are not all the proof cover's colour (#475569) and not all blank. */
async function shownIn(files: string[]): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    if (files.length === 0) return out;
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        for (const f of files) {
            const mime = f.endsWith(".png") ? "image/png" : "image/jpeg";
            const shown: string[] = await page.evaluate(
                async ({ src, boxes }) => {
                    const img = new Image();
                    img.src = src;
                    await img.decode();
                    const canvas = document.createElement("canvas");
                    canvas.width = img.naturalWidth;
                    canvas.height = img.naturalHeight;
                    const ctx = canvas.getContext("2d")!;
                    ctx.drawImage(img, 0, 0);
                    const visible: string[] = [];
                    for (const b of boxes) {
                        if (b.x + b.w > canvas.width || b.y + b.h > canvas.height) continue;
                        const d = ctx.getImageData(b.x, b.y, b.w, b.h).data;
                        let cover = 0;
                        let dark = 0;
                        for (let i = 0; i < d.length; i += 4) {
                            if (Math.abs(d[i]! - 0x47) < 12 && Math.abs(d[i + 1]! - 0x55) < 12 && Math.abs(d[i + 2]! - 0x69) < 12) cover++;
                            else if (d[i]! + d[i + 1]! + d[i + 2]! < 300) dark++;
                        }
                        const n = d.length / 4;
                        // Text is there when some pixels are dark ink and the box is not the cover.
                        if (cover / n < 0.9 && dark / n > 0.01) visible.push(b.pair);
                    }
                    return visible;
                },
                { src: `data:${mime};base64,${fs.readFileSync(f).toString("base64")}`, boxes: BOXES },
            );
            for (const p of shown) {
                const set = out.get(p) ?? new Set<string>();
                set.add(path.basename(f));
                out.set(p, set);
            }
        }
    } finally {
        await browser.close();
    }
    return out;
}

const urlQuery = new URLSearchParams(Object.fromEntries(KINDS.map((k) => [k, C.url[k]]))).toString();
const SPECS = {
    web: {
        title: "The account page saves the profile and exports",
        kind: "web",
        category: "Canary",
        steps: [
            { action: "navigate", url: "/" },
            { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" },
            { action: "assert", check: "text", locator: { by: "role", role: "status" }, expected: "Profile saved" },
            { action: "download", locator: { by: "role", role: "link", value: "Export", exact: true }, filename: "export" },
            { action: "assert", check: "visible", expected: "Never shown anywhere" },
        ],
    },
    api: { title: "The profile endpoint creates", kind: "api", category: "Canary API", steps: [{ action: "request", method: "POST", path: "/api/profile", body: { note: "hello" }, auth: "none" }, { action: "assertResponse", check: "status", expected: 201 }] },
};

describe("evidence audit with canary secrets", () => {
    it("a test generation with a scripted model runs on the canary app", async () => {
        projectId = (await call("POST", "/api/projects", { name: "Canary" })).body.id;
        const queued = await call("POST", `/api/projects/${projectId}/test-generation`, {
            url: APP,
            targets: ["web"],
            maxPages: 5,
            runTestCases: true,
            credentials: { username: "canary-user", password: PASSWORD },
            accessibility: false,
            healthChecks: true,
            securityChecks: false,
            inputChecks: false,
            contractChecks: false,
            accessChecks: false,
        });
        expect(queued.status, queued.text).toBe(202);
        ids.generation = queued.body.jobId;
        const job = await waitJob(queued.body.jobId);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"], JSON.stringify(job.error ?? job.status)).toContain(job.status);
        expect(sentToAi.length).toBeGreaterThan(0);
    }, 300_000);

    it("imported tests fail on the app, keeping evidence, a trace, a screenshot and a video", async () => {
        const imp = await call("POST", `/api/projects/${projectId}/specs`, { baseUrl: APP, credentials: { username: "canary-user", password: PASSWORD }, specs: Object.values(SPECS) });
        expect(imp.status, imp.text).toBe(202);
        Object.keys(SPECS).forEach((k, i) => (ids[k] = imp.body.tests[i].id));
        await waitJob(imp.body.jobId);
        for (const k of Object.keys(SPECS)) expect((await call("GET", `/api/tests/${ids[k]}`)).body.validationStatus, k).not.toBe("VALIDATED");
        // The web test got as far as its last step: the password was typed, the profile saved and the export downloaded.
        expect((await call("GET", `/api/tests/${ids.web}/evidence`)).body.execution).toMatchObject({ status: "failed", failedStep: SPECS.web.steps.length });
        const kinds = platform.db.all<{ kind: string }>("SELECT DISTINCT kind FROM artifacts WHERE test_case_id = ?", ids.web!).map((r) => r.kind);
        expect(kinds).toEqual(expect.arrayContaining(["evidence", "trace", "screenshot"]));
    }, 300_000);

    it("an issue is filed for the failing web test, and the project report is made", async () => {
        const conn = await call("POST", `/api/projects/${projectId}/integrations`, { kind: "github", owner: "acme", repo: "canary", token: GH_TOKEN, apiUrl: `http://127.0.0.1:${GH_PORT}` });
        expect(conn.status, conn.text).toBe(201);
        const made = await call("POST", `/api/tests/${ids.web}/issue`, { integrationId: conn.body.id });
        expect(made.status, made.text).toBe(201);
        expect(issuesSent).toHaveLength(1);
        search("issue sent to the tracker", issuesSent.join("\n"));
        const html = await call("GET", `/api/projects/${projectId}/report?format=html`);
        expect(html.status, html.text.slice(0, 200)).toBe(200);
        search("project report (html)", html.text);
        const pdf = await server.inject({ method: "GET", url: `/api/projects/${projectId}/report?format=pdf` });
        expect(pdf.statusCode, pdf.body.slice(0, 200)).toBe(200);
        const { extractText, getDocumentProxy } = await import("unpdf");
        const { text } = await extractText(await getDocumentProxy(new Uint8Array(pdf.rawPayload)), { mergePages: true });
        expect(text).toContain("Canary");
        search("project report (pdf text)", text);
    }, 60_000);

    it("a candidate finding made of what the app showed goes through the finding contract", async () => {
        const store = new CandidateFindingStore(platform.db.sql);
        await store.upsert({
            projectId,
            jobId: ids.generation!,
            finding: {
                objective: { id: "obj-1", kind: "rule", source: "R-1" },
                actions: { stepCount: 3 },
                expected: { text: "The profile shows the saved values.", source: "R-1" },
                observed: KINDS.map((k) => C.text[k]).join(" | "),
                evidence: { screenshots: [], requests: [`GET /api/ping?${urlQuery} -> 200`, `POST /api/profile -> 200 ${JSON.stringify(C.json)}`], console: KINDS.map((k) => `${k}: ${C.console[k]}`) },
                capture: "captured",
                independence: "independent",
                confidence: "high",
                fingerprint: "c".repeat(64),
                modelVersion: "v1",
                replays: [],
            },
        });
        expect((await store.list(projectId)).length).toBe(1);
    });

    it("searches every stored row, file, scratch file, API answer and AI prompt, and checks the screenshots' covers", async () => {
        // API answers people read.
        for (const jobId of [ids.generation!, ...new Set(platform.db.all<{ id: string }>("SELECT id FROM generation_jobs WHERE project_id = ?", projectId).map((r) => r.id))]) {
            search("job events (API)", (await call("GET", `/api/test-generation/${jobId}/events`)).text);
            search("job (API)", (await call("GET", `/api/test-generation/${jobId}`)).text);
        }
        for (const t of platform.db.all<{ id: string }>("SELECT id FROM test_cases WHERE project_id = ?", projectId)) {
            search("test detail (API)", (await call("GET", `/api/tests/${t.id}`)).text);
            search("evidence (API)", (await call("GET", `/api/tests/${t.id}/evidence`)).text);
        }
        search("findings (API)", (await call("GET", `/api/projects/${projectId}/candidate-findings`)).text);
        search("sent to the AI", sentToAi.join("\n"));
        // Every row of every table.
        platform.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        for (const { name } of platform.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
            searched.add(`row: ${name}`);
            for (const row of platform.db.all(`SELECT * FROM "${name}"`)) record(`row: ${name}`, JSON.stringify(row));
        }
        // Every stored file, and the runs' scratch files.
        const stored = filesUnder(dataDir);
        const scratchNow = () => filesUnder(path.join(REPO_ROOT, ".validation"), startedAt).filter((f) => !f.endsWith("evidence-canary-matrix.json"));
        // A job's folder is removed just after its status is final: give the last one a moment.
        for (let i = 0; i < 50 && scratchNow().length > 0; i++) await new Promise((r) => setTimeout(r, 200));
        const scratch = scratchNow();
        const pictures: string[] = [];
        for (const [where, list] of [["stored", stored], ["scratch", scratch]] as const) {
            for (const f of list) {
                const t = `${where} ${typeOf(f)}`;
                if (t.endsWith("screenshot")) pictures.push(f);
                if (t.endsWith("video")) {
                    searched.add(t); // pictures: what was on screen is in them, and they cannot be covered (P5-EVIDENCE-AUDIT.md)
                    continue;
                }
                searchFile(t, f);
            }
        }
        expect(stored.some((f) => typeOf(f) === "trace")).toBe(true);
        // L-8: a job's run folders (page snapshots, reports, traces, recordings) go when the job ends.
        expect(scratch.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
        expect(pictures.length).toBeGreaterThan(0);
        searched.add("screenshot (covered-box check)");
        for (const [pair] of await shownIn(pictures)) found.set("screenshot (covered-box check)", (found.get("screenshot (covered-box check)") ?? new Set<string>()).add(pair));

        const matrix = Object.fromEntries([...searched].sort().map((e) => [e, [...(found.get(e) ?? [])].sort()]));
        fs.mkdirSync(path.join(REPO_ROOT, ".validation"), { recursive: true });
        fs.writeFileSync(path.join(REPO_ROOT, ".validation/evidence-canary-matrix.json"), JSON.stringify(matrix, null, 2));
        const known = Object.fromEntries(Object.entries(KNOWN_LEAKS).map(([e, l]) => [e, [...l.pairs].sort()]));
        const leaking = Object.fromEntries(Object.entries(matrix).filter(([, p]) => p.length > 0));
        expect(leaking).toEqual(known);
    }, 180_000);

    it.todo("L-9: videos show every value on screen, fields included, and cannot be covered; they are not searched. Kept 7 days (within every retention period), never in scratch");
    for (const [evidence, leak] of Object.entries(KNOWN_LEAKS)) it.todo(`${leak.audit}: ${evidence} keeps ${leak.pairs.join(", ")}`);
});
