/**
 * Deploy triggers, with no browser and no worker (a started run simply stays queued): token management, hashing at rest,
 * the rate limit, the busy-project refusal, labelling, the address rules, and the API-key middleware staying unbypassable.
 * Runs that really execute and call back are in triggers-run.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { getTriggerServices } from "../src/platform/trigger-services.js";
import { isTriggerTokenRoute, redactTriggerUrl } from "../src/platform/trigger-store.js";

const API_KEY = "test-api-key-0123456789";
const FIXTURE = "http://127.0.0.1:5532";

let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let projectId: string;
let clockNow = Date.now();

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-triggers-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", API_KEY }));
    getTriggerServices(platform, { clock: () => clockNow }); // before the server, which reuses it
    server = await buildServer(platform);
    projectId = (await withKey("POST", "/api/projects", { name: "Deployed app" })).body.id;
    const imp = await withKey("POST", `/api/projects/${projectId}/specs`, {
        baseUrl: FIXTURE,
        validate: false,
        specs: [{ title: "Endpoint answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/ok" }, { action: "assertResponse", check: "status", expected: 200 }] }],
    });
    expect(imp.status, JSON.stringify(imp.body)).toBe(202);
}, 30_000);

afterAll(async () => {
    delete process.env.BLOCK_PRIVATE_TARGETS;
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

type Method = "GET" | "POST" | "DELETE";
const send = async (method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const res = await server.inject({ method, url, payload: payload as never, headers });
    return { status: res.statusCode, headers: res.headers, body: res.body && /^[{[]/.test(res.body) ? JSON.parse(res.body) : res.body };
};
/** A call made with the platform's API key (what the UI and administrators do). */
const withKey = (method: Method, url: string, payload?: unknown) => send(method, url, payload, { "x-api-key": API_KEY });
/** A call made the way a deploy pipeline does: no API key, only the token in the address. */
const asPipeline = (method: Method, url: string, payload?: unknown) => send(method, url, payload);

