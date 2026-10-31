import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { bootstrap } from "../platform/bootstrap.js";
import { buildServer } from "../platform/server.js";
import { Worker } from "../platform/worker.js";
import { localClient, type ApiClient } from "./client.js";

export interface LocalPlatform {
    client: ApiClient;
    close(): Promise<void>;
}

const LLM_ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"];

/**
 * A private, throwaway platform inside this process: its own temp data directory (never ./data), the real
 * server routes called in-process, and a real worker. Replay mode needs no AI, so the AI keys are removed
 * from this process: a saved test either passes or it does not, the same way every run.
 */
export async function startLocalPlatform(opts: { replay: boolean }): Promise<LocalPlatform> {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-test-"));
    const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: dataDir, WORKER_EMBEDDED: "false" };
    delete env.API_KEY;
    if (opts.replay) {
        for (const k of LLM_ENV) {
            delete env[k];
            delete process.env[k];
        }
        // One repair attempt is what lets a failing check be classified as an application finding
        // (the classification runs before any repair); with no AI available nothing is actually repaired.
        env.MAX_REPAIR_ATTEMPTS = "1";
    }
    const platform = bootstrap(loadConfig(env));
    const app = await buildServer(platform);
    const worker = new Worker(platform, 200);
    worker.start();
    return {
        client: localClient(app),
        async close() {
            await worker.stop();
            await app.close();
            platform.db.close();
            // Windows may hold the SQLite files for a moment after close.
            for (let i = 0; i < 5; i++) {
                try {
                    fs.rmSync(dataDir, { recursive: true, force: true });
                    return;
                } catch {
                    await new Promise((r) => setTimeout(r, 200));
                }
            }
        },
    };
}
