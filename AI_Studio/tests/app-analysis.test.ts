/**
 * The application analysis on the platform: every source turned into a fragment, merged, rules carried forward, a version stored only
 * when something changed. Scripted model (no provider), in-memory database, a local object store (fast tier).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { LlmClient } from "../src/engine/llm/provider.js";
import type { AppModel as UnderstandingModel, PageModel } from "../src/engine/understanding/app-model.js";
import { AppAnalysis, type AnalysisInputs } from "../src/platform/app-analysis.js";
import { AppIntelStore } from "../src/platform/app-intel-store.js";
import { Db } from "../src/platform/db.js";
import { createObjectStore, type ObjectStore } from "../src/platform/object-store.js";
import { deleteProject } from "../src/platform/project-folders.js";

const at = "2026-11-16T09:00:00.000Z";
const SECRET = "abcd1234secretvalue";
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** A model double: for every document it is shown, one rule per line that says "must", quoting that line; it fails on "FAILNOW". */
function scripted(): LlmClient & { prompts: string[] } {
    const prompts: string[] = [];
    return {
        modelName: "scripted",
        prompts,
        async object<T extends z.ZodTypeAny>(args: { prompt: string; schema: T }): Promise<z.infer<T>> {
            prompts.push(args.prompt);
            if (args.prompt.includes("FAILNOW")) throw new Error("The provider did not answer.");
            const known = [...args.prompt.matchAll(/^([\w-]+): (.+)$/gm)].filter((m) => args.prompt.indexOf("<known-workflows>") >= 0 && m.index! < args.prompt.indexOf("</known-workflows>"));
            const rules = [];
            for (const d of args.prompt.matchAll(/<document ref="([^"]+)">\n([\s\S]*?)\n<\/document>/g)) {
                for (const l of d[2]!.split("\n")) {
                    const m = /^(\d+)\| (.*)$/.exec(l);
                    if (!m || !/must/.test(m[2]!)) continue;
                    const workflows = known.filter((k) => m[2]!.toLowerCase().includes(k[2]!.toLowerCase())).map((k) => k[1]!);
                    rules.push({ kind: "constraint", description: m[2]!.slice(0, 100), expected: m[2]!, doc: d[1], lines: [Number(m[1])], quote: m[2]!, confidence: 0.8, workflows });
                }
            }
            return args.schema.parse({ rules, workflows: [], roles: [], transitions: [] });
        },
    } as unknown as LlmClient & { prompts: string[] };
}

const page = (p: string, purpose: string): PageModel =>
    ({ url: `https://shop.test${p}`, path: p, title: p, type: "other", purpose, depth: 0, status: 200, headings: [], forms: [], components: [], links: [], aria: "", text: "", apiCalls: [], revealed: [], consoleErrors: [], discovery: 2 }) as unknown as PageModel;

const understanding = (pages: PageModel[]): UnderstandingModel =>
    ({
        url: "https://shop.test",
        origin: "https://shop.test",
        siteType: "ecommerce",
        purpose: "A shop",
        features: [],
        pages,
        navigation: [],
        apis: [{ method: "POST", path: "/api/cart/items", origin: "https://shop.test", statuses: [200], queryParams: [], source: "network", usedIn: ["/cart"] }],
        authentication: { required: false, mechanisms: [], loggedIn: false },
        journeys: [{ name: "Checkout", description: "Buy", steps: ["Open the cart", "Pay"], priority: "high", pages: ["/cart"], requiresAuth: false }],
        externalDependencies: [],
        documentedTestCases: [],
        stats: { pagesVisited: pages.length, pagesSkipped: 0, apisFound: 1, durationMs: 1 },
    }) as unknown as UnderstandingModel;

const OPENAPI = {
    openapi: "3.0.0",
    info: { title: "Shop", version: "1" },
    paths: { "/api/orders/{id}": { get: { responses: { "200": { description: "The order" }, "404": { description: `No such order. Use token=${SECRET}` } } } } },
};

