/**
 * Application intelligence routes, second part: the sources of a project, an uploaded database schema file, the application version label,
 * starting an analysis, and who may do what. In-process server, no browser, no AI provider (fast tier).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { analyseAfterExploration, analysisState, ANALYSIS_RUNNING, ANALYSIS_STOPPED, AppAnalysis, schemaKey, startAnalysis } from "../src/platform/app-analysis.js";
import { AgentInputsStore } from "../src/platform/agent-inputs-store.js";
import { secretBoxOf } from "../src/platform/ai-config.js";
import { AppIntelStore, WORKFLOW_CHANGED } from "../src/platform/app-intel-store.js";
import { permissionRuleFor } from "../src/platform/auth/roles.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { AGENT_PROJECTS_ONLY, ONLY_A_PERSON_LABELS, ONLY_A_PERSON_WORKFLOWS, RULE_CHANGED, SAY_WHICH_RULE, SAY_WHICH_WORKFLOW } from "../src/platform/routes/app-intel.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { MAX_SCHEMA_INPUT } from "../src/engine/intel/sources/db-schema.js";

const KEY = "app-intel-api-test-key-0123456789";
let dataDir: string;
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let intel: AppIntelStore;
let projectId: string;
let otherId: string;

const SCHEMA = "CREATE TABLE orders (\n  id INTEGER PRIMARY KEY,\n  status TEXT NOT NULL\n);\nCREATE TABLE lines (\n  id INTEGER PRIMARY KEY,\n  order_id INTEGER REFERENCES orders(id)\n);\n";
const headers = { "x-api-key": KEY };
const upload = (pid: string, name: string, body: string | Buffer, type = "application/octet-stream") =>
    app.inject({ method: "POST", url: `/api/projects/${pid}/intel/sources/schema?name=${encodeURIComponent(name)}`, headers: { ...headers, "content-type": type }, payload: body });

beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-intel-api-"));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: "app-intel-api-secret-key-0123456789abcdef" }));
    app = await buildServer(platform);
    await app.ready();
    intel = new AppIntelStore(platform.db.sql);
    const make = async (name: string) => ((await app.inject({ method: "POST", url: "/api/projects", headers, payload: { name, platforms: ["web"], testingModes: ["agent"] } })).json() as { id: string }).id;
    projectId = await make("Intel API shop");
    otherId = await make("Intel API other");
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("uploading a database schema file", () => {
    it("connects it as a source, kept in the object store", async () => {
        const res = await upload(projectId, "schema.sql", SCHEMA);
        expect(res.statusCode).toBe(201);
        expect(res.json()).toMatchObject({ kind: "db_schema", ref: "schema.sql", status: "connected" });
        const id = res.json().id as string;
        expect((await platform.store.getBytes(schemaKey(projectId, id))).toString("utf8")).toBe(SCHEMA);
        const listed = (await app.inject({ method: "GET", url: `/api/projects/${projectId}/intel/sources`, headers })).json();
        expect(listed.sources.map((s: { ref: string }) => s.ref)).toEqual(["schema.sql"]);
    });

    it("replaces the file of the same name and connects it again", async () => {
        const res = await upload(projectId, "schema.sql", SCHEMA + "\n-- changed\n");
        expect(res.statusCode).toBe(201);
        expect((await intel.sources(projectId)).filter((s) => s.kind === "db_schema")).toHaveLength(1);
    });

    it("refuses a file over the size cap, an empty one, a bad name and a wrong type, each with a sentence", async () => {
        const big = await upload(projectId, "big.sql", Buffer.alloc(MAX_SCHEMA_INPUT + 1, 97));
        expect(big.statusCode).toBe(413);
        expect(big.json().error).toBe("A schema file is at most 1 MB.");
        expect((await upload(projectId, "empty.sql", "")).json().error).toBe("The schema file is empty.");
        expect((await upload(projectId, "../x.sql", SCHEMA)).statusCode).toBe(400);
        const wrongType = await upload(projectId, "s.sql", "{}", "application/json");
        expect(wrongType.statusCode).toBe(415);
        expect((await intel.sources(projectId)).map((s) => s.ref)).toEqual(["schema.sql"]);
    });

    it("is read by the next analysis", async () => {
        const r = await new AppAnalysis({ sql: platform.sql, store: platform.store }).run(projectId, { requirements: [], tests: { cases: [], scripts: [] }, repositories: [] }, { noAi: "No key." });
        expect(r.changed).toBe(true);
        const latest = (await app.inject({ method: "GET", url: `/api/projects/${projectId}/intel/models/latest`, headers })).json();
        expect(latest.model.entities.map((e: { name: string }) => e.name).sort()).toEqual(["lines", "orders"]);
        expect((await intel.sources(projectId))[0]).toMatchObject({ status: "processed" });
    });

    it("of another project is never removed through this one", async () => {
        const mine = (await intel.sources(projectId))[0]!;
        expect((await app.inject({ method: "DELETE", url: `/api/projects/${otherId}/intel/sources/schema/${mine.id}`, headers })).statusCode).toBe(404);
        expect((await app.inject({ method: "GET", url: `/api/projects/no-such-project/intel/sources`, headers })).statusCode).toBe(404);
        expect(await intel.sources(projectId)).toHaveLength(1);
    });

    it("is removed with its file", async () => {
        const mine = (await intel.sources(projectId))[0]!;
        const res = await app.inject({ method: "DELETE", url: `/api/projects/${projectId}/intel/sources/schema/${mine.id}`, headers });
        expect(res.statusCode).toBe(200);
        expect(await intel.sources(projectId)).toEqual([]);
        expect(await platform.store.exists(schemaKey(projectId, mine.id))).toBe(false);
    });
});

/** A signed-in person (an owner's own API token), as opposed to the server's shared access key. */
const personHeaders = () => {
    const users = accessControlOf(app).users;
    const someone = users.create({ email: `person-${Math.random().toString(36).slice(2)}@people.example`, name: "Person", role: "owner" });
    return { authorization: `Bearer ${users.createToken(someone.id, { name: "t", role: "owner" }).token}` };
};

