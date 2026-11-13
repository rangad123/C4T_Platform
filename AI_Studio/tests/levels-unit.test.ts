import { describe, expect, it } from "vitest";
import { effectiveLimits, firstN, LEVEL_SETTINGS, levelOf, levelSettings } from "../src/engine/levels.js";
import { planFamilies, type StoredPlan } from "../src/engine/planning/preview.js";
import { exploreOffer } from "../src/platform/explore-task.js";
import { planOptionsOf } from "../src/platform/plan-store.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import type { AppModel, PageModel } from "../src/engine/understanding/app-model.js";

describe("exploration levels", () => {
    it("thorough is the default for a missing or unknown level, with the owner's numbers", () => {
        expect(levelOf(undefined)).toBe("thorough");
        expect(levelOf({})).toBe("thorough");
        expect(levelOf({ level: "huge" })).toBe("thorough");
        expect(levelOf({ level: "deep" })).toBe("deep");
        expect(levelSettings(null)).toMatchObject({ maxPages: 60, maxDepth: 4, maxScenarios: 50, perPattern: 3 });
        expect(LEVEL_SETTINGS.deep).toMatchObject({ maxPages: 120, maxDepth: 5, maxScenarios: 100, perPattern: 5 });
        expect(LEVEL_SETTINGS.everything).toMatchObject({ maxPages: 250, maxDepth: 6, maxScenarios: 150, perPattern: 8 });
        expect(LEVEL_SETTINGS.everything.checkPages).toBe(Infinity);
    });

    it("new jobs default to thorough's limits", () => {
        expect(DEFAULT_JOB_OPTIONS).toMatchObject({ maxPages: 60, maxDepth: 4, maxScenarios: 50 });
        expect(DEFAULT_JOB_OPTIONS.level).toBeUndefined();
    });

    it("explicit limits win but never go below thorough's", () => {
        expect(effectiveLimits({})).toEqual({ maxPages: 60, maxDepth: 4, maxScenarios: 50 });
        expect(effectiveLimits({ level: "deep" })).toEqual({ maxPages: 120, maxDepth: 5, maxScenarios: 100 });
        expect(effectiveLimits({ level: "everything" })).toEqual({ maxPages: 250, maxDepth: 6, maxScenarios: 150 });
        // A job stored before levels existed (25 / 3 / 25) runs as thorough.
        expect(effectiveLimits({ maxPages: 25, maxDepth: 3, maxScenarios: 25 })).toEqual({ maxPages: 60, maxDepth: 4, maxScenarios: 50 });
        // Explicit numbers above thorough are kept, even when the level would give more.
        expect(effectiveLimits({ level: "deep", maxPages: 80, maxDepth: 4, maxScenarios: 70 })).toEqual({ maxPages: 80, maxDepth: 4, maxScenarios: 70 });
        expect(effectiveLimits({ maxPages: 200 })).toEqual({ maxPages: 200, maxDepth: 4, maxScenarios: 50 });
    });

    it("firstN treats Infinity as all", () => {
        expect(firstN([1, 2, 3], 2)).toEqual([1, 2]);
        expect(firstN([1, 2, 3], Infinity)).toEqual([1, 2, 3]);
    });
});

const TYPES: PageModel["type"][] = ["home", "login", "register", "checkout", "cart", "form", "search", "listing", "detail", "account", "dashboard", "content", "other"];
const page = (path: string, type: PageModel["type"]): PageModel =>
    ({ url: `https://shop.example${path}`, path, type, title: "", depth: 1, status: 200, headings: [], forms: [], components: [], links: [], aria: "", text: "", apiCalls: [], revealed: [], consoleErrors: [] }) as unknown as PageModel;
// 100 distinct pages (distinct URL patterns) spread over every key page type: more than deep's 24 key pages.
const pages = Array.from({ length: 100 }, (_, i) => page(`/${TYPES[i % TYPES.length]}-p${i}`, TYPES[i % TYPES.length]!));
const model = {
    url: "https://shop.example/", origin: "https://shop.example", siteType: "ecommerce", purpose: "shop", features: [], pages,
    navigation: [], apis: [], journeys: [], authentication: { required: false, mechanisms: [], loggedIn: false }, externalDependencies: [],
    documentedTestCases: [], stats: { pagesVisited: pages.length, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
} as unknown as AppModel;
const plan = { version: 1, createdAt: "2026-11-13T00:00:00.000Z", model, scenarios: [], analysed: true, specBaseTrusted: false, accessReach: [], apiAccess: [], notes: [] } as unknown as StoredPlan;
const count = (level: string | undefined, id: string) =>
    planFamilies(plan, planOptionsOf({ ...DEFAULT_JOB_OPTIONS, targets: ["web"], visual: true, visionChecks: true, performanceChecks: true, ...(level ? { level: level as "deep" } : {}) })).find((f) => f.id === id)!.count;

describe("the plan's check counts scale with the level", () => {
    it("thorough: 12 accessibility, health and visual pages, 5 AI screen reviews", () => {
        for (const id of ["accessibility", "health", "visual"]) expect(count(undefined, id)).toBe(12);
        expect(count(undefined, "vision")).toBe(5);
        expect(count("thorough", "accessibility")).toBe(12);
    });
    it("a 100-page model gives 12 / 24 / every key page", () => {
        for (const id of ["accessibility", "health", "visual"]) {
            expect(count("deep", id)).toBe(24);
            expect(count("everything", id)).toBe(100);
        }
        expect(count("deep", "vision")).toBe(10);
        expect(count("everything", "vision")).toBe(100);
        expect(count("deep", "performance")).toBe(16);
        expect(count("everything", "performance")).toBe(100);
    });
});

describe("an exploration on the runner carries its level", () => {
    it("the offer's request keeps the level and the limits", () => {
        const offer = exploreOffer({
            taskId: "t1",
            job: { id: "j1" },
            request: { url: "https://shop.example/", level: "deep", maxPages: 120, maxDepth: 5, maxScenarios: 100, targets: ["web"], allowMutatingApiTests: false } as never,
            modelName: "scripted",
            secrets: [],
            leaseSeconds: 60,
        });
        expect(JSON.stringify(offer)).toContain('"level":"deep"');
        expect(JSON.stringify(offer)).toContain('"maxPages":120');
    });
});