/** The cart page also shows a control whose name carries a secret: what the crawl saw is stored only after redaction. */
const PAGES = [
    { ...page("/cart", "Shows the cart; a quantity must be between 1 and 10"), components: [{ role: "button", name: `Copy api_key=${SECRET}`, locatorHint: "" }] } as PageModel,
    page("/orders", "Lists orders that must be paid within 7 days"),
];

function inputs(over: Partial<AnalysisInputs> = {}): AnalysisInputs {
    return {
        exploration: { ref: "https://shop.test", model: understanding(PAGES) },
        openapi: { ref: "https://shop.test/openapi.json", read: async () => JSON.stringify(OPENAPI) },
        requirements: [{ ref: "REQ-1", title: "Cart size", description: "A cart must hold at most 50 lines.", acceptanceCriteria: "" }],
        tests: { cases: [{ ref: "TC-001", title: "Checkout", steps: [{ action: "Open the cart", expected: "The checkout total must show." }] }], scripts: [] },
        repositories: [],
        ...over,
    };
}

let db: Db;
let objects: ObjectStore;
let intel: AppIntelStore;
let analysis: AppAnalysis;
const PID = "p1";

beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-analysis-"));
    dirs.push(dir);
    db = new Db(":memory:");
    db.run("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)", "u-1", "one@people.example", "One", at, "owner", "active");
    db.run("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)", PID, "u-1", "Shop", at, at);
    objects = createObjectStore({ artifactsDir: dir });
    intel = new AppIntelStore(db.sql, () => at);
    analysis = new AppAnalysis({ sql: db.sql, store: objects, now: () => at });
});

const fragmentKeys = async () => (await objects.list(`${PID}/intel/`)).map((o) => o.key);

describe("a first analysis", () => {
    it("stores one version from every source, with unverified rules from the documents, tests and pages", async () => {
        const llm = scripted();
        const r = await analysis.run(PID, inputs(), { llm });
        expect(r).toMatchObject({ changed: true, version: 1 });
        const v = (await intel.latest(PID))!;
        expect(v.model.pages.map((p) => p.path).sort()).toEqual(["/cart", "/orders"]);
        expect(v.model.endpoints.map((e) => `${e.origin} ${e.method} ${e.path}`).sort()).toEqual(["documented GET /api/orders/{id}", "observed POST /api/cart/items"]);
        expect(v.appVersion).toEqual({ source: "unversioned", label: "", analysedAt: at });
        const rules = await intel.rules(PID);
        expect(rules.map((x) => x.expected).sort()).toEqual(
            ["A cart must hold at most 50 lines.", "Expected after step 1: The checkout total must show.", "Purpose: Lists orders that must be paid within 7 days", "Purpose: Shows the cart; a quantity must be between 1 and 10"].sort(),
        );
        expect(new Set(rules.map((x) => x.status))).toEqual(new Set(["unverified"]));
        const sources = await intel.sources(PID);
        expect(sources.every((s) => s.status === "processed" && s.fingerprint && s.modelVersionId === v.id)).toBe(true);
        expect(sources.map((s) => s.kind).sort()).toEqual(["exploration", "exploration", "existing_tests", "openapi", "requirements"].sort());
    });

    it("offers the workflows other sources found, so a rule can be linked to one", async () => {
        const llm = scripted();
        await analysis.run(PID, inputs({ requirements: [{ ref: "REQ-2", title: "Pay", description: "Checkout must take a card.", acceptanceCriteria: "" }] }), { llm });
        expect(llm.prompts.find((p) => p.includes("REQ-2"))).toMatch(/<known-workflows>[\s\S]*journey-1-checkout: Checkout/);
        const rule = (await intel.rules(PID)).find((x) => x.expected.includes("take a card"))!;
        expect(rule.workflows).toEqual(["journey-1-checkout"]);
    });
});

