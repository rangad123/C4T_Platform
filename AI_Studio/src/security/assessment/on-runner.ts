/**
 * Round 52, EXECUTION_MODE=runners: a security assessment runs on the runner of the person who started it (docs/features/explore-on-runner.md).
 *
 * The assessment loop (runner.ts) still runs on the platform and keeps everything it always did there: the lease, the authorization check
 * every few seconds, cancel and the emergency stop, the time limit, judging, storing the findings and the report. Only the steps that touch
 * the application (probe.ts: the browser, the API document's operations, the read-only checks) go to the starter's runner, as one round-51
 * explore task of mode "assessment", so the probes leave from the runner's network under its own address rule and none from the server.
 *
 * The task has no job (agent_tasks.job_id is `sec-<assessment id>`, as a phone session's is `dev-<session id>`): it is offered only to its
 * owner's runner (agent_tasks.owner_id) when that runner lists the mode, and its AI and saving routes refuse it (they need a job). What the
 * runner found comes back in its result (`explore.model.assessment`), is checked, scrubbed of the saved sign-in's values and goes on exactly
 * as an assessment that ran on the platform. A platform that stops leaves the task running: the next loop takes the same task up.
 */
import { randomUUID } from "node:crypto";
import { getAdapter } from "../../engine/frameworks/index.js";
import { capabilityProblem } from "../../platform/agent-routing.js";
import { cannotRunSentence, getAgentServices, looksPrivateAddress, RunnerAgentError } from "../../platform/agent-services.js";
import type { Platform } from "../../platform/bootstrap.js";
import { waitForExplore } from "../../platform/explore-dispatch.js";
import { EXPLORE_ADAPTER_ID, exploreOffer, exploreProblem } from "../../platform/explore-task.js";
import { KEY_HAS_NO_RUNNER, RUNNER_NOT_SET_UP, RUNNER_OFFLINE, runnerRefusal } from "../../platform/runner-only.js";
import type { SecuritySettings } from "../settings.js";
import { progressOfLog, type AssessmentOnRunnerOutcome, type AssessmentOnRunnerRequest, type ProbeWork } from "./probe.js";
import type { RunnerDeps } from "./runner.js";

/** agent_tasks.job_id of an assessment's task. */
export const assessmentTaskJobId = (assessmentId: string): string => `sec-${assessmentId}`;

export const ASSESSMENT_PRIVATE_REFUSED =
    "This application's address is a private or local one (such as localhost or a computer on your network), and your runner does not open those. Switch on private addresses for your runner in Settings.";
export const ASSESSMENT_NO_FINDINGS = "Your runner finished the assessment but did not say what it found. Update your runner in Settings, Your runner, then try again.";

/**
 * Refuse (409, the runs' codes and the Settings link) an assessment its starter's runner cannot take now: none set up, offline, a runner
 * program too old for assessments, no browser, or a private address the runner does not open.
 */
