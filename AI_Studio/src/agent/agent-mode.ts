/**
 * Round 52: an AI agent run on this runner (an explore task of mode "agent"; docs/features/explore-on-runner.md). Runs in the task's own process
 * (explore-child.ts), so a cancel kills it and its browser. The engine's pursueObjective runs here as it does on a server worker (platform/agent-run.ts):
 * the browser is this computer's, the AI is the platform's (remote-llm.ts), and what the run records goes to the job's agent run on the platform
 * through the explore sink route (agentStep, agentTokens, agentApproval / approvalState, agentOutcome). The platform knows which run it is from
 * its own job: no run id travels from here.
 */
import { pursueObjective, type ApprovalAnswer, type ObjectiveLimits, type ObjectiveOutcome } from "../engine/agent/objective.js";
import type { EngineContext } from "../engine/context.js";
import { launchChromium, type SessionOptions } from "../engine/discovery/browser.js";
import type { ExplorePost } from "./explore-transport.js";

/** What an agent-mode explore task carries (`explore.request`). `url` is the site (its address rules are the offer's). */
export interface AgentOnRunnerRequest {
    url: string;
    startAddress: string;
    objective: string;
    successCriteria?: string;
    limits: ObjectiveLimits;
    credentials?: { username: string; password: string; totpSecret?: string };
    /** Every secret of the project in every form it can come back in: kept out of the model and the record. */
    secrets: string[];
    storageState?: SessionOptions["storageState"];
}

/** How often a waiting approval is asked about. */
const APPROVAL_POLL_MS = 1000;

/** One sink call at a time, answered, each its own numbered batch (the agent run's calls are few and in order). */
function caller(post: ExplorePost, signal: AbortSignal) {
    let seq = 0;
    return async <T>(c: Record<string, unknown>): Promise<T> => {
        const answer = (await post("sink", { calls: [c], seq: ++seq }, { signal })) as { results?: unknown[] };
        return answer?.results?.[0] as T;
    };
}

const wait = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    });

/** Run the objective in a browser of this computer; the outcome is sent to the platform before this returns. */
export async function runAgentObjective(ctx: EngineContext, req: AgentOnRunnerRequest, io: { post: ExplorePost; signal: AbortSignal }): Promise<ObjectiveOutcome> {
    const { signal } = io;
    const call = caller(io.post, signal);
    const browser = await launchChromium(ctx.config.HEADLESS);
    let outcome: ObjectiveOutcome;
    try {
        outcome = await pursueObjective({
            ctx,
            browser,
            baseUrl: req.url,
            startAddress: req.startAddress,
            objective: req.objective,
            ...(req.successCriteria ? { successCriteria: req.successCriteria } : {}),
            limits: req.limits,
            ...(req.credentials ? { credentials: req.credentials } : {}),
            secrets: req.secrets,
            ...(req.storageState ? { storageState: req.storageState } : {}),
            watch: {
                step: async (s) => {
                    const { picture, ...rest } = s;
                    await call({ method: "agentStep", s: { ...rest, ...(picture ? { picture: { name: `agent-step-${String(s.seq).padStart(3, "0")}.jpg`, data: Buffer.from(picture).toString("base64") } } : {}) } });
                },
                tokens: async (used) => void (await call({ method: "agentTokens", used })),
                askApproval: async (r, stop) => {
                    const id = await call<string>({ method: "agentApproval", r: { action: r.action, kind: r.impact.kind, why: r.impact.why, url: r.url, seconds: r.seconds } });
                    // The platform decides: a person's answer, the time limit or a stop of the job. Asked about until it is decided.
                    for (;;) {
                        const state = await call<string>({ method: "approvalState", id });
                        if (state && state !== "pending") return state as ApprovalAnswer;
                        if (stop.aborted || signal.aborted) return "stopped";
                        await wait(APPROVAL_POLL_MS, AbortSignal.any([stop, signal]));
                    }
                },
                // A person's stop reaches this process as a cancel of the task, which ends it.
                stopRequested: async () => signal.aborted,
            },
        });
    } finally {
        await browser.close().catch(() => undefined);
    }
    const { steps: _steps, ...rest } = outcome;
    await call({ method: "agentOutcome", o: { ...rest, reasoning: (rest.reasoning ?? "").slice(0, 8000), ...(rest.stopReason ? { stopReason: rest.stopReason.slice(0, 2000) } : {}) } });
    return outcome;
}
