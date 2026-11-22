/**
 * GitHub's signed webhook and the pull request feedback (Phase 6, G2; G8's security criteria). Everything runs in-process against a
 * local fake GitHub (tests/fixtures/fake-github.ts); no request goes to github.com and every token and secret here is made up.
 * Covers: a missing, forged or replayed-onto-another-body signature is refused (401) and leaves no row; another project's address
 * refuses a delivery signed with this project's secret; a delivery for another repository is refused; the same delivery twice acts
 * once; the per-project rate limit; forks are ignored; opened/synchronize queue an impact analysis and a successful deployment a
 * re-verification; the address skips the API key and only it (anchored); its token never reaches a log; feedback stays off until the
 * project's switch is on, then writes one sticky comment and a check (a commit status when check runs are refused).
 */
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CiReport } from "../src/cli/model.js";
import { COMMENT_MARKER } from "../src/cli/render.js";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { postPrFeedback } from "../src/platform/code-host/feedback.js";
import { CodeHostStore } from "../src/platform/code-host/store.js";
import { signatureOk, WEBHOOK_LIMIT_PER_MINUTE } from "../src/platform/code-host/webhook.js";
import { SecretBox } from "../src/platform/secrets.js";
import { buildServer } from "../src/platform/server.js";
import { isTriggerTokenRoute, redactTriggerUrl } from "../src/platform/trigger-store.js";
import { startFakeGithub } from "./fixtures/fake-github.js";

const KEY = "code-host-webhook-test-key-7a2e";
const TOKEN = "github_pat_11FAKE0WEBHOOK0TEST0TOKEN0abcdef0123456789";
const SECRET_A = "whsec-FAKE-project-a-0123456789";
const SECRET_B = "whsec-FAKE-project-b-9876543210";
const HEAD = "1111111111111111111111111111111111111111";

type Fake = Awaited<ReturnType<typeof startFakeGithub>>;
const ghOpts: Parameters<typeof startFakeGithub>[0] = { token: TOKEN, checkRuns: "ok" };
let gh: Fake;
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let store: CodeHostStore;
let dataDir: string;
const hooks: Record<string, string> = {};
const ids: Record<string, string> = {};
const answers: string[] = [];
const envBefore = process.env.CODE_HOST_GITHUB_API_URL;

beforeAll(async () => {
    gh = await startFakeGithub(ghOpts);
    process.env.CODE_HOST_GITHUB_API_URL = gh.url;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-codehook-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SCHEDULER_ENABLED: "false", API_KEY: KEY }));
    app = await buildServer(platform);
    await app.ready();
    store = new CodeHostStore(platform.db, new SecretBox(platform.config.dataDir, platform.config.SECRET_KEY));
    for (const [name, secret] of [["A", SECRET_A], ["B", SECRET_B], ["C", SECRET_A]] as const) {
        ids[name] = platform.repo.createProject({ name }).id as string;
        const r = await app.inject({ method: "PUT", url: `/api/projects/${ids[name]}/code-host`, headers: { "x-api-key": KEY }, payload: { owner: "acme", repo: "shop", token: TOKEN, webhookSecret: secret, apiUrl: gh.url } });
        answers.push(r.body);
        expect(r.statusCode).toBe(201);
        hooks[name] = r.json().webhookUrl;
    }
}, 60_000);

