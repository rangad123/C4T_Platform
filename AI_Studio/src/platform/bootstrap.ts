import { loadConfig, type Config } from "../config.js";
import { createLlmClientOrUnavailable, type LlmClient } from "../engine/llm/provider.js";
import { Db } from "./db.js";
import type { Sql } from "./sql.js";
import { Repo } from "./repo.js";
import { SecretBox, secretKeySource } from "./secrets.js";
import { createObjectStore, type ObjectStore } from "./object-store.js";
import { getAgentServices } from "./agent-services.js";
import { installFrameworkGate } from "./framework-settings-store.js";
import { installCustomGate } from "./custom-policy.js";
import { installPluginGate } from "./plugin-gate.js";
import { installLlmHealth } from "./llm-health.js";
import { installCompactSnapshots } from "./snapshot-settings.js";
import { installLlmRouting } from "./llm-routing.js";
import { installPromptCache } from "./prompt-cache-settings.js";
import { installWithoutAi } from "./without-ai-settings.js";

export interface Platform {
    config: Config;
    db: Db;
    /** The asynchronous interface on the same connection (sql.ts); converted stores take this instead of `db`. */
    sql: Sql;
    repo: Repo;
    store: ObjectStore;
    llm: LlmClient;
}

export function bootstrap(config: Config = loadConfig()): Platform {
    // A hosted install refuses to start without SECRET_KEY (secrets.ts), before anything is opened.
    secretKeySource(config);
    const db = new Db(config.dbPath);
    const repo = new Repo(db, new SecretBox(config.dataDir, config.SECRET_KEY));
    repo.ensureDefaultUser();
    // Fallback models saved in Settings, and AI model health shared between processes (docs/features/ai-model-reliability.md).
    installLlmHealth(db);
    // Smaller page snapshots switch saved in Settings (snapshot-settings.ts): read when an authoring session or phone exploration starts.
    installCompactSnapshots(db);
    // The fast model saved in Settings (docs/features/model-routing.md).
    installLlmRouting(db);
    // Prompt caching switch saved in Settings (prompt-cache-settings.ts): read by the engine at every model call.
    installPromptCache(db);
    // Repair without AI first and exploration reuse, switches saved in Settings (without-ai-settings.ts): read when the work starts.
    installWithoutAi(db);
    const llm = createLlmClientOrUnavailable(config);
    const platform: Platform = { config, db, sql: db.sql, repo, store: createObjectStore(config), llm };
    // Where a project's scripts run (here, or on a runner agent) and the check that a job can run there: needed by every process that creates or runs jobs.
    getAgentServices(platform);
    // Frameworks a project switched off (Runners, Frameworks): checked when any job is created.
    installFrameworkGate(repo);
    // Hand-written tests only run where their owner allowed it (ALLOW_CUSTOM_SCRIPTS, or an agent started with --allow-custom-scripts).
    installCustomGate(platform);
    // Tests of an adapter plug-in framework that is not loaded (or cannot run on an agent) are refused before a job exists; nothing is deleted.
    installPluginGate(platform);
    return platform;
}
