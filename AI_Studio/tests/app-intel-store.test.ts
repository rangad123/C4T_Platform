/**
 * Application intelligence (testing-engine Phase 1): the versioned model, business rules with their source, the person-only decision,
 * the read routes, and that nothing in test generation reads it (no browser, no model: fast tier).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { AppModelSchema, diffModels, explicitnessOf, RuleSchema } from "../src/engine/intel/model.js";
import { AppIntelStore } from "../src/platform/app-intel-store.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { ONLY_A_PERSON } from "../src/platform/routes/app-intel.js";

const KEY = "app-intel-test-key-0123456789";
let dataDir: string;
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let store: AppIntelStore;
let projectId: string;

const rule = (over: Record<string, unknown> = {}) => ({
    ref: "R-1",
    kind: "calculation",
    description: "The cart total",
    expected: "The total equals the sum of each line's price times quantity, minus the discount.",
    sourceType: "requirement",
    sourceRef: "REQ-4",
    evidence: [{ kind: "quote", ref: "REQ-4", excerpt: "Total = sum of lines - discount" }],
    explicitness: "explicit",
    confidence: 0.9,
    workflows: ["checkout"],
    ...over,
});

const model = (over: Record<string, unknown> = {}) => ({
    appType: "e-commerce",
    contextSources: ["url", "crawl", "requirements"],
    pages: [{ id: "cart", path: "/cart", purpose: "Shows the cart", elements: [{ role: "button", name: "Checkout", kind: "button" }] }],
    workflows: [{ id: "checkout", name: "Checkout", steps: [{ order: 0, action: "Open the cart", page: "cart" }], preconditions: ["Signed in"], postconditions: ["An order exists"], sourceType: "requirement" }],
    entities: [{ id: "cart", name: "Cart", fields: [{ name: "quantity", type: "integer", constraints: ["min 1"] }] }, { id: "item", name: "CartItem" }],
    relationships: [{ from: "cart", to: "item", kind: "has_many", evidence: [{ kind: "openapi", ref: "GET /api/cart" }] }],
    scenarios: [{ id: "S-1", description: "Totals", objective: "The total is right", expectedOutcomes: [{ text: "Total is 30.00", sourceType: "requirement", ruleRef: "R-1" }], rules: ["R-1"] }],
    ...over,
});

beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-app-intel-"));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", API_KEY: KEY, SECRET_KEY: "app-intel-secret-key-0123456789abcdef" }));
    app = await buildServer(platform);
    await app.ready();
    store = new AppIntelStore(platform.db.sql);
    const res = await app.inject({ method: "POST", url: "/api/projects", headers: { "x-api-key": KEY }, payload: { name: "Intel shop", platforms: ["web"], testingModes: ["agent"] } });
    expect(res.statusCode).toBeLessThan(300);
    projectId = (res.json() as { id: string }).id;
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the model's rules about sources", () => {
    it("works out explicit or inferred from the source, and refuses the wrong one", () => {
        expect(explicitnessOf("requirement")).toBe("explicit");
        expect(explicitnessOf("inferred")).toBe("inferred");
        expect(RuleSchema.safeParse(rule()).success).toBe(true);
        expect(RuleSchema.safeParse(rule({ sourceType: "inferred", explicitness: "explicit" })).success).toBe(false);
        expect(RuleSchema.safeParse(rule({ sourceType: "requirement", explicitness: "inferred" })).success).toBe(false);
        expect(RuleSchema.safeParse(rule({ sourceType: "inferred", explicitness: "inferred", sourceRef: "", evidence: [] })).success).toBe(true);
    });

    it("never takes what the application did as expected behaviour", () => {
        const r = RuleSchema.safeParse(rule({ sourceType: "observed", explicitness: "inferred" }));
        expect(r.success).toBe(false);
        expect(JSON.stringify(r.error?.issues)).toMatch(/not a source of expected behaviour/);
    });

    it("wants a reference or evidence for an explicit rule, and evidence for every relationship", () => {
        expect(RuleSchema.safeParse(rule({ sourceRef: "", evidence: [] })).success).toBe(false);
        expect(RuleSchema.safeParse(rule({ sourceType: "user_confirmed", sourceRef: "", evidence: [] })).success).toBe(true);
        expect(AppModelSchema.safeParse(model({ relationships: [{ from: "cart", to: "item", kind: "has_many", evidence: [] }] })).success).toBe(false);
    });
});

describe("versioned application models", () => {
    it("numbers each analysis, keeps it unchanged, and records what changed", async () => {
        const v1 = await store.addVersion({ projectId, model: model(), note: "first" });
        expect(v1.version).toBe(1);
        expect(v1.diff).toBeNull();
        const v2 = await store.addVersion({ projectId, model: model({ pages: [...model().pages as object[], { id: "orders", path: "/orders" }], entities: [{ id: "cart", name: "Cart" }] }) });
        expect(v2.version).toBe(2);
        expect(v2.diff).toEqual(diffModels(v1.model, v2.model));
        expect(v2.diff!.pages.added).toEqual(["orders"]);
        expect(v2.diff!.entities.removed).toEqual(["item"]);
        expect((await store.version(projectId, 1))!.model).toEqual(v1.model);
        expect((await store.latest(projectId))!.version).toBe(2);
        expect((await store.versions(projectId)).map((v) => v.version)).toEqual([2, 1]);
    });

    it("refuses a model that does not fit the shape", async () => {
        await expect(store.addVersion({ projectId, model: { pages: [{ path: "/no-id" }] } })).rejects.toThrow();
    });

    it("keeps a scenario's expected outcomes with their sources", async () => {
        const s = (await store.latest(projectId))!.model.scenarios[0]!;
        expect(s.expectedOutcomes[0]).toMatchObject({ sourceType: "requirement", ruleRef: "R-1" });
    });
});

describe("business rules", () => {
    it("are always added unverified, whatever is sent, and keep their source and evidence", async () => {
        const r = await store.addRule(projectId, { ...rule(), status: "confirmed" } as never).catch((e: Error) => e);
        expect(r).toBeInstanceOf(Error); // unknown field refused by the strict schema
        const added = await store.addRule(projectId, rule());
        expect(added).toMatchObject({ ref: "R-1", status: "unverified", explicitness: "explicit", sourceType: "requirement", sourceRef: "REQ-4", decidedBy: null });
        expect(added.evidence[0]).toMatchObject({ kind: "quote", ref: "REQ-4" });
        const inferred = await store.addRule(projectId, rule({ ref: "R-2", sourceType: "inferred", explicitness: "inferred", sourceRef: "", evidence: [], confidence: 0.4, kind: "transition" }));
        expect(inferred.status).toBe("unverified");
        expect((await store.rules(projectId, { explicitness: "inferred" })).map((x) => x.ref)).toEqual(["R-2"]);
    });

    it("become confirmed only by a person, and go back to unverified when what they expect changes", async () => {
        const r = (await store.rules(projectId)).find((x) => x.ref === "R-2")!;
        await expect(store.decide(projectId, r.id, "confirmed", "")).rejects.toThrow(/Only a person/);
        const confirmed = await store.decide(projectId, r.id, "confirmed", "person-1");
        expect(confirmed).toMatchObject({ status: "confirmed", decidedBy: "person-1" });
        // The same text again keeps the decision; a new expectation clears it.
        expect((await store.addRule(projectId, rule({ ref: "R-2", sourceType: "inferred", explicitness: "inferred", sourceRef: "", evidence: [], confidence: 0.4, kind: "transition" }))).status).toBe("confirmed");
        const changed = await store.addRule(projectId, rule({ ref: "R-2", sourceType: "inferred", explicitness: "inferred", sourceRef: "", evidence: [], confidence: 0.5, kind: "transition", expected: "A shipped order cannot go back to placed." }));
        expect(changed).toMatchObject({ status: "unverified", decidedBy: null });
    });
});

describe("the routes", () => {
    const get = (url: string) => app.inject({ method: "GET", url, headers: { "x-api-key": KEY } });

    it("read versions, a version and rules", async () => {
        expect((await get(`/api/projects/${projectId}/intel/models`)).json().versions).toHaveLength(2);
        expect((await get(`/api/projects/${projectId}/intel/models/latest`)).json().version).toBe(2);
        expect((await get(`/api/projects/${projectId}/intel/models/1`)).json().version).toBe(1);
        expect((await get(`/api/projects/${projectId}/intel/models/9`)).statusCode).toBe(404);
        expect((await get(`/api/projects/${projectId}/intel/models/x;drop`)).statusCode).toBe(404);
        expect((await get(`/api/projects/${projectId}/intel/rules?status=unverified`)).json().rules.map((r: { ref: string }) => r.ref)).toEqual(["R-1", "R-2"]);
        expect((await get(`/api/projects/${projectId}/intel/rules?status=nope`)).statusCode).toBe(400);
        expect((await get(`/api/projects/no-such-project/intel/rules`)).statusCode).toBe(404);
    });

    it("refuse a decision from the shared access key: it is no person", async () => {
        const r = (await store.rules(projectId))[0]!;
        const res = await app.inject({ method: "PUT", url: `/api/projects/${projectId}/intel/rules/${r.id}/decision`, headers: { "x-api-key": KEY }, payload: { status: "confirmed" } });
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toBe(ONLY_A_PERSON);
        expect((await store.rule(projectId, r.id))!.status).toBe("unverified");
    });
});

describe("nothing in test generation reads it yet", () => {
    it("is imported only by its own store, its route and the migration list", () => {
        const root = path.resolve(__dirname, "../src");
        const users: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (/\.ts$/.test(e.name) && /intel\/model\.js|app-intel-store\.js|routes\/app-intel\.js|\.\/app-intel\.js/.test(fs.readFileSync(p, "utf8"))) users.push(path.relative(root, p));
            }
        };
        walk(root);
        expect(users.sort()).toEqual(["eval/quality/score.ts", "platform/app-intel-store.ts", "platform/db.ts", "platform/routes/app-intel.ts", "platform/routes/index.ts"].sort());
    });
});
