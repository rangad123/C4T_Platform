/**
 * The screen map and exploring as each role, without a browser: screens and transitions from crawl results, coverage from
 * authored tests, unvisited transitions and role differences reaching the planner (scripted double), role page budgets, and a
 * role scenario authored with that role's own account (the engine's browser and the authoring agent are stand-ins).
 */
import { describe, expect, it, vi } from "vitest";

const authored: Array<{ scenario: string; username?: string }> = [];
vi.mock("../src/engine/discovery/browser.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/engine/discovery/browser.js")>()),
    launchChromium: async () => ({ close: async () => undefined }),
}));
vi.mock("../src/engine/web/author.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/engine/web/author.js")>()),
    authorWebSpec: async (input: { scenario: { scenarioId: string }; credentials?: { username: string } }) => {
        authored.push({ scenario: input.scenario.scenarioId, username: input.credentials?.username });
        return {
            status: "complete",
            explanation: "done",
            testData: {},
            steps: [
                { action: "navigate", url: "/login", description: "open" },
                { action: "fill", locator: { by: "label", value: "Username" }, value: "{{credentials.username}}", description: "user" },
                { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}", description: "pw" },
                { action: "assert", check: "visible", locator: { by: "text", value: "Delete course" }, description: "seen" },
            ],
        };
    },
}));
vi.mock("../src/engine/validation/validator.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/engine/validation/validator.js")>()),
    validateBatch: async () => [],
}));

import { loadConfig } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import { renderWithAdapter } from "../src/engine/frameworks/index.js";
import { MIN_ROLE_PAGES, rolePageBudget, type Reach } from "../src/engine/identity/access.js";
import { asRole, roleCredentials, roleDifferences } from "../src/engine/identity/role-differences.js";
import { createLlmClientOrUnavailable } from "../src/engine/llm/provider.js";
import { runGeneration, type GenerationRequest, type GenerationSink } from "../src/engine/orchestrator.js";
import { planScenarios } from "../src/engine/planning/planner.js";
import type { StoredPlan } from "../src/engine/planning/preview.js";
import { buildScreenMap, coverWithTests, mapCounts, uncoveredTransitions } from "../src/engine/screenmap/map.js";
import { ScenarioSchema, TestSpecSchema } from "../src/engine/spec/schema.js";
import type { AppModel, PageModel } from "../src/engine/understanding/app-model.js";

const O = "http://app.test";
const page = (path: string, heading: string, extra: Partial<PageModel> = {}): PageModel => ({
    url: O + path,
    path,
    title: heading,
    type: "content",
    depth: 1,
    status: 200,
    headings: [heading],
    forms: [],
    components: [{ role: "link", name: "Home", locatorHint: "" }],
    links: [],
    aria: "",
    text: "",
    apiCalls: [],
    revealed: [],
    consoleErrors: [],
    ...extra,
});
const PAGES = [
    page("/", "Home"),
    page("/courses", "Courses"),
    page("/course/algebra", "Algebra"),
    page("/course/biology", "Biology"),
    page("/apply", "Apply", { type: "form", forms: [{ purpose: "other", fields: [{ type: "select", label: "Role", required: false }], conditional: [{ when: "Role = Other", shows: ["Please specify"] }] }] }),
];
const T = (from: string, to: string, label: string, via: "link" | "menu" | "click" = "link") => ({ from: O + from, to: O + to, label, via });
const TRANSITIONS = [T("/", "/courses", "Courses"), T("/", "/apply", "Apply", "menu"), T("/courses", "/course/algebra", "Algebra"), T("/courses", "/course/biology", "Biology"), T("/courses", "/course/chemistry", "Chemistry"), T("/", "/logout", "Log out")];