const makeToken = async (body: Record<string, unknown> = {}) => (await withKey("POST", `/api/projects/${projectId}/triggers`, body)).body as { id: string; token: string; label: string | null; hint: string };
/** Move the clock past the per-token rate limit and let the project's queued job count as finished. */
const settleProject = () => {
    clockNow += 60_000;
    for (const j of platform.repo.listJobs(projectId)) if (!["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) platform.repo.setJobStatus(j.id, "COMPLETED");
};

describe("token management", () => {
    it("is behind the API key, and a token is shown once", async () => {
        expect((await send("POST", `/api/projects/${projectId}/triggers`, { label: "x" })).status).toBe(401);
        expect((await send("GET", `/api/projects/${projectId}/triggers`)).status).toBe(401);

        const t = await makeToken({ label: "GitHub deploy" });
        expect(t.token).toMatch(/^aitt_[A-Za-z0-9_-]{43}$/); // 32 random bytes
        expect(t).toMatchObject({ label: "GitHub deploy", hint: t.token.slice(-4) });

        const list = await withKey("GET", `/api/projects/${projectId}/triggers`);
        expect(list.status).toBe(200);
        expect(list.body.minSecondsBetweenRuns).toBe(30);
        expect(list.body.tokens).toHaveLength(1);
        expect(list.body.tokens[0]).toMatchObject({ id: t.id, label: "GitHub deploy", revokedAt: null, allowUrl: false });
        // the token is never listed again
        expect(JSON.stringify(list.body)).not.toContain(t.token);
        expect(Object.keys(list.body.tokens[0])).not.toContain("token");
        expect(Object.keys(list.body.tokens[0])).not.toContain("tokenHash");
        expect((await withKey("POST", "/api/projects/nope/triggers", {})).status).toBe(404);
    });

    it("stores only a hash: the token cannot be found anywhere in the database files", async () => {
        const t = await makeToken({ label: "hash check" });
        platform.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const files = [platform.config.dbPath, `${platform.config.dbPath}-wal`].filter((f) => fs.existsSync(f));
        for (const f of files) expect(fs.readFileSync(f).includes(Buffer.from(t.token)), f).toBe(false);
        const row = platform.db.get<{ token_hash: string }>("SELECT token_hash FROM trigger_tokens WHERE id = ?", t.id)!;
        expect(row.token_hash).toBe(createHash("sha256").update(t.token).digest("hex"));
        expect(row.token_hash).not.toContain(t.token);
        // and the token still works (the hash is what is looked up)
        expect(getTriggerServices(platform).store.find(t.token)?.id).toBe(t.id);
        expect(getTriggerServices(platform).store.find(t.token + "x")).toBeUndefined();
        await withKey("DELETE", `/api/projects/${projectId}/triggers/${t.id}`);
    });

    it("limits the number of active tokens and lets one be revoked", async () => {
        const ids: string[] = [];
        let refused: Awaited<ReturnType<typeof withKey>> | undefined;
        for (let i = 0; i < 12 && !refused; i++) {
            const r = await withKey("POST", `/api/projects/${projectId}/triggers`, { label: `t${i}` });
            if (r.status === 201) ids.push(r.body.id);
            else refused = r;
        }
        expect(refused?.status).toBe(409);
        expect(refused?.body.error).toMatch(/Revoke one/);
        for (const id of ids) expect((await withKey("DELETE", `/api/projects/${projectId}/triggers/${id}`)).status).toBe(200);
        expect((await withKey("DELETE", `/api/projects/${projectId}/triggers/${ids[0]}`)).status).toBe(404); // already revoked
    });
});

describe("starting a run with a token", () => {
    let token: string;
    let tokenId: string;
    let firstJob: string;

    it("needs no API key, queues a re-run of the project's tests and labels it as started by a deploy", async () => {
        ({ token, id: tokenId } = await makeToken({ label: "CI" }));
        const run = await asPipeline("POST", `/api/triggers/${token}/run`, { commit: "3f2a9c1", environment: "staging" });
        expect(run.status, JSON.stringify(run.body)).toBe(202);
        expect(run.body).toMatchObject({ state: "queued", testCount: 1, commit: "3f2a9c1", environment: "staging" });
        firstJob = run.body.jobId;

        const job = (await withKey("GET", `/api/test-generation/${firstJob}`)).body;
        expect(job).toMatchObject({ mode: "validate", trigger: "deploy", deploy: { commit: "3f2a9c1", environment: "staging", label: "CI" }, status: "QUEUED" });
        expect((await withKey("GET", `/api/projects/${projectId}/jobs`)).body[0]).toMatchObject({ jobId: firstJob, trigger: "deploy" });
        // the run is not echoed back with the token
        expect(JSON.stringify(run.body)).not.toContain(token);
    });

    it("answers 429 with Retry-After while the token's slot is taken, 409 while the project is busy, then runs again", async () => {
        const tooSoon = await asPipeline("POST", `/api/triggers/${token}/run`, {});
        expect(tooSoon.status).toBe(429);
        expect(Number(tooSoon.headers["retry-after"])).toBeGreaterThan(0);
        expect(tooSoon.body.error).toMatch(/one run every 30 seconds/);

        clockNow += 31_000; // past the limit; the first run is still queued, so the project is busy
        const busy = await asPipeline("POST", `/api/triggers/${token}/run`, {});
        expect(busy.status).toBe(409);
        expect(busy.body.error).toMatch(/already running/);
        expect(platform.repo.listJobs(projectId)).toHaveLength(1); // a refused request creates nothing

        // another token on the same project is not rate-limited by the first one's slot, only by the busy project
        const other = await makeToken({ label: "second" });
        expect((await asPipeline("POST", `/api/triggers/${other.token}/run`, {})).status).toBe(409);

        settleProject();
        const again = await asPipeline("POST", `/api/triggers/${token}/run`, { commit: "next" });
        expect(again.status).toBe(202);
        expect(again.body.jobId).not.toBe(firstJob);
    });

    it("reports a queued run through the status endpoint, only for the token's own runs", async () => {
        const second = platform.repo.listJobs(projectId)[0]!;
        const s = await asPipeline("GET", `/api/triggers/${token}/status/${second.id}`);
        expect(s.status).toBe(200);
        expect(s.body).toMatchObject({ jobId: second.id, state: "queued", finished: false, passed: null, commit: "next", environment: null, failures: [] });

        // an unknown job, a job of this project that no trigger started, and another token's view of this job
        expect((await asPipeline("GET", `/api/triggers/${token}/status/00000000-0000-0000-0000-000000000000`)).status).toBe(404);
        const manual = await platform.repo.createJob(projectId, platform.repo.getLatestApplicationPublic(projectId)!.id as string, { maxPages: 1, maxDepth: 1, maxScenarios: 1, targets: ["api"], allowMutatingApiTests: false, mode: "validate", testIds: [] });
        expect((await asPipeline("GET", `/api/triggers/${token}/status/${manual.id}`)).status).toBe(404);
        const otherProject = (await withKey("POST", "/api/projects", { name: "Another app" })).body.id;
        const foreign = (await withKey("POST", `/api/projects/${otherProject}/triggers`, {})).body.token;
        expect((await asPipeline("GET", `/api/triggers/${foreign}/status/${second.id}`)).status).toBe(404);
    });

    it("refuses a project with nothing to run, and malformed input", async () => {
        const empty = (await withKey("POST", "/api/projects", { name: "Empty" })).body.id;
        const t = (await withKey("POST", `/api/projects/${empty}/triggers`, {})).body.token;
        const none = await asPipeline("POST", `/api/triggers/${t}/run`, {});
        expect(none.status).toBe(409);
        expect(none.body.error).toMatch(/no application yet/);

        settleProject();
        for (const body of [{ commit: "has spaces; rm -rf" }, { environment: "x".repeat(80) }, { callbackUrl: "not a url" }, { commit: 5 }]) {
            expect((await asPipeline("POST", `/api/triggers/${token}/run`, body)).status, JSON.stringify(body)).toBe(400);
        }
        // nothing was started by the refused requests, and they did not use up the token's slot
        const queuedBefore = platform.repo.listJobs(projectId).length;
        expect((await asPipeline("POST", `/api/triggers/${token}/run`, { commit: "ok-1" })).status).toBe(202);
        expect(platform.repo.listJobs(projectId)).toHaveLength(queuedBefore + 1);
    });

    it("ignores a different address unless the token allows it and the platform allows the address", async () => {
        settleProject();
        const before = platform.repo.getLatestApplicationPublic(projectId)!;
        const plain = await asPipeline("POST", `/api/triggers/${token}/run`, { url: "http://127.0.0.1:5539/" });
        expect(plain.status).toBe(202);
        expect(plain.body.ignored[0]).toMatch(/only run against the project's own address/);
        expect(platform.repo.getLatestApplicationPublic(projectId)!.id).toBe(before.id);
        expect(platform.repo.getJob(plain.body.jobId)!.applicationId).toBe(before.id);

        // On a platform that blocks private addresses, a token that may send addresses still cannot send a private one.
        // (A second project whose own address is public; no worker runs here, so nothing is ever requested from it.)
        const pub = (await withKey("POST", "/api/projects", { name: "Public app" })).body.id as string;
        const imp = await withKey("POST", `/api/projects/${pub}/specs`, {
            baseUrl: "http://203.0.113.10",
            validate: false,
            specs: [{ title: "Endpoint answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/ok" }, { action: "assertResponse", check: "status", expected: 200 }] }],
        });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        const previews = (await withKey("POST", `/api/projects/${pub}/triggers`, { label: "previews", allowUrl: true })).body.token as string;
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        try {
            const blocked = await asPipeline("POST", `/api/triggers/${previews}/run`, { url: "http://127.0.0.1:5539/" });
            expect(blocked.status, JSON.stringify(blocked.body)).toBe(202);
            expect(blocked.body.ignored[0]).toMatch(/private\/loopback/);
            expect(platform.repo.getApplication(platform.repo.getJob(blocked.body.jobId)!.applicationId)!.url).toMatch(/^http:\/\/203\.0\.113\.10/);
            // a callback to a private address is refused outright (nobody should wait for a result that cannot arrive)
            clockNow += 60_000;
            for (const j of platform.repo.listJobs(pub)) platform.repo.setJobStatus(j.id, "COMPLETED");
            const cb = await asPipeline("POST", `/api/triggers/${previews}/run`, { callbackUrl: "http://127.0.0.1:5533/done" });
            expect(cb.status).toBe(400);
        } finally {
            delete process.env.BLOCK_PRIVATE_TARGETS;
        }

        settleProject();
        const permitted = await makeToken({ label: "previews", allowUrl: true });
        const ok = await asPipeline("POST", `/api/triggers/${permitted.token}/run`, { url: "http://127.0.0.1:5539/" });
        expect(ok.status).toBe(202);
        expect(ok.body.ignored).toBeUndefined();
        const app = platform.repo.getApplication(platform.repo.getJob(ok.body.jobId)!.applicationId)!;
        expect(app.url).toBe("http://127.0.0.1:5539/");
    });

    it("stops working the moment the token is revoked, and answers 404 (not 401) for revoked and unknown tokens alike", async () => {
        settleProject();
        const t = await makeToken({ label: "short-lived" });
        const jobId = (await asPipeline("POST", `/api/triggers/${t.token}/run`, {})).body.jobId as string;
        expect((await asPipeline("GET", `/api/triggers/${t.token}/status/${jobId}`)).status).toBe(200);
        expect((await withKey("DELETE", `/api/projects/${projectId}/triggers/${t.id}`)).status).toBe(200);
        settleProject();
        const revoked = await asPipeline("POST", `/api/triggers/${t.token}/run`, {});
        const unknown = await asPipeline("POST", `/api/triggers/aitt_${"A".repeat(43)}/run`, {});
        expect(revoked.status).toBe(404);
        expect(unknown.status).toBe(404);
        expect(revoked.body).toEqual(unknown.body);
        expect((await asPipeline("GET", `/api/triggers/${t.token}/status/${jobId}`)).status).toBe(404);
        expect(tokenId).toBeTruthy();
    });
});

describe("the API key stays in force", () => {
    let token: string;
    beforeAll(async () => {
        token = (await makeToken({ label: "probe" })).token;
    });

    it("lets exactly the two trigger routes through without a key", () => {
        const T = "aitt_" + "x".repeat(43);
        expect(isTriggerTokenRoute("POST", `/api/triggers/${T}/run`)).toBe(true);
        expect(isTriggerTokenRoute("GET", `/api/triggers/${T}/status/0f9d6a0e-1b2c-4d3e-8f90-a1b2c3d4e5f6`)).toBe(true);
        for (const [m, p] of [
            ["GET", `/api/triggers/${T}/run`], ["POST", `/api/triggers/${T}/status/abc`], ["POST", `/api/triggers/${T}/run/`], ["POST", `/api/triggers/${T}/runs`],
            ["POST", `/api/triggers/../projects/run`], ["POST", `/api/triggers/${T}/../projects`], ["GET", `/api/triggers/${T}/status/../../projects`],
            ["POST", `/API/triggers/${T}/run`], ["POST", `/api/Triggers/${T}/run`], ["POST", `/api//triggers/${T}/run`], ["POST", `/api/triggers/short/run`],
            ["POST", `/api/triggers/${T}/run?x=/api/health`], ["DELETE", `/api/triggers/${T}/run`], ["HEAD", `/api/triggers/${T}/status/abc`],
            ["GET", "/api/projects"], ["GET", "/api/triggers"], ["POST", `/api/projects/p/triggers`],
        ] as const) {
            expect(isTriggerTokenRoute(m, p), `${m} ${p}`).toBe(false);
        }
    });

    it("answers 401 to path tricks and to every other route, even with a real token", async () => {
        const T = token;
        const noKey = async (method: Method, url: string, headers: Record<string, string> = {}) => (await send(method, url, undefined, headers)).status;
        expect(await noKey("GET", "/api/projects")).toBe(401);
        for (const url of [
            "/api/triggers/%2e%2e/projects", "/api/triggers/%2E%2E%2Fprojects", `/api/triggers/${T}/status/..%2F..%2Fprojects`, `/api/triggers/${T}/run%2F..%2F..%2Fprojects`,
            "/api/%70rojects", "/%61pi/projects", "/api//projects", `/api/triggers/${T}/run/`, `/api/triggers/${T}/run%2f`, "/api/triggers",
            `/api/projects/${projectId}/triggers`, `/api/projects/${projectId}`, "/api/config",
        ]) {
            expect(await noKey("GET", url), `GET ${url}`).toBe(401);
        }
        expect(await noKey("POST", `/api/triggers/${T}/run/`)).toBe(401);
        expect(await noKey("GET", `/api/triggers/${T}/run`)).toBe(401); // wrong method for the exemption
        expect(await noKey("POST", `/api/triggers/${T}/status/abc`)).toBe(401);
        expect(await noKey("DELETE", `/api/projects/${projectId}/triggers/whatever`)).toBe(401);
        // the token is not an API key, in a header or in the query string
        expect(await noKey("GET", "/api/projects", { "x-api-key": token })).toBe(401);
        expect(await noKey("GET", `/api/projects?key=${token}`)).toBe(401);
        expect(await noKey("GET", `/api/artifacts/x?key=${token}`)).toBe(401);
        // wrong case is simply not a route (and never reaches a handler)
        const upper = await send("GET", "/API/projects");
        expect(upper.status === 404 || (upper.status === 200 && /^<!doctype html/i.test(String(upper.body)))).toBe(true); // not a route; at most the UI's page
        expect(String(upper.body)).not.toContain("Deployed app");
        // the health check stays public, and the key still opens everything
        expect(await noKey("GET", "/api/health")).toBe(200);
        expect((await withKey("GET", "/api/projects")).status).toBe(200);
    });

    it("keeps the token out of request logs", () => {
        expect(redactTriggerUrl("/api/triggers/aitt_abcdefabcdefabcdef/run")).toBe("/api/triggers/[token]/run");
        expect(redactTriggerUrl("/api/triggers/aitt_abcdefabcdefabcdef/status/123?x=1")).toBe("/api/triggers/[token]/status/123?x=1");
        expect(redactTriggerUrl("/api/projects/abc")).toBe("/api/projects/abc");
    });
});
