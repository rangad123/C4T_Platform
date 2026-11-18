/** Row 184: a coverage record as the engine writes one (orchestrator.ts ExplorationSummary), for the runner protocol tests. */
import type { ExplorationSummary } from "../../src/engine/orchestrator.js";

const tally = (total: number, exercised: number, notExercised: string[] = []) => ({ total, exercised, notExercised, more: 0 });

export function sampleExploration(over: Partial<ExplorationSummary> = {}): ExplorationSummary {
    return {
        stopReason: "objectives_done",
        stopDetail: "Every objective was pursued.",
        budgets: { objectives: 4, actions: 60, aiCalls: 50, tokens: 400_000, minutes: 20, depth: 3, steps: 30 },
        objectives: [{ id: "OBJ-0123456789abcdef", kind: "workflow", source: "checkout", priority: 3, reason: "A workflow the application states.", operators: ["as_stated", "back"] }],
        overCap: 0,
        skipped: [{ objectiveId: "OBJ-0123456789abcdef", operator: "double_submit", reason: "not run: data changes off" }],
        outcomes: [
            { objectiveId: "OBJ-0123456789abcdef:as_stated", status: "completed", reason: "done", actions: 2, result: { authoring: "complete", testKey: "checkout-as-stated" } },
            { objectiveId: "OBJ-0123456789abcdef:back", status: "not_reached", reason: "The session ended first.", actions: 0 },
        ],
        usage: { objectives: 1, actions: 2, aiCalls: 3, tokens: 1_200, minutes: 1 },
        coverage: {
            pages: { ...tally(2, 1, ["/cart"]), unknown: [] },
            states: 1,
            elements: tally(4, 2, ["Pay", "Remove"]),
            workflowSteps: tally(2, 1),
            transitions: tally(0, 0),
            inputClasses: tally(0, 0),
            rules: tally(1, 0, ["R-1"]),
            endpoints: tally(0, 0),
            uniqueScenarios: 1,
            unexplored: [{ objectiveId: "OBJ-0123456789abcdef", kind: "workflow", source: "checkout", priority: 3, reason: "A workflow the application states.", status: "not_reached" }],
            unexploredMore: 0,
            notRun: [{ objectiveId: "OBJ-0123456789abcdef", operator: "double_submit", reason: "data changes off" }, { operator: "back", reason: "history back not covered" }],
            notRunMore: 0,
        },
        actionLog: [
            { seq: 1, objectiveId: "OBJ-0123456789abcdef:as_stated", state: "/products|abc123abc123", action: 'click {"target":"Add to cart"}', atMs: 120, result: "performed" },
            { seq: 2, objectiveId: "OBJ-0123456789abcdef:as_stated", state: "/cart|def456def456", action: 'click {"target":"Add to cart"}', atMs: 300, result: "refused", reason: "the same action on the same state" },
        ],
        actionLogOmitted: 0,
        ...over,
    };
}
