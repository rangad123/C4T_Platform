/**
 * Per-project framework settings: storage, the append-only change log, and the check that keeps a switched-off framework from
 * running (`frameworkGate`, installed on the repository so every way of creating a job passes through it).
 *
 * Nothing is stored for a project that never changed anything: reading gives the defaults, which equal what the platform always did.
 */
import type { EngineContext } from "../engine/context.js";
import { adapterForSpec, defaultAdapterFor, localExecutor } from "../engine/frameworks/index.js";
import { withFrameworkSettings } from "../engine/frameworks/settings-executor.js";
import {
    clampSettings,
    defaultFrameworkSettings,
    describeChange,
    describeDeviations,
    effectiveSettings,
    firstTurnedOff,
    FRAMEWORK_IDS,
    normalizeSettings,
    sameSettings,
    turnedOffMessage,
    type FrameworkId,
    type FrameworkSettings,
} from "../engine/frameworks/settings.js";
import type { Db } from "./db.js";
import { HttpError } from "./http-error.js";
import type { JobOptions, Repo } from "./repo.js";

/** Migration slot 21. */
export const FRAMEWORK_SETTINGS_MIGRATION = `
CREATE TABLE framework_settings (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    settings_json TEXT NOT NULL,          -- the full, clamped settings object (engine/frameworks/settings.ts)
    updated_at TEXT NOT NULL
);
-- Append-only: rows are only ever added (there is no route to change or remove one). Deleted with the project.
CREATE TABLE framework_settings_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    by TEXT,                              -- free text, optional (like other features), at most 60 characters
    summary TEXT NOT NULL                 -- plain words: what moved
);
CREATE INDEX idx_framework_log_project ON framework_settings_log(project_id, id);
`;

export interface SettingsChange {
    id: number;
    at: string;
    by: string | null;
    summary: string;
}

export class FrameworkSettingsStore {
    constructor(private readonly db: Db) {}

    /** The project's settings, or the defaults when it never changed any. A damaged row also gives defaults for the damaged fields. */
    get(projectId: string): FrameworkSettings {
        const r = this.db.get<{ settings_json: string }>("SELECT settings_json FROM framework_settings WHERE project_id = ?", projectId);
        if (!r) return defaultFrameworkSettings();
        try {
            return normalizeSettings(JSON.parse(r.settings_json));
        } catch {
            return defaultFrameworkSettings();
        }
    }

    /** Store (already clamped) settings and add a line to the change log when something changed. Returns the log line, if any. */
    save(projectId: string, next: FrameworkSettings, by?: string): SettingsChange | undefined {
        const clamped = clampSettings(next).settings;
        const before = this.get(projectId);
        const at = new Date().toISOString();
        this.db.run(
            "INSERT INTO framework_settings (project_id, settings_json, updated_at) VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at",
            projectId,
            JSON.stringify(clamped),
            at,
        );
        if (sameSettings(before, clamped)) return undefined;
        const summary = describeChange(before, clamped);
        const r = this.db.get<{ id: number }>("INSERT INTO framework_settings_log (project_id, at, by, summary) VALUES (?,?,?,?) RETURNING id", projectId, at, by?.trim() ? by.trim().slice(0, 60) : null, summary)!;
        return { id: Number(r.id), at, by: by?.trim() ? by.trim().slice(0, 60) : null, summary };
    }

    /** The latest changes, newest first. */
    changes(projectId: string, limit = 10): SettingsChange[] {
        return this.db
            .all<{ id: number; at: string; by: string | null; summary: string }>("SELECT id, at, by, summary FROM framework_settings_log WHERE project_id = ? ORDER BY id DESC LIMIT ?", projectId, limit)
            .map((r) => ({ id: r.id, at: r.at, by: r.by, summary: r.summary }));
    }
}

/** True when every framework is on (the common case: nothing to check). */
export const allEnabled = (s: Pick<FrameworkSettings, "enabled">): boolean => FRAMEWORK_IDS.every((id) => s.enabled[id]);

