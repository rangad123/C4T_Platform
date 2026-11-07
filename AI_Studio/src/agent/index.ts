// Program entry for `npm run agent` and the `ai-test-agent` bin: run the agent, then exit with its code.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCheckProgram } from "./computer-check.js";
import { applyKitDefaults } from "./kit.js";
import { main } from "./main.js";
import { kitNetworkDefaults } from "./net.js";
import { RUNNER_UPDATE_EXIT, rollbackByHand, RunnerUpdater } from "./updater.js";
import { clearStopRequest, watchStopFile } from "./stop-file.js";

// The token must not show up in the process list: replace the title (on Linux and macOS this overwrites the command line).
process.title = "ai-test-agent";

// `--check`: "Check this computer" (computer-check.ts, docs/features/runner-check.md). Before anything else, so a broken runner.json or network
// line becomes one of its plain lines; it changes nothing and never prints the token. Output is flushed before the exit.
if (process.argv.slice(2).includes("--check")) {
    const code = await runCheckProgram({ argv: process.argv.slice(2), env: process.env, kitDir: path.dirname(fileURLToPath(import.meta.url)), out: (t) => process.stdout.write(t) });
    await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
    // A moment for the check's connections to finish closing: exiting while one closes can crash Node on Windows (a libuv assertion).
    await new Promise((resolve) => setTimeout(resolve, 300));
    process.exit(code);
}

// A runner started from a downloaded kit finds its settings (platform address, name, token file) in the files next to this program.
// From a repository checkout there is no runner.json here, and this changes nothing.
const kit = applyKitDefaults(process.env, path.dirname(fileURLToPath(import.meta.url)));
if (kit.kit === "broken") {
    console.error(`ai-test-agent: ${kit.message}`);
    process.exit(2);
}
// A person on a company network may add "proxy", "noProxy", "caFile" or "proxyTests" to the kit's runner.json (net.ts).
const kitNet = kitNetworkDefaults(kit.env, path.dirname(fileURLToPath(import.meta.url)));
if (!kitNet.ok) {
    console.error(`ai-test-agent: ${kitNet.message}`);
    process.exit(2);
}

// A runner from a download keeps itself up to date (updater.ts, docs/features/runner-updates.md): first finish what an earlier run left
// (an interrupted switch, a new version that keeps failing to connect), and `--rollback` goes back to the version kept by the last update.
const updater = kit.kit === true && kit.file.kitVersion && process.env.AITP_UPDATES !== "0" ? new RunnerUpdater({ kitDir: path.dirname(fileURLToPath(import.meta.url)), version: kit.file.kitVersion, env: kitNet.env }) : undefined;
const argv = process.argv.slice(2);
if (argv.includes("--rollback")) {
    if (!updater) {
        console.error("ai-test-agent: --rollback works only for a runner started from a download (runner.json next to runner.mjs).");
        process.exit(2);
    }
    process.exit(rollbackByHand(updater, (l) => console.log(l)));
}
const restart = updater?.startup((l) => console.log(l));
if (restart === RUNNER_UPDATE_EXIT) process.exit(RUNNER_UPDATE_EXIT);

let stops = 0;
const code = await main(argv, {
    ...(updater ? { updater } : {}),
    env: kitNet.env,
    globalNetwork: true,
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    onAgent: (agent) => {
        // First Ctrl-C / SIGTERM stops gracefully (running tasks are cancelled and reported); a second one leaves at once.
        const stop = () => {
            if (++stops > 1) process.exit(130);
            agent.stop();
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        // The Windows host's Stop writes stop.request next to runner.mjs (stop-file.ts): the same graceful stop as SIGTERM.
        const runnerDir = path.dirname(fileURLToPath(import.meta.url));
        try {
            clearStopRequest(runnerDir);
        } catch {
            /* nothing to clear */
        }
        watchStopFile(runnerDir, stop);
    },
});
// Like the other entry points: let the event loop drain rather than process.exit() (Windows can garble the exit code while
// connections close); the timer is only a safety net for something that refuses to let go.
process.exitCode = code;
setTimeout(() => process.exit(code), 8000).unref();