describe("analysing again", () => {
    it("with nothing changed stores no version and makes no AI call", async () => {
        await analysis.run(PID, inputs(), { llm: scripted() });
        const llm = scripted();
        const r = await analysis.run(PID, inputs(), { llm });
        expect(r).toMatchObject({ changed: false, version: null });
        expect(llm.prompts).toEqual([]);
        expect((await intel.versions(PID)).length).toBe(1);
    });

    it("re-reads only the source that changed, and carries every decision and every other source's rules", async () => {
        await analysis.run(PID, inputs(), { llm: scripted() });
        const pageRule = (await intel.rules(PID)).find((x) => x.expected.includes("between 1 and 10"))!;
        await intel.decide(PID, pageRule.id, "confirmed", "u-1");
        const llm = scripted();
        const r = await analysis.run(PID, inputs({ requirements: [{ ref: "REQ-1", title: "Cart size", description: "A cart must hold at most 60 lines.", acceptanceCriteria: "" }] }), { llm });
        expect(r).toMatchObject({ changed: true, version: 2 });
        expect(llm.prompts).toHaveLength(1);
        expect(llm.prompts[0]).toContain("REQ-1");
        const rules = await intel.rules(PID);
        expect(rules.find((x) => x.id === pageRule.id)).toMatchObject({ status: "confirmed", decidedBy: "u-1" });
        expect(rules.find((x) => x.id === pageRule.id)!.evidenceGone).toBeUndefined();
        expect(rules.filter((x) => x.evidenceGone).map((x) => x.expected)).toEqual(["A cart must hold at most 50 lines."]);
        expect(rules.find((x) => x.expected === "A cart must hold at most 60 lines.")!.status).toBe("unverified");
    });

    it("sends only the pages that changed, and keeps the rules of the pages that did not", async () => {
        await analysis.run(PID, inputs(), { llm: scripted() });
        const llm = scripted();
        const pages = [PAGES[0]!, page("/orders", "Lists orders that must be paid within 14 days")];
        await analysis.run(PID, inputs({ exploration: { ref: "https://shop.test", model: understanding(pages) } }), { llm });
        expect(llm.prompts).toHaveLength(1);
        expect(llm.prompts[0]).toContain("page:/orders");
        expect(llm.prompts[0]).not.toContain("page:/cart");
        const rules = await intel.rules(PID);
        expect(rules.find((x) => x.expected.includes("between 1 and 10"))!.evidenceGone).toBeUndefined();
        expect(rules.find((x) => x.expected.includes("within 7 days"))!.evidenceGone).toEqual({ version: 2, at });
    });

    it("marks a failed AI call on its source with a sentence and keeps what the other sources and the last good read found", async () => {
        await analysis.run(PID, inputs(), { llm: scripted() });
        const r = await analysis.run(PID, inputs({ requirements: [{ ref: "REQ-1", title: "Cart size", description: "FAILNOW: a cart must hold at most 60 lines.", acceptanceCriteria: "" }] }), { llm: scripted() });
        expect(r.failed).toEqual([expect.objectContaining({ kind: "requirements" })]);
        const req = (await intel.sources(PID)).find((s) => s.kind === "requirements")!;
        expect(req.status).toBe("failed");
        expect(req.error).toMatch(/failed: The provider did not answer\./);
        const v = (await intel.latest(PID))!;
        expect(v.model.missingContext.map((m) => m.text).join("\n")).toMatch(/requirements document .* could not be used/);
        expect((await intel.rules(PID)).filter((x) => x.evidenceGone)).toEqual([]);
        // Retried next time, because what was read last is not what is there now.
        const llm = scripted();
        await analysis.run(PID, inputs({ requirements: [{ ref: "REQ-1", title: "Cart size", description: "A cart must hold at most 60 lines.", acceptanceCriteria: "" }] }), { llm });
        expect(llm.prompts).toHaveLength(1);
        expect((await intel.sources(PID)).find((s) => s.kind === "requirements")!.status).toBe("processed");
    });
});

