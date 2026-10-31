/**
 * Git import through the platform's HTTP API with the real stores: custom tests with provenance and versions, validation of the
 * imported scripts by the real runner (API-only scripts, no browser window), refresh/check/delete, isolation, the run policy and
 * the token. Repositories are built in temp folders; the only server is a local fixture.
 * Run under the browser lock: it starts the real script runner.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CustomScriptStore } from "../src/platform/custom-script-store.js";
import { setGitImportSeam } from "../src/platform/routes/git-import.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { TestRepo, makeTempRoot, specFile } from "./fixtures/git-fixture.js";

const API_KEY = "test-api-key-gitimport-01";
const FIXTURE_PORT = 6092;
const AUTH_PORT = 6093;
const FIXTURE = `http://127.0.0.1:${FIXTURE_PORT}`;
const TOKEN = "GITIMPORT-API-Sentinel-7d41c0";
const FINAL = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];

let dataDir: string;
let tmp: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let fixture: http.Server;
let repo: TestRepo;
let c1: string;
let c2: string;
let custom: CustomScriptStore;
let off: { platform: Platform; server: Awaited<ReturnType<typeof buildServer>>; dir: string };

/** An API-only script: it uses the request fixture, so the real runner needs no browser window for it. */
const apiScript = (title: string, route: string, status = 200) =>
    `import { test, expect } from "@playwright/test";\ntest("${title}", async ({ request }) => {\n  const res = await request.get(process.env.BASE_URL + "${route}");\n  expect(res.status()).toBe(${status});\n});\n`;

const callOn = async (srv: typeof server, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, key = true) => {
    const res = await srv.inject({ method, url, payload: payload as never, headers: key ? { "x-api-key": API_KEY } : {} });
    return { status: res.statusCode, body: res.body && /^[{[]/.test(res.body) ? JSON.parse(res.body) : res.body } as { status: number; body: any };
};
const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, key = true) => callOn(server, method, url, payload, key);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function jobDone(jobId: string, timeoutMs = 120_000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const job = (await call("GET", `/api/test-generation/${jobId}`)).body;
        if (FINAL.includes(job.status)) return job;
        if (Date.now() > until) throw new Error(`job ${jobId} did not finish`);
        await sleep(250);
    }
}

/** A project with an application (so a validation job has something to run against). */
async function newProject(srv: typeof server, name: string): Promise<string> {
    const id = (await callOn(srv, "POST", "/api/projects", { name })).body.id;
    const seed = await callOn(srv, "POST", `/api/projects/${id}/specs`, {
        baseUrl: FIXTURE,
        validate: false,
        specs: [{ title: "Seed endpoint", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/ok" }, { action: "assertResponse", check: "status", expected: 200 }] }],
    });
    expect(seed.status, JSON.stringify(seed.body)).toBeLessThan(300);
    return id;
}

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    tmp = makeTempRoot("gitimport-api-");
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-gitimp-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", API_KEY, CONCURRENCY: "1", ALLOW_CUSTOM_SCRIPTS: "true" }));
    server = await buildServer(platform);
    worker = new Worker(platform as never, 100);
    worker.start();
    custom = new CustomScriptStore(platform.db);
    setGitImportSeam(platform, { allowLocal: true, scratchRoot: path.join(tmp, "scratch") });

    // the same platform with custom scripts off (the default): imports work, validation does not start
    const offDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-gitimp-off-"));
    const offPlatform = bootstrap(loadConfig({ DATA_DIR: offDir, SECRET_KEY: "test-secret-key-0123456789", API_KEY }));
    setGitImportSeam(offPlatform, { allowLocal: true, scratchRoot: path.join(tmp, "scratch-off") });
    off = { platform: offPlatform, server: await buildServer(offPlatform), dir: offDir };

    fixture = http.createServer((req, res) => {
        if (req.url === "/api/ok") return (res.writeHead(200, { "content-type": "application/json" }), res.end('{"ok":true}'));
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"error":"not found"}');
    });
    await new Promise<void>((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r));

    repo = new TestRepo(path.join(tmp, "repo"));
    repo.write("e2e/health.spec.ts", apiScript("Health answers", "/api/ok"));
    repo.write("e2e/danger.spec.ts", specFile("Danger", "", `import { execSync } from "child_process";`));
    repo.write("e2e/needs-helper.spec.ts", specFile("Needs helper", "", `import { go } from "./helpers/nav";`));
    c1 = repo.commit("first");
    repo.write("e2e/health.spec.ts", apiScript("Health answers", "/api/ok", 200).replace("toBe(200)", "toBeLessThan(300)"));
    repo.write("e2e/second.spec.ts", apiScript("Second one", "/api/ok"));
    c2 = repo.commit("second");
}, 60_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    await off?.server.close();
    fixture?.close();
    platform?.db.close();
    off?.platform.db.close();
    repo?.destroy();
    for (const d of [dataDir, tmp, off?.dir]) if (d) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

