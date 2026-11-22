/**
 * run secrets reaching what verification stores. Real platform (SQLite, object store), scripted executor.
 * Canaries are made up.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { harvestExecutionFindings, verifyDepsOf, verifyFindings, type VerifyDeps } from "../src/platform/findings/verify-service.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";

const PW = "plain-river-canary-pw";
const TOK = "cnrytok-apitoken-7q";
const HDRV = "cnryhdr-value-9w";
// Test data named after a secret with more after the word (a confirmation field, a value of a key) is hidden too.
const NEWPW = "cnry-newpw-5521x";
const NEWPW2 = "cnry-newpw-7731y";
const APIK = "cnry-apikey-v-4410";
const CANARIES = { password: PW, apiToken: TOK, authHeaderValue: HDRV, password_confirmation: NEWPW, passwordConfirm: NEWPW2, apiKeyValue: APIK };

let platform: Platform;
let dir = "";
beforeAll(() => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-verify-hardening-leak-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "verify-hardening-secret-key-0123456789abc", SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
});
afterAll(() => {
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const filesUnder = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(d, e.name)) : [path.join(d, e.name)]));

it("no run secret reaches the stored evidence package, finding row or events", async () => {
    const projectId = String(platform.repo.createProject({ name: "Leak shop" }).id);
    const appId = platform.repo.createApplication(projectId, "http://127.0.0.1:5599", { ...DEFAULT_JOB_OPTIONS }, { username: "qa", password: PW, apiToken: TOK, apiAuthHeader: `X-Api-Key: ${HDRV}` });
    const suiteId = platform.repo.getOrCreateSuite(projectId, "Account", "account");
    const spec = TestSpecSchema.parse({
        testId: "WEB-001",
        title: "Profile shows the name",
        kind: "web",
        category: "Account",
        source: { origin: "browser-agent", requirements: ["R-1"] },
        testData: { password: PW, apiToken: TOK, password_confirmation: NEWPW, passwordConfirm: NEWPW2, "x-api-key-value": APIK },
        steps: [{ action: "navigate", url: "/profile" }, { action: "assert", check: "exactText", locator: { by: "testId", value: "name" }, expected: "QA", source: "R-1" }],
    });
    const testId = platform.repo.insertTest({ projectId, suiteId, jobId: null, spec, framework: "playwright", validationStatus: "VALIDATED" });
    const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [testId] });
    const t = platform.repo.getTest(testId)!;
    const vt = { id: t.id, title: t.title, spec: t.spec, meta: t.generationMeta, testKey: t.testKey, framework: t.framework };
    const store = new CandidateFindingStore(platform.sql);
    const evPath = path.join(dir, "ev.json");
    fs.writeFileSync(evPath, JSON.stringify({ v: 1, durationMs: 1, counts: { requests: 0, requestsKept: 0, console: 1, consoleKept: 1 }, steps: [], requests: [], console: [{ t: 1, step: 2, type: "log", text: `header sent ${HDRV}` }] }));
    const run = (i: number, n: number, withEvidence: boolean): ScriptRun => ({
        testId: "WEB-001",
        status: "failed",
        durationMs: 1,
        failedStepIndex: 1,
        steps: [
            { index: 0, title: `1. Type "${PW}" into Password`, status: "passed" },
            { index: 1, title: "2. check", status: "failed", error: `Error: expect(locator).toHaveText(expected) failed\nExpected: "QA"\nReceived: "${PW}"` },
        ],
        artifacts: withEvidence ? [{ kind: "evidence", path: evPath }] : [],
        responses: [{ method: "GET", path: `/api/session/${TOK}`, status: 500 }],
        notes: [`Attempt ${i} of ${n}: the test never signs in`],
    });
    // As failedRunsOf rebuilds a stored run: the steps as stored, no responses.
    const [f] = await harvestExecutionFindings(store, { projectId, jobId: job.id, failed: [{ test: vt, run: { ...run(1, 1, false), responses: [] } }] });
    const execute: VerifyDeps["execute"] = async () => [1, 2, 3].map((i) => run(i, 3, true));
    const res = await verifyFindings({ ...verifyDepsOf(platform, job, { execute }), findings: [f!] });
    expect(res.verified.length).toBe(1);

    const leaks: Record<string, string[]> = {};
    const scan = (where: string, s: string) => {
        for (const [k, v] of Object.entries(CANARIES)) if (s.includes(v)) (leaks[where] ??= []).includes(k) || leaks[where]!.push(k);
    };
    // The test's own stored spec holds the canaries on purpose (in the database), so the packages and the finding row are scanned.
    for (const file of filesUnder(dir)) if (file.endsWith("package.json")) scan(`evidence package ${path.relative(dir, file)}`, fs.readFileSync(file, "utf8"));
    const stored = await store.get(projectId, f!.id);
    scan("finding row (attempts)", JSON.stringify(stored!.attempts));
    scan("finding (candidate record)", JSON.stringify(stored));
    expect(filesUnder(dir).filter((x) => x.endsWith("package.json"))).toHaveLength(3);
    expect(leaks).toEqual({});
});