describe("without an AI key", () => {
    it("still builds the structure, says why rules are missing, and makes no call", async () => {
        const r = await analysis.run(PID, inputs(), { noAi: "You have no AI key." });
        expect(r).toMatchObject({ changed: true, version: 1 });
        const v = (await intel.latest(PID))!;
        expect(v.model.pages).toHaveLength(2);
        expect(v.model.endpoints).toHaveLength(2);
        expect(v.model.missingContext.map((m) => m.text)).toContain("Rules were not read from documents, tests or pages: You have no AI key.");
        expect(await intel.rules(PID)).toEqual([]);
        expect((await intel.sources(PID)).filter((s) => s.kind === "requirements").map((s) => s.status)).toEqual(["connected"]);
        expect((await analysis.run(PID, inputs(), { noAi: "You have no AI key." })).changed).toBe(false);
    });
});

describe("repositories", () => {
    const artefacts = (commit: string, readme: string) => ({
        ref: "https://git.test/shop.git",
        commit,
        read: async () => ({
            artefacts: [
                { kind: "requirements" as const, ref: `README.md@${commit}`, path: "README.md", text: readme },
                { kind: "openapi" as const, ref: `api/openapi.json@${commit}`, path: "api/openapi.json", text: JSON.stringify(OPENAPI) },
            ],
            skipped: [],
            notes: [],
        }),
    });

    it("read every artefact through the redaction before extraction and storage, each as its own source", async () => {
        const llm = scripted();
        await analysis.run(PID, inputs({ repositories: [artefacts("c1", `# Shop\nAn order must be paid. Admin password: ${SECRET}\napi_key=${SECRET}`)] }), { llm });
        expect(llm.prompts.join("\n")).not.toContain(SECRET);
        const sources = await intel.sources(PID);
        expect(sources.filter((s) => s.ref.endsWith("@c1")).map((s) => `${s.kind} ${s.ref}`).sort()).toEqual(["openapi api/openapi.json@c1", "requirements README.md@c1"]);
        expect(sources.find((s) => s.kind === "repository")).toMatchObject({ ref: "https://git.test/shop.git", status: "processed" });
        expect((await intel.rules(PID)).some((x) => x.sourceRef.startsWith("README.md"))).toBe(true);
    });

    it("are not read again while the commit is the same, and a new commit re-reads only artefacts whose text changed", async () => {
        const first = artefacts("c1", "# Shop\nAn order must be paid.");
        await analysis.run(PID, inputs({ repositories: [first] }), { llm: scripted() });
        let reads = 0;
        const same = { ...first, read: async () => (reads++, first.read()) };
        expect((await analysis.run(PID, inputs({ repositories: [same] }), { llm: scripted() })).changed).toBe(false);
        expect(reads).toBe(0);
        const llm = scripted();
        await analysis.run(PID, inputs({ repositories: [artefacts("c2", "# Shop\nAn order must be paid.")] }), { llm });
        expect(llm.prompts).toEqual([]);
        expect((await intel.sources(PID)).filter((s) => s.ref.includes("@")).map((s) => s.ref).sort()).toEqual(["README.md@c2", "api/openapi.json@c2"]);
    });
});

describe("stored fragments", () => {
    it("never hold a secret, and neither does the stored model", async () => {
        await analysis.run(PID, inputs(), { llm: scripted() });
        for (const key of await fragmentKeys()) expect((await objects.getBytes(key)).toString("utf8"), key).not.toContain(SECRET);
        expect(JSON.stringify((await intel.latest(PID))!.model)).not.toContain(SECRET);
        expect(JSON.stringify((await intel.latest(PID))!.model)).toContain(`"name":"Copy [hidden]"`);
    });

    it("go with their source and with their project", async () => {
        await analysis.run(PID, inputs(), { llm: scripted() });
        expect((await fragmentKeys()).length).toBe(5);
        await analysis.run(PID, inputs({ openapi: undefined }), { llm: scripted() });
        expect((await intel.sources(PID)).some((s) => s.kind === "openapi")).toBe(false);
        expect((await fragmentKeys()).length).toBe(4);
        await deleteProject(db, objects, PID);
        expect(await fragmentKeys()).toEqual([]);
    });
});

