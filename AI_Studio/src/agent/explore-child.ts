/**
 * Round 51: one exploration on this runner (an `explore` task; docs/features/explore-on-runner.md). Round 52: the same task also builds a test
 * from a description (mode "plain", runPlainAuthoring) or does an AI agent run (mode "agent", agent-mode.ts), with the same AI and saving, explores
 * a phone app on this computer's phone (mode "mobile") or runs a security assessment's steps (mode "assessment"). Runs inside the task's own process
 * (task-child.ts hands an `explore` message here), so a cancel kills it and everything it started, as for a run.
 *
 * The engine's runGeneration runs here exactly as on the platform: its browser, crawler, sign-in, authoring agents and validation runs are this
 * computer's. Two things are not: the AI (remoteLlmClient: every model call goes to the platform, which runs it on the job's own model; no key
 * comes here) and what the job saves (remoteGenerationSink: every call goes to the job on the platform). Both travel through the agent
 * (`post` messages), which holds the runner's credential; this process never sees it.
 */
import path from "node:path";
import { parseEnvSettings, type Config } from "../config.js";
import type { EngineContext } from "../engine/context.js";
import { useChromium } from "../engine/discovery/browser.js";
import { localExecutor } from "../engine/frameworks/index.js";
import { withFrameworkSettings } from "../engine/frameworks/settings-executor.js";
import { describeDeviations, effectiveSettings, firstTurnedOff, normalizeSettings } from "../engine/frameworks/settings.js";
import type { ScriptExecutor } from "../engine/frameworks/types.js";
import { runGeneration, type GenerationRequest, type GenerationSummary } from "../engine/orchestrator.js";
import { runPlainAuthoring, type PlainRequest } from "../engine/authoring/plain.js";
import { openLocalDeviceSession } from "../engine/mobile/device/session.js";
import { runAssessmentOnRunner, type AssessmentOnRunnerRequest } from "../security/assessment/probe.js";
import { runAgentObjective, type AgentOnRunnerRequest } from "./agent-mode.js";
import { addressProblem } from "./address-guard.js";
import type { ChildExplore, ExploreAnswer, FromChild } from "./child-protocol.js";
import type { ExplorePost } from "./explore-transport.js";
import { remoteLlmClient } from "./remote-llm.js";
import { remoteGenerationSink } from "./remote-sink.js";

/** An answer from the platform that was a refusal: the agent's sentence, with the HTTP status when there was one. */
export class ExplorePostError extends Error {
    constructor(
        message: string,
        readonly status?: number,
    ) {
        super(message);
        this.name = "ExplorePostError";
    }
}

/**
 * ExplorePost over the channel to the agent: each call gets an id, the agent answers it (`answer`), and an aborted call is told to the agent
 * (`post-abort`) so it stops the request. `onAnswer` is where the caller feeds the agent's answers in.
 */
export function childPost(send: (m: FromChild) => void): { post: ExplorePost; onAnswer(a: ExploreAnswer): void; failAll(why: string): void } {
    let next = 1;
    const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
    const post: ExplorePost = (route, body, o) =>
        new Promise((resolve, reject) => {
            if (o?.signal?.aborted) return reject(new ExplorePostError("The exploration was stopped."));
            const id = next++;
            const onAbort = () => {
                if (!waiting.delete(id)) return;
                send({ type: "post-abort", id });
                reject(new ExplorePostError("The exploration was stopped."));
            };
            waiting.set(id, {
                resolve: (v) => (o?.signal?.removeEventListener("abort", onAbort), resolve(v)),
                reject: (e) => (o?.signal?.removeEventListener("abort", onAbort), reject(e)),
            });
            o?.signal?.addEventListener("abort", onAbort, { once: true });
            send({ type: "post", id, route, body });
        });
    return {
        post,
        onAnswer(a) {
            const w = waiting.get(a.id);
            if (!w) return;
            waiting.delete(a.id);
            if (a.ok) w.resolve(a.value);
            else w.reject(new ExplorePostError(a.message, a.status));
        },
        failAll(why) {
            for (const [id, w] of waiting) {
                waiting.delete(id);
                w.reject(new ExplorePostError(why));
            }
        },
    };
}

/** The local executor this runner uses for runs, with its browser choice and the project's framework settings applied. */
function executorOf(m: ChildExplore, platformWorkers: number): { executor: ScriptExecutor; frameworkOff?: EngineContext["frameworkOff"] } {
    const browser = m.browser && (m.browser.channel || m.browser.executablePath) ? m.browser : undefined;
    let executor: ScriptExecutor = browser ? { name: localExecutor.name, execute: (a, b, e, o) => localExecutor.execute(a, b, e, { ...o, browser }) } : localExecutor;
    if (m.explore.frameworkSettings === undefined) return { executor };
    const settings = normalizeSettings(m.explore.frameworkSettings);
    const eff = effectiveSettings(settings, { onAgent: true, platformWorkers });
    executor = withFrameworkSettings(executor, eff, describeDeviations(settings, eff).length > 0);
    return { executor, frameworkOff: (adapterId) => firstTurnedOff(settings, [adapterId]) };
}

