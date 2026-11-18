/**
 * Sheet #7: the exploration's progress tree (web/src/features/explore/explore-tree.ts) folded from events as the engine records them:
 * stages, then pages found, then test ideas, then tests, each with its state; a stopped job says what was not reached; a continued one says
 * what it kept. Browser-free.
 */
import { describe, expect, it } from "vitest";
import type { EventRow, PhaseKey, PhaseState } from "../web/src/api.js";
import { foldExploreTree, type TreeNode } from "../web/src/features/explore/explore-tree.js";
import type { RunTest } from "../web/src/features/runs/run-text.js";

let n = 0;
const ev = (kind: string, message: string, data?: Record<string, unknown>): EventRow => ({ id: ++n, stage: "x", kind, level: "info", message, createdAt: "2026-11-18T10:00:00Z", ...(data ? { data } : {}) });
const ALL: PhaseKey[] = ["discovery", "understanding", "planning", "generation", "validation"];
const progress = (p: Partial<Record<PhaseKey, PhaseState>>): Record<PhaseKey, PhaseState> => ({ discovery: "pending", understanding: "pending", planning: "pending", generation: "pending", validation: "pending", ...p });
const test = (id: string, testId: string, title: string, state: RunTest["state"]): RunTest => ({ id, testId, title, suite: "s", state });
/** "label=state" for a node's children, for short assertions. */
const kids = (node: TreeNode | undefined) => (node?.children ?? []).map((c) => `${c.label}=${c.state}`);
const stage = (tree: TreeNode[], phase: PhaseKey) => tree.find((s) => s.id === `stage:${phase}`)!;

// What a plan-only exploration records (crawler.ts page_visited/page_failed, planner.ts scenario_planned).
const planEvents = [
    ev("application_discovered", "Starting discovery of http://127.0.0.1:6731"),
    ev("page_visited", "Visited / (home, 0 forms, 4 controls)", { url: "http://127.0.0.1:6731/", status: 200, depth: 0, type: "home" }),
    ev("page_visited", "Visited /products (listing, 0 forms, 1 controls)", { url: "http://127.0.0.1:6731/products", status: 200, depth: 1, type: "listing" }),
    ev("page_failed", "Could not load http://127.0.0.1:6731/broken: net::ERR_EMPTY_RESPONSE"),
    ev("scenario_planned", "S-001 [Browsing/high] Browse the product list", { scenarioId: "S-001", title: "Browse the product list" }),
    // An older job's event, without data: read from its message.
    ev("scenario_planned", "S-002 [Browsing/low] Read the about page"),
];

// What a creation from the plan records (orchestrator.ts), while it writes the second idea.
const creationEvents = [
    ev("plan_reused", "Starting from the plan you approved: 5 pages and 0 API endpoints (nothing is explored again)"),
    ev("scenarios_queued", "3 test idea(s) to write", { scenarios: [{ scenarioId: "S-001", title: "Browse the product list" }, { scenarioId: "S-002", title: "Read the about page" }, { scenarioId: "S-003", title: "Open the contact page" }] }),
    ev("scenario_started", "S-001 Browse the product list", { scenarioId: "S-001" }),
    ev("script_generated", "WEB-001 Browse the product list (2 steps)", { scenarioId: "S-001", testId: "WEB-001" }),
    ev("scenario_started", "S-002 Read the about page", { scenarioId: "S-002" }),
];

