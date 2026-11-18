/**
 * Values typed into secret fields during an exploration by objectives never reach the action log (CP3 N-2). A real browser on a local
 * sign-up page (port 9897) with Password, One-time code and PIN fields and a constrained Quantity; a scripted model double (never a real
 * model) types a literal value into each secret field while it pursues the quantity's invalid input, through the real objective stage
 * (author.ts resolves each field to its element, orchestrator.ts keys the action). The job's exploration record is then read as a
 * runner sends it (task-runner.ts `explorationForResult`, with a log that masks nothing itself) and as the platform serves it
 * (saved through a real RepoSink, GET /api/projects/:id/jobs/:jobId/coverage); neither carries a typed secret.
 * Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/explore-typed-secrets.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { explorationForResult } from "../src/agent/task-runner.js";
import { loadConfig } from "../src/config.js";
import type { AppKnowledge } from "../src/engine/planning/planner.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { saveExploration } from "../src/platform/exploration-store.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { RepoSink } from "../src/platform/repo-sink.js";
import { buildServer } from "../src/platform/server.js";
import { seedProject } from "./fixtures/dashboard-seed.js";
import { exploreShop, OBJECTIVES_WITH_DATA, scriptedShopModel, type ShopSite, type ToolCall } from "./fixtures/objectives-shop.js";

const PORT = 9897;
const KEY = "typed-secrets-owner-key-1234";
/** What the model types: each must never be served. */
const TYPED = { password: "Hunt3r!pw22", otp: "481516", pin: "7391" };

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main>${body}</main></body></html>`;
const SIGNUP = `<h1>Sign up</h1><form method="post" action="/signup" novalidate>
<label>Create password <input name="pw" type="password"></label>
<label>One-time code <input name="code" type="text" autocomplete="one-time-code"></label>
<label>PIN <input name="pin" type="text" inputmode="numeric"></label>
<label>Quantity <input name="qty" type="number" min="1" max="10"></label>
<button type="submit">Sign up</button></form>`;

let site: ShopSite;
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";

beforeAll(async () => {
    site = { server: undefined as unknown as http.Server, url: `http://127.0.0.1:${PORT}`, fixed: false, injection: false };
    site.server = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        const p = (req.url ?? "/").split("?")[0];
        if (p === "/signup" && req.method === "POST") {
            req.resume();
            return req.on("end", () => res.end(page("Sign up", "<h1>Sign up</h1><p>Welcome aboard</p>")));
        }
        if (p === "/signup") return res.end(page("Sign up", SIGNUP));
        res.end(page("Home", `<h1>Home</h1><a href="/signup">Sign up</a>`));
    });
    await new Promise<void>((r) => site.server.listen(PORT, "127.0.0.1", r));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-typed-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "typed-test-secret-key-0123456789", API_KEY: KEY, SCHEDULER_ENABLED: "false" }));
    app = await buildServer(platform);
    await app.ready();
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    site?.server.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const knowledge = (): AppKnowledge => ({
    modelVersionId: "mv-signup-1",
    rules: [],
    workflows: [],
    objectiveInputs: {
        pages: [{ id: "page-signup", path: "/signup", forms: [{ name: "signup", fields: [{ name: "qty", label: "Quantity", type: "number", min: "1", max: "10" }] }] }],
        transitions: [],
        workflowSteps: [],
    },
});

const SCRIPT: Record<string, ToolCall[]> = {
    "Invalid input": [
        { tool: "navigate", input: { url: "/signup" } },
        { tool: "fill", input: { target: { by: "label", value: "Create password" }, value: TYPED.password } },
        { tool: "fill", input: { target: { by: "label", value: "One-time code" }, value: TYPED.otp } },
        { tool: "fill", input: { target: { by: "label", value: "PIN" }, value: TYPED.pin } },
        { tool: "fill", input: { target: { by: "label", value: "Quantity" }, value: "0" } },
        { tool: "click", input: { target: { by: "role", role: "button", value: "Sign up" } } },
        { tool: "finish", input: { result: "pass", explanation: "Done" } },
    ],
};

describe("typed secrets in an exploration's action log (CP3 N-2)", () => {
    it("a password, one-time code and PIN typed through the objective stage are in neither the runner's record nor the coverage route", async () => {
        const { llm } = scriptedShopModel(() => SCRIPT);
        const { summary } = await exploreShop(site, llm, { ...OBJECTIVES_WITH_DATA, appKnowledge: knowledge() });
        const ex = summary.exploration!;
        // The fills ran and were logged against the elements they resolved to.
        const fills = ex.actionLog.filter((r) => r.result === "performed" && r.action.startsWith("fill "));
        expect(fills.map((r) => /^fill (\S+ "[^"]*")/.exec(r.action)?.[1])).toEqual(['textbox "Create password"', 'textbox "One-time code"', 'textbox "PIN"', 'spinbutton "Quantity"']);
        // No value typed is part of an action's key (row 210, N-3), the ordinary quantity's neither.
        expect(fills.some((r) => r.action.includes('"value"'))).toBe(false);

        // A runner's record, with a log that masks nothing of its own: what the engine wrote is what is sent.
        const sent = explorationForResult(ex, { redact: (t: string) => t, warn: () => undefined }, "t1").exploration;
        expect(sent).toBeDefined();
        const sentText = JSON.stringify(sent);
        for (const v of Object.values(TYPED)) expect(sentText).not.toContain(v);

        // The platform's copy, served by the coverage route.
        const s = seedProject(platform, "Sign-up shop", site.url);
        const job = await platform.repo.createJob(s.projectId, s.appId, { ...DEFAULT_JOB_OPTIONS });
        const sink = new RepoSink(platform.repo, platform.store, { id: job.id, projectId: s.projectId, applicationId: s.appId });
        await saveExploration(sink, ex);
        await sink.writes.flush();
        const res = await app.inject({ method: "GET", url: `/api/projects/${s.projectId}/jobs/${job.id}/coverage`, headers: { "x-api-key": KEY } });
        expect(res.statusCode).toBe(200);
        const served = JSON.parse(res.body) as { actionLog: Array<{ action: string }> };
        expect(served.actionLog.filter((r) => r.action.startsWith("fill ")).length).toBe(4);
        for (const v of Object.values(TYPED)) expect(res.body).not.toContain(v);
    }, 300_000);
});