/**
 * Refuse, with a plain 409, a job whose tests are all of switched-off frameworks. A job with a mix runs: the engine leaves the
 * switched-off tests out and says so in the job's events. An analysis simply stops offering the switched-off kinds of test.
 */
export function frameworkGate(repo: Repo, store: FrameworkSettingsStore, projectId: string, options: JobOptions): void {
    const s = store.get(projectId);
    if (allEnabled(s)) return;
    const on = (id: FrameworkId) => s.enabled[id];
    const mode = options.mode ?? "generate";
    if (mode === "generate") {
        const wanted = options.targets ?? ["web", "api"];
        const kept = wanted.filter((k) => on(k === "web" ? "playwright" : k === "mobile" ? "taqwright" : "playwright-api"));
        if (kept.length === wanted.length) return;
        if (kept.length === 0) throw new HttpError(409, turnedOffMessage(wanted[0] === "api" ? "playwright-api" : wanted[0] === "mobile" ? "taqwright" : "playwright"));
        options.targets = kept;
        return;
    }
    let ids: FrameworkId[];
    if (mode === "variants") ids = ["playwright"];
    else if (mode === "plain") {
        const kind = options.plainKind ?? (options.rewriteTestId ? repo.getTest(options.rewriteTestId)?.spec.kind : undefined) ?? "web";
        ids = [kind === "api" ? "playwright-api" : "playwright"];
    } else {
        ids = [];
        for (const id of options.testIds ?? []) {
            const t = repo.getTest(id);
            if (!t) continue;
            const adapter = adapterForSpec(t.spec).id as FrameworkId;
            if (!ids.includes(adapter)) ids.push(adapter);
        }
    }
    if (ids.length > 0 && ids.every((id) => !on(id))) throw new HttpError(409, turnedOffMessage(ids[0]!));
}

/** Install the gate on a repository (every job, whoever creates it, passes through `Repo.createJob`). */
export function installFrameworkGate(repo: Repo): void {
    const store = new FrameworkSettingsStore(repo.db);
    repo.frameworkGate = async (projectId, options) => frameworkGate(repo, store, projectId, options);
}

/** The first switched-off framework among the specs' kinds as a plain message (used by imports), or undefined. */
export function turnedOffForSpecs(store: FrameworkSettingsStore, projectId: string, kinds: Iterable<string | { kind: string; platform?: string }>): string | undefined {
    const s = store.get(projectId);
    for (const kind of kinds) {
        // A spec (not just its kind) says whether a mobile test is an iOS one.
        const id = (typeof kind === "string" ? defaultAdapterFor(kind as never) : adapterForSpec(kind as never)).id as FrameworkId;
        if (s.enabled[id] === false) return turnedOffMessage(id);
    }
    return undefined;
}

/**
 * Lay a project's settings over a job's context: the executor that runs its scripts, the "switched off" answer the engine uses to leave
 * tests out, and one event (only when something differs from the defaults). With default settings it changes nothing at all.
 */
export function applyFrameworkSettings(ctx: EngineContext, repo: Repo, job: { projectId: string; options: JobOptions }): void {
    let settings: FrameworkSettings;
    try {
        settings = new FrameworkSettingsStore(repo.db).get(job.projectId);
    } catch {
        return; // an unreadable table must never stop a run
    }
    const remote = ctx.executor?.remote === true;
    const eff = effectiveSettings(settings, { onAgent: remote, platformWorkers: ctx.config.CONCURRENCY });
    const deviations = describeDeviations(settings, eff);
    if (deviations.length === 0) return;
    if (ctx.executor) ctx.executor = withFrameworkSettings(ctx.executor, eff, true);
    else ctx.executor = withFrameworkSettings(localExecutor, eff, true);
    ctx.frameworkOff = (adapterId) => firstTurnedOff(settings, [adapterId]);
    ctx.emit({ stage: "orchestration", kind: "framework_settings", message: `Running with ${deviations.join(", ")}.`, data: { deviations } });
    for (const note of eff.notes) ctx.emit({ stage: "orchestration", kind: "framework_settings_note", level: "warn", message: note });
}
