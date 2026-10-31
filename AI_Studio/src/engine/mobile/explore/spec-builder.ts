/**
 * A candidate becomes a `mobile` test spec: the same specification an imported or generated phone test has, rendered by the Taqwright generator.
 * Every spec passes the checks an import passes (schema, no literal secrets) plus caps, and must render; one that does not is dropped with a plain reason.
 */
import { secretProblems } from "../../builder/index.js";
import { renderWithAdapter } from "../../frameworks/index.js";
import { TestSpecSchema, type TestSpec } from "../../spec/schema.js";
import type { Candidate } from "./candidates.js";
import { FAMILY_LABEL, type PhoneFamily } from "./types.js";
import { permissionSteps, type PermissionAnswer } from "../state/permission-step.js";

export { FAMILY_LABEL };

export const MAX_TEST_STEPS = 40;

/** The id a draft carries until the platform gives the test its own. */
export const DRAFT_ID = "MOB-000";

const TYPE_OF: Record<PhoneFamily, TestSpec["type"]> = { start: "smoke", signIn: "functional", navigation: "navigation", forms: "functional", lists: "functional", back: "navigation", tabs: "navigation", search: "functional", settings: "navigation", journeys: "navigation" };
export const PRIORITY_OF: Record<PhoneFamily, TestSpec["priority"]> = { start: "critical", signIn: "high", navigation: "medium", forms: "medium", lists: "medium", back: "low", tabs: "high", search: "high", settings: "medium", journeys: "medium" };

/** "com.example.shop" reads as "Shop". */
export function appNameOf(appPackage: string): string {
    const last = appPackage.split(".").pop() ?? appPackage;
    const words = last.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : appPackage;
}

export interface DraftInput {
    candidate: Candidate;
    id: string;
    title: string;
    goal: string;
    priority: TestSpec["priority"];
    appPackage: string;
    /** Permission questions the exploration answered on the way in: the test starts by giving the same answers if asked (state/permission-step.ts). */
    permissions?: readonly PermissionAnswer[];
}

export function buildSpec(i: DraftInput): { ok: true; spec: TestSpec } | { ok: false; reason: string } {
    const c = i.candidate;
    const steps = [...permissionSteps(i.permissions), ...c.steps, ...c.checks];
    if (steps.length > MAX_TEST_STEPS) return { ok: false, reason: `It needs ${steps.length} steps, and a test has at most ${MAX_TEST_STEPS}` };
    let spec: TestSpec;
    try {
        spec = TestSpecSchema.parse({
            testId: DRAFT_ID,
            title: i.title,
            description: i.goal,
            kind: "mobile",
            platform: "android",
            category: `Phone · ${appNameOf(i.appPackage)}`,
            type: TYPE_OF[c.family],
            priority: i.priority,
            preconditions: c.usesSignIn ? ["The project has a test account (Library, Accounts, or Advanced options when exploring)"] : [],
            steps,
            expectedResults: c.shown.map((s) => `“${s}” is shown`),
            testData: {},
            tags: ["phone", "ai-explored", c.family],
            source: { scenarioId: i.id, journey: c.path.join(" → "), origin: "exploration" },
        });
    } catch (e) {
        return { ok: false, reason: `It is not a valid test: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}` };
    }
    for (const s of spec.steps) {
        const problem = secretProblems(s)[0];
        if (problem) return { ok: false, reason: problem };
    }
    try {
        renderWithAdapter(spec, "taqwright", { baseUrl: `android-app://${i.appPackage}` });
    } catch (e) {
        return { ok: false, reason: `It cannot be written as a phone test: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}` };
    }
    return { ok: true, spec };
}