describe("the application version", () => {
    it("is a label a person gives the latest analysis; before any analysis there is nothing to label", async () => {
        const as = personHeaders();
        const none = await app.inject({ method: "PUT", url: `/api/projects/${otherId}/intel/app-version`, headers: as, payload: { label: "2.4.1" } });
        expect(none.statusCode).toBe(409);
        expect(none.json().error).toBe("There is nothing to label yet. Read the application first.");
        const res = await app.inject({ method: "PUT", url: `/api/projects/${projectId}/intel/app-version`, headers: as, payload: { label: " 2.4.1 " } });
        expect(res.statusCode).toBe(200);
        expect((await intel.latest(projectId))!.appVersion).toMatchObject({ source: "person", label: "2.4.1" });
        expect((await app.inject({ method: "PUT", url: `/api/projects/${projectId}/intel/app-version`, headers: as, payload: { label: "" } })).statusCode).toBe(400);
    });

    it("is never labelled by the shared access key, which is no person", async () => {
        const res = await app.inject({ method: "PUT", url: `/api/projects/${projectId}/intel/app-version`, headers, payload: { label: "9.9.9" } });
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toBe(ONLY_A_PERSON_LABELS);
        expect((await intel.latest(projectId))!.appVersion.label).toBe("2.4.1");
    });
});

describe("a person's decision about a rule", () => {
    it("names the version of the rule it is about; a rule that changed since is refused with a sentence", async () => {
        const as = personHeaders();
        const r = await intel.addRule(projectId, { ref: "R-dec", kind: "constraint", description: "Order status", expected: "An order is placed, paid or shipped.", sourceType: "db_schema", sourceRef: "schema.sql:3", explicitness: "explicit", confidence: 0.9 });
        const url = `/api/projects/${projectId}/intel/rules/${r.id}/decision`;
        const missing = await app.inject({ method: "PUT", url, headers: as, payload: { status: "confirmed" } });
        expect(missing.statusCode).toBe(400);
        expect(missing.json().error).toBe(SAY_WHICH_RULE);
        // Changed under the person (another kind: another rule): the confirmation of what they read is refused.
        const changed = await intel.addRule(projectId, { ref: "R-dec", kind: "invariant", description: "Order status", expected: "An order is placed, paid or shipped.", sourceType: "db_schema", sourceRef: "schema.sql:3", explicitness: "explicit", confidence: 0.9 });
        const stale = await app.inject({ method: "PUT", url, headers: as, payload: { status: "confirmed", fingerprint: r.fingerprint } });
        expect(stale.statusCode).toBe(409);
        expect(stale.json().error).toBe(RULE_CHANGED);
        expect((await intel.rule(projectId, r.id))!.status).toBe("unverified");
        const ok = await app.inject({ method: "PUT", url, headers: as, payload: { status: "confirmed", fingerprint: changed.fingerprint } });
        expect(ok.statusCode).toBe(200);
        expect(ok.json()).toMatchObject({ status: "confirmed", fingerprint: changed.fingerprint });
        // Undoing a decision needs no version.
        expect((await app.inject({ method: "PUT", url, headers: as, payload: { status: "unverified" } })).json()).toMatchObject({ status: "unverified" });
    });
});