describe("the screen map", () => {
    it("makes one screen of sibling pages with the same structure, keeps the transitions between screens, and notes conditional fields", () => {
        const map = buildScreenMap({ pages: PAGES, transitions: TRANSITIONS }, [{ who: "teacher", pages: [page("/grades", "Grades")], transitions: [T("/", "/grades", "Grades")] }]);
        expect(map.screens.map((s) => s.key).sort()).toEqual(["/", "/apply", "/course/{slug}", "/courses", "/grades"]);
        expect(map.screens.find((s) => s.key === "/course/{slug}")!.paths).toEqual(["/course/algebra", "/course/biology"]);
        expect(map.screens.find((s) => s.key === "/grades")!.roles).toEqual(["teacher"]);
        // An unvisited page of a known template joins its screen; a logout link that no page explains is left out.
        expect(map.transitions.map((t) => `${t.from} -> ${t.to}: ${t.action} (${t.via})`).sort()).toEqual([
            "/ -> /apply: Apply (menu)",
            "/ -> /courses: Courses (link)",
            "/ -> /grades: Grades (link)",
            "/courses -> /course/{slug}: Algebra (link)",
            "/courses -> /course/{slug}: Biology (link)",
            "/courses -> /course/{slug}: Chemistry (link)",
        ]);
        expect(map.transitions.find((t) => t.to === "/grades")!.roles).toEqual(["teacher"]);
        expect(map.conditional).toEqual([{ screen: "/apply", when: "Role = Other", shows: ["Please specify"] }]);
    });

    it("counts the transitions authored tests follow, and adds one a test took that the crawl did not see", () => {
        const map = buildScreenMap({ pages: PAGES, transitions: TRANSITIONS });
        const spec = TestSpecSchema.parse({
            testId: "WEB-001",
            title: "Open a course",
            kind: "web",
            steps: [
                { action: "navigate", url: "/" },
                { action: "click", locator: { by: "role", role: "link", value: "Courses" } },
                { action: "click", locator: { by: "role", role: "link", value: "Algebra" } },
                { action: "click", locator: { by: "role", role: "button", value: "Apply now" } },
                { action: "assert", check: "url", expected: "/apply" },
            ],
        });
        expect(coverWithTests(map, [spec], O)).toBe(3);
        expect(mapCounts(map)).toEqual({ screens: 4, transitions: 6, covered: 3 });
        expect(map.transitions.find((t) => t.via === "test")).toMatchObject({ from: "/course/{slug}", to: "/apply", action: "apply now" });
    });

    it("lists the transitions no planned scenario follows", () => {
        const map = buildScreenMap({ pages: PAGES, transitions: TRANSITIONS });
        const gaps = uncoveredTransitions(map, [{ startPath: "/courses", title: "Open Algebra", description: "", preconditions: [], expectedResults: ["Algebra heading shown"] }], O);
        expect(gaps.map((g) => g.label)).toEqual([
            'transition on /: "Courses" leads to /courses ("Courses")',
            'transition on /: "Apply" leads to /apply ("Apply")',
            'transition on /courses: "Biology" leads to /course/algebra ("Algebra")',
            'transition on /courses: "Chemistry" leads to /course/algebra ("Algebra")',
        ]);
    });
});

const REACH: Reach[] = [
    { who: "anonymous", pages: [{ path: "/", heading: "Home" }] },
    { who: "teacher", pages: [{ path: "/", heading: "Home" }, { path: "/grades", heading: "Grades" }, { path: "/course/1", heading: "Algebra" }], controls: [{ path: "/course/1", names: ["Enrol", "Delete course"] }] },
    { who: "student", pages: [{ path: "/", heading: "Home" }, { path: "/course/2", heading: "Biology" }], controls: [{ path: "/course/2", names: ["Enrol"] }] },
];

describe("exploring as each role", () => {
    it("splits the level's page budget across the accounts, never below the minimum", () => {
        expect(rolePageBudget(60, 2)).toBe(30);
        expect(rolePageBudget(60, 5)).toBe(MIN_ROLE_PAGES);
        expect(rolePageBudget(250, 2)).toBe(125);
    });

    it("says what one account reaches or sees that another does not", () => {
        expect(roleDifferences(REACH)).toEqual(["“teacher” can open /grades (“Grades”); “student” did not reach it.", "On /course/{id}, “teacher” sees “Delete course”; “student” does not."]);
        expect(roleDifferences(REACH.slice(0, 2))).toEqual([]);
    });

    it("gives the planner the differences and the unvisited transitions, and keeps only real account names as roles", async () => {
        const prompts: string[] = [];
        const llm = {
            modelName: "scripted",
            usage: { inputTokens: 0, outputTokens: 0 },
            object: async ({ prompt }: { prompt: string }) => {
                prompts.push(prompt);
                const one = (title: string, role?: string) => ({ title, description: title, category: "Roles", startPath: "/course/1", expectedResults: [`${title} is shown`], requiresAuth: true, preconditions: [], requiredData: [], requirements: [], type: "functional", priority: "high", ...(role ? { role } : {}) });
                return { scenarios: prompt.includes("Plan now: role scenarios") ? [one("Teacher sees Delete course", "teacher"), one("Student has no Delete course", "student"), one("Ghost role idea", "ghost")] : [] };
            },
        };
        const model = { url: O, origin: O, siteType: "school", purpose: "", features: [], pages: PAGES, navigation: [], apis: [], authentication: { required: true, mechanisms: ["form"], loggedIn: true }, journeys: [], externalDependencies: [], documentedTestCases: [], stats: { pagesVisited: 5, pagesSkipped: 0, apisFound: 0, durationMs: 1 }, screenMap: buildScreenMap({ pages: PAGES, transitions: TRANSITIONS }) } as AppModel;
        const ctx = { config: loadConfig({}), llm, emit: () => undefined } as unknown as EngineContext;
        const out = await planScenarios(ctx, model, { maxScenarios: 50, hasCredentials: false, roles: ["teacher", "student"], roleDifferences: roleDifferences(REACH) });
        const rolePrompt = prompts.find((p) => p.includes("Plan now: role scenarios"))!;
        expect(rolePrompt).toContain("“teacher” sees “Delete course”");
        // Without the project's own account, role scenarios still count; an unknown role falls back to the project's account and is left out.
        expect(out.map((s) => [s.title, s.role])).toEqual([
            ["Teacher sees Delete course", "teacher"],
            ["Student has no Delete course", "student"],
        ]);
        expect(prompts.some((p) => p.includes('transition on /courses: "Biology" leads to /course/algebra') && p.includes("Not tested yet"))).toBe(true);
        expect(prompts.some((p) => p.includes("conditional fields (plan a scenario per branch): after Role = Other it shows Please specify"))).toBe(true);
    });
});

