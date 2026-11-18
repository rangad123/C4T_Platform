/**
 * Row 205 (row 204 triage): how the objective stage turns the level's budgets and the model's objectives into pursuits, without a
 * browser or a model.
 *   - The level's `objectives` caps objectives when the list is built; the loop then runs every pursuit built from them (one objective
 *     with one operator each), still bounded by the session's time, AI-call, token and action budgets.
 */
import { describe, expect, it } from "vitest";
import { runExploration } from "../src/engine/explore/loop.js";
import { LEVEL_SETTINGS } from "../src/engine/levels.js";
import { sessionBudgets } from "../src/engine/orchestrator.js";

describe("the session's pursuit budget", () => {
    it("3 objectives x 3 operators with an objectives budget of 3 runs all 9 pursuits", async () => {
        const level = { ...LEVEL_SETTINGS.thorough.exploration, objectives: 3 };
        const pursuits = ["OBJ-a", "OBJ-b", "OBJ-c"].flatMap((id, i) =>
            ["as_stated", "double_submit", "refresh"].map((op) => ({ id: `${id}:${op}`, priority: 10 - i, fingerprint: `${id}-${op}` })),
        );
        const budgets = sessionBudgets(level, pursuits.length);
        const ran: string[] = [];
        const r = await runExploration({
            objectives: pursuits,
            budgets,
            runObjective: async (p) => (ran.push(p.id), { status: "completed" }),
            now: () => 0,
            usage: () => ({ aiCalls: 0, tokens: 0 }),
            reset: async () => undefined,
        });
        expect(ran).toHaveLength(9);
        expect(r.outcomes.filter((o) => o.status === "not_reached")).toEqual([]);
        expect(r.stopReason).toBe("objectives_done");
        // The other budgets are the level's own.
        expect(budgets).toEqual({ objectives: 9, actions: level.actions, aiCalls: level.aiCalls, tokens: level.tokens, minutes: level.minutes, depth: level.depth });
    });

    it("the session's other budgets still stop the pursuits", async () => {
        const level = { ...LEVEL_SETTINGS.thorough.exploration, objectives: 3, aiCalls: 4 };
        const pursuits = Array.from({ length: 9 }, (_, i) => ({ id: `OBJ-${i}:as_stated`, priority: 1, fingerprint: `f${i}` }));
        let calls = 0;
        const r = await runExploration({
            objectives: pursuits,
            budgets: sessionBudgets(level, pursuits.length),
            runObjective: async () => ((calls += 1), { status: "completed" }),
            now: () => 0,
            usage: () => ({ aiCalls: calls, tokens: 0 }),
            reset: async () => undefined,
        });
        expect(calls).toBe(4);
        expect(r.stopReason).toBe("ai_calls");
    });
});