describe("who may do what", () => {
    it("reading needs access to the project; changing sources, the version or starting an analysis needs permission to write tests", () => {
        expect(permissionRuleFor("GET", "/api/projects/:id/intel/sources")).toBe("read");
        for (const [m, t] of [
            ["POST", "/api/projects/:id/intel/sources/schema"],
            ["DELETE", "/api/projects/:id/intel/sources/schema/:sourceId"],
            ["PUT", "/api/projects/:id/intel/app-version"],
            ["DELETE", "/api/projects/:id/intel/analyse"],
        ]) expect(permissionRuleFor(m!, t!), `${m} ${t}`).toBe("ai_studio.tests.write");
        // Starting one spends AI: it needs the permission to use the AI for tests (and, checked in the route, to write tests).
        expect(permissionRuleFor("POST", "/api/projects/:id/intel/analyse")).toBe("ai_studio.tests.generate");
    });

    it("its write routes are for AI agent projects; a code project is told so", async () => {
        const code = ((await app.inject({ method: "POST", url: "/api/projects", headers, payload: { name: "Intel API code", platforms: ["web"], testingModes: ["code"] } })).json() as { id: string }).id;
        const calls = [
            app.inject({ method: "POST", url: `/api/projects/${code}/intel/sources/schema?name=s.sql`, headers: { ...headers, "content-type": "application/octet-stream" }, payload: SCHEMA }),
            app.inject({ method: "POST", url: `/api/projects/${code}/intel/analyse`, headers }),
            app.inject({ method: "PUT", url: `/api/projects/${code}/intel/app-version`, headers: personHeaders(), payload: { label: "1.0" } }),
        ];
        for (const res of await Promise.all(calls)) {
            expect(res.statusCode).toBe(409);
            expect(res.json().error).toBe(AGENT_PROJECTS_ONLY);
        }
        expect(await intel.sources(code)).toEqual([]);
    });

    it("the shared access key still cannot confirm a rule", async () => {
        const r = await intel.addRule(projectId, { ref: "R-1", kind: "constraint", description: "Status", expected: "An order has a status.", sourceType: "db_schema", sourceRef: "schema.sql:3", explicitness: "explicit", confidence: 0.9 });
        const res = await app.inject({ method: "PUT", url: `/api/projects/${projectId}/intel/rules/${r.id}/decision`, headers, payload: { status: "confirmed" } });
        expect(res.statusCode).toBe(403);
        expect((await intel.rule(projectId, r.id))!.status).toBe("unverified");
    });
});

