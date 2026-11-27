/**
 * Pages only another test account reaches, and the forms an exploration fills (paid ladder L4: the admin's People page of bench-rbac was
 * in the screen map but never in the model, so its workflows got no objective and no pursuit went there; constraint objectives ranked
 * last, were cut by the objective cap or never reached, so input classes were exercised 0 times in all 10 records).
 *
 * - the crawl keeps the pages only a test account reached (rolePagesOf), the analysis sees them, and the model has them with who can open them;
 * - a model from before that still gets them from its screen map;
 * - a pursuit on such a page signs in as an account that reached it (pursuitAccount);
 * - a constraint objective on a form a workflow fills ranks with that workflow, so it is inside the cap and next to it.
 * Pure: no browser, no AI.
 */
import { describe, expect, it } from "vitest";
import { objectivesFrom } from "../src/engine/explore/objectives.js";
import { fragmentFromExploration } from "../src/engine/intel/from-exploration.js";
import { objectivePursuits, pursuitAccount, ruleStartPath } from "../src/engine/orchestrator.js";
import { objectiveInputsOf } from "../src/engine/planning/planner.js";
import { rolePagesOf } from "../src/engine/screenmap/map.js";
import { analyzeApplication } from "../src/engine/understanding/analyzer.js";
import type { AppModel as UnderstandingModel, PageModel } from "../src/engine/understanding/app-model.js";
import type { EngineContext } from "../src/engine/context.js";
import type { LlmClient } from "../src/engine/llm/provider.js";

const page = (path: string, extra: Partial<PageModel> = {}): PageModel => ({
    url: `http://notes.test${path}`,
    path,
    title: path,
    type: "content",
    depth: 1,
    status: 200,
    headings: [],
    forms: [],
    components: [],
    links: [],
    aria: "",
    text: "",
    apiCalls: [],
    revealed: [],
    consoleErrors: [],
    discovery: 2,
    ...extra,
});

const people = page("/admin/users", {
    type: "form",
    headings: ["People"],
    components: [{ role: "button", name: "Change role", locatorHint: "" }],
    forms: [{ id: "role", action: "", method: "post", purpose: "other", fields: [{ type: "select", name: "role", label: "Role", required: false, options: ["user", "manager", "admin"] }] }],
});
const main = [page("/notes"), page("/account")];

const model = (extra: Partial<UnderstandingModel> = {}): UnderstandingModel => ({
    url: "http://notes.test/",
    origin: "http://notes.test",
    siteType: "webapp",
    purpose: "",
    features: [],
    pages: main,
    navigation: [],
    apis: [],
    authentication: { required: true, mechanisms: ["form"], loggedIn: true },
    journeys: [],
    externalDependencies: [],
    documentedTestCases: [],
    stats: { pagesVisited: 2, pagesSkipped: 0, apisFound: 0, durationMs: 1 },
    ...extra,
});

