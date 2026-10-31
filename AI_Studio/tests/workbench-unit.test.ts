/**
 * The facts the test workbench states, computed from what the platform stored (pure: no browser, no server):
 * which step results are about the steps as they are now, when "Undo my last edit" is true, how unsaved changes are counted,
 * the one history list, which two versions can be compared, and the tab routes.
 */
import { describe, expect, it } from "vitest";
import { diffSteps } from "../web/src/features/builder/stepdiff.js";
import { buildHistory, changeCount, changesWord, comparePair, lastEditBeforeFailure, marksCurrent, stepMarks, tabOf, TABS, type Execution, type SpecVersionRow } from "../web/src/features/workbench/test-model.js";
import { resolveAlias } from "../web/src/lib/aliases.js";
import { routes } from "../web/src/lib/router.js";

const at = (min: number) => new Date(Date.UTC(2026, 9, 13, 12, min, 0)).toISOString();
const run = (min: number, status: "passed" | "failed", steps: Execution["steps"] = []): Execution => ({ id: `e${min}`, attempt: 1, status, durationMs: 1200, error: null, startedAt: at(min), steps, artifacts: [] });
const ver = (version: number, min: number, note: string | null = null): SpecVersionRow => ({ version, createdAt: at(min), note, steps: 3 });

describe("tab routes", () => {
    it("knows the four tabs and nothing else", () => {
        expect(TABS).toEqual(["steps", "text", "code", "history"]);
        expect(tabOf("text")).toBe("text");
        expect(tabOf("builder")).toBeNull();
        expect(tabOf(undefined)).toBeNull();
        expect(routes.testTab("t1", "history")).toBe("#/tests/t1/history");
        // the old step editor route is an alias of the Steps tab; the old code route is the Code tab itself
        expect(routes.builder("t1")).toBe("#/tests/t1/steps");
        expect(resolveAlias(["tests", "t1", "builder"], new URLSearchParams())).toBe("#/tests/t1/steps");
        expect(resolveAlias(["tests", "t1", "code"], new URLSearchParams())).toBeNull();
        expect(resolveAlias(["tests", "t1"], new URLSearchParams())).toBeNull();
        expect(routes.code("t1", { history: true })).toBe("#/tests/t1/code?history=1");
    });
});

describe("stepMarks: what the last run said about each step", () => {
    const spec = { steps: [{ action: "navigate" }, { action: "click" }, { action: "assert" }] };
    it("follows the steps by position", () => {
        const marks = stepMarks({ spec, executions: [run(10, "failed", [{ index: 0, title: "a", status: "passed", error: null }, { index: 1, title: "b", status: "passed", error: null }, { index: 2, title: "c", status: "failed", error: "nope" }])] });
        expect(marks.map((m) => m?.status)).toEqual(["passed", "passed", "failed"]);
        expect(marks[2]?.error).toBe("nope");
    });
    it("has no marks for a test that never ran, or a step the run did not reach", () => {
        expect(stepMarks({ spec, executions: [] })).toEqual([undefined, undefined, undefined]);
        expect(stepMarks({ spec, executions: [run(1, "failed", [{ index: 0, title: "a", status: "failed", error: "x" }])] }).map((m) => m?.status)).toEqual(["failed", undefined, undefined]);
    });
    it("marks a use of reusable steps by all the steps inside it", () => {
        const withBlock = { steps: [{ action: "navigate" }, { action: "useBlock" }] };
        const runSteps = [
            { index: 0, from: 0, step: {} },
            { index: 1, from: 1, block: "Sign in", step: {} },
            { index: 2, from: 1, block: "Sign in", step: {} },
        ];
        const passed = stepMarks({ spec: withBlock, runSteps, executions: [run(1, "passed", [0, 1, 2].map((i) => ({ index: i, title: "s", status: "passed" as const, error: null })))] });
        expect(passed.map((m) => m?.status)).toEqual(["passed", "passed"]);
        const failed = stepMarks({ spec: withBlock, runSteps, executions: [run(1, "failed", [{ index: 0, title: "s", status: "passed", error: null }, { index: 1, title: "s", status: "passed", error: null }, { index: 2, title: "s", status: "failed", error: "inside" }])] });
        expect(failed.map((m) => m?.status)).toEqual(["passed", "failed"]);
        expect(failed[1]?.error).toBe("inside");
    });
});

