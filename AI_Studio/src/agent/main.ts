/**
 * Program logic of `ai-test-agent`, separated from the process so tests can call it: parse the command line, run the agent,
 * return the exit code. Output goes through the injected writers; the token is never among the things written.
 */
import { Agent, EXIT } from "./agent.js";
import { startRunnerCheck } from "./computer-check.js";
import { AGENT_VERSION, parseAgentArgs, USAGE } from "./config.js";
import fsp from "node:fs/promises";
import { deleteCredential, loadCredential, type StoreDeps } from "./credential-store.js";
import { Logger } from "./log.js";
import { setUpRunnerNetwork } from "./net.js";
import type { RunnerUpdater } from "./updater.js";

export interface MainIo {
    env: NodeJS.ProcessEnv;
    out(line: string): void;
    err(line: string): void;
    /** Called with the agent so the process can wire signals to `stop()`. */
    onAgent?(agent: Agent): void;
    /**
     * The real program (index.ts): the proxy and certificate settings also apply to this process's own connections and to process.env
     * (net.ts). Without it only `env` is changed, so a test calling main() leaves its own process alone.
     */
    globalNetwork?: boolean;
    /** A runner from a download keeps itself up to date (updater.ts; index.ts makes it). */
    updater?: RunnerUpdater;
    /** Tests: a stand-in for the computer's credential store commands. */
    credentialStore?: StoreDeps;
}

export async function main(argv: string[], io: MainIo): Promise<number> {
    const parsed = parseAgentArgs(argv, io.env);
    if (parsed.kind === "help") {
        io.out(USAGE);
        return 0;
    }
    if (parsed.kind === "version") {
        io.out(`ai-test-agent ${AGENT_VERSION}`);
        return 0;
    }
    if (parsed.kind === "error") {
        io.err(`ai-test-agent: ${parsed.message}`);
        io.err("Run ai-test-agent --help for the options.");
        return EXIT.usage;
    }
    // Uninstalling: remove the credential this runner keeps (the installers call this; credential-store.ts).
    if (parsed.kind === "forget") {
        try {
            await deleteCredential(parsed.credentialDir, io.credentialStore);
            io.out("The runner's credential was removed from this computer.");
            return 0;
        } catch {
            io.err("ai-test-agent: The runner's credential could not be removed.");
            return EXIT.failed;
        }
    }
    // No token given: the credential this runner keeps, else the enrollment code to get one (round 39).
    const cfg = parsed.config;
    if (cfg.tokenSource === "store") {
        const dir = cfg.credentialDir ?? cfg.workDir;
        let stored: string | null;
        try {
            stored = await loadCredential(dir, io.credentialStore);
        } catch (e) {
            io.err(`ai-test-agent: ${e instanceof Error ? e.message : "The runner could not read its credential."}`);
            return EXIT.failed;
        }
        if (stored && !cfg.enroll?.explicit) {
            cfg.token = stored;
            // A code file left next to a runner that already has its credential is used up: remove it.
            if (cfg.enroll?.file) await fsp.rm(cfg.enroll.file, { force: true }).catch(() => undefined);
            delete cfg.enroll;
        } else if (!cfg.enroll) {
            io.err("ai-test-agent: This runner has no credential yet. Add this computer with --enroll <code> (make the code on the Runners page), or give a token with AITP_AGENT_TOKEN, --token-file or --token.");
            io.err("Run ai-test-agent --help for the options.");
            return EXIT.usage;
        }
    }
    const log = new Logger({ out: io.out, err: io.err });
    // Company networks (net.ts): proxy and certificates before the first connection; the proxy password is registered with the log first.
    if (parsed.config.network) await setUpRunnerNetwork(parsed.config.network, { env: io.env, global: io.globalNetwork === true, workDir: parsed.config.workDir, platformUrl: parsed.config.baseUrl }, log);
    // "Check this computer" (computer-check.ts): what the real runner finds at start goes to the platform with its hello. Never stops the start.
    if (io.globalNetwork === true) await startRunnerCheck(parsed.config);
    const agent = new Agent({ config: parsed.config, log, env: io.env, ...(io.updater ? { updater: io.updater } : {}), ...(io.credentialStore ? { credentialStore: io.credentialStore } : {}) });
    io.onAgent?.(agent);
    return agent.run();
}
