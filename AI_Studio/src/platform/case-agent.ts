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
import type { EngineEvent } from "../engine/context.js";
import type { LlmClient } from "../engine/llm/provider.js";
import { batchesOf, generateCasesForBatch } from "../engine/manual/generate.js";
import { HttpError } from "./http-error.js";
import { projectSetupOf } from "./project-setup.js";
import type { JobOptions, Repo } from "./repo.js";
import { RequirementStore } from "./requirement-store.js";

export const CASE_AGENT_PLAN_REFUSED = "This project's agent writes test cases only. Import them into a code project to make test scripts.";
export const CASE_AGENT_RUN_REFUSED = "This project's agent writes test cases only. Test runs belong in a code project.";
/** SPEC R16.2: a Test Case Generation run needs one of its two inputs. */
export const NO_ADDRESS_OR_REQUIREMENTS = "Add the application's address or a requirements document first.";

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

/**
 * An exploration with no address (SPEC R16, FX25): true when the project is a Test Case Generation project with active requirements, so
 * the run writes its cases from them (`requirementsOnly`); a TCG project with neither is refused (400); other projects get false.
 * Used by every start: the explore route, a schedule and a runbook step.
 */
export async function requirementsOnlyRun(repo: Repo, projectId: string): Promise<boolean> {
    if (!(await isCaseAgentProject(repo, projectId))) return false;
    if (!(await new RequirementStore(repo.db.sql).list(projectId)).some((r) => r.status === "active")) throw new HttpError(400, NO_ADDRESS_OR_REQUIREMENTS);
    return true;
}

/**
 * A run from the requirements alone (SPEC R16, owner decision Q7; `requirementsOnly`): the project's active requirements go to the
 * requirements generator (engine/manual/generate.ts), and each case it writes is announced as the run's `scenario_planned` event, which
 * case-outcome.ts reads as the run's test cases (no page; the tree node is the requirement area). Nothing is saved or run here.
 * Returns how many cases were written; throws what the model call throws.
 */
export async function writeCasesFromRequirements(repo: Repo, projectId: string, llm: LlmClient, emit: (e: EngineEvent) => void, signal: AbortSignal): Promise<number> {
    const active = (await new RequirementStore(repo.db.sql).list(projectId)).filter((r) => r.status === "active");
    const platform = projectSetupOf(repo.getProject(projectId) ?? {}).platforms[0] ?? "web";
    emit({ stage: "planning", kind: "requirements_read", message: `Writing test cases from ${active.length === 1 ? "1 requirement" : `${active.length} requirements`}` });
    let n = 0;
    for (const batch of batchesOf(active.map((r) => ({ id: r.id, ref: r.ref, title: r.title, description: r.description, acceptanceCriteria: r.acceptanceCriteria })))) {
        signal.throwIfAborted();
        const refOf = new Map(batch.map((r) => [r.id, r.ref]));
        for (const { requirementId, input } of await generateCasesForBatch(llm, batch, { address: null, platform })) {
            n++;
            emit({
                stage: "planning",
                kind: "scenario_planned",
                message: `S-${String(n).padStart(3, "0")} [requirement/${input.priority}] ${input.title}`,
                data: { scenarioId: `S-${String(n).padStart(3, "0")}`, title: input.title, type: input.automation ?? "manual", priority: input.priority, steps: input.steps, area: input.area, requirement: refOf.get(requirementId) ?? "" },
            });
        }
    }
    return n;
}
