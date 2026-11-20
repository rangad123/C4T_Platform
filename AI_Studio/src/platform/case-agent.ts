/**
 * Test Case Generation projects (founder 2026-11-19, SPEC D3 and owner decisions Q4, Q6).
 *
 * A project is one when it is tested by the AI agent only (no code mode) and its saved choice of testing agents includes
 * `test-generation`, alone or with other agents (Q6: such a project does the test-case job only). Its explorations are plan-only:
 * they build the tree and write test cases, and nothing is authored as a script or run. Every place that starts work calls one of:
 *   - caseAgentOptions: an exploration of such a project is made plan-only, whoever starts it (form, schedule, runbook, MCP, CLI);
 *   - refuseTestsInCaseAgentProject: creating test scripts or running tests is refused with a 409 and a sentence.
 * Old test scripts already saved in such a project stay readable; only creating and running them is refused.
 * Mixed projects (agent and code) and code projects are never Test Case Generation projects.
 */
import { HttpError } from "./http-error.js";
import { projectSetupOf } from "./project-setup.js";
import type { JobOptions, Repo } from "./repo.js";

export const CASE_AGENT_PLAN_REFUSED = "This project's agent writes test cases only. Import them into a code project to make test scripts.";
export const CASE_AGENT_RUN_REFUSED = "This project's agent writes test cases only. Test runs belong in a code project.";

/** True when the project is a Test Case Generation project (SPEC D3, Q6). An unknown project is not one. */
export async function isCaseAgentProject(repo: Repo, projectId: string): Promise<boolean> {
    const row = repo.getProject(projectId);
    if (!row) return false;
    const modes = projectSetupOf(row).testingModes;
    if (!modes.includes("agent") || modes.includes("code")) return false;
    const chosen = await repo.db.sql.all<{ agent_id: string }>("SELECT agent_id FROM project_testing_agents WHERE project_id = ?", projectId);
    return chosen.some((r) => r.agent_id === "test-generation");
}

/** Refuses (409) to create test scripts or run tests in a Test Case Generation project; `message` says what to do instead. */
export async function refuseTestsInCaseAgentProject(repo: Repo, projectId: string, message: string = CASE_AGENT_RUN_REFUSED): Promise<void> {
    if (await isCaseAgentProject(repo, projectId)) throw new HttpError(409, message);
}

/**
 * An exploration's options for this project: unchanged for other projects; plan-only for a Test Case Generation project, with
 * anything that would create from a plan or run test cases left out.
 */
export async function caseAgentOptions(repo: Repo, projectId: string, options: JobOptions): Promise<JobOptions> {
    if (!(await isCaseAgentProject(repo, projectId))) return options;
    const { runTestCases: _r, fromPlan: _f, carryFrom: _c, excludeIdeas: _e, ...rest } = options;
    return { ...rest, mode: "generate", planOnly: true };
}
