/**
 * Generated test data, its cleanup and the AI screen review default, without a browser or a real model (fast tier).
 *
 * Covers: realistic values per field (type, autocomplete, name, label, options, pattern, limits), numbers and dates in range,
 * uniqueness and the run tag, determinism with a seed, boundary / invalid values; the planner is told about generated data only
 * when data-changing tests are on; the authoring tool records the run tag; tagged records are removed through a local delete
 * endpoint and an uncleanable tag is said in plain words; AI screen review per level and model capability, an explicit off wins.
 * Ports: local sample API 9270.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext, EngineEvent } from "../src/engine/context.js";
import { runTagOf } from "../src/engine/cleanup/helper.js";
import { leftBehindByTag, parseCreatedLog } from "../src/engine/cleanup/ledger.js";
import { CleanupCollector, finishCleanup } from "../src/engine/cleanup/run.js";
import { LEVEL_SETTINGS, visionOn } from "../src/engine/levels.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { planFamilies } from "../src/engine/planning/preview.js";
import { planScenarios } from "../src/engine/planning/planner.js";
import { createTestData, fieldKind, makeRunTag, RUN_TAG, TEST_EMAIL_DOMAIN, testValueTool } from "../src/engine/testdata/generate.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { applyAgentChoice } from "../src/platform/testing-agents.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";

const NOW = new Date("2026-06-15T12:00:00Z");
const gen = (seed = "s1") => createTestData({ seed, now: NOW });

describe("the test data generator", () => {
    it("knows what a field asks for from its type, autocomplete, name and label", () => {
        expect(fieldKind({ type: "email" })).toBe("email");
        expect(fieldKind({ type: "tel" })).toBe("phone");
        expect(fieldKind({ autocomplete: "given-name" })).toBe("firstName");
        expect(fieldKind({ autocomplete: "postal-code" })).toBe("postalCode");
        expect(fieldKind({ name: "last_name" })).toBe("lastName");
        expect(fieldKind({ label: "Course title" })).toBe("title");
        expect(fieldKind({ label: "Street address" })).toBe("street");
        expect(fieldKind({ type: "date", label: "Date of birth" })).toBe("birthDate");
        expect(fieldKind({ type: "textarea", name: "x" })).toBe("longText");
        expect(fieldKind({ options: ["Select…", "Math"] })).toBe("choice");
    });

    it("gives realistic values: email on the reserved domain, fictional phone, address parts, a real option", () => {
        const g = gen();
        expect(g.tag).toMatch(RUN_TAG);
        const email = g.value({ type: "email" });
        expect(email).toMatch(new RegExp(`^[a-z]+\\.[a-z]+\\.${g.tag}\\.1@${TEST_EMAIL_DOMAIN.replace(".", "\\.")}$`));
        expect(g.value({ type: "tel" })).toMatch(/^\+1 202 555 01\d\d$/);
        expect(g.value({ autocomplete: "postal-code" })).toMatch(/^\d{5}$/);
        expect(g.value({ label: "Street" })).toMatch(/^\d+ [A-Z][a-z]+ (Street|Avenue|Road|Lane)$/);
        expect(g.value({ options: ["-- choose --", "Math", "Art"] })).toMatch(/^(Math|Art)$/);
        expect(g.value({ label: "Full name" })).toContain(g.tag);
    });

    it("keeps numbers and dates within min, max and step", () => {
        const g = gen();
        for (let i = 0; i < 50; i++) {
            const n = Number(g.value({ type: "number", min: 5, max: 20, step: 5 }));
            expect([5, 10, 15, 20]).toContain(n);
            const d = g.value({ type: "date", min: "2026-07-01", max: "2026-07-10" });
            expect(d >= "2026-07-01" && d <= "2026-07-10").toBe(true);
        }
        const born = g.value({ type: "date", label: "Birthday" });
        expect(born >= "1965-01-01" && born <= "2000-12-31").toBe(true);
        const future = g.value({ type: "date", label: "Start date" });
        expect(future > "2026-06-15").toBe(true);
    });

    it("respects maxLength, minLength and pattern", () => {
        const g = gen();
        expect(g.value({ label: "Course title", maxLength: 12 }).length).toBeLessThanOrEqual(12);
        expect(g.value({ label: "Code", minLength: 30 }).length).toBeGreaterThanOrEqual(30);
        expect(g.value({ name: "zip", pattern: "[0-9]{5}" })).toMatch(/^[0-9]{5}$/);
        expect(g.value({ name: "ref", pattern: "[0-9]{6}" })).toMatch(/^[0-9]{6}$/);
    });

    it("is unique per call and carries the run tag", () => {
        const g = gen();
        const emails = new Set(Array.from({ length: 30 }, () => g.value({ type: "email" })));
        const titles = new Set(Array.from({ length: 30 }, () => g.value({ label: "Title" })));
        expect(emails.size).toBe(30);
        expect(titles.size).toBe(30);
        for (const t of titles) expect(t).toContain(g.tag);
        expect(createTestData().tag).toMatch(RUN_TAG);
        expect(createTestData({ tag: "qa1234" }).tag).toBe("qa1234");
        expect(createTestData({ tag: "not a tag", seed: "x" }).tag).toBe(makeRunTag("x"));
    });

    it("is deterministic with a seed", () => {
        const fields = [{ type: "email" }, { label: "First name" }, { type: "number", min: 1, max: 1000 }, { type: "date" }, { label: "Title" }];
        expect(gen("same").record(fields)).toEqual(gen("same").record(fields));
        expect(gen("same").record(fields)).not.toEqual(gen("other").record(fields));
        expect(makeRunTag("job-1")).toBe(makeRunTag("job-1"));
    });

    it("gives boundary values (accepted) and invalid ones (refused)", () => {
        const g = gen();
        const num = g.edges({ type: "number", min: 1, max: 10, required: true });
        expect(num).toEqual(expect.arrayContaining([
            { value: "", valid: false, why: "a required field left empty" },
            { value: "1", valid: true, why: "the smallest allowed number" },
            { value: "0", valid: false, why: "just below the smallest allowed number" },
            { value: "10", valid: true, why: "the largest allowed number" },
            { value: "11", valid: false, why: "just above the largest allowed number" },
        ]));
        const text = g.edges({ label: "Title", maxLength: 8 });
        expect(text.find((e) => e.valid)!.value).toHaveLength(8);
        expect(text.find((e) => !e.valid)!.value).toHaveLength(9);
        expect(g.edges({ type: "email" }).every((e) => !e.valid && !e.value.includes("@" + TEST_EMAIL_DOMAIN))).toBe(true);
        const dates = g.edges({ type: "date", min: "2026-01-01" });
        expect(dates).toContainEqual({ value: "2025-12-31", valid: false, why: "the day before the earliest allowed date" });
    });

    it("is offered to the authoring agent as a tool that records the run tag in the spec", async () => {
        const g = gen();
        const specData: Record<string, string> = {};
        const actions: string[] = [];
        const t = testValueTool(g, specData, (a) => void actions.push(a.tool));
        const exec = t.execute as (a: unknown, o: unknown) => Promise<string>;
        const v = await exec({ field: { type: "email" }, kind: "valid" }, {});
        expect(v).toContain(g.tag);
        expect(runTagOf({ testData: specData })).toBe(g.tag);
        expect(JSON.parse(await exec({ field: { type: "number", min: 1 }, kind: "invalid" }, {}))).toContainEqual({ value: "0", why: "just below the smallest allowed number" });
        expect(actions).toEqual(["testValue", "testValue"]);
    });
});

describe("planning with generated data", () => {
    const model: AppModel = {
        url: "http://app.test", origin: "http://app.test", siteType: "other", purpose: "Courses", features: [],
        pages: [{ url: "http://app.test/courses/new", path: "/courses/new", title: "New course", type: "form", depth: 1, status: 200, headings: [], forms: [{ purpose: "other", fields: [{ type: "text", label: "Title", required: true }], submitLabel: "Save" }], components: [], links: [], aria: "", text: "", apiCalls: [], revealed: [], consoleErrors: [] }],
        navigation: [], apis: [], journeys: [], externalDependencies: [], documentedTestCases: [], authentication: { required: false, mechanisms: [], loggedIn: false },
        stats: { pagesVisited: 1, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
    };
    const promptsOf = async (testData?: { tag?: string }) => {
        const prompts: string[] = [];
        const llm = { modelName: "scripted", model: {} as never, usage: { inputTokens: 0, outputTokens: 0 }, text: async () => "", object: (async ({ prompt }: { prompt: string }) => (prompts.push(prompt), { scenarios: [] })) as LlmClient["object"] } as LlmClient;
        const ctx: EngineContext = { config: loadConfig({}), llm, emit: () => undefined };
        await planScenarios(ctx, model, { maxScenarios: 5, hasCredentials: false, ...(testData ? { testData } : {}) });
        return prompts.join("\n");
    };

    it("tells the planner it may create, edit and delete with generated data only when the switch is on", async () => {
        const on = await promptsOf({ tag: "qa9z9z" });
        expect(on).toContain("Tests that create, edit or delete records ARE allowed");
        expect(on).toContain("with generated data");
        expect(on).toContain("qa9z9z");
        expect(await promptsOf()).not.toContain("generated data");
    });
});

describe("cleanup of records made with generated data, against a local sample API", () => {
    const store = new Map<string, string>();
    let server: http.Server;
    const BASE = "http://127.0.0.1:9270";
    beforeAll(async () => {
        server = http.createServer((req, res) => {
            const m = /^\/api\/courses\/([^/]+)$/.exec(req.url ?? "");
            if (req.method === "DELETE" && m) {
                const had = store.delete(decodeURIComponent(m[1]!));
                res.writeHead(had ? 204 : 404).end();
                return;
            }
            res.writeHead(405).end();
        });
        await new Promise<void>((r) => server.listen(9270, "127.0.0.1", r));
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it("keeps the tag a script wrote down, and only a well-formed one", () => {
        const lines = parseCreatedLog([
            JSON.stringify({ k: "created", path: "/api/courses", id: "1", at: NOW.toISOString(), tag: "qa7k2q" }),
            JSON.stringify({ k: "created", path: "/api/courses", id: "2", at: NOW.toISOString(), tag: "<script>" }),
        ].join("\n"));
        expect(lines.map((l) => (l.k === "created" ? l.tag : "-"))).toEqual(["qa7k2q", undefined]);
    });

    it("removes the tagged records it can and says in plain words which tag was left in the app", async () => {
        store.set("c1", "Course qa7k2q 1").set("c2", "Course qa7k2q 2").set("keep", "someone else's");
        const collector = new CleanupCollector(["/api/courses/{id}"]);
        const at = NOW.toISOString();
        collector.add({ testId: "WEB-001", steps: [] }, [
            { k: "created", path: "/api/courses", id: "c1", at, tag: "qa7k2q" },
            { k: "created", path: "/api/courses", id: "c2", at, tag: "qa7k2q" },
            // No DELETE operation is known for tags: these stay.
            { k: "created", path: "/api/tags", id: "t1", at, tag: "qa7k2q" },
            { k: "created", path: "/api/tags", id: "t2", at, tag: "qa7k2q" },
            { k: "created", path: "/api/tags", id: "t3", at, tag: "qa7k2q" },
        ]);
        const events: EngineEvent[] = [];
        const ctx = { config: loadConfig({}), llm: {} as LlmClient, emit: (e: EngineEvent) => void events.push(e) } as EngineContext;
        const done = await finishCleanup(ctx, collector, { enabled: true, apiBaseUrl: BASE });
        expect([...store.keys()]).toEqual(["keep"]);
        expect(done.filter((i) => i.status === "removed").map((i) => i.id).sort()).toEqual(["c1", "c2"]);
        expect(done.filter((i) => i.status === "no-delete-operation")).toHaveLength(3);
        expect(done.find((i) => i.id === "t1")!.reason).toContain("tag qa7k2q");
        expect(leftBehindByTag(done)).toBe("3 records with tag qa7k2q were left in the app.");
        expect(events.at(-1)!.message).toBe("Removed 2 of 5 records the tests created; 3 left behind. 3 records with tag qa7k2q were left in the app.");
    });
});

describe("AI screen review default", () => {
    it("is on at deep and everything only when the model can read images; an explicit choice wins", () => {
        expect(LEVEL_SETTINGS.thorough.visionByDefault).toBe(false);
        expect(visionOn({}, true)).toBe(false);
        expect(visionOn({ level: "thorough" }, true)).toBe(false);
        expect(visionOn({ level: "deep" }, true)).toBe(true);
        expect(visionOn({ level: "everything" }, true)).toBe(true);
        expect(visionOn({ level: "deep" }, false)).toBe(false);
        expect(visionOn({ level: "everything", visionChecks: false }, true)).toBe(false);
        expect(visionOn({ level: "thorough", visionChecks: true }, false)).toBe(true);
    });

    it("an exploration keeps the person's off, leaves it to the level when nothing was said, and is off without the UX agent", () => {
        expect(DEFAULT_JOB_OPTIONS.visionChecks).toBeUndefined();
        expect(applyAgentChoice({ ...DEFAULT_JOB_OPTIONS, level: "deep" }, {}, ["ux"]).visionChecks).toBeUndefined();
        expect(applyAgentChoice({ ...DEFAULT_JOB_OPTIONS, level: "deep" }, { visionChecks: false }, ["ux"]).visionChecks).toBe(false);
        expect(applyAgentChoice({ ...DEFAULT_JOB_OPTIONS, level: "deep" }, { visionChecks: true }, ["ux"]).visionChecks).toBe(true);
        expect(applyAgentChoice({ ...DEFAULT_JOB_OPTIONS, level: "deep" }, {}, ["api"]).visionChecks).toBe(false);
    });

    it("the plan preview shows it on at deep and everything unless switched off", () => {
        const home = { url: "https://a.example/", path: "/", type: "home", title: "", depth: 0, status: 200, headings: [], forms: [], components: [], links: [], aria: "", text: "", apiCalls: [], revealed: [], consoleErrors: [] };
        const plan = { version: 1, createdAt: NOW.toISOString(), model: { url: "https://a.example/", origin: "https://a.example", pages: [home], apis: [], journeys: [], navigation: [], authentication: { required: false, mechanisms: [], loggedIn: false } }, scenarios: [], analysed: true, specBaseTrusted: false, apiAccess: [], accessReach: [], notes: [] } as never;
        const vision = (o: Record<string, unknown>) => planFamilies(plan, { targets: ["web"], ...o }).find((f) => f.id === "vision")?.on;
        expect(vision({ level: "thorough" })).toBe(false);
        expect(vision({ level: "deep" })).toBe(true);
        expect(vision({ level: "everything", visionChecks: false })).toBe(false);
    });
});