describe("starting an analysis", () => {
    /** An OpenAPI fetch that waits until the analysis is stopped: the analysis stays running meanwhile. */
    const hanging = (_url: string, signal?: AbortSignal) =>
        new Promise<string>((_ok, fail) => (signal?.aborted ? fail(new Error("stopped")) : signal?.addEventListener("abort", () => fail(new Error("stopped")), { once: true })));
    let pid: string;

    beforeAll(async () => {
        pid = ((await app.inject({ method: "POST", url: "/api/projects", headers, payload: { name: "Intel API analyse", platforms: ["web"], testingModes: ["agent"] } })).json() as { id: string }).id;
        new AgentInputsStore(platform.db, secretBoxOf(platform.config)).save(pid, { site: "https://shop.test", openApiUrl: "https://shop.test/openapi.json" });
    });

    it("runs one analysis per project at a time; a second start is refused with a sentence", async () => {
        const first = await startAnalysis(platform, pid, null, { fetchText: hanging });
        const again = await app.inject({ method: "POST", url: `/api/projects/${pid}/intel/analyse`, headers });
        expect(again.statusCode).toBe(409);
        expect(again.json().error).toBe(ANALYSIS_RUNNING);
        const state = (await app.inject({ method: "GET", url: `/api/projects/${pid}/intel/sources`, headers })).json();
        expect(state.running).toEqual({ since: first.since });
        // Stopped: nothing of it is kept, and it says so.
        expect((await app.inject({ method: "DELETE", url: `/api/projects/${pid}/intel/analyse`, headers })).statusCode).toBe(200);
        await first.done;
        const after = (await app.inject({ method: "GET", url: `/api/projects/${pid}/intel/sources`, headers })).json();
        expect(after.running).toBeNull();
        expect(after.last).toMatchObject({ error: ANALYSIS_STOPPED, version: null });
        expect(await intel.latest(pid)).toBeUndefined();
        expect((await app.inject({ method: "DELETE", url: `/api/projects/${pid}/intel/analyse`, headers })).statusCode).toBe(404);
    });

    it("from the API runs in the background and stores a version, building the structure without an AI key", async () => {
        const res = await app.inject({ method: "POST", url: `/api/projects/${otherId}/intel/analyse`, headers });
        expect(res.statusCode).toBe(202);
        expect(res.json().running.since).toEqual(expect.any(String));
        for (let i = 0; i < 100 && analysisState(platform.db, otherId).running; i++) await new Promise((r) => setTimeout(r, 20));
        expect(analysisState(platform.db, otherId)).toMatchObject({ running: null, last: { version: 1, changed: true } });
        expect((await intel.latest(otherId))!.model.missingContext.map((m) => m.text).join("\n")).not.toContain("Rules were not read"); // no AI source connected
    });

    it("after an exploration stops a manual one first, and stops with the exploration job", async () => {
        const manual = await startAnalysis(platform, pid, null, { fetchText: hanging });
        const job = new AbortController();
        const hook = analyseAfterExploration(platform, pid, { noAi: "No key.", signal: job.signal, fetchText: hanging });
        await manual.done;
        // The exploration's own analysis is now the project's running one; the job's cancel stops it.
        job.abort();
        const r = await hook;
        expect(r.result?.version ?? null).toBeNull();
        expect(analysisState(platform.db, pid).running).toBeNull();
    });
});