let projectId: string;
let gid: string;
let healthId: string;

describe("the API", () => {
    it("is protected by the API key", async () => {
        projectId = await newProject(server, "Git import project");
        for (const [m, u] of [
            ["POST", `/api/projects/${projectId}/git-imports`],
            ["GET", `/api/projects/${projectId}/git-imports`],
            ["POST", `/api/projects/${projectId}/git-imports/x/check`],
            ["POST", `/api/projects/${projectId}/git-imports/x/refresh`],
            ["DELETE", `/api/projects/${projectId}/git-imports/x`],
        ] as const) expect((await call(m, u, { url: repo.url }, false)).status, `${m} ${u}`).toBe(401);
    });

    it("refuses bad input in plain words, before any download", async () => {
        const post = (body: Record<string, unknown>) => call("POST", `/api/projects/${projectId}/git-imports`, body);
        expect((await post({ url: "ssh://git@github.com/a/b.git" })).body.error).toMatch(/SSH/);
        expect((await post({ url: "git://github.com/a/b.git" })).status).toBe(400);
        expect((await post({ url: "https://u:p@github.com/a/b" })).body.error).toMatch(/user name and password/);
        expect((await post({ url: repo.url, path: "../../x" })).status).toBe(400);
        expect((await post({ url: repo.url, ref: "--upload-pack=x" })).status).toBe(400);
        expect((await post({})).status).toBe(400);
        expect((await call("POST", `/api/projects/nope/git-imports`, { url: repo.url })).status).toBe(404);
    });

    it("previews without touching the database", async () => {
        const before = (await call("GET", `/api/projects/${projectId}/tests`)).body.length;
        const r = await call("POST", `/api/projects/${projectId}/git-imports`, { url: repo.url, ref: "main", path: "e2e", dryRun: true });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.commit).toBe(c2);
        const by = Object.fromEntries(r.body.files.map((f: any) => [f.path, f]));
        expect(by["e2e/health.spec.ts"]).toMatchObject({ title: "Health answers", tests: 1, problems: [] });
        expect(by["e2e/danger.spec.ts"].problems.join(" ")).toMatch(/child_process/);
        expect(by["e2e/needs-helper.spec.ts"].problems.join(" ")).toMatch(/helper named nav that doesn't exist yet/);
        expect((await call("GET", `/api/projects/${projectId}/tests`)).body.length).toBe(before);
        expect((await call("GET", `/api/projects/${projectId}/git-imports`)).body).toEqual([]);
        expect(fs.readdirSync(path.join(tmp, "scratch")).filter((n) => n.startsWith("run-"))).toEqual([]);
    });

    it("imports the first commit as custom tests with provenance and a git version, then validates them", async () => {
        const r = await call("POST", `/api/projects/${projectId}/git-imports`, { url: repo.url, ref: c1, path: "e2e" });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body.commit).toBe(c1);
        expect(r.body.imported.map((i: any) => i.path)).toEqual(["e2e/health.spec.ts"]);
        expect(r.body.imported[0].created).toBe(true);
        const reasons = Object.fromEntries(r.body.skipped.map((s: any) => [s.path, s.reason]));
        expect(reasons["e2e/danger.spec.ts"]).toMatch(/child_process/);
        expect(reasons["e2e/needs-helper.spec.ts"]).toMatch(/nav/);
        healthId = r.body.imported[0].testId;
        expect(typeof r.body.jobId).toBe("string");

        const state = custom.get(healthId)!;
        expect(state.origin).toBe("git");
        expect(state.git).toMatchObject({ host: "local", commit: c1, file: "e2e/health.spec.ts" });
        const versions = custom.listVersions(healthId);
        expect(versions).toHaveLength(1);
        expect(versions[0]).toMatchObject({ kind: "git" });
        // blocked files never became tests
        const titles = (await call("GET", `/api/projects/${projectId}/tests`)).body.map((t: any) => t.title);
        expect(titles).not.toContain("Danger");
        expect(titles).toContain("Health answers");

        const list = (await call("GET", `/api/projects/${projectId}/git-imports`)).body;
        expect(list).toHaveLength(1);
        gid = list[0].id;
        expect(list[0]).toMatchObject({ host: "local", ref: c1, commit: c1, tests: 1 });

        const job = await jobDone(r.body.jobId);
        expect(job.status, JSON.stringify(job)).toBe("COMPLETED");
        const test = (await call("GET", `/api/projects/${projectId}/tests`)).body.find((t: any) => t.id === healthId);
        expect(test.validationStatus).toBe("VALIDATED");
    }, 180_000);

    it("importing the same thing again changes nothing", async () => {
        const r = await call("POST", `/api/projects/${projectId}/git-imports`, { url: repo.url, ref: c1, path: "e2e" });
        expect(r.status).toBe(201);
        expect(r.body.imported).toEqual([{ testId: healthId, path: "e2e/health.spec.ts", created: false, changed: false }]);
        expect(r.body.jobId).toBeNull();
        expect(custom.listVersions(healthId)).toHaveLength(1);
        expect((await call("GET", `/api/projects/${projectId}/git-imports`)).body).toHaveLength(1);
    });

    it("is isolated per project", async () => {
        const other = await newProject(server, "Another project");
        expect((await call("GET", `/api/projects/${other}/git-imports`)).body).toEqual([]);
        expect((await call("POST", `/api/projects/${other}/git-imports/${gid}/check`)).status).toBe(404);
        expect((await call("POST", `/api/projects/${other}/git-imports/${gid}/refresh`, {})).status).toBe(404);
        expect((await call("DELETE", `/api/projects/${other}/git-imports/${gid}`)).status).toBe(404);
        expect((await call("GET", `/api/projects/${projectId}/git-imports`)).body).toHaveLength(1);
    });

    it("check lists what changed upstream; refresh adds a version and the new file", async () => {
        // move the branch the link follows: the link was made with a commit id, so make a branch link
        const r0 = await call("POST", `/api/projects/${projectId}/git-imports`, { url: repo.url, ref: "main", path: "e2e" });
        expect(r0.status, JSON.stringify(r0.body)).toBe(201);
        // main is already at the second commit; build the situation with a branch at the first commit instead
        repo.git("branch", "-f", "follow", c1);
        const r1 = await call("POST", `/api/projects/${projectId}/git-imports`, { url: repo.url, ref: "follow", path: "e2e" });
        expect(r1.status, JSON.stringify(r1.body)).toBe(201);
        expect(r1.body.commit).toBe(c1);
        const link = (await call("GET", `/api/projects/${projectId}/git-imports`)).body.find((l: any) => l.ref === "follow");
        const quiet = await call("POST", `/api/projects/${projectId}/git-imports/${link.id}/check`);
        expect(quiet.body).toMatchObject({ upToDate: true, changed: [] });

        repo.git("branch", "-f", "follow", c2);
        const chk = await call("POST", `/api/projects/${projectId}/git-imports/${link.id}/check`);
        expect(chk.status, JSON.stringify(chk.body)).toBe(200);
        expect(chk.body.upToDate).toBe(false);
        expect(chk.body.newCommit).toBe(c2);
        expect(chk.body.changed.map((c: any) => c.path)).toEqual(["e2e/health.spec.ts"]);
        expect(chk.body.changed[0].testId).toBeTruthy();

        const versionsBefore = custom.listVersions(chk.body.changed[0].testId).length;
        const ref = await call("POST", `/api/projects/${projectId}/git-imports/${link.id}/refresh`, {});
        expect(ref.status, JSON.stringify(ref.body)).toBe(201);
        const by = Object.fromEntries(ref.body.imported.map((i: any) => [i.path, i]));
        expect(by["e2e/second.spec.ts"].created).toBe(true);
        expect(by["e2e/health.spec.ts"]).toMatchObject({ created: false, changed: true });
        expect(custom.listVersions(by["e2e/health.spec.ts"].testId)).toHaveLength(versionsBefore + 1);
        expect(custom.get(by["e2e/health.spec.ts"].testId)!.git!.commit).toBe(c2);
        expect((await call("GET", `/api/projects/${projectId}/git-imports`)).body.find((l: any) => l.id === link.id)).toMatchObject({ commit: c2, tests: 2 });
        if (ref.body.jobId) expect((await jobDone(ref.body.jobId)).status).toBe("COMPLETED");
        gid = link.id;
    }, 240_000);

    it("deleting the link keeps the tests, and importing again picks them up instead of duplicating", async () => {
        const before = (await call("GET", `/api/projects/${projectId}/tests`)).body.length;
        const del = await call("DELETE", `/api/projects/${projectId}/git-imports/${gid}`);
        expect(del.status).toBe(204);
        expect((await call("GET", `/api/projects/${projectId}/git-imports`)).body.find((l: any) => l.id === gid)).toBeUndefined();
        expect((await call("GET", `/api/projects/${projectId}/tests`)).body.length).toBe(before);
        const again = await call("POST", `/api/projects/${projectId}/git-imports`, { url: repo.url, ref: "follow", path: "e2e" });
        expect(again.status).toBe(201);
        expect(again.body.imported.every((i: any) => i.created === false)).toBe(true);
        expect((await call("GET", `/api/projects/${projectId}/tests`)).body.length).toBe(before);
    }, 120_000);

    it("allows one import at a time per project", async () => {
        const [a, b] = await Promise.all([
            call("POST", `/api/projects/${projectId}/git-imports`, { url: repo.url, path: "e2e", dryRun: true }),
            call("POST", `/api/projects/${projectId}/git-imports`, { url: repo.url, path: "e2e", dryRun: true }),
        ]);
        expect([a.status, b.status].sort()).toEqual([200, 409]);
        expect([a.body, b.body].find((x) => x.error)!.error).toMatch(/already running/);
    });

    it("says plainly when git is missing", async () => {
        setGitImportSeam(platform, { allowLocal: true, scratchRoot: path.join(tmp, "scratch"), git: { file: path.join(tmp, "no-git-here") } });
        const r = await call("POST", `/api/projects/${projectId}/git-imports`, { url: repo.url, dryRun: true });
        expect(r.status).toBe(422);
        expect(r.body.error).toMatch(/Git isn't installed on the computer that runs the platform/);
        setGitImportSeam(platform, { allowLocal: true, scratchRoot: path.join(tmp, "scratch") });
    });

    it("never lets the private-address guard be skipped for a real https address", async () => {
        const prev = process.env.BLOCK_PRIVATE_TARGETS;
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        try {
            const r = await call("POST", `/api/projects/${projectId}/git-imports`, { url: "https://127.0.0.1/acme/tests", dryRun: true });
            expect(r.status).toBe(400);
            expect(r.body.error).toMatch(/private|loopback/);
        } finally {
            if (prev === undefined) delete process.env.BLOCK_PRIVATE_TARGETS;
            else process.env.BLOCK_PRIVATE_TARGETS = prev;
        }
    });
});

