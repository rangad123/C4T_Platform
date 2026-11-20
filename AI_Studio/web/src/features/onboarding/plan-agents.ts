import type { SwitchStates } from "../testing-agents/case-agent-view.js";
import type { FamilyOption, PlanFamily } from "./onboarding.js";

/** The agent switch each kind of test of a plan answers to; the journeys are the test cases (functionalTests), the API checks the API agent's. */
const SWITCH_OF: Partial<Record<FamilyOption, string>> = {
    web: "functionalTests",
    api: "apiTests",
    accessibility: "accessibility",
    healthChecks: "healthChecks",
    securityChecks: "securityChecks",
    performanceChecks: "performanceChecks",
    loadChecks: "loadChecks",
    inputChecks: "inputChecks",
    visionChecks: "visionChecks",
    contractChecks: "contractChecks",
    accessChecks: "accessChecks",
    visual: "visual",
};

/**
 * The kinds of test a plan lists, for the agents chosen for the project (founder 2026-11-19, sheet row 19): a kind no chosen agent
 * does is left out, not shown switched off. `switches` null (code, mixed, or no agents saved): every kind, as before. A phone plan's
 * own screens are not agent switches and always stay.
 */
export function familiesForAgents(families: PlanFamily[], switches: SwitchStates | null): PlanFamily[] {
    if (!switches) return families;
    return families.filter((f) => {
        const sw = SWITCH_OF[f.option];
        return !sw || switches[sw] !== "off";
    });
}
