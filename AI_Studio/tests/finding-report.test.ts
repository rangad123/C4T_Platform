/**
 * Phase 5 C3: a bug report and an issue from a finding group (issues/content.ts, routes/integrations.ts, reports/project-report.ts).
 * No browser, no model: a real platform through Fastify inject, a local GitHub-shaped tracker that records what it was sent.
 *
 *  - V8: a Confirmed finding's report has all 13 fields; only the likely cause may be unknown, and then it says why.
 *  - The issue draft passes the canary grep: the planted values of examples/canary-app (every channel and kind) put into every text a
 *    report is made of are in none of the rendered forms (title, Markdown, Jira's document), as is, encoded or as digits.
 *  - Only a Confirmed finding (or one in Classified, which follows it) or one that needs manual review can be filed; a double click
 *    files once; a group gets one issue per tracker; another project's finding or tracker is a 404; a viewer cannot file.
 *  - The project report has a "Confirmed bugs" section with the same fields, and no image.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import canaries from "../examples/canary-app/canaries.json" with { type: "json" };
import { loadConfig } from "../src/config.js";
import { findingFingerprint, type CandidateFindingInput } from "../src/engine/explore/finding.js";
import { FindingViewSchema, type FindingView, type FindingViewInput } from "../src/engine/findings/view.js";
import type { Explanation } from "../src/engine/findings/explain.js";
import type { RootCause } from "../src/engine/findings/root-cause.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { buildFindingReport, findingIssueDraft, missingFields, REPORT_FIELDS, toAdf, toMarkdown } from "../src/platform/issues/content.js";
import { buildServer } from "../src/platform/server.js";

// ── the report, pure ─────────────────────────────────────────────────────────

const view = (over: Partial<FindingViewInput> = {}): FindingView =>
    FindingViewSchema.parse({
        id: "f-1",
        projectId: "p-1",
        source: { kind: "exploration", id: "f-1" },
        state: "confirmed",
        title: "Registration accepts an invalid email address",
        testId: "t-1",
        detectedAt: "2026-11-21T10:00:00.000Z",
        expected: { text: 'Anything else is refused with "Enter a valid email address."', source: "R-cb1ada2e7986", stated: "explicit" },
        observed: "The form was accepted and the visitor signed in.",
        steps: [{ action: "navigate", url: "/register" }, { action: "fill", target: "Email" }, { action: "click", target: "Create account" }, { action: "assert", target: "Enter a valid email address." }],
        attempts: [1, 2, 3].map((n) => ({ outcome: n === 2 ? ("passed" as const) : ("failed" as const), ...(n === 2 ? {} : { failedStep: 4, check: "visible", target: "Enter a valid email address.", error: "expect(locator).toBeVisible() failed", requests: [{ method: "POST", path: "/register", status: 303, own: true }] }) })),
        ...over,
    });
const spec = TestSpecSchema.parse({
    testId: "WEB-019",
    title: "Registration refuses an invalid email address",
    kind: "web",
    category: "Accounts",
    priority: "high",
    preconditions: ["Signed out"],
    steps: [
        { action: "navigate", url: "/register" },
        { action: "fill", locator: { by: "label", value: "Email" }, value: "not-an-address" },
        { action: "click", locator: { by: "role", role: "button", value: "Create account" } },
        { action: "assert", check: "visible", locator: { by: "text", value: "Enter a valid email address." } },
    ],
    expectedResults: ["The message is shown"],
});
const ENV = { appUrl: "https://shop.example.test", appVersion: "51487a03", browser: "Chromium" };

describe("V8: the 13 fields", () => {
    it("a Confirmed finding's report has every field; the likely cause may be unknown, with its reason", () => {
        const r = buildFindingReport({ members: [view()], spec, area: "Accounts", environment: ENV, evidenceUrl: "https://studio.example.test/#/tests/t-1" });
        expect(Object.keys(r)).toEqual([...REPORT_FIELDS]);
        expect(missingFields(r)).toEqual([]);
        expect(r.reproduction).toEqual(["2 of 3 attempts failed the same way."]);
        expect(r.likelyCause[0]).toMatch(/^Unknown: .{10,}/);
        expect(r.steps[3]).toMatch(/failed here/);
        expect(r.preconditions).toEqual(["Signed out"]);
        expect(r.evidence[0]).toBe("POST /register → 303");
    });

    it("says which fields are missing, and an unknown without a reason counts as missing", () => {
        const r = buildFindingReport({ members: [view({ attempts: [] })], environment: {} });
        expect(missingFields(r)).toEqual(["area", "environment", "reproduction"]);
        const filled = { ...r, area: ["Accounts"], environment: ["Application: x"], reproduction: ["1 of 1"] };
        expect(missingFields({ ...filled, likelyCause: ["Unknown."] })).toEqual(["likelyCause"]);
        expect(missingFields({ ...filled, environment: ["Not recorded"] })).toEqual(["environment"]);
    });

    it("uses the cause's label and location and the AI's next step when they exist", () => {
        const rootCause = {
            label: "strongly_supported",
            reason: "The AI's cited line lies in the handler.",
            location: { file: "server.mjs", line: 167, function: "register", route: "POST /register", why: "x", explanation: "The email check is skipped." },
            handlers: [], helpers: [], frames: [], dataOps: [], commits: [], dropped: [],
        } as RootCause;
        const explanation = { class: "app_defect", aiClass: false, explanation: "x", next: "Check the email rule in register().", confidence: { confidence: "high", basis: "b", factors: {} }, warnings: [] } as unknown as Explanation;
        const r = buildFindingReport({ members: [view()], spec, environment: ENV, rootCause, explanation });
        expect(r.likelyCause).toEqual(["Strongly supported: server.mjs:167 in register() (POST /register)", "The email check is skipped."]);
        expect(r.nextStep).toEqual(["Check the email rule in register()."]);
        expect(missingFields(r)).toEqual([]);
    });
});

// ── the canary grep ──────────────────────────────────────────────────────────

type Kind = keyof (typeof canaries.channels)["field"];
const CH = canaries.channels;
/** As in tests/evidence-canary.test.ts: as is, URL-encoded, HTML-escaped, JSON-escaped; digits of a card or phone; a DB URL by its password. */
function needles(kind: Kind, v: string): string[] {
    if (kind === "dbUrl") v = /:([^:@/]+)@/.exec(v)![1]!;
    const out = new Set([v, encodeURIComponent(v), v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"), JSON.stringify(v).slice(1, -1)]);
    if (kind === "card" || kind === "phone") out.add(v.replace(/\D/g, ""));
    if (kind === "email") out.add(v.replace("@", "%40"));
    return [...out];
}
const PAIRS = (Object.keys(CH) as Array<keyof typeof CH>).flatMap((ch) => (Object.keys(CH.field) as Kind[]).map((k) => ({ pair: `${ch}.${k}`, kind: k, value: CH[ch][k] })));
const leaks = (text: string) => PAIRS.filter((p) => needles(p.kind, p.value).some((n) => text.includes(n))).map((p) => p.pair);

describe("the issue draft passes the canary grep", () => {
    it("no planted value, in any form, reaches the title, the Markdown or the Jira document", () => {
        // Each channel's values go where that kind of text ends up in a report: page text, request paths, errors, steps, the cause.
        const all = (ch: keyof typeof CH, sep = " ") => (Object.keys(CH.field) as Kind[]).map((k) => `${k} ${CH[ch][k]}`).join(sep);
        const enc = (ch: keyof typeof CH) => (Object.keys(CH.field) as Kind[]).map((k) => `${k}=${encodeURIComponent(CH[ch][k])}`).join("&");
        const v = view({
            title: `Profile shows ${all("text")}`,
            observed: `The page said: ${all("text")}. Console: ${all("console")}. Frame: ${all("iframe")}. Download: ${all("download")}`,
            expected: { text: `Saved as ${all("field")}`, source: "R-1", stated: "explicit" },
            steps: [{ action: "fill", target: all("field") }, { action: "navigate", url: `/profile?${enc("url")}` }],
            attempts: [1, 2].map(() => ({
                outcome: "failed" as const,
                failedStep: 2,
                error: `Request failed: ${JSON.stringify(Object.fromEntries((Object.keys(CH.json) as Kind[]).map((k) => [k, CH.json[k]])))}`,
                page: `/profile?${enc("url")}`,
                requests: [{ method: "GET", path: `/api/profile?${enc("url")}`, status: 200, own: true }],
                stack: [`app.js:save ${all("header")}`],
            })),
        });
        const cookieSpec = TestSpecSchema.parse({ ...spec, preconditions: [`Cookie: session=${CH.cookie.cookie}; ${all("cookie", "; ")}`] });
        const rootCause = {
            label: "hypothesis",
            reason: "Only the AI points there.",
            location: { file: "server.mjs", line: 10, why: "x", explanation: `It writes ${all("json")} and ${CH.field.dbUrl}` },
            handlers: [], helpers: [], frames: [], dataOps: [], commits: [], dropped: [],
        } as RootCause;
        const explanation = { class: "app_defect", aiClass: false, explanation: "x", next: `Look for ${all("text")}`, confidence: { confidence: "high", basis: "b", factors: {} }, warnings: [] } as unknown as Explanation;
        const report = buildFindingReport({ members: [v], spec: cookieSpec, area: all("text"), environment: { appUrl: `https://shop.example.test/?${enc("url")}` }, rootCause, explanation });
        const draft = findingIssueDraft(report, "https://studio.example.test/#/tests/t-1");
        const rendered = [draft.title, toMarkdown(draft.blocks), JSON.stringify(toAdf(draft.blocks)), JSON.stringify(report)].join("\n");
        // The fixture really carries every pair (the check is not empty).
        const planted = [JSON.stringify(v), JSON.stringify(cookieSpec), JSON.stringify(rootCause), JSON.stringify(explanation)].join("\n") + decodeURIComponent(enc("url"));
        expect(leaks(planted).length).toBeGreaterThan(40);
        expect(leaks(rendered)).toEqual([]);
        // Still readable: the words around the values survive.
        expect(toMarkdown(draft.blocks)).toMatch(/The page said/);
    });

    it("a value written URL-encoded in a request or on a page is masked too, one value at a time (not cut off by a long line)", () => {
        let planted = 0;
        for (const k of Object.keys(CH.url) as Kind[]) {
            const q = `/api/profile?${k}=${encodeURIComponent(CH.url[k])}`;
            const v = view({ observed: `Redirected to ${q}`, attempts: [1, 2].map(() => ({ outcome: "failed" as const, page: q, requests: [{ method: "GET", path: q, status: 200, own: true }] })) });
            const draft = findingIssueDraft(buildFindingReport({ members: [v], environment: ENV }));
            planted += leaks(q).length;
            expect(leaks([draft.title, toMarkdown(draft.blocks), JSON.stringify(toAdf(draft.blocks))].join("\n")), k).toEqual([]);
        }
        // Every kind was really planted (the check is not empty). Since E2 the finding view's shared redaction hides them as well.
        expect(planted).toBeGreaterThanOrEqual(Object.keys(CH.url).length);
    });
});

// ── through the API ──────────────────────────────────────────────────────────

const KEY = "finding-report-owner-key-9f8e7d";
const GH_PORT = 5279;
const GH = `http://127.0.0.1:${GH_PORT}`;
const GH_TOKEN = "ghp_findingReportToken1234567890ab";
const created: Array<{ title: string; body: string }> = [];
let ghDelayMs = 0;
let gh: http.Server;
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
let store: CandidateFindingStore;
let projectA = "";
let projectB = "";
let viewer = "";

const call = async (method: "GET" | "POST", url: string, body?: unknown, headers: Record<string, string> = { "x-api-key": KEY }) => {
    const res = await app.inject({ method, url, headers, ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: res.statusCode, body: res.body ? (() => { try { return JSON.parse(res.body) as any; } catch { return res.body as any; } })() : null };
};
const finding = (scenario: string): CandidateFindingInput => ({
    objective: { id: "obj-1", kind: "rule", source: "R-4" },
    actions: { stepCount: 2 },
    expected: { text: "The total equals the sum of the lines.", source: "R-4" },
    observed: "The total shows 40.00 for two lines of 15.00.",
    evidence: { screenshots: [], requests: ["GET /api/cart answered HTTP 200"], console: [] },
    capture: "captured",
    independence: "independent",
    confidence: "high",
    fingerprint: findingFingerprint({ source: "R-4", expected: "The total equals the sum of the lines.", scenario }),
    modelVersion: null,
    replays: [
        { label: "Replay 1", outcome: "failed", failedStep: 2, summary: "Stopped at the total check" },
        { label: "Replay 2", outcome: "failed", failedStep: 2, summary: "Stopped at the total check" },
    ],
});
const addTest = (projectId: string, key: string) => {
    const s = TestSpecSchema.parse({ ...spec, testId: key, title: `Cart total ${key}` });
    const suite = platform.repo.getOrCreateSuite(projectId, "Cart", "cart");
    return platform.repo.insertTest({ projectId, suiteId: suite, jobId: null, spec: s, framework: "playwright", validationStatus: "NEEDS_REVIEW" }) as string;
};
const ATTEMPTS = [1, 2, 3].map(() => ({ outcome: "failed", failedStep: 2, check: "exactText", target: "Total", value: "30.00", requests: [{ method: "GET", path: "/api/cart", status: 200, own: true }] }));
/** A finding with its own test, walked by the engine to `to`. */
async function seeded(projectId: string, scenario: string, to: "candidate" | "reproduced" | "confirmed" | "needs_manual_review") {
    const testId = addTest(projectId, `WEB-${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`);
    const id = (await store.upsert({ projectId, testId, finding: finding(scenario) })).finding.id;
    if (to === "candidate") return id;
    await store.transition(projectId, id, { to: "verification_pending", by: "engine" });
    if (to === "needs_manual_review") {
        await store.transition(projectId, id, { to: "needs_manual_review", by: "engine" });
        return id;
    }
    await store.transition(projectId, id, { to: "reproduced", by: "engine", set: { severity: "high", attempts: ATTEMPTS, confidence: { confidence: "high", basis: "b", factors: {} } as any } });
    if (to === "confirmed") await store.transition(projectId, id, { to: "confirmed", by: "engine" });
    return id;
}
const issue = (projectId: string, fid: string, integrationId: string, headers?: Record<string, string>) => call("POST", `/api/projects/${projectId}/findings/${fid}/issue`, { integrationId }, headers);
let trackerA = "";
let trackerB = "";

beforeAll(async () => {
    gh = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (d) => (raw += d));
        req.on("end", async () => {
            const send = (code: number, obj: unknown) => (res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify(obj)));
            if (req.headers.authorization !== `Bearer ${GH_TOKEN}`) return send(401, { message: "Bad credentials" });
            if (req.method === "GET") return send(200, { full_name: "acme/shop", has_issues: true, archived: false });
            if (req.method === "POST" && /\/issues$/.test(req.url!)) {
                if (ghDelayMs) await new Promise((r) => setTimeout(r, ghDelayMs));
                const b = JSON.parse(raw);
                created.push({ title: b.title, body: b.body });
                return send(201, { number: created.length, html_url: `https://github.example/acme/shop/issues/${created.length}` });
            }
            send(404, { message: "Not Found" });
        });
    });
    await new Promise<void>((r) => gh.listen(GH_PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    process.env.PUBLIC_URL = "https://studio.example.test";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-finding-report-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "finding-report-secret-key-0123456789", API_KEY: KEY, SCHEDULER_ENABLED: "false" }));
    app = await buildServer(platform);
    await app.ready();
    projectA = platform.repo.createProject({ name: "Atlas shop" }).id as string;
    projectB = platform.repo.createProject({ name: "Other shop" }).id as string;
    platform.repo.createApplication(projectA, "https://atlas.example.test", {});
    store = new CandidateFindingStore(platform.sql);
    const control = accessControlOf(app);
    const u = control.users.create({ email: "vera@example.com", name: "Vera", role: "viewer" });
    viewer = control.users.createToken(u.id, { name: "t", role: "viewer" }).token;
    const connect = async (projectId: string) => {
        const r = await call("POST", `/api/projects/${projectId}/integrations`, { kind: "github", owner: "acme", repo: "shop", token: GH_TOKEN, apiUrl: GH });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        return r.body.id as string;
    };
    trackerA = await connect(projectA);
    trackerB = await connect(projectB);
}, 60_000);