describe("the progress tree, from recorded events", () => {
    it("a plan-only exploration: stages, the pages found and the test ideas, each with its state", () => {
        const tree = foldExploreTree({ phases: ["discovery", "understanding", "planning"], progress: progress({ discovery: "done", understanding: "done", planning: "running" }), events: planEvents, tests: [], active: true, stopped: false });
        expect(tree.map((s) => `${s.phase}=${s.state}`)).toEqual(["discovery=done", "understanding=done", "planning=running"]);
        expect(kids(stage(tree, "discovery"))).toEqual(["/=done", "/products=done", "http://127.0.0.1:6731/broken=failed"]);
        expect(stage(tree, "discovery").children[2]!.detail).toBe("Could not be loaded");
        expect(kids(stage(tree, "planning"))).toEqual(["S-001 Browse the product list=done", "S-002 Read the about page=done"]);
    });

    it("a creation: each idea waits, runs and is written, with its test under it; the checks are one group", () => {
        const tests = [test("t1", "WEB-001", "Browse the product list", "passed"), test("t2", "WEB-002", "Accessibility: /", "running"), test("t3", "API-001", "Security headers", "waiting")];
        const tree = foldExploreTree({ phases: ALL, progress: progress({ discovery: "done", understanding: "done", planning: "done", generation: "running" }), events: creationEvents, tests, active: true, stopped: false });
        const gen = stage(tree, "generation");
        expect(gen.state).toBe("running");
        expect(kids(gen)).toEqual(["S-001 Browse the product list=done", "S-002 Read the about page=running", "S-003 Open the contact page=waiting", "Checks (2)=running"]);
        expect(kids(gen.children[0])).toEqual(["WEB-001 Browse the product list=done"]);
        expect(gen.children[0]!.children[0]!.detail).toBe("Passing");
        expect(kids(gen.children[3])).toEqual(["WEB-002 Accessibility: /=running", "API-001 Security headers=waiting"]);
        // The kept pages are said under the crawl, not listed again.
        expect(kids(stage(tree, "discovery"))).toEqual(["5 pages kept from before, not explored again=done"]);
        expect(stage(tree, "validation").state).toBe("waiting");
    });

    it("a stopped creation: what the stop came before is not reached, never left waiting or running", () => {
        const tree = foldExploreTree({ phases: ALL, progress: progress({ discovery: "done", understanding: "done", planning: "done", generation: "running" }), events: creationEvents, tests: [test("t1", "WEB-001", "Browse the product list", "not_run")], active: false, stopped: true });
        const gen = stage(tree, "generation");
        expect(kids(gen)).toEqual(["S-001 Browse the product list=done", "S-002 Read the about page=skipped", "S-003 Open the contact page=skipped"]);
        expect(gen.children[1]!.detail).toBe("Stopped here");
        expect(gen.children[2]!.detail).toBe("Not reached: the exploration was stopped");
        expect(gen).toMatchObject({ state: "skipped", detail: "Stopped here" });
        expect(stage(tree, "validation")).toMatchObject({ state: "skipped", detail: "Not reached: the exploration was stopped" });
        expect(kids(gen.children[0])).toEqual(["WEB-001 Browse the product list=skipped"]);
    });

    it("ideas that could not be written, failed, or found a problem say so; a continued creation says what it kept", () => {
        const events = [
            ev("creation_resumed", "Continuing the stopped creation: its 4 test(s) are kept", { carried: 4, toRun: 2 }),
            ev("scenarios_queued", "3", { scenarios: [{ scenarioId: "S-002", title: "B" }, { scenarioId: "S-003", title: "C" }, { scenarioId: "S-004", title: "D" }] }),
            ev("scenario_skipped", 'S-002 "B" could not be authored: no such button', { scenarioId: "S-002" }),
            ev("scenario_failed", "S-003: provider error", { scenarioId: "S-003" }),
            ev("possible_defect", "WEB-009 D: total is wrong", { scenarioId: "S-004", testId: "WEB-009" }),
        ];
        const tree = foldExploreTree({ phases: ALL, progress: progress({ discovery: "done", understanding: "done", planning: "done", generation: "done", validation: "done" }), events, tests: [test("t9", "WEB-009", "D", "finding")], active: false, stopped: false });
        const gen = stage(tree, "generation");
        expect(kids(gen)).toEqual(["4 tests kept from the stopped creation, not made again=done", "S-002 B=skipped", "S-003 C=failed", "S-004 D=done"]);
        expect(gen.children[1]!.detail).toBe("Could not be written in this application");
        expect(kids(gen.children[3])).toEqual(["WEB-009 D=failed"]);
        expect(gen.children[3]!.children[0]!.detail).toBe("Needs a look");
    });
});