describe("gathering a project's inputs", () => {
    it("reads the latest exploration, the saved OpenAPI address, active requirements, written cases and test scripts", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-analysis-gather-"));
        dirs.push(dir);
        const { bootstrap } = await import("../src/platform/bootstrap.js");
        const { loadConfig } = await import("../src/config.js");
        const { RequirementStore } = await import("../src/platform/requirement-store.js");
        const { ManualCaseStore } = await import("../src/platform/manual-case-store.js");
        const { AgentInputsStore } = await import("../src/platform/agent-inputs-store.js");
        const { secretBoxOf } = await import("../src/platform/ai-config.js");
        const { gatherAnalysisInputs } = await import("../src/platform/app-analysis.js");
        const p = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", SECRET_KEY: "app-analysis-secret-key-0123456789abcdef" }));
        try {
            const owner = p.db.get<{ id: string }>("SELECT id FROM users LIMIT 1")!.id;
            p.db.run("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)", "gp", owner, "Gather", at, at);
            // A saved sign-in whose password a person also typed into a requirement and a case: it never reaches a prompt or storage.
            const appId = p.repo.createApplication("gp", "https://shop.test", {}, { username: "qa.user", password: "sunflower99" } as never);
            p.repo.setAppModel(appId, understanding(PAGES));
            new AgentInputsStore(p.db, secretBoxOf(p.config)).save("gp", { site: "https://shop.test", openApiUrl: "https://shop.test/openapi.json" });
            const reqs = new RequirementStore(p.sql);
            await reqs.create("gp", { title: "Cart size", description: "A cart must hold at most 50 lines." }, "typed");
            await reqs.create("gp", { title: "Sign in", description: "Signing in as qa.user with sunflower99 must open the dashboard." }, "typed");
            await reqs.create("gp", { title: "Old rule", description: "Coupons must stack.", status: "retired" }, "typed");
            const { ManualCaseInputSchema } = await import("../src/engine/manual/cases.js");
            new ManualCaseStore(p.db).createCase("gp", ManualCaseInputSchema.parse({ title: "Checkout", steps: [{ action: "Open the cart", expected: "The total must show." }] }));
            // Written by the AI from a requirement (linked as generated): not a source.
            const gen = new ManualCaseStore(p.db).addGenerated("gp", [ManualCaseInputSchema.parse({ title: "AI case", steps: [{ action: "Pay", expected: "The receipt must show." }] })]).created[0]!;
            const req1 = (await reqs.list("gp"))[0]!;
            await reqs.link("gp", req1.id, { automated: [], manual: [gen.id] }, "generated");
            // Scripts: one a person wrote, one an exploration wrote.
            const { TestSpecSchema } = await import("../src/engine/spec/schema.js");
            const suite = p.repo.getOrCreateSuite("gp", "Main", "main");
            const spec = (key: string, origin: string, expected: string) =>
                TestSpecSchema.parse({ testId: key, title: key, kind: "web", category: "General", steps: [{ action: "navigate", url: "/cart" }], expectedResults: [expected], source: { origin } });
            p.repo.insertTest({ projectId: "gp", suiteId: suite, jobId: null, spec: spec("WEB-001", "manual", "The basket must keep its lines."), framework: "playwright", validationStatus: "PENDING" });
            p.repo.insertTest({ projectId: "gp", suiteId: suite, jobId: null, spec: spec("WEB-002", "exploration", "The order total must show 0.00 after paying."), framework: "playwright", validationStatus: "PENDING" });
            // Written by the AI for a case, saved with a person-looking origin: recognised by who wrote it.
            const { withVersionSource } = await import("../src/platform/review-store.js");
            withVersionSource("ai", () => p.repo.insertTest({ projectId: "gp", suiteId: suite, jobId: null, spec: spec("WEB-003", "imported", "The account must lock after 3 failed attempts."), framework: "playwright", validationStatus: "PENDING" }));
            const asked: string[] = [];
            const inputs = await gatherAnalysisInputs(p, "gp", { fetchText: async (u) => (asked.push(u), JSON.stringify(OPENAPI)) });
            expect(inputs.exploration).toMatchObject({ ref: "https://shop.test" });
            expect(inputs.requirements.map((r) => r.title)).toEqual(["Cart size", "Sign in"]);
            // Only what a person wrote or imported is read as an existing test; what the AI or an exploration wrote is not read at all.
            expect(inputs.tests.cases).toEqual([expect.objectContaining({ title: "Checkout", steps: [{ action: "Open the cart", expected: "The total must show." }] })]);
            expect(inputs.tests.scripts.map((x) => x.key)).toEqual(["WEB-001"]);
            expect(inputs.repositories).toEqual([]);
            expect(inputs.secrets).toContain("sunflower99");
            const llm = scripted();
            const r = await new AppAnalysis({ sql: p.sql, store: p.store, now: () => at }).run("gp", inputs, { llm });
            expect(llm.prompts.join("\n")).not.toContain("sunflower99");
            for (const o of await p.store.list("gp/intel/")) expect((await p.store.getBytes(o.key)).toString("utf8"), o.key).not.toContain("sunflower99");
            expect(asked).toEqual(["https://shop.test/openapi.json"]);
            expect(r).toMatchObject({ changed: true, version: 1, failed: [] });
            const expectations = (await new AppIntelStore(p.sql).rules("gp")).map((x) => x.expected).join("\n");
            expect(expectations).toContain("The basket must keep its lines.");
            expect(expectations).not.toContain("0.00 after paying");
            expect(expectations).not.toContain("receipt");
            expect(expectations).not.toContain("lock after 3 failed");
            expect(expectations).not.toContain("sunflower99");
        } finally {
            p.db.close();
        }
    }, 60_000);

    it("refuses an OpenAPI document over the size cap with a sentence", async () => {
        const { fetchOpenApiText, OPENAPI_LIMITS } = await import("../src/platform/app-analysis.js");
        const big = (async () => new Response("x".repeat(OPENAPI_LIMITS.bytes + 1))) as unknown as typeof fetch;
        await expect(fetchOpenApiText("https://shop.test/openapi.json", big)).rejects.toThrow(/larger than 2 MB/);
        const missing = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
        await expect(fetchOpenApiText("https://shop.test/openapi.json", missing)).rejects.toThrow(/answered 404/);
    });
});