describe("the run policy", () => {
    it("stores the tests but starts no job while hand-written scripts may not run here", async () => {
        const pid = await newProject(off.server, "Off project");
        const r = await callOn(off.server, "POST", `/api/projects/${pid}/git-imports`, { url: repo.url, ref: "main", path: "e2e" });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body.imported.length).toBeGreaterThan(0);
        expect(r.body.jobId).toBeNull();
        expect(r.body.note).toMatch(/--allow-custom-scripts|ALLOW_CUSTOM_SCRIPTS/);
        const tests = (await callOn(off.server, "GET", `/api/projects/${pid}/tests`)).body.filter((t: any) => t.title === "Health answers");
        expect(tests[0].validationStatus).toBe("PENDING");
    }, 60_000);
});

describe("the access token", () => {
    it("is used for one download and appears nowhere afterwards", async () => {
        const seen: Array<string | undefined> = [];
        const server401 = http.createServer((req, res) => (seen.push(req.headers.authorization), res.writeHead(401), res.end("no")));
        await new Promise<void>((r) => server401.listen(AUTH_PORT, "127.0.0.1", r));
        const answers: string[] = [];
        try {
            // the test seam lets this platform use a local http address; the header must reach only that server
            const r = await call("POST", `/api/projects/${projectId}/git-imports`, { url: `http://127.0.0.1:${AUTH_PORT}/acme/tests.git`, token: TOKEN });
            expect(r.status).toBe(422);
            answers.push(JSON.stringify(r.body));
        } finally {
            await new Promise((r) => server401.close(r));
        }
        expect(answers[0]).toMatch(/refused the access token/);
        expect(seen).toContain(`Bearer ${TOKEN}`);

        // nothing the platform keeps or answers contains it
        const everything = [
            ...answers,
            JSON.stringify((await call("GET", `/api/projects/${projectId}/git-imports`)).body),
            JSON.stringify((await call("GET", `/api/projects/${projectId}/tests`)).body),
            JSON.stringify(custom.auditTrail(projectId)),
        ].join("\n");
        expect(everything).not.toContain(TOKEN);
        platform.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        const dbFiles = fs.readdirSync(dataDir).filter((f) => f.startsWith("platform.db"));
        for (const f of dbFiles) expect(fs.readFileSync(path.join(dataDir, f)).includes(Buffer.from(TOKEN))).toBe(false);
    }, 60_000);
});
