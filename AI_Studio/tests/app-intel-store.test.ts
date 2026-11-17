/**
 * Application intelligence (testing-engine Phase 1): the versioned model, business rules with their source, the person-only decision,
 * the read routes, and that nothing in test generation reads it (no browser, no model: fast tier).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { AppModelSchema, diffModels, explicitnessOf, RuleSchema, ruleFingerprint } from "../src/engine/intel/model.js";
import { AppIntelStore, MAX_MODEL_BYTES } from "../src/platform/app-intel-store.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { ONLY_A_PERSON } from "../src/platform/routes/app-intel.js";

const KEY = "app-intel-test-key-0123456789";
const at = "2026-11-16T09:00:00.000Z";
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

describe("rules across analyses", () => {
    it("are stored with their fingerprint and found by it", async () => {
        const r = await store.addRule(projectId, rule({ ref: "R-3", expected: "An order has at least one line." }));
        expect(r.fingerprint).toBe(ruleFingerprint(RuleSchema.parse(rule({ ref: "R-3", expected: "An order has at least one line." }))));
        const byFp = await store.rulesByFingerprint(projectId);
        expect(byFp.get(r.fingerprint)!.map((x) => x.ref)).toEqual(["R-3"]);
    });

    it("stored before fingerprints existed get theirs worked out when read", async () => {
        const r = await store.addRule(projectId, rule({ ref: "R-4", expected: "A coupon applies once." }));
        platform.db.run("UPDATE app_rules SET fingerprint = NULL WHERE id = ?", r.id);
        expect((await store.rule(projectId, r.id))!.fingerprint).toBe(r.fingerprint);
        expect((await store.rulesByFingerprint(projectId)).get(r.fingerprint)!.map((x) => x.id)).toEqual([r.id]);
    });

    it("whose evidence disappeared are marked for a person, keeping their decision", async () => {
        const r = await store.addRule(projectId, rule({ ref: "R-5", expected: "Shipping is free over 50." }));
        await store.decide(projectId, r.id, "confirmed", "person-1");
        const gone = await store.markEvidenceGone(projectId, r.id, 7);
        expect(gone).toMatchObject({ status: "confirmed", decidedBy: "person-1", evidenceGone: { version: 7, at: expect.any(String) }, workflows: ["checkout"] });
        // Found again with the same expectation: the mark goes, the decision stays.
        const again = await store.addRule(projectId, rule({ ref: "R-5", expected: "Shipping is free over 50." }));
        expect(again).toMatchObject({ status: "confirmed", decidedBy: "person-1" });
        expect(again.evidenceGone).toBeUndefined();
    });

    it("keep their status and decisions when a new analysis is stored", async () => {
        const before = (await store.rules(projectId)).map((r) => [r.ref, r.status, r.decidedBy]);
        await store.addVersion({ projectId, model: model() });
        expect((await store.rules(projectId)).map((r) => [r.ref, r.status, r.decidedBy])).toEqual(before);
    });

    it("keep a person's decision only for the exact rule decided: a new kind or new links make it a new, unverified rule", async () => {
        const base = rule({ ref: "R-7", expected: "A refund needs a reason." });
        const r = await store.addRule(projectId, base);
        await store.decide(projectId, r.id, "confirmed", "person-1");
        // Reworded only: the same rule, the decision stays.
        expect(await store.addRule(projectId, { ...base, description: "Refund reasons" })).toMatchObject({ status: "confirmed", decidedBy: "person-1" });
        expect(await store.addRule(projectId, { ...base, kind: "invariant" })).toMatchObject({ status: "unverified", decidedBy: null });
        await store.decide(projectId, r.id, "confirmed", "person-1");
        expect(await store.addRule(projectId, { ...base, kind: "invariant", workflows: ["returns"] })).toMatchObject({ status: "unverified", decidedBy: null });
    });

    it("are saved from an analysis by fingerprint: a carried rule keeps its stored status, a new one is unverified whatever it says", async () => {
        const decided = await store.addRule(projectId, rule({ ref: "R-8", expected: "Stock never goes below zero." }));
        await store.decide(projectId, decided.id, "rejected", "person-1");
        const carried = { ...RuleSchema.parse(rule({ ref: "R-8", expected: "Stock never goes below zero.", description: "Stock floor, reworded" })), id: decided.id, fingerprint: decided.fingerprint, status: "unverified" as const };
        const fresh = RuleSchema.parse(rule({ ref: "R-new-1", expected: "A gift card cannot pay for a gift card." }));
        const res = await store.saveCarried(projectId, [carried, { ...fresh, fingerprint: ruleFingerprint(fresh), status: "confirmed" as const }]);
        expect(res).toEqual({ saved: 2, leftOut: 0 });
        // The decided wording stays; the new one is shown beside it.
        expect(await store.rule(projectId, decided.id)).toMatchObject({ status: "rejected", decidedBy: "person-1", description: "The cart total", rewordedDescription: "Stock floor, reworded" });
        const added = (await store.rules(projectId)).find((x) => x.fingerprint === ruleFingerprint(fresh))!;
        expect(added).toMatchObject({ ref: "R-new-1", status: "unverified", decidedBy: null });
    });

    it("from different sources never overwrite each other through the same ref", async () => {
        const a = RuleSchema.parse(rule({ ref: "R-same", expected: "Orders over 1,000 need approval." }));
        const b = RuleSchema.parse(rule({ ref: "R-same", expected: "Orders are numbered without gaps." }));
        await store.saveCarried(projectId, [{ ...a, fingerprint: ruleFingerprint(a), status: "unverified" }]);
        const stored = (await store.rules(projectId)).find((x) => x.fingerprint === ruleFingerprint(a))!;
        await store.decide(projectId, stored.id, "confirmed", "person-1");
        await store.saveCarried(projectId, [{ ...b, fingerprint: ruleFingerprint(b), status: "unverified" }]);
        const all = await store.rules(projectId);
        expect(all.find((x) => x.id === stored.id)).toMatchObject({ expected: "Orders over 1,000 need approval.", status: "confirmed" });
        const other = all.find((x) => x.fingerprint === ruleFingerprint(b))!;
        expect(other.ref).not.toBe("R-same");
        expect(other.status).toBe("unverified");
    });

    it("with the same fingerprint are all returned, none dropped", async () => {
        const a = await store.addRule(projectId, rule({ ref: "R-dup-1", expected: "A cart holds at most 50 lines." }));
        const b = await store.addRule(projectId, rule({ ref: "R-dup-2", expected: " A cart holds  at most 50 lines." }));
        expect(b.fingerprint).toBe(a.fingerprint);
        expect((await store.rulesByFingerprint(projectId)).get(a.fingerprint)!.map((x) => x.ref).sort()).toEqual(["R-dup-1", "R-dup-2"]);
    });

    it("an evidence-gone mark is kept when an analysis carries the rule as still gone, and cleared when it is found again", async () => {
        const r = await store.addRule(projectId, rule({ ref: "R-9", expected: "Prices include tax." }));
        const base = RuleSchema.parse(rule({ ref: "R-9", expected: "Prices include tax." }));
        await store.saveCarried(projectId, [{ ...base, id: r.id, fingerprint: r.fingerprint, status: "unverified", evidenceGone: { version: 3, at } }]);
        expect((await store.rule(projectId, r.id))!.evidenceGone).toEqual({ version: 3, at });
        await store.saveCarried(projectId, [{ ...base, id: r.id, fingerprint: r.fingerprint, status: "unverified" }]);
        expect((await store.rule(projectId, r.id))!.evidenceGone).toBeUndefined();
    });

    it("keep the wording a person decided about; a later rewording is shown beside it, never vouched for", async () => {
        const base = rule({ ref: "R-word", expected: "A guest cannot delete another user's order.", description: "A guest cannot delete another user's order" });
        const r = await store.addRule(projectId, base);
        await store.decide(projectId, r.id, "confirmed", "person-1", r.fingerprint);
        const carried = { ...RuleSchema.parse({ ...base, description: "An admin cannot delete any order" }), id: r.id, fingerprint: r.fingerprint, status: "unverified" as const };
        await store.saveCarried(projectId, [carried]);
        const after = (await store.rule(projectId, r.id))!;
        expect(after).toMatchObject({ status: "confirmed", description: "A guest cannot delete another user's order", rewordedDescription: "An admin cannot delete any order" });
        // The same through a re-add by ref.
        await store.addRule(projectId, { ...base, description: "Guests and orders" });
        expect((await store.rule(projectId, r.id))!).toMatchObject({ description: "A guest cannot delete another user's order", rewordedDescription: "Guests and orders" });
        // Undone: nobody vouches for the old wording any more, so the newest one becomes the rule's.
        const undone = (await store.decide(projectId, r.id, "unverified", "person-1"))!;
        expect(undone).toMatchObject({ status: "unverified", description: "Guests and orders" });
        expect(undone.rewordedDescription).toBeUndefined();
    });

    it("re-read from unchanged text and reworded keep their decision; worded the same from changed text, they do not take it", async () => {
        // Through the analysis path: carry-forward matches by the anchor (the text the rule was read from), the store keeps what it matched.
        const { carryForward } = await import("../src/engine/intel/carry-forward.js");
        const h = (s: string) => createHash("sha256").update(s).digest("hex");
        const anchor = { text: h("doc 2.9"), lines: h("lines 2.9") };
        const first = RuleSchema.parse(rule({ ref: "R-anc-1", kind: "workflow", description: "Sign-out", expected: "After sign-out the person is a visitor.", anchor }));
        await store.saveCarried(projectId, [{ ...first, fingerprint: ruleFingerprint(first), status: "unverified" }]);
        const r = (await store.rules(projectId)).find((x) => x.ref === "R-anc-1")!;
        expect(r.anchor).toEqual(anchor);
        await store.decide(projectId, r.id, "confirmed", "person-1", r.fingerprint);

        const reworded = RuleSchema.parse(rule({ ref: "R-anc-2", kind: "transition", description: "Signing out", expected: "Once signed out, the person is a visitor again.", anchor }));
        const before = (await store.rules(projectId)).filter((x) => x.id === r.id);
        await store.saveCarried(projectId, carryForward(before, [reworded], { version: 2, at }).rules);
        const kept = (await store.rule(projectId, r.id))!;
        expect(kept).toMatchObject({ status: "confirmed", decidedBy: "person-1", expected: "After sign-out the person is a visitor.", rewordedExpected: "Once signed out, the person is a visitor again." });
        expect(kept.evidenceGone).toBeUndefined();
        // The decision still names what the person read.
        expect(kept.fingerprint).toBe(r.fingerprint);

        // The requirement was edited; the model words the rule exactly as the person confirmed it.
        const edited = RuleSchema.parse(rule({ ref: "R-anc-3", kind: "workflow", description: "Sign-out", expected: "After sign-out the person is a visitor.", anchor: { text: h("doc 2.9 edited"), lines: h("lines 2.9 edited") } }));
        await store.saveCarried(projectId, carryForward([kept], [edited], { version: 3, at }).rules);
        const old = (await store.rule(projectId, r.id))!;
        expect(old).toMatchObject({ status: "confirmed", evidenceGone: { version: 3, at } });
        const fresh = (await store.rules(projectId)).filter((x) => x.anchor?.text === h("doc 2.9 edited"));
        expect(fresh.map((x) => [x.status, x.decidedBy])).toEqual([["unverified", null]]);
    });

    it("of another project are never read or written by id", async () => {
        const res = await app.inject({ method: "POST", url: "/api/projects", headers: { "x-api-key": KEY }, payload: { name: "Other shop", platforms: ["web"], testingModes: ["agent"] } });
        const other = (res.json() as { id: string }).id;
        const mine = (await store.rules(projectId))[0]!;
        expect(await store.rule(other, mine.id)).toBeUndefined();
        expect(await store.markEvidenceGone(other, mine.id, 1)).toBeUndefined();
        expect(await store.decide(other, mine.id, "rejected", "person-1")).toBeUndefined();
        expect((await store.rulesByFingerprint(other)).size).toBe(0);
        expect((await store.rule(projectId, mine.id))!.status).toBe(mine.status);
        const theirs = await store.addVersion({ projectId: other, model: {} });
        await expect(store.addRule(projectId, rule({ ref: "R-6" }), { modelVersionId: theirs.id })).rejects.toThrow(/not found/);
    });

    it("say so, never truncate silently, when a model is over the size cap", async () => {
        const big = { pages: Array.from({ length: 2000 }, (_, i) => ({ id: `p${i}`, path: `/p/${i}`, elements: Array.from({ length: 12 }, () => ({ role: "button", name: "x".repeat(200), kind: "button" })) })) };
        await expect(store.addVersion({ projectId, model: big })).rejects.toThrow(`An application model is at most ${MAX_MODEL_BYTES} bytes.`);
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
                else if (/\.ts$/.test(e.name) && /from "[^"]*(?:\/intel\/[\w/-]+|app-intel-store|\/app-intel|app-analysis)\.js"/.test(fs.readFileSync(p, "utf8"))) users.push(path.relative(root, p));
            }
        };
        walk(root);
        // The intelligence engine's own files and the understanding benchmark read it; test generation does not. The repeat-run benchmark
        // reads only the extraction limits; web case scripts are now built in the browser, so case-script.ts no longer reads the model.
        // The AI response cache reads only the rule-reading answer's schema, to check a stored answer before handing it back.
        const outside = users.filter((u) => !u.startsWith("engine/intel/") && !u.startsWith("eval/bench/understanding/"));
        expect(outside.sort()).toEqual(["engine/explore/objectives.ts", "engine/planning/planner.ts", "eval/bench/repeat/run.ts", "eval/quality/score.ts", "platform/app-analysis.ts", "platform/app-intel-store.ts", "platform/db.ts", "platform/job-runner.ts", "platform/llm-response-cache-runner.ts", "platform/routes/app-intel.ts", "platform/routes/index.ts", "platform/routes/requirements.ts"].sort());
    });
});
