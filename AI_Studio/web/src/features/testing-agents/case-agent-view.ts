/**
 * Test Case Generation projects on the web side (founder 2026-11-19, SPEC D3 and owner decision Q6), read from what the project and
 * its testing agents already say, by the same rule as the server's src/platform/case-agent.ts: tested by the AI agent only, and its
 * saved choice of agents includes the Test Case Generation Agent. Such a project writes test cases only; test scripts live in code
 * projects. Pure, so tests/plan-families-agents-unit.test.ts reads it without a browser.
 */
export type SwitchStates = Record<string, "on" | "allowed" | "off">;

export interface ProjectAgentView {
    /** Still reading the project or its agents. */
    loading: boolean;
    /** A Test Case Generation project. */
    caseAgent: boolean;
    /** The switches of the agents a person chose, for a project tested by the AI agent only; null when nothing narrows it (code, mixed, no choice saved). */
    switches: SwitchStates | null;
}

/** `project`: GET /api/projects/:id; `agents`: GET /api/projects/:id/testing-agents (either undefined while unread or failed). */
export function projectAgentView(
    project: { testingModes?: readonly string[] } | undefined,
    agents: { applies: boolean; agents: readonly string[]; source: "chosen" | "matched"; switches: SwitchStates } | undefined,
): Omit<ProjectAgentView, "loading"> {
    // No modes saved means both (an older project, web/src/api.ts projectShape): a mixed project.
    const modes = project?.testingModes?.length ? project.testingModes : ["agent", "code"];
    const agentOnly = modes.includes("agent") && !modes.includes("code");
    const chosen = agentOnly && agents?.applies === true && agents.source === "chosen" ? agents : null;
    return { caseAgent: Boolean(chosen?.agents.includes("test-generation")), switches: chosen?.switches ?? null };
}