describe("pages only a test account reached", () => {
    it("the crawl keeps them, once per address pattern, with every account that reached them; pages the main crawl saw and sign-in pages are not kept", () => {
        const kept = rolePagesOf(main, [
            { who: "ana", pages: [page("/notes"), page("/account")], transitions: [] },
            { who: "manager", pages: [page("/notes"), page("/notes/n2")], transitions: [] },
            { who: "admin", pages: [page("/notes"), people, page("/notes/n2"), page("/login", { type: "login" })], transitions: [] },
        ]);
        expect(kept.map((p) => [p.path, p.reachedBy])).toEqual([
            ["/notes/n2", ["manager", "admin"]],
            ["/admin/users", ["admin"]],
        ]);
        expect(kept[1]!.forms[0]!.fields[0]!.options).toEqual(["user", "manager", "admin"]);
    });

    it("the model has them with their forms and who can open them, and they reach the objective inputs", () => {
        const fragment = fragmentFromExploration({ model: model({ rolePages: [{ ...people, reachedBy: ["admin"] }] }), ref: "x", now: "2026-11-28T00:00:00.000Z" });
        const admin = fragment.model.pages.find((p) => p.path === "/admin/users")!;
        expect(admin.reachableBy).toEqual(["admin"]);
        expect(admin.forms[0]!.fields[0]).toMatchObject({ name: "role", options: ["user", "manager", "admin"] });
        // The crawl's own pages say nothing about who reaches them without a survey.
        expect(fragment.model.pages.find((p) => p.path === "/notes")).not.toHaveProperty("reachableBy");
        const inputs = objectiveInputsOf({ pages: fragment.model.pages, transitions: [] } as never, []);
        expect(inputs.accountPages).toEqual([{ path: "/admin/users", reachableBy: ["admin"] }]);
        expect(inputs.pages.map((p) => p.path)).toContain("/admin/users");
    });

    it("a model stored before them gets them from its screen map (address and who reached it)", () => {
        const screenMap = {
            screens: [
                { key: "/notes", heading: "Notes", type: "form" as const, paths: ["/notes"], roles: ["ana", "admin"] },
                { key: "/admin/users", heading: "People", type: "form" as const, paths: ["/admin/users"], roles: ["admin"] },
                { key: "/login", heading: "Sign in", type: "login" as const, paths: ["/login"] },
            ],
            transitions: [
                { from: "/notes", to: "/admin/users", action: "People", via: "link" as const, roles: ["admin"] },
                { from: "/notes", to: "/account", action: "Account", via: "link" as const, roles: ["ana", "admin"] },
            ],
            conditional: [],
        };
        const fragment = fragmentFromExploration({ model: model({ screenMap }), ref: "x", now: "2026-11-28T00:00:00.000Z" });
        // The admin's link to it is kept, so a rule naming "the People page" can be tied to the page.
        expect(objectiveInputsOf(fragment.model, []).accountPages).toEqual([{ path: "/admin/users", reachableBy: ["admin"], names: ["People"] }]);
        const pages = fragment.model.pages;
        expect(pages.map((p) => [p.path, p.reachableBy ?? null])).toEqual([
            ["/notes", null],
            ["/account", null],
            ["/admin/users", ["admin"]],
        ]);
    });

    it("the analysis is shown them with who reached them, and their purpose and journeys come back", async () => {
        const asked: string[] = [];
        const answer = {
            siteType: "webapp",
            purpose: "Notes",
            features: [],
            pagePurposes: [{ path: "/admin/users", type: "form", purpose: "Lists everyone and changes roles" }],
            journeys: [{ name: "Change someone's role", description: "", steps: [{ action: "Choose a role and press Change role", page: "/admin/users", endpoint: "" }], priority: "high", pages: ["/admin/users"], requiresAuth: true }],
            authenticationMechanisms: [],
        };
        const llm = { modelName: "scripted", usage: { inputTokens: 0, outputTokens: 0 }, text: async () => "", object: async (a: { prompt: string }) => (asked.push(a.prompt), answer) } as unknown as LlmClient;
        const ctx = { config: {}, llm, emit: () => undefined } as unknown as EngineContext;
        const { siteType: _s, purpose: _p, features: _f, journeys: _j, ...base } = model({ rolePages: [{ ...people, reachedBy: ["admin"] }] });
        const analysed = await analyzeApplication(ctx, base);
        expect(asked[0]).toContain('/admin/users: reached by "admin"');
        expect(analysed.rolePages![0]!.purpose).toBe("Lists everyone and changes roles");
        expect(analysed.journeys[0]!.pages).toEqual(["/admin/users"]);
        expect(analysed.pages.map((p) => p.path)).toEqual(["/notes", "/account"]);
    });
});

describe("a pursuit on a page only another account reached", () => {
    const roles = [
        { name: "ana", username: "ana@example.test" },
        { name: "manager", username: "mia@example.test" },
        { name: "admin", username: "ada@example.test" },
    ];
    const accountPages = [
        { path: "/notes", reachableBy: ["ana", "manager", "admin"] },
        { path: "/notes/n2", reachableBy: ["manager", "admin"] },
        { path: "/admin/users", reachableBy: ["admin"] },
    ];
    it("signs in as the first account that reached every such page it works on", () => {
        expect(pursuitAccount(["/admin/users"], accountPages, roles, "ana@example.test")).toBe("admin");
        expect(pursuitAccount(["/notes/n2"], accountPages, roles, "ana@example.test")).toBe("manager");
        expect(pursuitAccount(["/notes", "/notes/n2", "/admin/users"], accountPages, roles, "ana@example.test")).toBe("admin");
    });
    it("stays the project's account where it reaches the pages, where it is not a test account, or where no one account reaches them all", () => {
        expect(pursuitAccount(["/notes", "/account"], accountPages, roles, "ana@example.test")).toBeUndefined();
        expect(pursuitAccount(["/admin/users"], accountPages, roles, "ada@example.test")).toBeUndefined();
        expect(pursuitAccount(["/admin/users"], accountPages, roles, "someone@example.test")).toBeUndefined();
        expect(pursuitAccount(["/admin/users"], accountPages, undefined, "ana@example.test")).toBeUndefined();
        expect(pursuitAccount(["/admin/users", "/x"], [...accountPages, { path: "/x", reachableBy: ["manager"] }], roles, "ana@example.test")).toBeUndefined();
    });
});