describe("marksCurrent: are the marks about the steps as they are now", () => {
    it("is true when no edit was saved after the run began, and for a test never edited", () => {
        expect(marksCurrent(undefined, [{ startedAt: at(10) }])).toBe(true);
        expect(marksCurrent([ver(1, 1), ver(2, 5)], [{ startedAt: at(10) }])).toBe(true);
    });
    it("is false after an edit that came later, and when nothing ran", () => {
        expect(marksCurrent([ver(1, 1), ver(2, 15)], [{ startedAt: at(10) }])).toBe(false);
        expect(marksCurrent([ver(1, 1)], [])).toBe(false);
    });
});

describe("lastEditBeforeFailure: Undo my last edit is offered only when it is true", () => {
    const failing = (executions: Array<{ status: string; startedAt: string }>, status = "FAILED_VALIDATION") => ({ validationStatus: status, executions });
    it("offers it when a passing run, then an edit, then a failing run", () => {
        const r = lastEditBeforeFailure(failing([{ status: "failed", startedAt: at(20) }, { status: "passed", startedAt: at(5) }]), [ver(1, 1, "Before the first edit"), ver(2, 10)]);
        expect(r).toEqual({ version: 2, goBackTo: 1, at: at(10) });
    });
    it("goes back to the version just before the newest", () => {
        const r = lastEditBeforeFailure(failing([{ status: "failed", startedAt: at(40) }, { status: "passed", startedAt: at(5) }]), [ver(1, 1), ver(2, 10), ver(3, 30)]);
        expect(r?.goBackTo).toBe(2);
        expect(r?.version).toBe(3);
    });
    it("does not offer it when the test passes, was never edited, or the edit came after the failing run", () => {
        expect(lastEditBeforeFailure({ validationStatus: "VALIDATED", executions: [{ status: "passed", startedAt: at(20) }] }, [ver(1, 1), ver(2, 10)])).toBeNull();
        expect(lastEditBeforeFailure(failing([{ status: "failed", startedAt: at(20) }, { status: "passed", startedAt: at(5) }]), [ver(1, 1)])).toBeNull();
        expect(lastEditBeforeFailure(failing([{ status: "failed", startedAt: at(20) }, { status: "passed", startedAt: at(5) }]), undefined)).toBeNull();
        expect(lastEditBeforeFailure(failing([{ status: "failed", startedAt: at(8) }, { status: "passed", startedAt: at(5) }]), [ver(1, 1), ver(2, 10)])).toBeNull();
    });
    it("does not offer it when nothing had passed before the edit (the edit is not shown to be the cause)", () => {
        expect(lastEditBeforeFailure(failing([{ status: "failed", startedAt: at(20) }, { status: "failed", startedAt: at(5) }]), [ver(1, 1), ver(2, 10)])).toBeNull();
        expect(lastEditBeforeFailure(failing([{ status: "failed", startedAt: at(20) }]), [ver(1, 1), ver(2, 10)])).toBeNull();
    });
    it("also covers a finding that appeared after an edit", () => {
        expect(lastEditBeforeFailure(failing([{ status: "failed", startedAt: at(20) }, { status: "passed", startedAt: at(5) }], "NEEDS_REVIEW"), [ver(1, 1), ver(2, 10)])?.goBackTo).toBe(1);
    });
});

describe("counting unsaved changes", () => {
    const nav = { action: "navigate", url: "/a" };
    const click = { action: "click", locator: { by: "role", role: "button", value: "Go" } };
    it("counts steps added, removed, changed and moved, and details like the name", () => {
        const base = { title: "Search", steps: [nav, click] };
        expect(changeCount(diffSteps(base, base))).toBe(0);
        expect(changeCount(diffSteps(base, { title: "Search", steps: [nav, click, { action: "assert", check: "text", expected: "x" }] }))).toBe(1);
        expect(changeCount(diffSteps(base, { title: "Search more", steps: [nav, { ...click, locator: { by: "role", role: "button", value: "Find" } }] }))).toBe(2);
    });
    it("says it in words", () => {
        expect(changesWord(1)).toBe("1 unsaved change");
        expect(changesWord(3)).toBe("3 unsaved changes");
    });
});

