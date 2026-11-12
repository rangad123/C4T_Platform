/**
 * Runs one task's scripts through the platform's own adapter code (`getAdapter(id).execute`), so a remote run behaves
 * exactly like a local one. Started by the agent for each task; talks to it over the IPC channel (child-protocol.ts).
 */
import { getAdapter } from "../engine/frameworks/index.js";
import type { MobileRunEnv } from "../engine/validation/mobile-runner.js";
import type { IosRunEnv } from "../engine/mobile/ios-runner.js";
import type { LiveRunEvent } from "../engine/validation/runner.js";
import type { ChildRun, FromChild, ToChild } from "./child-protocol.js";

const send = (m: FromChild): Promise<void> => new Promise((resolve) => (process.send ? process.send(m, () => resolve()) : resolve()));

// Cancelling kills this whole process tree from outside; the signal only matters if the parent disappears.
const abort = new AbortController();

// Round 51: an exploration's calls for the platform go through the agent and come back as answers (explore-child.ts).
// Loaded only for an exploration, so a run's process does not load the whole engine.
let explorePost: ReturnType<typeof import("./explore-child.js").childPost> | undefined;
let exploring = false;

process.on("message", (raw) => {
    const m = raw as ToChild;
    if (m?.type === "run") void runTask(m);
    else if (m?.type === "answer") explorePost?.onAnswer(m);
    else if (m?.type === "explore" && !exploring) {
        exploring = true;
        void startExplore(m);
    }
});

async function startExplore(m: Extract<ToChild, { type: "explore" }>): Promise<void> {
    try {
        const { childPost, runExplore } = await import("./explore-child.js");
        explorePost = childPost((out) => void send(out));
        await runExplore(m, { send, post: explorePost.post, signal: abort.signal });
    } catch (e) {
        await send({ type: "error", message: e instanceof Error ? e.message : String(e) });
    }
    process.exit(0);
}

// The agent went away (it crashed or was killed): stop what is running and leave, so no test runner is left behind.
process.on("disconnect", () => {
    abort.abort();
    explorePost?.failAll("The runner stopped.");
    setTimeout(() => process.exit(1), 3000).unref();
});

async function runTask(m: ChildRun): Promise<void> {
    try {
        const mobile: MobileRunEnv | undefined = m.mobile
            ? {
                  target: m.mobile.target,
                  avd: m.mobile.avd,
                  manageEmulator: m.mobile.manageEmulator,
                  ...(m.mobile.cliPath ? { cliPath: m.mobile.cliPath } : {}),
                  ...(m.mobile.keepEmulator !== undefined ? { keepEmulator: m.mobile.keepEmulator } : {}),
                  ...(m.mobile.where ? { where: m.mobile.where } : {}),
                  // Emulator start-up messages travel to the platform with the next heartbeat.
                  log: (line) => void send({ type: "log", line: String(line).slice(0, 300) }),
              }
            : undefined;
        const ios: IosRunEnv | undefined = m.ios
            ? {
                  target: m.ios.target,
                  manageSimulator: m.ios.manageSimulator,
                  ...(m.ios.defaultSimulator ? { defaultSimulator: m.ios.defaultSimulator } : {}),
                  ...(m.ios.keepSimulator !== undefined ? { keepSimulator: m.ios.keepSimulator } : {}),
                  ...(m.ios.cliPath ? { cliPath: m.ios.cliPath } : {}),
                  // Simulator start-up messages travel to the platform with the next heartbeat.
                  log: (line) => void send({ type: "log", line: String(line).slice(0, 300) }),
              }
            : undefined;
        const runs = await getAdapter(m.adapterId).execute(
            { scratchDir: m.scratchDir, scripts: m.scripts, ...(m.helpers?.length ? { helpers: m.helpers } : {}) },
            { run: m.run, ...(mobile ? { mobile } : {}), ...(ios ? { ios } : {}), ...(m.desktop ? { desktop: m.desktop } : {}) },
            { workers: m.opts.workers, signal: abort.signal, ...(m.allowCustom ? { allowCustom: true } : {}), ...(m.browser ? { browser: m.browser } : {}), ...(m.opts.timeoutMs !== undefined ? { timeoutMs: m.opts.timeoutMs } : {}), ...(m.opts.projects ? { projects: m.opts.projects } : {}), ...(m.opts.testTimeoutMs !== undefined ? { testTimeoutMs: m.opts.testTimeoutMs } : {}), ...(m.opts.startTimeoutMs !== undefined ? { startTimeoutMs: m.opts.startTimeoutMs } : {}),
                // "Finished 3 of 12 tests" travels to the platform with the next heartbeat (frameworks that cannot report progress ignore this).
                onProgress: (p) => void send({ type: "log", line: `Finished ${p.done} of ${p.total} tests: ${p.title} (${p.status})`.slice(0, 300) }),
                // Protocol 2: each test and step as it starts and ends, and each failure screenshot (Playwright web and API runs; others ignore it).
                ...(m.live ? { onLive: (event: LiveRunEvent) => void send({ type: "live", event }) } : {}),
            },
        );
        await send({ type: "result", runs });
    } catch (e) {
        await send({ type: "error", message: e instanceof Error ? e.message : String(e) });
    }
    process.exit(0);
}
