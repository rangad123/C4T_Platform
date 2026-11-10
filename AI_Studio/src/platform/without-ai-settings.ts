/**
 * The two "no AI where it is not needed" switches in Settings, AI model (docs/features/repair-and-reuse-without-ai.md): repair without AI
 * first, and exploration reuse. Both on by default; a choice saved here wins over LLM_DETERMINISTIC_REPAIR / LLM_EXPLORATION_REUSE from the
 * environment. Stored in the AI usage feature's key/value table `ai_settings` (no migration of its own).
 *
 *   GET /api/llm/without-ai    { deterministicRepair: Switch, explorationReuse: Switch }
 *   PUT /api/llm/without-ai    { deterministicRepair?: boolean | null, explorationReuse?: boolean | null }   null = follow the environment again
 *
 * Also what a job saved this way (`withoutAiOfJob`), counted from its own events, for the job's AI usage answer.
 */
import { z } from "zod";
import type { Config } from "../config.js";
import { envSwitch, EVENT_PAGES_REUSED, EVENT_REPAIRED_WITHOUT_AI, SAVING_ENV, setWithoutAiSource, withoutAiSetting, type SavingSource, type WithoutAiSaving } from "../engine/llm/without-ai.js";
import type { Db } from "./db.js";
import { SettingsCache } from "./settings-cache.js";
import { HttpError } from "./http-error.js";
import type { RouteCtx } from "./routes/types.js";

const KEYS: Record<WithoutAiSaving, string> = { deterministicRepair: "llm_deterministic_repair", explorationReuse: "llm_exploration_reuse" };
const SAVINGS: WithoutAiSaving[] = ["deterministicRepair", "explorationReuse"];

export function savedWithoutAi(db: Db, s: WithoutAiSaving): boolean | undefined {
    try {
        const row = db.get<{ value: string | null }>("SELECT value FROM ai_settings WHERE key = ?", KEYS[s]);
        return row?.value === "on" ? true : row?.value === "off" ? false : undefined;
    } catch {
        return undefined;
    }
}

export function saveWithoutAi(db: Db, s: WithoutAiSaving, enabled: boolean | null): void {
    if (enabled === null) db.run("DELETE FROM ai_settings WHERE key = ?", KEYS[s]);
    else db.run("INSERT INTO ai_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", KEYS[s], enabled ? "on" : "off");
    void caches?.[s].refresh();
}

/** What the engine reads, one cache per switch (settings-cache.ts): a save here is seen at once, one on another process within the refresh interval. */
let caches: Record<WithoutAiSaving, SettingsCache<boolean | undefined>> | undefined;

/** Called once per process (bootstrap): the saved choices become the engine's source. */
export function installWithoutAi(db: Db): void {
    const c = (caches = { deterministicRepair: new SettingsCache(() => savedWithoutAi(db, "deterministicRepair")), explorationReuse: new SettingsCache(() => savedWithoutAi(db, "explorationReuse")) });
    setWithoutAiSource((s) => c[s].get());
}

export interface SwitchView {
    enabled: boolean;
    /** app = saved in Settings, environment = the variable, default = on because nothing is set. */
    source: SavingSource;
    /** What the environment variable says (null when it is not set). */
    environment: boolean | null;
    variable: string;
}

export function withoutAiView(config: Config): Record<WithoutAiSaving, SwitchView> {
    const one = (s: WithoutAiSaving): SwitchView => {
        const v = withoutAiSetting(config, s);
        const env = config[SAVING_ENV[s]];
        return { enabled: v.enabled, source: v.source, environment: (env ?? "").trim() ? envSwitch(env) : null, variable: SAVING_ENV[s] };
    };
    return { deterministicRepair: one("deterministicRepair"), explorationReuse: one("explorationReuse") };
}

const Choice = z.boolean({ error: "Each switch is true, false or null" }).nullable().optional();
const Body = z.object({ deterministicRepair: Choice, explorationReuse: Choice }).strict();

export function registerWithoutAiRoutes(ctx: RouteCtx): void {
    const { app, p } = ctx;
    app.get("/api/llm/without-ai", async () => withoutAiView(p.config));
    app.put("/api/llm/without-ai", async (req) => {
        const parsed = Body.safeParse(req.body ?? {});
        if (!parsed.success) throw new HttpError(400, "Send { deterministicRepair: true | false | null } and/or { explorationReuse: true | false | null }");
        for (const s of SAVINGS) if (parsed.data[s] !== undefined) saveWithoutAi(p.db, s, parsed.data[s]!);
        return withoutAiView(p.config);
    });
}

export interface WithoutAiSavings {
    /** Tests repaired by the plain rules (the model was not asked for them). */
    repairs: number;
    /** By which rule: shared-element, role-name, same-text, moved. */
    repairsByKind: Record<string, number>;
    /** Pages not sent to the AI again because they did not change since the last exploration. */
    pagesReused: number;
    summary: string;
}

/** What this job did without AI, from its own events; null when it did nothing that way. */
export function withoutAiOfJob(db: Db, jobId: string): WithoutAiSavings | null {
    let rows: Array<{ kind: string; data_json: string | null }>;
    try {
        rows = db.all<{ kind: string; data_json: string | null }>("SELECT kind, data_json FROM agent_events WHERE job_id = ? AND kind IN (?, ?) LIMIT 5000", jobId, EVENT_REPAIRED_WITHOUT_AI, EVENT_PAGES_REUSED);
    } catch {
        return null;
    }
    if (!rows.length) return null;
    const out: WithoutAiSavings = { repairs: 0, repairsByKind: {}, pagesReused: 0, summary: "" };
    for (const r of rows) {
        let d: Record<string, unknown> = {};
        try {
            d = (JSON.parse(r.data_json ?? "{}") as Record<string, unknown>) ?? {};
        } catch {
            /* counted without detail */
        }
        if (r.kind === EVENT_REPAIRED_WITHOUT_AI) {
            out.repairs++;
            const k = typeof d.kind === "string" ? d.kind : "other";
            out.repairsByKind[k] = (out.repairsByKind[k] ?? 0) + 1;
        } else out.pagesReused += typeof d.pages === "number" && Number.isFinite(d.pages) ? d.pages : 0;
    }
    const parts = [
        out.repairs ? `${out.repairs} ${out.repairs === 1 ? "repair" : "repairs"} without AI` : "",
        out.pagesReused ? `${out.pagesReused} unchanged ${out.pagesReused === 1 ? "page" : "pages"} not sent to the AI again` : "",
    ].filter(Boolean);
    out.summary = parts.join(", ");
    return out;
}