describe("a person's decision about a workflow", () => {
    let pid: string;
    let wf: { id: string; fingerprint: string };
    const STEPS = [{ order: 0, action: "Open the cart", page: "page:/cart" }, { order: 1, action: "Pay" }];
    const version = (name: string) =>
        intel.addVersion({ projectId: pid, model: { workflows: [{ id: "journey-1-checkout", name, steps: STEPS, sourceType: "inferred", evidence: [{ kind: "page", ref: "/cart" }] }] } });
    const url = () => `/api/projects/${pid}/intel/workflows/${wf.id}/decision`;
    const latestWorkflow = async () => (await app.inject({ method: "GET", url: `/api/projects/${pid}/intel/models/latest`, headers })).json().model.workflows[0];

    beforeAll(async () => {
        pid = ((await app.inject({ method: "POST", url: "/api/projects", headers, payload: { name: "Intel API workflows", platforms: ["web"], testingModes: ["agent"] } })).json() as { id: string }).id;
        await version("Checkout");
        wf = await latestWorkflow();
    });

    it("is shown with each workflow: its fingerprint, and no decision yet", async () => {
        expect(wf).toMatchObject({ id: "journey-1-checkout", sourceType: "inferred", decision: null, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
    });

    it("needs a person, the fingerprint of what they read, and a workflow of this project", async () => {
        expect(permissionRuleFor("PUT", "/api/projects/:id/intel/workflows/:workflowId/decision")).toBe("ai_studio.tests.write");
        const key = await app.inject({ method: "PUT", url: url(), headers, payload: { status: "confirmed", fingerprint: wf.fingerprint } });
        expect(key.statusCode).toBe(403);
        expect(key.json().error).toBe(ONLY_A_PERSON_WORKFLOWS);
        const as = personHeaders();
        const missing = await app.inject({ method: "PUT", url: url(), headers: as, payload: { status: "confirmed" } });
        expect([missing.statusCode, missing.json().error]).toEqual([400, SAY_WHICH_WORKFLOW]);
        const stale = await app.inject({ method: "PUT", url: url(), headers: as, payload: { status: "confirmed", fingerprint: "0".repeat(64) } });
        expect([stale.statusCode, stale.json().error]).toEqual([409, WORKFLOW_CHANGED]);
        expect((await app.inject({ method: "PUT", url: `/api/projects/${otherId}/intel/workflows/${wf.id}/decision`, headers: as, payload: { status: "confirmed", fingerprint: wf.fingerprint } })).statusCode).toBe(404);
        const code = ((await app.inject({ method: "POST", url: "/api/projects", headers, payload: { name: "Intel API workflows code", platforms: ["web"], testingModes: ["code"] } })).json() as { id: string }).id;
        expect((await app.inject({ method: "PUT", url: `/api/projects/${code}/intel/workflows/${wf.id}/decision`, headers: as, payload: { status: "confirmed", fingerprint: wf.fingerprint } })).statusCode).toBe(409);
        expect((await latestWorkflow()).decision).toBeNull();
    });

    it("confirmed, follows the same steps into a later analysis, keeps the decided name and shows the new one beside it", async () => {
        const as = personHeaders();
        const res = await app.inject({ method: "PUT", url: url(), headers: as, payload: { status: "confirmed", fingerprint: wf.fingerprint } });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ sourceType: "inferred", decision: { status: "confirmed", decidedBy: expect.any(String) } });
        await version("Buy things");
        expect(await latestWorkflow()).toMatchObject({ name: "Checkout", rewordedName: "Buy things", sourceType: "inferred", fingerprint: wf.fingerprint, decision: { status: "confirmed" } });
    });

    it("confirmed, gives the test writer the confirmed rule of that workflow; rejected, neither the workflow nor its rules", async () => {
        const { appKnowledgeOf } = await import("../src/platform/job-runner.js");
        const { rulesForScenario } = await import("../src/engine/planning/planner.js");
        const r = await intel.addRule(pid, { ref: "R-wf", kind: "constraint", description: "Paying", expected: "Paying empties the cart.", sourceType: "inferred", sourceRef: "", explicitness: "inferred", confidence: 0.6, workflows: ["journey-1-checkout"] });
        await intel.decide(pid, r.id, "confirmed", "person-1", r.fingerprint);
        const k = (await appKnowledgeOf(platform.repo, pid)).appKnowledge!;
        expect(k.workflows.map((w) => [w.name, w.sourceType])).toEqual([["Checkout", "user_confirmed"]]);
        expect(rulesForScenario({ journey: "Checkout" }, k).map((x) => x.ref)).toEqual(["R-wf"]);
        const as = personHeaders();
        expect((await app.inject({ method: "PUT", url: url(), headers: as, payload: { status: "rejected", fingerprint: wf.fingerprint } })).json().decision.status).toBe("rejected");
        const rejected = (await appKnowledgeOf(platform.repo, pid)).appKnowledge!;
        expect(rejected.workflows).toEqual([]);
        expect(rulesForScenario({ journey: "Checkout" }, rejected)).toEqual([]);
        // Undone: no decision, and a guessed workflow is again not given to the writer.
        expect((await app.inject({ method: "PUT", url: url(), headers: as, payload: { status: "unverified", fingerprint: wf.fingerprint } })).json().decision).toBeNull();
        expect((await appKnowledgeOf(platform.repo, pid)).appKnowledge!.workflows).toEqual([]);
    });

    it("rejected, leaves out even a workflow a document states", async () => {
        const { appKnowledgeOf } = await import("../src/platform/job-runner.js");
        await intel.addVersion({ projectId: pid, model: { workflows: [{ id: "wf-refund", name: "Refund", steps: [{ order: 0, action: "Ask for a refund" }], sourceType: "requirement", evidence: [{ kind: "quote", ref: "req.md#L3" }] }] } });
        expect((await appKnowledgeOf(platform.repo, pid)).appKnowledge!.workflows.map((w) => w.name)).toEqual(["Refund"]);
        const stated = await latestWorkflow();
        const res = await app.inject({ method: "PUT", url: `/api/projects/${pid}/intel/workflows/wf-refund/decision`, headers: personHeaders(), payload: { status: "rejected", fingerprint: stated.fingerprint } });
        expect(res.statusCode).toBe(200);
        expect((await appKnowledgeOf(platform.repo, pid)).appKnowledge!.workflows).toEqual([]);
    });
});