/** Run the exploration and say how it went (`explored` with the summary, or `error`). Never throws. */
export async function runExplore(m: ChildExplore, io: { send(m: FromChild): Promise<void>; post: ExplorePost; signal: AbortSignal; env?: NodeJS.ProcessEnv }): Promise<void> {
    try {
        // The runner's environment, the browser hidden, and every file of the job in the task's own folder.
        // Built here rather than with loadConfig: the runner has no database or platform data folder, and none of their names goes in its bundle.
        const dataDir = path.join(m.scratchDir, "data");
        const config: Config = {
            ...parseEnvSettings({ ...(io.env ?? process.env), HEADLESS: "true" }),
            // What a runner never does, whatever its environment says: hand-written scripts and plug-ins come only with a run's own rules.
            ALLOW_CUSTOM_SCRIPTS: false,
            ALLOW_ADAPTER_PLUGINS: false,
            customScriptsRequested: false,
            adapterPluginsRequested: false,
            dataDir,
            dbPath: "",
            artifactsDir: path.join(dataDir, "generated-tests"),
            scratchDir: m.scratchDir,
        };
        if (m.browser && (m.browser.channel || m.browser.executablePath)) useChromium(m.browser);
        const sink = remoteGenerationSink({ post: io.post, signal: io.signal, dir: path.join(m.scratchDir, "from-platform") });
        const { executor, frameworkOff } = executorOf(m, config.CONCURRENCY);
        const ctx: EngineContext = {
            config,
            llm: remoteLlmClient({ post: io.post, modelName: m.explore.modelName, signal: io.signal }),
            signal: io.signal,
            executor,
            ...(frameworkOff ? { frameworkOff } : {}),
            emit: (event) => void io.send({ type: "engine", event }),
        };
        // Records that data-changing API tests create are removed from this computer (the application may be reachable only from here), by
        // this runner's own address rule.
        const cleanup = m.explore.cleanup
            ? {
                  enabled: true,
                  ...(m.refusePrivate
                      ? {
                            guard: async (url: string) => {
                                const why = await addressProblem(url);
                                if (why) throw new Error(why);
                            },
                        }
                      : {}),
              }
            : undefined;
        // Round 52: the job's kind picks the engine entry, as job-runner.ts does on a server worker.
        const mode = m.explore.mode ?? "generate";
        const none: GenerationSummary = { model: null, testsGenerated: 0, testsValidated: 0, testsFailedValidation: 0, testsNeedingReview: 0, errors: [] };
        if (mode === "assessment") {
            // A security assessment's steps, its checks sent from this computer under this runner's address rule. No AI and nothing saved on
            // the way: what it found goes back in the result, and the platform judges, stores and reports it (security/assessment/runner.ts).
            const assessment = await runAssessmentOnRunner(m.explore.request as unknown as AssessmentOnRunnerRequest, { signal: io.signal, refusePrivate: m.refusePrivate === true, log: (line) => void io.send({ type: "log", line: line.slice(0, 300) }) });
            await io.send({ type: "explored", summary: { ...none, model: { assessment } as unknown as GenerationSummary["model"] } });
            return;
        }
        if (mode === "mobile") {
            // The phone attached to this computer (adb, or an emulator it starts). A plugged-in phone only when the runner's owner allowed it.
            const realPhone = (m.explore.request as { runnerPhone?: { realPhone?: boolean } }).runnerPhone?.realPhone === true;
            ctx.openDevice = (opts) => openLocalDeviceSession({ ...opts, ...(realPhone ? {} : { noRealPhone: true }), env: io.env ?? process.env });
        }
        if (mode === "agent") {
            await runAgentObjective(ctx, m.explore.request as unknown as AgentOnRunnerRequest, { post: io.post, signal: io.signal });
            await io.send({ type: "explored", summary: none });
            return;
        }
        const summary =
            mode === "plain"
                ? await runPlainAuthoring(ctx, { ...(m.explore.request as unknown as PlainRequest), ...(cleanup ? { cleanup } : {}) }, sink)
                : await runGeneration(ctx, { ...(m.explore.request as unknown as GenerationRequest), ...(cleanup ? { cleanup } : {}) }, sink);
        // Everything it saved is accepted by the platform before the result says it is done.
        await sink.flush();
        await io.send({ type: "explored", summary });
    } catch (e) {
        await io.send({ type: "error", message: e instanceof Error ? e.message : String(e) });
    }
}
