/**
 * A written test case made into a web test script by the same pipeline as Test scripts, New test script, Describe it
 * (engine/authoring/plain.ts): the case becomes the description, the authoring agent signs in with the project's sign-in and does the
 * case's steps in a real browser against the application, records only the steps that worked and the checks it saw hold, and the
 * test is run once. So a check after signing in is what the application really shows (its "Account" page), never a page name the AI
 * guessed ("Dashboard").
 *
 * Each case is one plain job: "Generate test scripts" (routes/generate-scripts.ts) starts the first, and when a job ends the test it made
 * becomes its case's script (linked to the case and the case's requirements) and the next case's job starts (job-runner.ts). A case whose
 * job made no test is passed over (its run says why) and the next one is built, so one click builds them all. The chain stops at a
 * cancel, when another run of the project has started, or when two cases in a row made no test for the same reason (no AI, the browser
 * could not start, the AI limit: the cases after them would fail the same way): the cases left have no script yet, the page names them
 * with why, and generating again picks them up.
 */
import { detectKind, PLAIN_MAX_LENGTH, refusalFor } from "../engine/authoring/describe.js";
import { scriptTitleOf } from "../engine/authoring/case-script.js";
import type { ManualCase } from "../engine/manual/cases.js";
import { ManualCaseStore } from "./manual-case-store.js";
import type { JobOptions, JobRow, Repo } from "./repo.js";
import { RequirementStore } from "./requirement-store.js";

const TERMINAL = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];

/**
 * What a written case says, as the description of a described test: the title first (the test's title is its first line), then each
 * step, and each expected result as a check ("Check that ...", which the description reader takes as an expected result).
 */
export function caseDescription(c: Pick<ManualCase, "title" | "steps"> & { ref?: string | null }): string {
    const lines = [scriptTitleOf({ ref: c.ref ?? "", title: c.title })];
    c.steps.forEach((s, i) => {
        const action = s.action.trim();
        const expected = s.expected.trim().replace(/^expected(?:\s+results?)?\s*:\s*/i, "");
        if (action) lines.push(`${i + 1}. ${action}`);
        if (expected) lines.push(`Check that ${expected}`);
    });
    return lines.join("\n").slice(0, PLAIN_MAX_LENGTH);
}

/** One script per case: a linked test that still exists in this project is its script. */
export function caseHasScript(repo: Repo, projectId: string, c: Pick<ManualCase, "linkedTestIds">): boolean {
    return c.linkedTestIds.some((t) => repo.getTest(t)?.projectId === projectId);
}

/** The options of the plain job that builds this case's script, with the cases still to build after it. */
export function caseJobOptions(base: JobOptions, c: ManualCase, queue: string[], apis: ReadonlyArray<{ path: string }>, lastFailure?: string): JobOptions {
    const description = caseDescription(c);
    const { rewriteTestId: _rewrite, plainCaseFailed: _failed, ...rest } = base;
    void _rewrite;
    void _failed;
    return { ...rest, mode: "plain", plainDescription: description, plainKind: detectKind(description, apis as Array<{ path: string }>), plainCaseId: c.id, plainCaseQueue: queue, ...(lastFailure !== undefined ? { plainCaseFailed: lastFailure } : {}) };
}

/**
 * The scripts made for a case become its scripts: the case points at them (one script per case) and they cover the case's own
 * requirement and the requirements the case is linked to. Shared by the phone scripts (routes/generate-scripts.ts) and the web ones.
 */
export async function linkScriptsToCase(repo: Repo, projectId: string, caseId: string, testIds: string[]): Promise<void> {
    if (!testIds.length) return;
    const c = new ManualCaseStore(repo.db).getCase(projectId, caseId);
    if (!c) return;
    const linked = [...new Set([...c.linkedTestIds, ...testIds])];
    repo.db.run("UPDATE manual_cases SET linked_json = ?, updated_at = ? WHERE id = ? AND project_id = ?", JSON.stringify(linked), new Date().toISOString(), caseId, projectId);
    const requirements = new RequirementStore(repo.db.sql);
    const reqIds = [...new Set([...(c.requirementId ? [c.requirementId] : []), ...(await requirements.forTest(projectId, c.id)).map((r) => r.id)])];
    for (const rid of reqIds) {
        try {
            await requirements.link(projectId, rid, { automated: testIds, manual: [] }, "generated");
        } catch {
            // A requirement deleted meanwhile: the script stays, without that link.
        }
    }
}

/**
 * After a case's job has ended (not when it was handed over or its lease lost: the attempt that takes it up does this): its test becomes
 * the case's script, and the next case that still needs a script gets its job. Returns that job, or null when the chain stops here.
 */
export async function afterCaseJob(repo: Repo, job: JobRow): Promise<JobRow | null> {
    const caseId = job.options.plainCaseId;
    const done = repo.getJob(job.id);
    if (!caseId || !done || !TERMINAL.includes(done.status)) return null;
    const pid = job.projectId;
    const made = repo.listTests(pid, { jobId: job.id }).map((t) => t.id);
    await linkScriptsToCase(repo, pid, caseId, made);

    const queue = [...(job.options.plainCaseQueue ?? [])];
    if (!queue.length || done.error === "Cancelled") return null;
    // No test made: the next case is built, unless the case before this one failed for the same reason (not a reason about the case).
    const failure = made.length === 0 ? (done.error ?? "") : undefined;
    if (failure !== undefined && job.options.plainCaseFailed === failure) return null;
    // A person started another run meanwhile: theirs goes first, and the cases left are generated again later.
    if (repo.listJobs(pid).some((j) => j.id !== job.id && !TERMINAL.includes(j.status))) return null;
    const cases = new ManualCaseStore(repo.db);
    const apis = repo.getLatestAppModel(pid)?.apis ?? [];
    for (let id = queue.shift(); id; id = queue.shift()) {
        const c = cases.getCase(pid, id);
        if (!c || c.automation !== "automated" || caseHasScript(repo, pid, c)) continue;
        // Changed since it was queued into something that is not built (a payment, an attack...): skipped, as the first call skips it.
        if (refusalFor(caseDescription(c), { allowChanges: job.options.allowMutatingApiTests === true })) continue;
        return await repo.createJob(pid, job.applicationId, caseJobOptions(job.options, c, queue, apis, failure));
    }
    return null;
}