afterAll(async () => {
    if (envBefore === undefined) delete process.env.CODE_HOST_GITHUB_API_URL;
    else process.env.CODE_HOST_GITHUB_API_URL = envBefore;
    await app?.close();
    platform?.db.close();
    await gh?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const prBody = (action: string, o: { head?: string | null; n?: number; repo?: string } = {}) => ({
    action,
    number: o.n ?? 7,
    pull_request: { number: o.n ?? 7, head: { sha: HEAD, repo: o.head === null ? null : { full_name: o.head ?? "acme/shop" } }, base: { repo: { full_name: "acme/shop" } }, body: "PR-BODY-SENTINEL" },
    repository: { full_name: o.repo ?? "acme/Shop" },
});
let deliveries = 0;
async function deliver(hook: string, event: string, payload: unknown, o: { secret?: string | null; delivery?: string; sig?: string } = {}) {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { "content-type": "application/json", "x-github-event": event, "x-github-delivery": o.delivery ?? `d-${++deliveries}` };
    const sig = o.sig ?? (o.secret === null ? undefined : sign(o.secret ?? SECRET_A, body));
    if (sig) headers["x-hub-signature-256"] = sig;
    const r = await app.inject({ method: "POST", url: hook, headers, payload: body });
    answers.push(r.body);
    return { status: r.statusCode, body: r.body ? r.json() : undefined };
}
const events = (project: string) => platform.db.all("SELECT delivery_id, event, action, pr, head_sha, environment, queued, ignored FROM pr_events WHERE project_id = ? ORDER BY received_at, delivery_id", ids[project]);

describe("the webhook address", () => {
    it("is shown once, by the save that made it, and never again", async () => {
        expect(hooks.A).toMatch(/^\/api\/code-host\/github\/aith_[A-Za-z0-9_-]{43}$/);
        const again = await app.inject({ method: "PUT", url: `/api/projects/${ids.A}/code-host`, headers: { "x-api-key": KEY }, payload: { owner: "acme", repo: "shop", apiUrl: gh.url, verify: false } });
        expect(again.statusCode).toBe(200);
        expect(again.json()).not.toHaveProperty("webhookUrl");
        expect(again.json().connection).toMatchObject({ webhookUrlSet: true, feedback: false });
        const token = hooks.A!.split("/").pop()!;
        const got = await app.inject({ method: "GET", url: `/api/projects/${ids.A}/code-host`, headers: { "x-api-key": KEY } });
        expect(got.body).not.toContain(token);
        expect(JSON.stringify(platform.db.all("SELECT * FROM code_repos"))).not.toContain(token);
    });

    it("is the only code-host address that skips the API key, matched exactly", () => {
        const token = hooks.A!.split("/").pop()!;
        expect(isTriggerTokenRoute("POST", `/api/code-host/github/${token}`)).toBe(true);
        expect(isTriggerTokenRoute("GET", `/api/code-host/github/${token}`)).toBe(false);
        expect(isTriggerTokenRoute("POST", `/api/code-host/github/${token}/`)).toBe(false);
        expect(isTriggerTokenRoute("POST", `/api/code-host/github/${token}/x`)).toBe(false);
        expect(isTriggerTokenRoute("POST", `/api/code-host/gitlab/${token}`)).toBe(false);
        expect(isTriggerTokenRoute("POST", `/api/projects/${ids.A}/code-host`)).toBe(false);
        expect(redactTriggerUrl(`/api/code-host/github/${token}?x=1`)).toBe("/api/code-host/github/[token]?x=1");
    });

    it("answers an unknown token 404, with no API key needed to get that far", async () => {
        expect((await deliver(`/api/code-host/github/aith_${"x".repeat(43)}`, "ping", { repository: { full_name: "acme/shop" } })).status).toBe(404);
    });
});

describe("signatures (G8)", () => {
    it("checks the HMAC of the exact body in constant time", () => {
        expect(signatureOk(SECRET_A, Buffer.from("{}"), sign(SECRET_A, "{}"))).toBe(true);
        expect(signatureOk(SECRET_A, Buffer.from("{} "), sign(SECRET_A, "{}"))).toBe(false);
        expect(signatureOk(SECRET_A, Buffer.from("{}"), sign(SECRET_B, "{}"))).toBe(false);
        expect(signatureOk(SECRET_A, Buffer.from("{}"), sign(SECRET_A, "{}").replace("sha256=", "sha1="))).toBe(false);
        expect(signatureOk(SECRET_A, Buffer.from("{}"), sign(SECRET_A, "{}").slice(0, -2))).toBe(false);
        expect(signatureOk(undefined, Buffer.from("{}"), sign("", "{}"))).toBe(false);
    });

    it("refuses a missing, forged or moved signature and keeps nothing", async () => {
        const body = prBody("opened");
        expect((await deliver(hooks.A!, "pull_request", body, { secret: null })).status).toBe(401);
        expect((await deliver(hooks.A!, "pull_request", body, { secret: "whsec-FAKE-guessed-secret-000" })).status).toBe(401);
        expect((await deliver(hooks.A!, "pull_request", body, { sig: sign(SECRET_A, JSON.stringify(prBody("closed"))) })).status).toBe(401);
        expect((await deliver(hooks.A!, "pull_request", body, { sig: "sha256=zz" })).status).toBe(401);
        expect(events("A")).toEqual([]);
    });

    it("refuses on another project's address a delivery signed with this project's secret", async () => {
        const r = await deliver(hooks.B!, "pull_request", prBody("opened"), { secret: SECRET_A });
        expect(r.status).toBe(401);
        expect(events("B")).toEqual([]);
    });

    it("refuses a correctly signed delivery for another repository", async () => {
        const r = await deliver(hooks.A!, "pull_request", prBody("opened", { repo: "acme/other" }));
        expect(r.status).toBe(400);
        expect(events("A")).toEqual([]);
    });
});

describe("what a delivery queues", () => {
    it("queues an impact analysis for an opened pull request, and the same delivery again acts once", async () => {
        const first = await deliver(hooks.A!, "pull_request", prBody("opened"), { delivery: "11111111-aaaa-bbbb-cccc-000000000001" });
        expect(first).toEqual({ status: 202, body: { queued: "impact" } });
        const again = await deliver(hooks.A!, "pull_request", prBody("opened"), { delivery: "11111111-aaaa-bbbb-cccc-000000000001" });
        expect(again).toEqual({ status: 200, body: { duplicate: true } });
        expect(events("A")).toEqual([{ delivery_id: "11111111-aaaa-bbbb-cccc-000000000001", event: "pull_request", action: "opened", pr: 7, head_sha: HEAD, environment: null, queued: "impact", ignored: null }]);
    });

    it("queues one for synchronize; ignores a closed one and one from a fork or a deleted fork", async () => {
        expect((await deliver(hooks.A!, "pull_request", prBody("synchronize", { n: 8 }))).body).toEqual({ queued: "impact" });
        expect((await deliver(hooks.A!, "pull_request", prBody("closed", { n: 8 }))).body).toEqual({ ignored: "pull request closed: nothing to analyse" });
        const fork = await deliver(hooks.A!, "pull_request", prBody("opened", { n: 9, head: "someone/shop" }));
        expect(fork).toEqual({ status: 200, body: { ignored: "from a fork: its code is not run with this project's secrets" } });
        expect((await deliver(hooks.A!, "pull_request", prBody("synchronize", { n: 10, head: null }))).body).toMatchObject({ ignored: expect.stringContaining("fork") });
        expect(events("A").map((e: any) => [e.pr, e.action, e.queued])).toEqual([
            [7, "opened", "impact"],
            [8, "synchronize", "impact"],
            [8, "closed", null],
            [9, "opened", null],
            [10, "synchronize", null],
        ]);
    });

    it("queues a re-verification for a successful deployment only", async () => {
        const dep = (state: string) => ({ deployment_status: { state }, deployment: { sha: HEAD, environment: "staging" }, repository: { full_name: "acme/shop" } });
        expect((await deliver(hooks.B!, "deployment_status", dep("success"), { secret: SECRET_B })).status).toBe(202);
        expect((await deliver(hooks.B!, "deployment_status", dep("failure"), { secret: SECRET_B })).status).toBe(200);
        expect((await deliver(hooks.B!, "ping", { zen: "x", repository: { full_name: "acme/shop" } }, { secret: SECRET_B })).body).toEqual({ ignored: "ping" });
        expect(events("B").map((e: any) => [e.event, e.action, e.head_sha, e.environment, e.queued])).toEqual([
            ["deployment_status", "success", HEAD, "staging", "reverify"],
            ["deployment_status", "failure", HEAD, "staging", null],
            ["ping", null, null, null, null],
        ]);
    });

    it(`takes at most ${WEBHOOK_LIMIT_PER_MINUTE} deliveries a minute for a project, and keeps none past it`, async () => {
        for (let i = 0; i < WEBHOOK_LIMIT_PER_MINUTE; i++) expect((await deliver(hooks.C!, "ping", { repository: { full_name: "acme/shop" } })).status).toBe(200);
        const over = await deliver(hooks.C!, "pull_request", prBody("opened"));
        expect(over.status).toBe(429);
        expect(events("C")).toHaveLength(WEBHOOK_LIMIT_PER_MINUTE);
        // Another project is not held back by it.
        expect((await deliver(hooks.B!, "ping", { repository: { full_name: "acme/shop" } }, { secret: SECRET_B })).status).toBe(200);
    });
});

const report = (passed: boolean): CiReport => ({
    schemaVersion: 1,
    tool: { name: "ai-test", version: "0.0.0" },
    generatedAt: "2026-11-21T10:00:00.000Z",
    mode: "remote-rerun",
    target: "https://shop.example",
    project: { name: "A" },
    durationMs: 1200,
    summary: { total: 3, passed: passed ? 3 : 2, findings: passed ? 0 : 1, failedValidation: 0, notRun: 0, bySeverity: { critical: 0, high: passed ? 0 : 1, medium: 0, low: 0 } as CiReport["summary"]["bySeverity"] },
    gate: { failOn: "high", failOnFailedValidation: false, passed, reasons: passed ? [] : ["1 high finding"], exitCode: passed ? 0 : 1 },
    tests: [],
});

describe("pull request feedback", () => {
    it("posts nothing while the project's switch is off", async () => {
        const before = gh.requests.length;
        expect(await postPrFeedback(store, ids.A!, { pr: 7, headSha: HEAD, report: report(true) })).toEqual({ skipped: "Pull request feedback is off for this project." });
        expect(gh.requests.length).toBe(before);
    });

    it("with the switch on, keeps one sticky comment and posts a check run on the head commit", async () => {
        const on = await app.inject({ method: "PUT", url: `/api/projects/${ids.A}/code-host`, headers: { "x-api-key": KEY }, payload: { owner: "acme", repo: "shop", apiUrl: gh.url, feedback: true, verify: false } });
        expect(on.json().connection.feedback).toBe(true);
        const first = await postPrFeedback(store, ids.A!, { pr: 7, headSha: HEAD, report: report(false) });
        expect(first).toMatchObject({ comment: { posted: "created" }, check: { posted: "check_run" } });
        const second = await postPrFeedback(store, ids.A!, { pr: 7, headSha: HEAD, report: report(true) });
        expect(second).toMatchObject({ comment: { posted: "updated" }, check: { posted: "check_run" } });
        const comments = gh.comments.get(7)!;
        expect(comments).toHaveLength(1);
        expect(comments[0]!.body).toContain(COMMENT_MARKER);
        expect(comments[0]!.body).toContain("passed");
        const checks = gh.requests.filter((r) => r.url === "/repos/acme/shop/check-runs");
        expect(checks.map((c) => [c.body.head_sha, c.body.conclusion, c.authorization])).toEqual([
            [HEAD, "failure", `Bearer ${TOKEN}`],
            [HEAD, "success", `Bearer ${TOKEN}`],
        ]);
    });

    it("falls back to a commit status when GitHub refuses the check run to a personal access token", async () => {
        ghOpts.checkRuns = "forbidden";
        try {
            expect(await postPrFeedback(store, ids.A!, { pr: 7, headSha: HEAD, report: report(false) })).toMatchObject({ check: { posted: "status" } });
        } finally {
            ghOpts.checkRuns = "ok";
        }
        const status = gh.requests.filter((r) => r.url === `/repos/acme/shop/statuses/${HEAD}`);
        expect(status.map((s) => [s.body.state, s.body.context])).toEqual([["failure", "AI Studio"]]);
    });

    it("refuses a head commit that is not a commit id before sending anything", async () => {
        const before = gh.requests.length;
        expect(await postPrFeedback(store, ids.A!, { pr: 7, headSha: "../../x", report: report(true) })).toHaveProperty("skipped");
        expect(gh.requests.length).toBe(before);
    });
});

describe("secrets (G8)", () => {
    it("no answer held the GitHub token or a webhook secret", () => {
        expect(answers.length).toBeGreaterThan(40);
        for (const s of [TOKEN, SECRET_A, SECRET_B]) expect(answers.filter((a) => a.includes(s))).toEqual([]);
    });
});
