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