describe("a role scenario", () => {
    it("is authored with that role's account, and its script signs in as that account", async () => {
        const scenarios = [
            ScenarioSchema.parse({ scenarioId: "S-001", title: "Teacher sees Delete course", description: "x", category: "Roles", expectedResults: ["Delete course is shown"], requiresAuth: true, role: "teacher" }),
            ScenarioSchema.parse({ scenarioId: "S-002", title: "Browse courses", description: "x", category: "Courses", expectedResults: ["Courses are listed"] }),
        ];
        const plan: StoredPlan = { version: 1, createdAt: new Date().toISOString(), model: { url: O, origin: O, siteType: "school", purpose: "", features: [], pages: [], navigation: [], apis: [], authentication: { required: true, mechanisms: ["form"], loggedIn: true }, journeys: [], externalDependencies: [], documentedTestCases: [], stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 1 } } as never, scenarios, analysed: true, specBaseTrusted: false, accessReach: [], apiAccess: [], warnings: [] };
        const created: Array<{ spec: { title: string; steps: Array<{ value?: string }>; tags: string[] } }> = [];
        let keys = 0;
        const sink = new Proxy({} as GenerationSink, {
            get: (_t, k) => {
                if (k === "then" || k === "loadMemory" || k === "saveMemory" || k === "restoreTest" || k === "rememberPhone") return undefined;
                if (k === "agentAction") return () => undefined;
                return async (...args: unknown[]) => {
                    if (k === "nextTestKey") return `${String(args[0])}-${String(++keys).padStart(3, "0")}`;
                    if (k === "createTest") {
                        created.push(args[0] as never);
                        return { id: `t${created.length}`, testId: `T-${created.length}` };
                    }
                    if (k === "startAgentRun") return "run-1";
                    if (k === "loadBaselines") return [];
                    return undefined;
                };
            },
        });
        const cfg = loadConfig({ SECRET_KEY: "screenmap-roles-secret-0123456789" } as never);
        const req = {
            url: O,
            maxPages: 60,
            maxDepth: 4,
            maxScenarios: 50,
            targets: ["web"],
            allowMutatingApiTests: false,
            plan,
            useMemory: false,
            credentials: { username: "owner@example.com", password: "owner-pw" },
            roles: [{ name: "teacher", username: "teacher@example.com", password: "teacher-pw" }, { name: "student", username: "student@example.com", password: "student-pw" }],
            securityChecks: false,
            healthChecks: false,
            accessibility: false,
            accessChecks: false,
            inputChecks: false,
            contractChecks: false,
        } as unknown as GenerationRequest;
        await runGeneration({ config: cfg, llm: createLlmClientOrUnavailable(cfg), emit: () => undefined }, req, sink);
        expect(authored.sort((a, b) => a.scenario.localeCompare(b.scenario))).toEqual([
            { scenario: "S-001", username: "teacher@example.com" },
            { scenario: "S-002", username: "owner@example.com" },
        ]);
        const teacher = created.find((c) => c.spec.title === "Teacher sees Delete course")!.spec;
        expect(teacher.steps.map((s) => s.value).filter(Boolean)).toEqual(["{{credentials.teacher.username}}", "{{credentials.teacher.password}}"]);
        expect(teacher.tags).toContain("role:teacher");
        const other = created.find((c) => c.spec.title === "Browse courses")!.spec;
        expect(other.steps.map((s) => s.value).filter(Boolean)).toEqual(["{{credentials.username}}", "{{credentials.password}}"]);
        // The script reads the account's own variables; no sign-in detail is written into it.
        const script = renderWithAdapter(TestSpecSchema.parse(teacher), "playwright", { baseUrl: O, apiBaseUrl: O, deleteOps: [] } as never).content;
        expect(script).toContain("process.env.TEST_TEACHER_USERNAME");
        expect(script).not.toContain("teacher-pw");
    });

    it("uses the project's account when the scenario's role is not one of its accounts", () => {
        expect(roleCredentials({ role: "ghost" }, [{ name: "teacher", username: "t", password: "p" }])).toBeUndefined();
        expect(roleCredentials({}, [{ name: "teacher", username: "t", password: "p" }])).toBeUndefined();
        expect(asRole({ steps: [{ value: "{{ credentials.totp }}" }], testData: { u: "{{credentials.username}}" }, tags: [] }, "Teacher")).toEqual({ steps: [{ value: "{{credentials.teacher.totp}}" }], testData: { u: "{{credentials.teacher.username}}" }, tags: ["role:teacher"] });
    });
});
