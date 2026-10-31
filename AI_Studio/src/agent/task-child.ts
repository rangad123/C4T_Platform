/**
 * Runs one task's scripts through the platform's own adapter code (`getAdapter(id).execute`), so a remote run behaves
 * exactly like a local one. Started by the agent for each task; talks to it over the IPC channel (child-protocol.ts).
 */
import { getAdapter } from "../engine/frameworks/index.js";
import type { MobileRunEnv } from "../engine/validation/mobile-runner.js";
import type { IosRunEnv } from "../engine/mobile/ios-runner.js";
import type { FromChild, ToChild } from "./child-protocol.js";

const send = (m: FromChild): Promise<void> => new Promise((resolve) => (process.send ? process.send(m, () => resolve()) : resolve()));

// Cancelling kills this whole process tree from outside; the signal only matters if the parent disappears.
const abort = new AbortController();

process.on("message", (raw) => {
    const m = raw as ToChild;
    if (m?.type === "run") void runTask(m);
});

// The agent went away (it crashed or was killed): stop what is running and leave, so no test runner is left behind.
process.on("disconnect", () => {
    abort.abort();
    setTimeout(() => process.exit(1), 3000).unref();
});

async function runTask(m: ToChild): Promise<void> {
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
            },
        );
        await send({ type: "result", runs });
    } catch (e) {
        await send({ type: "error", message: e instanceof Error ? e.message : String(e) });
    }
    process.exit(0);
}
