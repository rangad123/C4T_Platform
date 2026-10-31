/**
 * The prompt-caching switch in Settings, AI model (docs/features/prompt-caching.md). On by default; a choice saved here wins over
 * LLM_PROMPT_CACHE from the environment. Stored in the AI usage feature's key/value table `ai_settings` (no migration of its own).
 *
 *   GET /api/llm/prompt-cache    { enabled, source, environment, provider, model, style, explanation }
 *   PUT /api/llm/prompt-cache    { enabled: boolean | null }   null = follow LLM_PROMPT_CACHE again
 *
 * Every process (API, worker) installs the source at start (bootstrap.ts), and the engine reads it at every model call, so a change
 * applies to the next request of jobs that are already running.
 */
import { z } from "zod";
import type { Config } from "../config.js";
import { cacheStyleFor, describeCacheStyle, envPromptCache, promptCacheSetting, setPromptCacheSource, type CacheStyle } from "../engine/llm/prompt-cache.js";
import type { Db } from "./db.js";
import { SettingsCache } from "./settings-cache.js";
import { HttpError } from "./http-error.js";
import type { RouteCtx } from "./routes/types.js";

const KEY = "llm_prompt_cache";

/** The value saved in the app: true/false, or undefined when nobody saved one (or the table cannot be read). */
export function savedPromptCache(db: Db): boolean | undefined {
    try {
        const row = db.get<{ value: string | null }>("SELECT value FROM ai_settings WHERE key = ?", KEY);
        return row?.value === "on" ? true : row?.value === "off" ? false : undefined;
    } catch {
        return undefined;
    }
}

export function savePromptCache(db: Db, enabled: boolean | null): void {
    if (enabled === null) db.run("DELETE FROM ai_settings WHERE key = ?", KEY);
    else db.run("INSERT INTO ai_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", KEY, enabled ? "on" : "off");
    void cache?.refresh();
}

/** What the engine reads (settings-cache.ts): a save here is seen at once, one on another process within the refresh interval. */
let cache: SettingsCache<boolean | undefined> | undefined;

/** Called once per process (bootstrap): the saved choice becomes the engine's source. */
export function installPromptCache(db: Db): void {
    const c = (cache = new SettingsCache(() => savedPromptCache(db)));
    setPromptCacheSource(() => c.get());
}

export interface PromptCacheView {
    enabled: boolean;
    /** app = saved in Settings, environment = LLM_PROMPT_CACHE, default = on because nothing is set. */
    source: "app" | "environment" | "default";
    /** What LLM_PROMPT_CACHE says (null when it is not set), so Settings can say what "follow the server" means. */
    environment: boolean | null;
    provider: string;
    model: string;
    style: CacheStyle;
    explanation: string;
}

export function promptCacheView(config: Config, modelName: string): PromptCacheView {
    const s = promptCacheSetting(config);
    const style = cacheStyleFor(config.LLM_PROVIDER, modelName);
    const envSet = (config.LLM_PROMPT_CACHE ?? "").trim() !== "";
    return {
        enabled: s.enabled,
        source: s.source,
        environment: envSet ? envPromptCache(config.LLM_PROMPT_CACHE) : null,
        provider: config.LLM_PROVIDER,
        model: modelName,
        style,
        explanation: describeCacheStyle(style),
    };
}

const Body = z.object({ enabled: z.boolean({ invalid_type_error: "Send { enabled: true }, { enabled: false } or { enabled: null }" }).nullable() }).strict();

export function registerPromptCacheRoutes(ctx: RouteCtx): void {
    const { app, p } = ctx;
    app.get("/api/llm/prompt-cache", async () => promptCacheView(p.config, p.llm.modelName));
    app.put("/api/llm/prompt-cache", async (req) => {
        const parsed = Body.safeParse(req.body ?? {});
        if (!parsed.success) throw new HttpError(400, "Send { enabled: true }, { enabled: false } or { enabled: null }");
        savePromptCache(p.db, parsed.data.enabled);
        return promptCacheView(p.config, p.llm.modelName);
    });
}