afterAll(async () => {
    delete process.env.PUBLIC_URL;
    await app?.close();
    platform?.db.close();
    await new Promise((r) => gh?.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/projects/:id/findings/:fid/issue", () => {
    it("files a Confirmed finding once, whatever the double click, with the 13 fields", async () => {
        const fid = await seeded(projectA, "double click", "confirmed");
        const before = created.length;
        ghDelayMs = 150;
        const [a, b] = await Promise.all([issue(projectA, fid, trackerA), issue(projectA, fid, trackerA)]);
        ghDelayMs = 0;
        expect([a.status, b.status].sort()).toEqual([200, 201]);
        expect(a.body.link.url).toBe(b.body.link.url);
        expect(created.length).toBe(before + 1);
        const again = await issue(projectA, fid, trackerA);
        expect(again).toMatchObject({ status: 200, body: { existing: true } });
        expect(created.length).toBe(before + 1);
        const body = created.at(-1)!.body;
        for (const h of ["Severity", "Confidence", "Area", "Environment", "Preconditions", "Steps", "Expected", "Actual", "Reproduction", "Evidence", "Likely cause", "Next step"]) expect(body).toContain(`### ${h}`);
        expect(body).toContain("3 of 3 attempts failed the same way.");
        expect(body).toMatch(/Unknown: No code source/);
        expect(body).toContain("https://studio.example.test/#/tests/");
    });

    it("files the likely cause verification kept on the finding (eng-fix3-verify), making no root cause of its own", async () => {
        const fid = await seeded(projectA, "stored cause", "confirmed");
        await store.setRootCause(projectA, [fid], { label: "strongly_supported", reason: "A cited line lies in the handler.", location: { file: "src/cart.js", line: 12, function: "total", why: "the AI's hypothesis", explanation: "The total adds one line twice." }, handlers: [], helpers: [], frames: [], dataOps: [], commits: [], dropped: [] });
        expect((await issue(projectA, fid, trackerA)).status).toBe(201);
        expect(created.at(-1)!.body).toContain("Strongly supported: src/cart.js:12");
        expect(created.at(-1)!.body).toContain("The total adds one line twice.");
    });

    it("files a finding that needs manual review", async () => {
        const fid = await seeded(projectA, "manual review", "needs_manual_review");
        expect((await issue(projectA, fid, trackerA)).status).toBe(201);
    });

    it("refuses any other state, and files nothing", async () => {
        const before = created.length;
        for (const to of ["candidate", "reproduced"] as const) {
            const fid = await seeded(projectA, `refused ${to}`, to);
            const r = await issue(projectA, fid, trackerA);
            expect(r.status, to).toBe(422);
            expect(r.body.error ?? r.body.message).toMatch(/Only a Confirmed finding/);
        }
        const nab = await seeded(projectA, "not a bug", "candidate");
        await store.transition(projectA, nab, { to: "not_a_bug", by: "person", reason: "Works as designed" });
        expect((await issue(projectA, nab, trackerA)).status).toBe(422);
        expect(created.length).toBe(before);
    });

    it("one issue per group and tracker", async () => {
        const one = await seeded(projectA, "group one", "confirmed");
        const two = await seeded(projectA, "group two", "confirmed");
        await store.group(projectA, [one, two], { by: "test" });
        const before = created.length;
        const first = await issue(projectA, one, trackerA);
        expect(first.status).toBe(201);
        const second = await issue(projectA, two, trackerA);
        expect(second).toMatchObject({ status: 200, body: { existing: true } });
        expect(second.body.link.url).toBe(first.body.link.url);
        expect(created.length).toBe(before + 1);
    });

    it("another project's finding or tracker is a 404, and a viewer cannot file", async () => {
        const fid = await seeded(projectA, "isolation", "confirmed");
        const other = await seeded(projectB, "isolation b", "confirmed");
        expect((await issue(projectB, fid, trackerB)).status).toBe(404);
        expect((await issue(projectA, fid, trackerB)).status).toBe(404);
        expect((await issue(projectA, other, trackerA)).status).toBe(404);
        expect((await issue(projectA, "no-such-finding", trackerA)).status).toBe(404);
        expect((await issue(projectA, fid, trackerA, { authorization: `Bearer ${viewer}` })).status).toBe(403);
    });
});

describe("the project report", () => {
    it("has a Confirmed bugs section with the report's fields and no image", async () => {
        await seeded(projectA, "report", "confirmed");
        const r = await app.inject({ method: "GET", url: `/api/projects/${projectA}/report`, headers: { "x-api-key": KEY } });
        expect(r.statusCode).toBe(200);
        const html = r.body;
        expect(html).toMatch(/<h2>Confirmed bugs \(\d+\)<\/h2>/);
        for (const h of ["Severity", "Confidence", "Reproduction", "Likely cause", "Next step"]) expect(html).toContain(`<dt>${h}</dt>`);
        expect(html).toContain("3 of 3 attempts failed the same way.");
        expect(html).not.toMatch(/<img/);
        // A finding still a candidate is not a confirmed bug.
        const count = (h: string) => Number(/<h2>Confirmed bugs \((\d+)\)/.exec(h)![1]);
        const before = count(html);
        expect(before).toBeGreaterThan(0);
        await seeded(projectA, "report candidate", "candidate");
        await seeded(projectA, "report review", "needs_manual_review");
        const again = await app.inject({ method: "GET", url: `/api/projects/${projectA}/report`, headers: { "x-api-key": KEY } });
        expect(count(again.body)).toBe(before);
    });
});