describe("stopping an analysis", () => {
    it("does not wait for an AI call in flight, and keeps nothing of the run", async () => {
        let calls = 0;
        const never = { modelName: "slow", object: () => (calls++, new Promise(() => undefined)) } as unknown as LlmClient;
        const stop = new AbortController();
        const run = analysis.run(PID, inputs(), { llm: never, signal: stop.signal });
        for (let i = 0; i < 100 && calls === 0; i++) await new Promise((r) => setTimeout(r, 5));
        expect(calls).toBe(1);
        stop.abort();
        await expect(run).rejects.toThrow("The reading was stopped before it finished.");
        expect(calls).toBe(1);
        expect(await intel.latest(PID)).toBeUndefined();
    });
});

describe("storing an analysis", () => {
    it("keeps the version and its rules together: a fault leaves neither, and the next analysis stores both", async () => {
        const spy = vi.spyOn(AppIntelStore.prototype, "saveCarried").mockRejectedValueOnce(new Error("database is locked"));
        await expect(analysis.run(PID, inputs(), { llm: scripted() })).rejects.toThrow(/locked/);
        spy.mockRestore();
        expect(await intel.latest(PID)).toBeUndefined();
        const again = await analysis.run(PID, inputs(), { llm: scripted() });
        expect(again).toMatchObject({ changed: true, version: 1 });
        expect((await intel.rules(PID)).length).toBeGreaterThan(0);
    });

    it("stops during a repository read that does not answer", async () => {
        const stop = new AbortController();
        const run = analysis.run(PID, inputs({ repositories: [{ ref: "https://git.test/r.git", commit: "a".repeat(40), read: () => new Promise(() => undefined) }] }), { llm: scripted(), signal: stop.signal });
        setTimeout(() => stop.abort(), 30);
        await expect(run).rejects.toThrow("The reading was stopped before it finished.");
        expect(await intel.latest(PID)).toBeUndefined();
    });
});
