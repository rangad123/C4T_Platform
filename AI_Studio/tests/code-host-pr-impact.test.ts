/**
 * A pull request's webhook delivery end to end (Phase 6): signed delivery → changed files and the repository's source from GitHub (a
 * local fake, tests/fixtures/fake-github.ts; nothing reaches github.com) → impact analysis with the project's tests and its past
 * findings → one pr_selections row (mode full: automatic selection stays off) → one sticky comment with the risk reasons and "Full run
 * recommended" → the pr_selection_ready notice on the channels that chose it, masked. The same delivery twice still gives one of each.
 * Every token, secret and canary here is made up.
 */
import { createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { COMMENT_MARKER } from "../src/cli/render.js";
import { loadConfig } from "../src/config.js";
import { findingFingerprint } from "../src/engine/explore/finding.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { buildServer } from "../src/platform/server.js";
import { startFakeGithub } from "./fixtures/fake-github.js";

const KEY = "code-host-pr-impact-test-key-51c0";
const TOKEN = "github_pat_11FAKE0PRIMPACT0TEST0TOKEN0abcdef0123456789";
const SECRET = "whsec-FAKE-pr-impact-0123456789";
const HEAD = "2222222222222222222222222222222222222222";
const CANARY = "api_key=FAKECANARY0primpact0123456789abcdef";

const OLD = `import express from "express";
const app = express();
app.post("/api/orders", (req, res) => {
    const total = 1;
    res.json({ total });
});
app.get("/api/health", (req, res) => res.json({ ok: true }));
`;
const NEW = OLD.replace("const total = 1;", "const total = 2;");
const PATCH = "@@ -3,4 +3,4 @@ app.post\n app.post(\"/api/orders\", (req, res) => {\n-    const total = 1;\n+    const total = 2;\n     res.json({ total });\n });";

type Fake = Awaited<ReturnType<typeof startFakeGithub>>;
let gh: Fake;
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let receiver: http.Server;
let receiverUrl = "";
const received: Array<{ url: string; body: string }> = [];
const ids: Record<string, string> = {};
const hooks: Record<string, string> = {};
const envBefore = process.env.CODE_HOST_GITHUB_API_URL;

const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, headers: { "x-api-key": KEY }, ...(payload !== undefined ? { payload: payload as never } : {}) });
    return { status: r.statusCode, body: r.body && /^[{[]/.test(r.body) ? r.json() : r.body };
};
const api = (title: string, method: string, p: string, priority = "medium") => ({ title, kind: "api", category: "API", priority, steps: [{ action: "request", method, path: p }, { action: "assertResponse", check: "status", expected: 200 }] });

async function project(name: string, feedback: boolean): Promise<void> {
    const id = (await call("POST", "/api/projects", { name })).body.id as string;
    ids[name] = id;
    const specs = await call("POST", `/api/projects/${id}/specs`, { baseUrl: "http://127.0.0.1:9", validate: false, specs: [api(`Create an order ${CANARY}`, "POST", "/api/orders", "critical"), api("Health answers", "GET", "/api/health")] });
    expect(specs.status, JSON.stringify(specs.body)).toBe(202);
    const r = await call("PUT", `/api/projects/${id}/code-host`, { owner: "acme", repo: "shop", token: TOKEN, webhookSecret: SECRET, apiUrl: gh.url, feedback });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    hooks[name] = r.body.webhookUrl;
}

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    gh = await startFakeGithub({
        token: TOKEN,
        prs: { 7: { headSha: HEAD, files: [{ filename: "server.mjs", patch: PATCH }, { filename: "README.md", patch: "@@ -1 +1 @@\n-a\n+b" }] } },
        source: { "server.mjs": NEW, "README.md": "b\n" },
    });
    process.env.CODE_HOST_GITHUB_API_URL = gh.url;
    receiver = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => (received.push({ url: req.url ?? "", body }), res.writeHead(200).end("ok")));
    });
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-primpact-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SCHEDULER_ENABLED: "false", API_KEY: KEY, SECRET_KEY: "pr-impact-test-secret-key-0123456789" }));
    app = await buildServer(platform);
    await app.ready();
    await project("On", true);
    await project("Off", false);
    // A past finding on the changed endpoint (S2's findings list): the order test's previous-defects factor.
    await new CandidateFindingStore(platform.sql).upsert({
        projectId: ids.On!,
        finding: {
            objective: null,
            actions: { stepCount: 1 },
            expected: { text: "The order total is the sum of its lines.", source: "R-1" },
            observed: "The total was 3.",
            evidence: { screenshots: [], requests: ["GET /api/health -> 200", "POST /api/orders -> 500"], console: [] },
            capture: "captured",
            independence: "independent",
            confidence: "high",
            fingerprint: findingFingerprint({ source: "R-1", expected: "The order total is the sum of its lines.", scenario: "pr" }),
            modelVersion: null,
            replays: [],
        },
    });
    const ch = (name: string, events: string[]) => call("POST", `/api/projects/${ids.On}/alert-channels`, { kind: "webhook", name, url: `${receiverUrl}/${name}`, events });
    expect((await ch("chose", ["pr_selection_ready"])).status).toBe(201);
    expect((await ch("runs-only", ["run_failed"])).status).toBe(201);
}, 60_000);

