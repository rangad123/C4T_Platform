/**
 * The "smaller page snapshots" switch in Settings, AI model (docs/features/smaller-snapshots.md). On by default; a choice saved here wins over
 * LLM_COMPACT_SNAPSHOTS from the environment. Stored in the AI usage feature's key/value table `ai_settings` (no migration of its own).
 *
 *   GET /api/llm/compact-snapshots    { enabled, source, environment }
 *   PUT /api/llm/compact-snapshots    { enabled: boolean | null }   null = follow LLM_COMPACT_SNAPSHOTS again
 *
 * Every process (API, worker) installs the source at start (bootstrap.ts); the engine reads it when an authoring session or a phone
 * exploration starts, so a change applies to the next one.
 */
import { z } from "zod";
import type { Config } from "../config.js";
import { compactSnapshotSetting, envCompactSnapshots, EVENT_SNAPSHOT_SAVINGS, setCompactSnapshotSource, type SnapshotSettingSource } from "../engine/snapshots/setting.js";
import type { Db } from "./db.js";
import { SettingsCache } from "./settings-cache.js";
import { HttpError } from "./http-error.js";
import type { RouteCtx } from "./routes/types.js";

const KEY = "llm_compact_snapshots";

/** The value saved in the app: true/false, or undefined when nobody saved one (or the table cannot be read). */
export function savedCompactSnapshots(db: Db): boolean | undefined {
    try {
        const row = db.get<{ value: string | null }>("SELECT value FROM ai_settings WHERE key = ?", KEY);
        return row?.value === "on" ? true : row?.value === "off" ? false : undefined;
    } catch {
        return undefined;
    }
}

export function saveCompactSnapshots(db: Db, enabled: boolean | null): void {
    if (enabled === null) db.run("DELETE FROM ai_settings WHERE key = ?", KEY);
    else db.run("INSERT INTO ai_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", KEY, enabled ? "on" : "off");
    void cache?.refresh();
}

/** What the engine reads (settings-cache.ts): a save here is seen at once, one on another process within the refresh interval. */
let cache: SettingsCache<boolean | undefined> | undefined;

/** Called once per process (bootstrap): the saved choice becomes the engine's source. */
export function installCompactSnapshots(db: Db): void {
    const c = (cache = new SettingsCache(() => savedCompactSnapshots(db)));
    setCompactSnapshotSource(() => c.get());
}

export interface CompactSnapshotsView {
    enabled: boolean;
    /** app = saved in Settings, environment = LLM_COMPACT_SNAPSHOTS, default = on because nothing is set. */
    source: SnapshotSettingSource;
    /** What LLM_COMPACT_SNAPSHOTS says (null when it is not set), so Settings can say what "follow the server" means. */
    environment: boolean | null;
}

export function compactSnapshotsView(config: Config): CompactSnapshotsView {
    const s = compactSnapshotSetting(config);
    const envSet = (config.LLM_COMPACT_SNAPSHOTS ?? "").trim() !== "";
    return { enabled: s.enabled, source: s.source, environment: envSet ? envCompactSnapshots(config.LLM_COMPACT_SNAPSHOTS) : null };
}

export interface SnapshotSavings {
    /** Authoring sessions and phone explorations that used smaller snapshots. */
    sessions: number;
    /** Estimated snapshot tokens the model read (each model step counted), without and with the saving. */
    baselineTokens: number;
    sentTokens: number;
    savedTokens: number;
    /** How often the model asked for the whole page. */
    wholePageLooks: number;
    summary: string;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** What smaller snapshots saved in one job, added up from its job events (null when the job wrote none). Read through the job index. */
export function snapshotSavingsOfJob(db: Db, jobId: string): SnapshotSavings | null {
    let rows: Array<{ data_json: string | null }>;
    try {
        rows = db.all<{ data_json: string | null }>("SELECT data_json FROM agent_events WHERE job_id = ? AND kind = ? LIMIT 2000", jobId, EVENT_SNAPSHOT_SAVINGS);
    } catch {
        return null;
    }
    if (!rows.length) return null;
    const t = { sessions: 0, baselineTokens: 0, sentTokens: 0, savedTokens: 0, wholePageLooks: 0 };
    for (const r of rows) {
        let d: Record<string, unknown> = {};
        try {
            d = (JSON.parse(r.data_json ?? "{}") as Record<string, unknown>) ?? {};
        } catch {
            continue;
        }
        t.sessions++;
        t.baselineTokens += num(d.baselineTokens);
        t.sentTokens += num(d.sentTokens);
        t.savedTokens += num(d.savedTokens);
        t.wholePageLooks += num(d.wholePage);
    }
    const pct = t.baselineTokens > 0 ? Math.round((t.savedTokens / t.baselineTokens) * 100) : 0;
    const summary = t.savedTokens > 0 ? `Smaller page snapshots saved about ${t.savedTokens.toLocaleString("en-US")} tokens (${pct}% of the snapshot text)` : "Smaller page snapshots saved nothing in this job";
    return { ...t, summary };
}

const Body = z.object({ enabled: z.boolean().nullable() }).strict();

export function registerCompactSnapshotRoutes(ctx: RouteCtx): void {
    const { app, p } = ctx;
    app.get("/api/llm/compact-snapshots", async () => compactSnapshotsView(p.config));
    app.put("/api/llm/compact-snapshots", async (req) => {
        const parsed = Body.safeParse(req.body ?? {});
        if (!parsed.success) throw new HttpError(400, "Send { enabled: true }, { enabled: false } or { enabled: null }");
        saveCompactSnapshots(p.db, parsed.data.enabled);
        return compactSnapshotsView(p.config);
    });
}