describe("a rule about a page only another account reached", () => {
    const accountPages = [
        { path: "/admin/users", reachableBy: ["admin"], names: ["People"] },
        { path: "/notes/n2", reachableBy: ["ben", "admin"], names: ["Ben's salary review"] },
    ];
    it("starts on that page when its words name the link that leads there, so the pursuit signs in as that account", () => {
        expect(ruleStartPath("The People page lists everyone with an account and lets an admin change each role.", accountPages)).toBe("/admin/users");
        expect(ruleStartPath("Everyone with an account has one role.", accountPages)).toBeUndefined();
        // Whole words only, and never two pages at once.
        expect(ruleStartPath("Peoples of the world", accountPages)).toBeUndefined();
        expect(ruleStartPath("People see Ben's salary review", accountPages)).toBeUndefined();
        const inputs = { pages: [], transitions: [], workflowSteps: [], accountPages };
        const rule = { ref: "R-5.1", kind: "other" as const, description: "The People page lets an admin change each role", expected: "The role changes", explicitness: "explicit" as const, workflows: [], status: "unverified" as const };
        const built = objectivePursuits({ rules: [rule], workflows: [], objectiveInputs: inputs }, { maxObjectives: 10, steps: 10, perObjective: { minutes: 5, tokens: 50_000 }, dataChanges: true, dataOperators: false, requiresAuth: true });
        expect(built.pursuits[0]!.scenario.startPath).toBe("/admin/users");
        expect(pursuitAccount([built.pursuits[0]!.scenario.startPath], accountPages, [{ name: "ana", username: "ana@x.test" }, { name: "admin", username: "ada@x.test" }], "ana@x.test")).toBe("admin");
    });
});

describe("a constraint on a form a workflow fills", () => {
    const options = { maxObjectives: 3, budget: { steps: 10, minutes: 5, tokens: 50_000 } };
    const rule = (ref: string) => ({ ref, kind: "other" as const, description: `Rule ${ref}`, expected: `Expected ${ref}`, explicitness: "explicit" as const, workflows: [], status: "unverified" as const });
    const flows = [{ id: "wf-sign-in", name: "Pay for the order", steps: [{ order: 1, action: "Enter email and password" }], preconditions: [], postconditions: ["Signed in"], sourceType: "requirement" as const }];
    const inputs = {
        pages: [{ id: "page:/login", path: "/login", forms: [{ name: "login", fields: [{ name: "email", type: "email", required: true }] }] }],
        transitions: [],
        workflowSteps: [{ workflowId: "wf-sign-in", steps: [{ order: 1, action: "Enter email and password", page: "page:/login", path: "/login" }] }],
    };
    it("ranks with that workflow, so the cap keeps it beside the workflow and before the rules", () => {
        const { objectives } = objectivesFrom(inputs, [rule("R-1"), rule("R-2"), rule("R-3")], flows, options);
        const kinds = objectives.map((o) => o.kind);
        expect(kinds).toContain("constraint");
        const flow = objectives.find((o) => o.kind === "workflow")!;
        const field = objectives.find((o) => o.kind === "constraint")!;
        expect(field.priority).toBe(flow.priority);
        expect(field.reason).toMatch(/ranked with the workflow "Pay for the order", which fills this form/);
    });
    it("a form no workflow fills keeps its own rank (and the cap leaves it out)", () => {
        const { objectives } = objectivesFrom({ ...inputs, workflowSteps: [] }, [rule("R-1"), rule("R-2"), rule("R-3")], flows, options);
        expect(objectives.map((o) => o.kind)).not.toContain("constraint");
    });
});
