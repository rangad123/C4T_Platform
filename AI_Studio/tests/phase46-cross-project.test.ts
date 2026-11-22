/**
 * Project isolation of the Phase 4–6 reads (P7-2 checklist): project A holds a finding, a database-check setting with its token, a pull
 * request's chosen tests and a test; project B is empty. Every B route answers without any of A's data, an id of A's under B's path is
 * 404, and a person who may see only B cannot read A's routes at all. Browser-free (SQLite, routes by inject).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { findingFingerprint, type CandidateFindingInput } from "../src/engine/explore/finding.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { DbProbeStore } from "../src/platform/db-probe-store.js";
import { SecretBox } from "../src/platform/secrets.js";
import { buildServer } from "../src/platform/server.js";
import { addTest, seedProject, type Seed } from "./fixtures/dashboard-seed.js";

const KEY = "cross-project-owner-key-7c1d2e3f";
const PROBE_TOKEN = "a-project-probe-token-cnry-91827364";
const MARK = "cnry-a-only";
let platform: Platform;
let dir = "";
let app: Awaited<ReturnType<typeof buildServer>>;
let A: Seed;
let B: Seed;
let fid = "";
let onlyB = "";
let artifactA = "";
let editor = "";

const finding = (): CandidateFindingInput => ({
    objective: { id: "obj-1", kind: "rule", source: "R-4" },
    actions: { stepCount: 2 },
    expected: { text: `Total equals sum ${MARK}.`, source: "R-4" },
    observed: `Total wrong ${MARK}.`,
    evidence: { screenshots: [], requests: [], console: [] },
    capture: "captured",
    independence: "independent",
    confidence: "high",
    fingerprint: findingFingerprint({ source: "R-4", expected: "Total equals sum.", scenario: "x" }),
    modelVersion: null,
    replays: [],
});

const get = async (url: string, headers: Record<string, string> = { "x-api-key": KEY }) => {
    const res = await app.inject({ method: "GET", url, headers });
    return { status: res.statusCode, body: res.body };
};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-cross-project-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "cross-project-secret-key-0123456789", API_KEY: KEY, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    app = await buildServer(platform);
    await app.ready();
    A = seedProject(platform, "A shop", "https://a.example.test");
    B = seedProject(platform, "B shop", "https://b.example.test");
    const testA = addTest(platform, A, MARK);
    fid = (await new CandidateFindingStore(platform.sql).upsert({ projectId: A.projectId, testId: testA, finding: finding() })).finding.id;
    await new DbProbeStore(platform.sql, new SecretBox(platform.config.dataDir, platform.config.SECRET_KEY)).set(A.projectId, { enabled: true, url: `https://${MARK}.example.test/probe`, token: PROBE_TOKEN });
    platform.db.run(
        "INSERT INTO pr_selections (id, project_id, pr, head_sha, mode, selected_json, reasons_json, created_at) VALUES (?,?,?,?,?,?,?,?)",
        "sel-a", A.projectId, 7, "b".repeat(40), "focused", JSON.stringify([testA]), JSON.stringify({ tests: [{ id: testA, why: MARK }] }), new Date().toISOString(),
    );
    // A verification attempt's evidence package, kept as verify-service.ts keeps it: an artifact of A's test.
    const rel = path.posix.join(A.projectId, "_artifacts", "API-001", "verify-x", "attempt-1", "package.json");
    const saved = await platform.store.put(rel, Buffer.from(JSON.stringify({ observed: MARK })), { contentType: "application/json" });
    artifactA = platform.repo.addArtifact({ projectId: A.projectId, testId: testA, kind: "evidence", path: rel, size: saved.size });
    const control = accessControlOf(app);
    const u = control.users.create({ email: "only-b@example.com", name: "Only B", role: "editor" });
    control.projects.store.set(u.id, { mode: "only", projects: [{ projectId: B.projectId, role: "editor" }] });
    onlyB = control.users.createToken(u.id, { name: "t", role: "editor" }).token;
    const e = control.users.create({ email: "editor@example.com", name: "Editor", role: "editor" });
    editor = control.users.createToken(e.id, { name: "t", role: "editor" }).token;
});

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const ROUTES = ["findings", "quality", "pull-requests", "db-probe", "test-coverage", "code-host", "candidate-findings"];

describe("Phase 4–6 routes keep each project's data to itself", () => {
    it("A's routes show A's data (the seed is real)", async () => {
        expect((await get(`/api/projects/${A.projectId}/findings`)).body).toContain(MARK);
        expect((await get(`/api/projects/${A.projectId}/pull-requests`)).body).toContain('"pr":7');
        expect((await get(`/api/projects/${A.projectId}/db-probe`)).body).toContain(MARK);
    });

    it("B's routes answer without any of A's data, and never the probe token", async () => {
        for (const r of ROUTES) {
            const res = await get(`/api/projects/${B.projectId}/${r}`);
            expect(res.status, r).toBe(200);
            expect(res.body, r).not.toContain(MARK);
            expect(res.body, r).not.toContain('"pr":7');
        }
        for (const r of ROUTES) expect((await get(`/api/projects/${A.projectId}/${r}`)).body, r).not.toContain(PROBE_TOKEN);
    });

    it("A's finding under B's path is 404", async () => {
        expect((await get(`/api/projects/${B.projectId}/findings/${fid}`)).status).toBe(404);
    });

    it("a person who may see only B cannot read A's routes", async () => {
        const as = { authorization: `Bearer ${onlyB}` };
        expect((await get(`/api/projects/${B.projectId}/findings`, as)).status).toBe(200);
        for (const r of ROUTES) expect([403, 404], r).toContain((await get(`/api/projects/${A.projectId}/${r}`, as)).status);
        // A's verification evidence, by its own id.
        expect((await get(`/api/artifacts/${artifactA}`)).body).toContain(MARK);
        const art = await get(`/api/artifacts/${artifactA}`, as);
        expect(art.status).toBe(404);
        expect(art.body).not.toContain(MARK);
    });
});

describe("the database check's token is a connection's secret", () => {
    it("an editor can read the setting but not set it; setting it needs the manage permission, like every other connection", async () => {
        const as = { authorization: `Bearer ${editor}` };
        const put = (headers: Record<string, string>) =>
            app.inject({ method: "PUT", url: `/api/projects/${B.projectId}/db-probe`, headers, payload: { enabled: true, url: "https://probe.b.example.test/db", token: "editor-set-probe-token-0123456789abcdef" } });
        expect((await get(`/api/projects/${B.projectId}/db-probe`, as)).status).toBe(200);
        expect((await put(as)).statusCode).toBe(403);
        expect((await get(`/api/projects/${B.projectId}/db-probe`)).body).toContain('"tokenSaved":false');
        expect((await put({ "x-api-key": KEY })).statusCode).toBe(200);
    });
});
