/**
 * Row 205 item 7 (owner decision 2026-11-21, row 206): the test writer and the planner may place orders and make payments only when the
 * project allows tests that change data (allowMutatingApiTests, passed in as `allowPurchases`; the engine reads no environment). Off,
 * the prompts keep the rule to stop before paying. Either way the writer never types a real card number and pays only with test data a
 * person supplied or the application's own test-mode values. No browser, no model.
 */
import { describe, expect, it } from "vitest";
import { planningSystem } from "../src/engine/planning/planner.js";
import { authoringSystem } from "../src/engine/web/author.js";

const NO_REAL_CARDS = /Never type a real card number: pay only with test data you were given \(the test account, test card values in the test data or notes, or the application's own test-mode values shown on the page\)\./;

describe("the writer's payment rule", () => {
    it("off: the prompt keeps the rule to stop before payments, and the no-real-card-numbers sentence", () => {
        for (const p of [authoringSystem({}), authoringSystem({ allowPurchases: false })]) {
            expect(p).toContain("- Never perform irreversible/destructive real-world actions (payment, deleting accounts, sending messages). Stop before them and assert on the UI.");
            expect(p).toMatch(NO_REAL_CARDS);
            expect(p).not.toMatch(/placing orders and making payments .* allowed/i);
        }
    });

    it("on: placing orders and paying is allowed, other irreversible actions are not, and the no-real-card-numbers sentence stays", () => {
        const p = authoringSystem({ allowPurchases: true });
        expect(p).not.toMatch(/Never perform irreversible\/destructive real-world actions \(payment/);
        expect(p).toMatch(/This project allows tests that change data, so placing orders and making payments in the application under test is allowed/);
        expect(p).toMatch(/deleting accounts, sending messages.*still never/);
        expect(p).toMatch(NO_REAL_CARDS);
    });

    it("the vision, test-data and compact-snapshot notes are still added", () => {
        expect(authoringSystem({ vision: true, testData: true, compact: true }).length).toBeGreaterThan(authoringSystem({}).length);
    });
});

describe("the planner's payment rule", () => {
    it("off: no real payments are planned; on: placing orders and paying with test data may be planned, never deleting accounts", () => {
        const off = planningSystem(false);
        expect(off).toMatch(/NEVER plan actions that cause irreversible or external effects against a live site: no real payments/);
        const on = planningSystem(true);
        expect(on).not.toMatch(/no real payments/);
        expect(on).toMatch(/placing orders and paying with the test data provided may be planned/);
        expect(on).toMatch(/no account deletion/);
        expect(on).toMatch(/never a real card\s+number/);
    });
});
