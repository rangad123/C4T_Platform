/**
 * Requirements as records through a real platform (Fastify inject, a real database, no model, no browser): the store's slot,
 * create, change and delete (refused while tests link to it, done when confirmed), links to automated tests and manual cases,
 * the coverage rules (not covered, covered, passing, failing; retired left out), import from text and from a file with a preview,
 * the AI refinement refused plainly without a model, links made by generation, cross-project ids answering 404, and the
 * permission refusals (read with ai_studio.access, write with ai_studio.tests.write).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { RepoSink } from "../src/platform/repo-sink.js";
import { automatedResult, candidateOf, candidatesFromText, candidatesWithAi, coverageOf, manualResult } from "../src/platform/requirement-store.js";
import { buildServer } from "../src/platform/server.js";
import { addTest, seedProject, type Seed } from "./fixtures/dashboard-seed.js";

const KEY = "req-owner-key-5c1d2e3f";
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
let A: Seed;
let B: Seed;
let viewer = "";

const call = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = { "x-api-key": KEY }) => {
    const res = await app.inject({ method: method as "GET", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as any) : null };
};
const reqs = (s: Seed) => `/api/projects/${s.projectId}/requirements`;
const add = async (s: Seed, body: Record<string, unknown>) => {
    const r = await call("POST", reqs(s), body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
};
const manualCase = async (s: Seed, title: string) => {
    const r = await call("POST", `/api/projects/${s.projectId}/manual-cases`, { title, priority: "medium", steps: [{ action: "Open it", expected: "It opens" }] });
    expect(r.status).toBe(201);
    return r.body.id as string;
};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-req-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "req-test-secret-key-0123456789", API_KEY: KEY, SCHEDULER_ENABLED: "false" }));
    app = await buildServer(platform);
    await app.ready();
    A = seedProject(platform, "Atlas shop", "https://atlas.example.test");
    for (const k of ["pay", "basket", "search"]) addTest(platform, A, k);
    B = seedProject(platform, "Other shop", "https://other.example.test");
    addTest(platform, B, "pay");
    const control = accessControlOf(app);
    const u = control.users.create({ email: "vera@example.com", name: "Vera", role: "viewer" });
    viewer = control.users.createToken(u.id, { name: "t", role: "viewer" }).token;
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("the rules", () => {
    it("reads a test's latest result and the coverage it gives", () => {
        expect(automatedResult("VALIDATED")).toBe("passed");
        expect(automatedResult("NEEDS_REVIEW")).toBe("failed");
        expect(automatedResult("FAILED_VALIDATION")).toBe("failed");
        expect(automatedResult("PENDING")).toBe("not_run");
        expect(manualResult("blocked")).toBe("failed");
        expect(manualResult("skipped")).toBe("not_run");
        expect(manualResult(undefined)).toBe("not_run");
        expect(coverageOf([])).toBe("not_covered");
        expect(coverageOf(["passed", "passed"])).toBe("passing");
        expect(coverageOf(["passed", "not_run"])).toBe("covered");
        expect(coverageOf(["passed", "failed", "not_run"])).toBe("failing");
    });

    it("finds requirements in text with the parser's rules, no AI", () => {
        const c = candidatesFromText("# Checkout\n- REQ-1: A shopper can pay by card.\n- REQ-2: The basket keeps its items after signing in.\n\nThe system must send a receipt by email.");
        expect(c.map((x) => x.ref)).toEqual(["REQ-1", "REQ-2", "R-001"]);
        expect(c[0]).toMatchObject({ title: "A shopper can pay by card.", section: "Checkout" });
    });
});

describe("reading with the AI", () => {
    const fake = (object: () => Promise<unknown>) => ({ config: platform.config, llm: { modelName: "fake", usage: { inputTokens: 0, outputTokens: 0 }, object } as never });

    it("says the list is the AI's when the model answered", async () => {
        const r = await candidatesWithAi(fake(async () => ({ requirements: [{ id: "REQ-1.a", text: "A shopper can pay by card.", kind: "functional" }, { id: "REQ-1.b", text: "A shopper can pay by bank transfer.", kind: "functional" }] })), "- REQ-1: A shopper can pay by card or by bank transfer.");
        expect(r).toMatchObject({ usedAi: true, note: null });
        expect(r.candidates.map((c) => c.ref)).toEqual(["REQ-1.a", "REQ-1.b"]);
    });

    it("never passes the rules' list off as the AI's when the model fails", async () => {
        const r = await candidatesWithAi(fake(async () => { throw new Error("overloaded"); }), "- REQ-1: A shopper can pay by card.");
        expect(r.usedAi).toBe(false);
        expect(r.note).toMatch(/without AI/);
        expect(r.candidates.map((c) => c.ref)).toEqual(["REQ-1"]);
    });

    it("turns an id the AI copied from a document into a reference that can be saved", () => {
        expect(candidateOf({ id: "/SEC 12", text: "Sessions end after an hour.", kind: "security" }).ref).toBe("SEC-12");
    });
});

describe("storage", () => {
    it("creates its tables in migration slot 38", () => {
        const names = platform.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
        expect(names).toEqual(expect.arrayContaining(["requirements", "requirement_links"]));
        expect(platform.db.get<{ v: number }>("SELECT MAX(version) AS v FROM schema_version")!.v).toBeGreaterThanOrEqual(38);
    });
});

describe("requirements", () => {
    let pay: any;
    it("adds one with the next REQ-n when no reference is given, and refuses a taken reference whatever its case", async () => {
        pay = await add(A, { title: "A shopper can pay by card", acceptanceCriteria: "The card is charged once", priority: "high" });
        expect(pay).toMatchObject({ ref: "REQ-1", status: "active", priority: "high", source: "typed", createdBy: "Access key" });
        const second = await add(A, { ref: "REQ-7", title: "The basket keeps its items" });
        expect(second.ref).toBe("REQ-7");
        expect((await add(A, { title: "Search finds products" })).ref).toBe("REQ-8");
        const dup = await call("POST", reqs(A), { ref: "req-7", title: "Again" });
        expect(dup.status).toBe(409);
        expect(dup.body.error).toMatch(/req-7 is already a requirement/);
        expect((await call("POST", reqs(A), { title: "" })).status).toBe(400);
        expect((await call("POST", reqs(A), { ref: "bad ref!", title: "x" })).status).toBe(400);
        expect((await call("POST", reqs(A), { title: "x", status: "done" })).status).toBe(400);
    });

    it("changes the fields asked for, and refuses another requirement's reference", async () => {
        const r = await call("PATCH", `${reqs(A)}/${pay.id}`, { description: "Visa and Mastercard", status: "draft" });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ ref: "REQ-1", description: "Visa and Mastercard", status: "draft", title: "A shopper can pay by card" });
        expect((await call("PATCH", `${reqs(A)}/${pay.id}`, { ref: "REQ-7" })).status).toBe(409);
        expect((await call("PATCH", `${reqs(A)}/${pay.id}`, {})).status).toBe(400);
    });

    it("links automated tests and manual cases, and coverage follows their latest results", async () => {
        const manual = await manualCase(A, "Card receipt on paper");
        const link = await call("POST", `${reqs(A)}/${pay.id}/tests`, { automated: [A.tests.get("pay"), A.tests.get("basket")], manual: [manual] });
        expect(link.status).toBe(200);
        expect(link.body.added).toBe(3);
        // Linking again changes nothing.
        expect((await call("POST", `${reqs(A)}/${pay.id}/tests`, { automated: [A.tests.get("pay")] })).body.added).toBe(0);
        const covered = await call("GET", `${reqs(A)}/${pay.id}`);
        expect(covered.body.coverage).toBe("covered");
        expect(covered.body.tests.map((t: any) => t.kind).sort()).toEqual(["automated", "automated", "manual"]);

        platform.repo.updateTest(A.tests.get("pay")!, { validationStatus: "VALIDATED" });
        platform.repo.updateTest(A.tests.get("basket")!, { validationStatus: "VALIDATED" });
        const rel = await call("POST", `/api/projects/${A.projectId}/releases`, { name: "1.0" });
        expect((await call("PUT", `/api/projects/${A.projectId}/releases/${rel.body.id}/results/${manual}`, { result: "passed", by: "Vera" })).status).toBe(200);
        expect((await call("GET", `${reqs(A)}/${pay.id}`)).body.coverage).toBe("passing");

        platform.repo.updateTest(A.tests.get("basket")!, { validationStatus: "NEEDS_REVIEW" });
        const failing = await call("GET", `${reqs(A)}/${pay.id}`);
        expect(failing.body.coverage).toBe("failing");
        expect(failing.body.counts).toEqual({ linked: 3, passed: 2, failed: 1, notRun: 0 });
        expect(failing.body.tests.find((t: any) => t.kind === "manual")).toMatchObject({ result: "passed", detail: "passed" });

        const list = await call("GET", reqs(A));
        expect(list.body.summary).toEqual({ total: 3, notCovered: 2, covered: 0, passing: 0, failing: 1, retired: 0 });
        expect((await call("GET", `${reqs(A)}?coverage=not_covered`)).body.requirements.map((r: any) => r.ref)).toEqual(["REQ-7", "REQ-8"]);
        expect((await call("GET", `${reqs(A)}?q=basket`)).body.requirements.map((r: any) => r.ref)).toEqual(["REQ-7"]);
        expect((await call("GET", `${reqs(A)}?status=draft`)).body.requirements.map((r: any) => r.ref)).toEqual(["REQ-1"]);
        expect((await call("GET", `${reqs(A)}/coverage`)).body.failing).toBe(1);
    });

    it("says which requirements a test covers, and every link of the project", async () => {
        const forTest = await call("GET", `/api/tests/${A.tests.get("pay")}/requirements`);
        expect(forTest.body.requirements.map((r: any) => r.ref)).toEqual(["REQ-1"]);
        const links = await call("GET", `${reqs(A)}/links`);
        expect(links.body.links).toHaveLength(3);
        expect(links.body.links.filter((l: any) => l.kind === "manual")).toHaveLength(1);
    });

    it("leaves a retired requirement out of the summary", async () => {
        const search = (await call("GET", reqs(A))).body.requirements.find((r: any) => r.ref === "REQ-8");
        await call("PATCH", `${reqs(A)}/${search.id}`, { status: "retired" });
        expect((await call("GET", `${reqs(A)}/coverage`)).body).toMatchObject({ total: 2, retired: 1, notCovered: 1 });
    });

    it("unlinks one test", async () => {
        expect((await call("DELETE", `${reqs(A)}/${pay.id}/tests/${A.tests.get("basket")}`)).status).toBe(204);
        expect((await call("DELETE", `${reqs(A)}/${pay.id}/tests/${A.tests.get("basket")}`)).status).toBe(404);
        expect((await call("GET", `${reqs(A)}/${pay.id}`)).body.coverage).toBe("passing");
    });

    it("refuses to delete a requirement tests link to until it is confirmed; the tests stay", async () => {
        const refused = await call("DELETE", `${reqs(A)}/${pay.id}`);
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ details: { linked: 2 } });
        expect(refused.body.error).toMatch(/covered by 2 tests/);
        expect((await call("DELETE", `${reqs(A)}/${pay.id}?confirm=1`)).status).toBe(204);
        expect((await call("GET", `${reqs(A)}/${pay.id}`)).status).toBe(404);
        expect(platform.repo.getTest(A.tests.get("pay")!)).toBeTruthy();
        expect(platform.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM requirement_links WHERE requirement_id = ?", pay.id)!.c).toBe(0);
        // Nothing links to REQ-7: it goes at once.
        const basket = (await call("GET", reqs(A))).body.requirements.find((r: any) => r.ref === "REQ-7");
        expect((await call("DELETE", `${reqs(A)}/${basket.id}`)).status).toBe(204);
    });
});

describe("import", () => {
    const doc = "# Payments\n- REQ-20: A shopper can pay by card.\n- REQ-21: A refund reaches the card within five days.\n\n# Accounts\nThe system must lock an account after five failed sign-ins.";

    it("previews pasted text, marking the references the project already has, and saves only what is chosen", async () => {
        await add(A, { ref: "REQ-21", title: "Refunds" });
        const p = await call("POST", `${reqs(A)}/import/preview`, { text: doc });
        expect(p.status).toBe(200);
        expect(p.body).toMatchObject({ total: 3, existing: 1, usedAi: false });
        expect(p.body.candidates.map((c: any) => [c.ref, c.exists])).toEqual([["REQ-20", false], ["REQ-21", true], ["R-001", false]]);
        // The preview stored nothing.
        expect((await call("GET", reqs(A))).body.requirements.some((r: any) => r.ref === "REQ-20")).toBe(false);
        const saved = await call("POST", `${reqs(A)}/import`, { requirements: p.body.candidates.map((c: any) => ({ ref: c.ref, title: c.title, description: c.description })) });
        expect(saved.status).toBe(201);
        expect(saved.body).toMatchObject({ created: 2, duplicates: ["REQ-21"] });
        const rec = (await call("GET", reqs(A))).body.requirements.find((r: any) => r.ref === "R-001");
        expect(rec).toMatchObject({ source: "imported", title: "The system must lock an account after five failed sign-ins." });
    });

    it("reads a file, and refuses an unreadable one or an empty request plainly", async () => {
        const file = { filename: "reqs.md", contentBase64: Buffer.from("- FR-1: Orders can be cancelled within an hour.\n").toString("base64") };
        const p = await call("POST", `${reqs(A)}/import/preview`, { file });
        expect(p.body.candidates.map((c: any) => c.ref)).toEqual(["FR-1"]);
        const bad = await call("POST", `${reqs(A)}/import/preview`, { file: { filename: "reqs.exe", contentBase64: "AAAA" } });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toMatch(/Unsupported requirements file/);
        expect((await call("POST", `${reqs(A)}/import/preview`, {})).status).toBe(400);
        expect((await call("POST", `${reqs(A)}/import`, { requirements: [] })).status).toBe(400);
    });

    it("says plainly that the AI cannot refine here when no model is set up", async () => {
        const r = await call("POST", `${reqs(A)}/import/refine`, { text: doc });
        expect(r.status).toBe(422);
        expect(r.body.error).toMatch(/No AI model is set up here/);
    });
});

describe("generation", () => {
    it("links a test the AI wrote from a requirements document to the requirement records it names", async () => {
        const req = await add(A, { ref: "REQ-40", title: "A shopper can save a card" });
        const job = await platform.repo.createJob(A.projectId, A.appId, { ...(await import("../src/platform/repo.js")).DEFAULT_JOB_OPTIONS });
        const sink = new RepoSink(platform.repo, platform.store, { id: job.id, projectId: A.projectId, applicationId: A.appId });
        const spec = TestSpecSchema.parse({ testId: "WEB-040", title: "Save a card", kind: "web", category: "Payments", steps: [{ action: "navigate", url: "/" }], source: { origin: "browser-agent", requirements: ["req-40", "REQ-99"] } });
        const h = await sink.createTest({ spec, framework: "playwright", validation: "PENDING" });
        await sink.writes.flush();
        const detail = await call("GET", `${reqs(A)}/${req.id}`);
        expect(detail.body.tests).toEqual([expect.objectContaining({ id: h.id, kind: "automated", origin: "generated" })]);
    });
});

describe("a project backup", () => {
    it("carries requirements and their links to the restored project, under the new ids", async () => {
        const r = await add(B, { ref: "REQ-50", title: "Backed up", acceptanceCriteria: "It comes back", status: "draft" });
        const manual = await manualCase(B, "Backed up by hand");
        await call("POST", `${reqs(B)}/${r.id}/tests`, { automated: [B.tests.get("pay")], manual: [manual] });
        const zip = await app.inject({ method: "GET", url: `/api/projects/${B.projectId}/backup`, headers: { "x-api-key": KEY } });
        expect(zip.statusCode, zip.body.slice(0, 200)).toBe(200);
        const restored = await app.inject({ method: "POST", url: "/api/projects/restore", headers: { "x-api-key": KEY, "content-type": "application/octet-stream" }, payload: zip.rawPayload });
        expect(restored.statusCode, restored.body.slice(0, 300)).toBeLessThan(300);
        const answer = JSON.parse(restored.body);
        expect(answer.restored.requirements).toBeGreaterThanOrEqual(1);
        const pid = answer.projectId ?? answer.project?.id;
        const back = (await call("GET", `/api/projects/${pid}/requirements`)).body.requirements.find((x: any) => x.ref === "REQ-50");
        expect(back).toMatchObject({ title: "Backed up", acceptanceCriteria: "It comes back", status: "draft", tests: { linked: 2 } });
        expect(back.id).not.toBe(r.id);
        const tests = (await call("GET", `/api/projects/${pid}/requirements/${back.id}`)).body.tests;
        expect(tests.map((t: any) => t.kind).sort()).toEqual(["automated", "manual"]);
        expect(tests.every((t: any) => t.id !== B.tests.get("pay") && t.id !== manual)).toBe(true);
    });
});

describe("other projects and permissions", () => {
    let mine: any;
    beforeAll(async () => {
        mine = await add(B, { title: "B's own" });
    });

    it("answers 404 for another project's requirement, and refuses linking another project's test", async () => {
        expect((await call("GET", `${reqs(A)}/${mine.id}`)).status).toBe(404);
        expect((await call("PATCH", `${reqs(A)}/${mine.id}`, { title: "x" })).status).toBe(404);
        expect((await call("DELETE", `${reqs(A)}/${mine.id}?confirm=1`)).status).toBe(404);
        expect((await call("POST", `${reqs(A)}/${mine.id}/tests`, { automated: [A.tests.get("search")] })).status).toBe(404);
        const foreign = await call("POST", `${reqs(B)}/${mine.id}/tests`, { automated: [A.tests.get("search")] });
        expect(foreign.status).toBe(404);
        expect(foreign.body.error).toMatch(/not one of this project's automated tests/);
        expect((await call("GET", `${reqs(B)}/${mine.id}`)).body.title).toBe("B's own");
        // A's list never shows B's requirement.
        expect((await call("GET", reqs(A))).body.requirements.some((r: any) => r.id === mine.id)).toBe(false);
    });

    it("lets a viewer read and refuses them every change", async () => {
        const as = { authorization: `Bearer ${viewer}` };
        expect((await call("GET", reqs(B), undefined, as)).status).toBe(200);
        expect((await call("GET", `${reqs(B)}/${mine.id}`, undefined, as)).status).toBe(200);
        expect((await call("GET", `/api/tests/${B.tests.get("pay")}/requirements`, undefined, as)).status).toBe(200);
        for (const [method, url, body] of [
            ["POST", reqs(B), { title: "x" }],
            ["PATCH", `${reqs(B)}/${mine.id}`, { title: "x" }],
            ["DELETE", `${reqs(B)}/${mine.id}?confirm=1`, undefined],
            ["POST", `${reqs(B)}/${mine.id}/tests`, { automated: [B.tests.get("pay")] }],
            ["POST", `${reqs(B)}/import/preview`, { text: "- REQ-1: x must y" }],
            ["POST", `${reqs(B)}/import/refine`, { text: "- REQ-1: x must y" }],
            ["POST", `${reqs(B)}/import`, { requirements: [{ title: "x" }] }],
        ] as const) {
            const r = await call(method, url, body, as);
            expect(r.status, `${method} ${url}`).toBe(403);
        }
        expect((await call("GET", `${reqs(B)}/${mine.id}`)).body.title).toBe("B's own");
    });
});