// A repeat exploration as crawler.ts and orchestrator.ts record it (sheet #8 stage 4): two unchanged pages took their probe results, then a
// spot check switched reuse off and one of them was tried again.
const repeatEvents = () => [
    ev("signin_reused", "reused: went straight to the sign-in page known since 2026-11-10 (/login); ...", { path: "/login", since: "2026-11-10T08:00:00.000Z" }),
    ev("page_visited", "Visited / (home, 0 forms, 4 controls); unchanged since 2026-11-10, so ...", { url: "http://127.0.0.1:6731/", status: 200, depth: 0, type: "home", reusedFrom: "2026-11-10T08:00:00.000Z" }),
    ev("page_visited", "Visited /about (content, 0 forms, 1 controls); unchanged since 2026-11-09, so ...", { url: "http://127.0.0.1:6731/about", status: 200, depth: 1, type: "content", reusedFrom: "2026-11-09T08:00:00.000Z" }),
    ev("page_visited", "Visited /products (listing, 0 forms, 1 controls)", { url: "http://127.0.0.1:6731/products", status: 200, depth: 1, type: "listing" }),
    ev("reuse_off", "Reuse of the last exploration is off for the rest of this run: a spot check of /products found ...", { reason: "a spot check of /products found it behaves differently from the last exploration", changed: 0, spotChecked: 1 }),
    ev("reuse_reprobed", "Tried again the 1 page whose earlier results were taken before reuse was switched off.", { pages: 1 }),
    ev("probes_reused", "reused: 1 page unchanged since 2026-11-10. ...", { pages: 1, since: "2026-11-10T08:00:00.000Z", spotChecked: 1, expired: 0, changed: 0, paths: ["/"] }),
    ev("pages_from_memory", "Started from 3 pages the last exploration knew", { pages: 3, gone: 1 }),
    ev("understanding_reused", "2 unchanged pages were not sent to the AI again", { pages: 2, of: 3 }),
];

describe("what an exploration reused, in the progress tree", () => {
    it("a reused page carries the badge with its date; one tried again after reuse went off loses it and says so", () => {
        const tree = foldExploreTree({ phases: ["discovery", "understanding", "planning"], progress: progress({ discovery: "done", understanding: "done", planning: "done" }), events: repeatEvents(), tests: [], active: false, stopped: false });
        const disc = stage(tree, "discovery");
        const page = (label: string) => disc.children.find((c) => c.label === label)!;
        expect(page("/").badge).toEqual({ text: "Reused 2026-11-10", tone: "info" });
        expect(page("/").detail).toMatch(/^Unchanged since 2026-11-10: its menus, conditional fields and validation messages were taken from then/);
        expect(page("/about").badge).toBeUndefined();
        expect(page("/about").detail).toBe("Tried again after reuse was switched off");
        expect(page("/products").badge).toBeUndefined();
        expect(page("/products").detail).toBeUndefined();
    });

    it("the crawl says what it reused and, as a warning, that reuse was switched off and why; the reading says what it did not resend", () => {
        const tree = foldExploreTree({ phases: ["discovery", "understanding", "planning"], progress: progress({ discovery: "done", understanding: "done", planning: "done" }), events: repeatEvents(), tests: [], active: false, stopped: false });
        const notes = stage(tree, "discovery").children.filter((c) => c.id.startsWith("note:"));
        expect(notes.map((n) => [n.label, n.badge?.text ?? null, n.detail ?? null])).toEqual([
            ["Went straight to the sign-in page /login", "Reused 2026-11-10", "The form was still filled and the sign-in checked."],
            ["Reuse of the last exploration was switched off for the rest of this run", "Reuse off", "Why: a spot check of /products found it behaves differently from the last exploration."],
            ["1 page was tried again after reuse was switched off", null, null],
            ["1 page unchanged since 2026-11-10: not tried again", "Reused 2026-11-10", "1 page was tried anyway as a spot check and matched."],
            ["Started from 3 pages the last exploration knew", "Reused", "1 known page is gone now and was left out."],
        ]);
        expect(notes.find((n) => n.badge?.text === "Reuse off")!.badge!.tone).toBe("warning");
        expect(stage(tree, "understanding").children.map((c) => [c.label, c.badge?.text])).toEqual([["2 unchanged pages were not sent to the AI again", "Reused"]]);
    });

    it("explore everything again is said as reuse off; without reuse events nothing carries a badge", () => {
        const asked = foldExploreTree({ phases: ["discovery"], progress: progress({ discovery: "done" }), events: [ev("full_exploration", "Exploring every page again, as asked: nothing is reused from the last exploration."), ...planEvents], tests: [], active: false, stopped: false });
        expect(stage(asked, "discovery").children[0]).toMatchObject({ label: "Everything was explored again, as asked: nothing was reused", badge: { text: "Reuse off", tone: "warning" } });
        const plain = foldExploreTree({ phases: ["discovery"], progress: progress({ discovery: "done" }), events: planEvents, tests: [], active: false, stopped: false });
        expect(stage(plain, "discovery").children.some((c) => c.badge)).toBe(false);
    });
});
