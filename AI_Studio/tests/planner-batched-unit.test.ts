/**
 * Batched planning without a browser or a real model (fast tier): a 60-page app is planned in several concurrent calls (areas,
 * cross-area journeys), duplicates and scenarios without a concrete outcome are left out, the coverage-gap pass plans for an
 * untouched form with a list of what is already covered, requirements come first, and a reached AI limit is said in plain words.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext, EngineEvent } from "../src/engine/context.js";
import { LEVEL_SETTINGS } from "../src/engine/levels.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { BudgetExceeded } from "../src/engine/llm/usage.js";
import { hasConcreteOutcome, planAreas, planCoverage, planScenarios } from "../src/engine/planning/planner.js";
import type { AppModel, PageModel } from "../src/engine/understanding/app-model.js";

const page = (path: string, extra: Partial<PageModel> = {}): PageModel => ({
    url: `http://shop.test${path}`, path, title: path, type: "content", depth: 1, status: 200, headings: [], forms: [],
    components: Array.from({ length: 80 }, (_, i) => ({ role: "button", name: `${path} control ${i}`, locatorHint: "" })),
    links: [], aria: "", text: "", apiCalls: [], revealed: [], consoleErrors: [], ...extra,
});

/** 60 pages in five areas; /account/settings has a form the first round never names. */
function bigModel(): AppModel {
    const paths = [
        "/", "/account/settings",
        ...Array.from({ length: 20 }, (_, i) => `/products/${i}`),
        ...Array.from({ length: 12 }, (_, i) => `/account/p${i}`),
        ...Array.from({ length: 15 }, (_, i) => `/blog/${i}`),
        ...Array.from({ length: 8 }, (_, i) => `/help/${i}`),
        "/about", "/terms", "/privacy",
    ];
    const pages = paths.map((p) =>
        p === "/account/settings" ? page(p, { forms: [{ purpose: "other", fields: [{ type: "text", label: "Display name", required: true }], submitLabel: "Save profile" }] }) : page(p),
    );
    return {
        url: "http://shop.test", origin: "http://shop.test", siteType: "ecommerce", purpose: "Shop", features: ["catalogue"], pages,
        navigation: [], apis: [], journeys: [{ name: "Buy", description: "", steps: ["browse", "buy"], priority: "critical", pages: ["/products/0"], requiresAuth: false }],
        externalDependencies: [], documentedTestCases: [], authentication: { required: false, mechanisms: [], loggedIn: false },
        stats: { pagesVisited: pages.length, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
    };
}

const idea = (title: string, startPath: string, expected = `"${title}" is shown`, requirements: string[] = []) => ({
    title, description: title, category: "Area", type: "functional" as const, priority: "high" as const, startPath,
    preconditions: [], expectedResults: [expected], requiresAuth: false, requiredData: [], requirements,
});

/** A scripted planner: answers from what the prompt asks for, and logs every prompt. */
function scripted(answer: (prompt: string, n: number) => ReturnType<typeof idea>[], log: { prompts: string[]; inFlight: number; most: number }): LlmClient {
    return {
        modelName: "scripted", model: {} as never, usage: { inputTokens: 0, outputTokens: 0 }, text: async () => "",
        object: (async ({ prompt }: { prompt: string }) => {
            const n = log.prompts.push(prompt);
            log.most = Math.max(log.most, ++log.inFlight);
            await new Promise((r) => setTimeout(r, 5));
            log.inFlight--;
            return { scenarios: answer(prompt, n) };
        }) as LlmClient["object"],
    };
}

const ctxWith = (llm: LlmClient, events: EngineEvent[] = []): EngineContext => ({ config: loadConfig({}), llm, emit: (e) => void events.push(e) });
const detailPaths = (prompt: string) => [...prompt.matchAll(/^### (\S+)/gm)].map((m) => m[1]!);

describe("batched planning", () => {
    it("plans a 60-page app in several concurrent calls, removes duplicates and vague ideas, and fills the gaps", async () => {
        const log = { prompts: [] as string[], inFlight: 0, most: 0 };
        const llm = scripted((prompt) => {
            if (prompt.includes("Not tested yet")) {
                return [...prompt.matchAll(/^- (page|other form on) (\S+)/gm)].map((m) =>
                    m[1] === "page" ? idea(`Check ${m[2]} content`, m[2]!) : idea(`Save a new Display name on ${m[2]}`, m[2]!, "The Display name field shows the saved value after reload"),
                );
            }
            if (prompt.includes("cross several areas")) return [idea("Buy a product end to end", "/products/0", "The order summary lists the product"), idea("Open the home page", "/")];
            // An area: one idea for every other page, the same idea every call (a duplicate), and one that proves nothing.
            const paths = detailPaths(prompt);
            return [
                ...paths.filter((_, i) => i % 2 === 0).map((p) => idea(`Check ${p} content`, p)),
                idea("Open the home page", "/"),
                idea("Home page open", "/"),
                idea(`Visit ${paths[0]}`, paths[0]!, "The page loads"),
            ];
        }, log);
        const events: EngineEvent[] = [];
        const model = bigModel();
        const out = await planScenarios(ctxWith(llm, events), model, { maxScenarios: LEVEL_SETTINGS.thorough.maxScenarios, hasCredentials: false, digestElementsPerPage: LEVEL_SETTINGS.thorough.digestElementsPerPage });

        expect(out).toHaveLength(50);
        const areaCalls = log.prompts.filter((p) => p.includes("Plan now: the area"));
        expect(areaCalls.length).toBeGreaterThanOrEqual(4);
        expect(log.prompts.filter((p) => p.includes("cross several areas"))).toHaveLength(1);
        expect(log.most).toBeGreaterThan(1);
        // The level's digest size: 60 controls of a page are shown, not 14.
        expect(areaCalls.join("\n")).toContain("/products/0 control 59");
        expect(areaCalls.join("\n")).not.toContain("/products/0 control 60");
        // Duplicates (same title, or the same words from the same page) and "the page loads" are gone.
        expect(new Set(out.map((s) => s.title.toLowerCase())).size).toBe(out.length);
        expect(out.filter((s) => /home page/i.test(s.title))).toHaveLength(1);
        expect(out.every(hasConcreteOutcome)).toBe(true);
        expect(events.some((e) => e.kind === "scenarios_vague")).toBe(true);
        // The gap pass named the untouched form, gave the covered list, and its scenario made it into the plan.
        const gap = log.prompts.find((p) => p.includes("Not tested yet"))!;
        expect(gap).toContain("other form on /account/settings");
        expect(gap).toContain("Already covered by the plan");
        expect(gap).toContain("- [Area] Check /products/0 content");
        expect(out.some((s) => s.title === "Save a new Display name on /account/settings")).toBe(true);
        expect(out.map((s) => s.scenarioId).slice(0, 2)).toEqual(["S-001", "S-002"]);
        const coverage = events.find((e) => e.kind === "plan_coverage")!;
        expect(coverage.message).toMatch(/^Coverage: \d+ of 61 pages and forms have a test$/);
    });

    it("splits areas by path prefix and keeps a small app in one call", () => {
        const areas = planAreas(bigModel());
        expect(areas.map((a) => a.name)).toEqual(expect.arrayContaining(["/products", "/account", "/blog", "/help"]));
        expect(areas.flatMap((a) => a.pages)).toHaveLength(60);
        expect(areas.every((a) => a.pages.length <= 15)).toBe(true);
        const small = { ...bigModel(), pages: bigModel().pages.slice(0, 10) };
        expect(planAreas(small)).toHaveLength(1);
    });

    it("plans every requirement first and asks again for one left out", async () => {
        const log = { prompts: [] as string[], inFlight: 0, most: 0 };
        const llm = scripted((prompt) => {
            if (prompt.includes("Not tested yet") && prompt.includes("[REQ-3]")) return [idea("Search finds a product by name", "/products/0", "The product appears in the results", ["REQ-3"])];
            if (prompt.includes("Plan the scenarios for these requirements")) return [idea("Log in", "/", "The account menu shows the user's name", ["REQ-1"]), idea("Wrong password", "/", "An error says the password is wrong", ["REQ-2"])];
            return detailPaths(prompt).map((p) => idea(`Check ${p} content`, p));
        }, log);
        const reqs = ["REQ-1", "REQ-2", "REQ-3"].map((id) => ({ id, text: `${id} text`, kind: "functional" as const }));
        const out = await planScenarios(ctxWith(llm), bigModel(), { maxScenarios: 5, hasCredentials: true, requirements: reqs as never });
        expect(out).toHaveLength(5);
        expect(out.slice(0, 3).flatMap((s) => s.requirements).sort()).toEqual(["REQ-1", "REQ-2", "REQ-3"]);
    });

    it("says a reached AI limit in plain words: the whole plan, or the part made before it", async () => {
        const hit = new BudgetExceeded({ cap: "job", used: 120, limit: 100, percent: 120 });
        const none: LlmClient = { modelName: "m", model: {} as never, usage: { inputTokens: 0, outputTokens: 0 }, text: async () => "", object: (async () => { throw hit; }) as LlmClient["object"] };
        await expect(planScenarios(ctxWith(none), bigModel(), { maxScenarios: 50, hasCredentials: false })).rejects.toThrow("The AI token limit for this job was reached");

        let n = 0;
        const some: LlmClient = { ...none, object: (async () => { if (n++ === 0) return { scenarios: [idea("Buy a product end to end", "/products/0", "The order summary lists the product")] }; throw hit; }) as LlmClient["object"] };
        const warnings: string[] = [];
        const events: EngineEvent[] = [];
        const out = await planScenarios(ctxWith(some, events), bigModel(), { maxScenarios: 50, hasCredentials: false, warnings });
        expect(out).toHaveLength(1);
        expect(warnings[0]).toMatch(/^The AI token limit for this job was reached: \d+ of \d+ planning call\(s\) did not finish, so the plan has the 1 test idea\(s\) made before that\.$/);
        expect(events.some((e) => e.kind === "planning_limit" && e.level === "warn")).toBe(true);
        // No gap pass after the limit: only the first round was asked.
        expect(n).toBe(planAreas(bigModel()).length + 1);
    });

    it("counts a form as covered only when a scenario on its page names it", () => {
        const model = bigModel();
        const onPage = [{ ...idea("Open settings", "/account/settings"), scenarioId: "S-1" }];
        expect(planCoverage(model, onPage).untouched.some((g) => g.kind === "form")).toBe(true);
        const named = [{ ...idea("Change the Display name", "/account/settings"), scenarioId: "S-1" }];
        expect(planCoverage(model, named).untouched.some((g) => g.kind === "form")).toBe(false);
        expect(planCoverage(model, named).total).toBe(61);
    });
});