afterAll(async () => {
    if (envBefore === undefined) delete process.env.CODE_HOST_GITHUB_API_URL;
    else process.env.CODE_HOST_GITHUB_API_URL = envBefore;
    await app?.close();
    platform?.db.close();
    await gh?.close();
    await new Promise<void>((r) => (receiver ? receiver.close(() => r()) : r()));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const delivery = (n = 7) => JSON.stringify({ action: "synchronize", number: n, pull_request: { number: n, head: { sha: HEAD, repo: { full_name: "acme/shop" } }, base: { repo: { full_name: "acme/shop" } } }, repository: { full_name: "acme/shop" } });
async function deliver(hook: string, id: string, body = delivery()) {
    const sig = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
    const r = await app.inject({ method: "POST", url: hook, headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": id, "x-hub-signature-256": sig }, payload: body });
    return r.statusCode;
}
const selections = (name: string) => platform.db.all<{ pr: number; head_sha: string; mode: string; selected_json: string; reasons_json: string }>("SELECT * FROM pr_selections WHERE project_id = ?", ids[name]);
const testId = (name: string, title: string) => platform.repo.listTests(ids[name]!).find((t) => t.title.startsWith(title))!.id;

describe("a signed pull request delivery", () => {
    it("stores one selection and writes one sticky comment with the risk reasons and the full-run recommendation", async () => {
        expect(await deliver(hooks.On!, "pr-d-1")).toBe(202);
        await vi.waitFor(() => expect(gh.comments.get(7)?.length).toBe(1), { timeout: 15_000, interval: 50 });
        const rows = selections("On");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ pr: 7, head_sha: HEAD, mode: "full" });
        const order = testId("On", "Create an order");
        expect(JSON.parse(rows[0]!.selected_json)).toContain(order);
        const reasons = JSON.parse(rows[0]!.reasons_json);
        expect(reasons.endpoints).toEqual(["POST /api/orders (server.mjs:3)"]);
        expect(reasons.unmapped.map((u: any) => u.path)).toEqual(["README.md"]);
        expect(reasons.fullRunRecommended).toBe(true);
        expect(reasons.findings).toHaveLength(1);
        // The previous-defects factor reads the findings list: one finding on POST /api/orders.
        const t = reasons.tests.find((x: any) => x.testId === order);
        expect(t.risk).toContain("previous defects 1 finding (+2)");
        expect(reasons.tests[0].testId).toBe(order);

        const body = gh.comments.get(7)![0]!.body;
        expect(body).toContain(COMMENT_MARKER);
        expect(body).toContain("**Full run recommended.**");
        expect(body).toContain("previous defects 1 finding (+2)");
        expect(body).toContain("README.md");
        expect(body).not.toContain("FAKECANARY");
        // No run yet: no check and no commit status on the head commit.
        expect(gh.requests.filter((r) => r.method === "POST" && /check-runs|statuses/.test(r.url))).toEqual([]);
        // The token goes only to the fake GitHub, never into the comment.
        expect(body).not.toContain(TOKEN);
    });

    it("tells the channel that chose pr_selection_ready, masked, and no other", async () => {
        await vi.waitFor(() => expect(received.some((r) => r.url === "/chose")).toBe(true), { timeout: 10_000, interval: 50 });
        const msgs = received.filter((r) => r.url === "/chose");
        expect(msgs).toHaveLength(1);
        const m = JSON.parse(msgs[0]!.body);
        expect(m).toMatchObject({ event: "pr_selection_ready", project: { id: ids.On } });
        expect(m.summary).toMatch(/^1 of 2 tests are proposed for pull request #7; a full run is recommended\.$|^2 of 2 tests are proposed for pull request #7; a full run is recommended\.$/);
        expect(JSON.stringify(received)).not.toContain("FAKECANARY");
        expect(received.filter((r) => r.url === "/runs-only")).toEqual([]);
        const log = platform.db.all<{ event: string; status: string }>("SELECT event, status FROM alert_log WHERE project_id = ?", ids.On);
        expect(log).toEqual([{ event: "pr_selection_ready", status: "sent" }]);
    });

    it("acts once for the same delivery twice, and once for another delivery of the same head commit", async () => {
        expect(await deliver(hooks.On!, "pr-d-1")).toBe(200);
        expect(await deliver(hooks.On!, "pr-d-2")).toBe(202);
        // Give a second analysis time to run, were one started.
        await new Promise((r) => setTimeout(r, 500));
        expect(selections("On")).toHaveLength(1);
        expect(gh.comments.get(7)).toHaveLength(1);
        expect(received.filter((r) => r.url === "/chose")).toHaveLength(1);
    });

    it("stores the selection but writes nothing on the pull request while the project's switch is off", async () => {
        const before = gh.requests.filter((r) => r.method !== "GET").length;
        expect(await deliver(hooks.Off!, "pr-off-1")).toBe(202);
        await vi.waitFor(() => expect(selections("Off")).toHaveLength(1), { timeout: 15_000, interval: 50 });
        expect(gh.requests.filter((r) => r.method !== "GET").length).toBe(before);
    });
});
