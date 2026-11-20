/**
 * Founder 2026-11-19 wording for Test Case Generation projects, browser-free (FX11; FX13 is checked in tests/case-agent-fixes-ui.test.ts):
 *   - the guide's "Explore the application" place and its "Get tests for my app" topic say the Test Case Generation Agent explores
 *     the application or reads its requirements, builds a tree and writes test cases, and no longer say every exploration runs checks;
 *   node scripts/with-lock.mjs tsc -- npx vitest run tests/case-agent-wording-unit.test.ts
 */
import { describe, expect, it } from "vitest";
import { topics } from "../web/src/features/guide/content/index.js";
import { PLACES } from "../web/src/features/guide/places.js";

describe("the guide says what the Test Case Generation Agent does (FX11)", () => {
    it("the Explore the application place: a tree and test cases, not 'which checks run'", () => {
        const text = PLACES["explore-again"].canDo.map((a) => `${a.text} ${a.button}`).join(" ");
        expect(text).not.toMatch(/which checks run|about the checks/i);
        expect(text).toMatch(/Test Case Generation Agent explores the application or reads its requirements, builds a tree and writes test cases/);
    });

    it("the Get tests for my app topic: no 'Checks run now'", () => {
        const t = topics.find((x) => x.id === "explore-my-app")!;
        const text = [t.what, ...t.steps.map((s) => s.text), ...(t.goodToKnow ?? [])].join(" ");
        expect(text).not.toMatch(/Checks run now/);
        expect(text).toMatch(/Test Case Generation projects build a tree and write test cases/);
    });
});