export function assertAssessmentRunner(p: Platform, who: { kind: string; ownerId: string | null }, projectId: string, targetUrl: string): void {
    if (!who.ownerId) throw runnerRefusal("RUNNER_NOT_SET_UP", who.kind === "key" ? KEY_HAS_NO_RUNNER : RUNNER_NOT_SET_UP);
    const own = getAgentServices(p).ownRunner(who.ownerId, projectId);
    if (!own) throw runnerRefusal("RUNNER_NOT_SET_UP", RUNNER_NOT_SET_UP);
    if (!own.online || !own.agent) throw runnerRefusal("RUNNER_OFFLINE", RUNNER_OFFLINE);
    const old = exploreProblem(own.agent, "assessment");
    if (old) throw runnerRefusal("RUNNER_CANNOT_RUN", old);
    const browser = getAdapter("playwright");
    const why = capabilityProblem(browser, own.agent.capabilities);
    if (why) throw runnerRefusal("RUNNER_CANNOT_RUN", cannotRunSentence(browser, own.agent.name, why));
    if (looksPrivateAddress(targetUrl) && !own.token.allowPrivateTargets) throw runnerRefusal("RUNNER_CANNOT_RUN", ASSESSMENT_PRIVATE_REFUSED);
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const DISCOVERY_ARRAYS = ["pages", "documents", "apiAnswers", "apiCalls", "forms", "technologies", "outOfScope", "excluded", "blockedWrites", "failures"] as const;

/** What a runner sent, checked for shape (it is not trusted; ingest normalizes and redacts every finding again). */
export function checkedOutcome(raw: unknown): AssessmentOnRunnerOutcome {
    const bad = () => new RunnerAgentError(ASSESSMENT_NO_FINDINGS);
    if (!isObj(raw) || !isObj(raw.work)) throw bad();
    const w = raw.work;
    const work: ProbeWork = {};
    if (w.discovery !== undefined) {
        const d = w.discovery;
        if (!isObj(d) || typeof d.startUrl !== "string" || typeof d.notVisited !== "number" || DISCOVERY_ARRAYS.some((k) => !Array.isArray(d[k]))) throw bad();
        work.discovery = d as unknown as NonNullable<ProbeWork["discovery"]>;
    }
    if (w.discoveryDone === true) work.discoveryDone = true;
    if (w.scan !== undefined) {
        const s = w.scan;
        if (!isObj(s) || !Array.isArray(s.results) || !Array.isArray(s.outcomes) || typeof s.capReached !== "boolean" || typeof s.requested !== "number") throw bad();
        if (s.results.length > 10_000 || s.outcomes.length > 200) throw bad();
        work.scan = s as unknown as NonNullable<ProbeWork["scan"]>;
    }
    if (!work.discovery || !work.scan) throw bad();
    const extra = Array.isArray(raw.extra) ? raw.extra.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 500)).slice(0, 20) : [];
    return { work, extra };
}

/** The loop's `onRunner` for this platform (routes/assessments.ts sets it in runners mode). */
export function assessOnRunner(p: Platform, settings: SecuritySettings): NonNullable<RunnerDeps["onRunner"]> {
    return async ({ assessment, ownerId, request, secrets, signal, keepTask, update }) => {
        const svc = getAgentServices(p);
        const job = { id: assessmentTaskJobId(assessment.id), projectId: assessment.projectId };
        // Taken up again after a platform restart: the task already on the runner carries on (or its result is read), never a second one.
        const earlier = svc.store.tasksOfJob(job.id).find((t) => t.adapterId === EXPLORE_ADAPTER_ID && (t.status === "queued" || t.status === "running" || t.status === "done"));
        const taskId = earlier?.id ?? randomUUID();
        if (!earlier) {
            const full: AssessmentOnRunnerRequest = {
                ...request,
                settings: { maxRequestsPerAssessment: settings.maxRequestsPerAssessment, maxResponseBytes: settings.maxResponseBytes, maxTotalBytes: settings.maxTotalBytes },
            };
            const offer = exploreOffer({ taskId, job, mode: "assessment", request: full, modelName: "none", secrets, leaseSeconds: svc.limits.leaseSeconds });
            svc.store.enqueue({ id: taskId, projectId: job.projectId, jobId: job.id, adapterId: EXPLORE_ADAPTER_ID, payloadEnc: svc.encrypt(offer), files: [], ownerId });
        }
        const emit = (e: { kind: string; message: string }) => {
            if (e.kind === "explore_on_runner") update({ state: "DISCOVERING", progress: 10, progressText: `${e.message.replace(/\.$/, "")}: it opens the application and makes the read-only checks from there.` });
        };
        // The runner's progress lines (its heartbeat's log) become the assessment's own progress, so the page shows it live.
        let shown = "";
        const watch = setInterval(() => {
            try {
                const now = progressOfLog(svc.store.getTask(taskId)?.log ?? []);
                if (now && now.progressText !== shown) {
                    shown = now.progressText!;
                    update({ ...now, progress: Math.max(10, now.progress ?? 10) });
                }
            } catch {
                /* the database is busy for a moment: next tick */
            }
        }, 1_000);
        try {
            const summary = await waitForExplore(svc, taskId, job, "assessment", emit, signal, { ownerId });
            return checkedOutcome((summary.model as unknown as { assessment?: unknown } | null)?.assessment);
        } finally {
            clearInterval(watch);
            if (signal.aborted && !keepTask()) svc.store.requestCancel(taskId);
        }
    };
}