describe("buildHistory: one list of everything that happened", () => {
    const base = { specVersions: [] as SpecVersionRow[], codeVersions: [], executions: [] as Execution[], repairs: [], autoFix: null, imported: null, quarantine: [] };
    it("puts versions, runs, repairs, imports and quarantine in one list, newest first", () => {
        const failed = { ...run(30, "failed"), artifacts: [{ id: "a1", kind: "screenshot" }, { id: "a2", kind: "trace" }] };
        const list = buildHistory({
            ...base,
            specVersions: [ver(1, 1, "Before the first edit"), ver(2, 10), ver(3, 12, "Edited as text"), ver(4, 14, "Restored version 2"), ver(5, 15, "Undid version 4")],
            codeVersions: [{ version: 1, createdAt: at(50), kind: "taken-over", note: null, by: "Nitika" }],
            executions: [run(5, "passed"), failed],
            repairs: [
                { id: "r1", status: "applied", oldDescription: "the Add button", newDescription: "the Add to cart button", createdAt: at(20), decidedAt: at(22) },
                { id: "r2", status: "proposed", oldDescription: "x", newDescription: "y", createdAt: at(23), decidedAt: null },
            ],
            autoFix: { attempts: 2, at: at(2) },
            imported: { text: "Imported from Git (github.com/acme/tests, main)", at: at(0) },
            quarantine: [{ id: "1", at: at(40), by: "Maya", kind: "put it in quarantine", reason: "Flaky" }],
        });
        expect(list.map((e) => e.key)).toEqual(["code-1", "q-1", "run-e30", "repair-r1", "steps-5", "steps-4", "steps-3", "steps-2", "run-e5", "auto-fix", "steps-1", "import"]);
        // a proposed repair is not history yet; a failed run carries its screenshot, not the trace
        expect(list.find((e) => e.key === "repair-r2")).toBeUndefined();
        expect(list.find((e) => e.key === "run-e30")?.run?.evidence).toEqual({ id: "a1", kind: "screenshot" });
        expect(list.find((e) => e.key === "steps-1")?.kind).toBe("original");
        expect(list.find((e) => e.key === "steps-3")?.kind).toBe("text");
        expect(list.find((e) => e.key === "steps-4")?.kind).toBe("restore");
        expect(list.find((e) => e.key === "steps-5")?.kind).toBe("restore");
        // only the newest version of each family is current
        expect(list.filter((e) => e.version?.current).map((e) => e.key).sort()).toEqual(["code-1", "steps-5"]);
    });
    it("is empty for a test that has had nothing happen", () => {
        expect(buildHistory(base)).toEqual([]);
    });
    it("does not show a run's evidence that the retention policy removed", () => {
        const pruned = { ...run(9, "failed"), artifacts: [{ id: "gone", kind: "screenshot", pruned_at: at(9) }] };
        expect(buildHistory({ ...base, executions: [pruned] })[0]?.run?.evidence).toBeUndefined();
    });
});

describe("comparePair: which two versions can be compared", () => {
    it("needs two, orders them, and refuses to compare steps with code", () => {
        expect(comparePair([])).toBeNull();
        // one version is compared with the newest of its kind, unless it is the newest
        expect(comparePair([{ family: "steps", n: 1 }], { steps: 3, code: 2 })).toEqual({ family: "steps", from: 1, to: 3 });
        expect(comparePair([{ family: "code", n: 1 }], { steps: 3, code: 2 })).toEqual({ family: "code", from: 1, to: 2 });
        expect(comparePair([{ family: "steps", n: 3 }], { steps: 3 })).toBeNull();
        expect(comparePair([{ family: "steps", n: 3 }])).toBeNull();
        expect(comparePair([{ family: "steps", n: 3 }, { family: "steps", n: 1 }])).toEqual({ family: "steps", from: 1, to: 3 });
        expect(comparePair([{ family: "code", n: 1 }, { family: "code", n: 2 }])).toEqual({ family: "code", from: 1, to: 2 });
        const mixed = comparePair([{ family: "steps", n: 1 }, { family: "code", n: 1 }]);
        expect(mixed && "problem" in mixed ? mixed.problem : "").toContain("same kind");
    });
});
