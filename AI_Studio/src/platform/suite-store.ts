/**
 * Test suites a person builds: an ordered list of a project's test cases and how the suite runs (the environment, extra browsers and
 * screen sizes, retries, whether it stops at the first failure). They sit beside the automatic groups by area (`test_suites`, made
 * from each test's category), which are not touched here. The tables are migration slot 39 in db.ts.
 *
 * A suite belongs to one project, and so does every test in it (checked by the routes). Positions are 0..n-1 after every change.
 * Which schedules start a suite is kept in a link table of its own, so the schedules table stays as it was.
 *
 * A suite made by "Generate suites, by requirement" remembers where it came from (its origin: the requirement, and every script the
 * generation put in it), so a later generation finds it by the requirement, not by its name, and never puts back a script a person
 * took out. There is no column for it: the origin is kept in `browsers_json`, which then holds `{ "browsers": [...], "origin": {...} }`
 * instead of the plain list every other suite keeps. Both shapes are read; a suite without an origin is written exactly as before.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ENV_NAME } from "../engine/environments/env.js";
import { EXTRA_VARIANT_IDS } from "../engine/validation/variants.js";
import type { Row } from "./db.js";
import type { Sql } from "./sql.js";

export const SUITE_LIMITS = { suitesPerProject: 50, testsPerSuite: 500, nameLength: 80, descriptionLength: 2000 } as const;

/** How a suite runs. Without an environment the tests run against the project's own address. */
export const SuiteSettingsSchema = z
    .object({
        /** A named environment of the project (staging, production...), or null for the project's own address. */
        environment: z.string().regex(ENV_NAME).nullable(),
        /** A production environment is used only when the person confirmed it, as for schedules. */
        confirmProduction: z.boolean(),
        /** Extra browsers and screen sizes the tests that pass are also checked on (desktop Chrome always runs). */
        browsers: z.array(z.enum(EXTRA_VARIANT_IDS)).max(EXTRA_VARIANT_IDS.length),
        /** A failing test is run again straight away this many times; a pass after a fail is reported as unreliable. */
        retries: z.number().int().min(0).max(2),
        /** Stop the run at the first test that does not pass; the tests after it are not run. */
        stopOnFirstFailure: z.boolean(),
    })
    .strict();
export type SuiteSettings = z.infer<typeof SuiteSettingsSchema>;

export const DEFAULT_SUITE_SETTINGS: SuiteSettings = { environment: null, confirmProduction: false, browsers: [], retries: 0, stopOnFirstFailure: false };

/** Where a generated suite came from. `added`: every script a generation put in it (or found in it), so none of them is added again. */
export interface SuiteOrigin {
    kind: "requirement";
    requirementId: string;
    added: string[];
}
/** Scripts an origin remembers; past this the oldest are forgotten (a suite holds at most 500). */
const MAX_ORIGIN_ADDED = 2000;

export interface Suite {
    id: string;
    projectId: string;
    name: string;
    description: string;
    settings: SuiteSettings;
    /** Set on a suite "Generate suites, by requirement" made; null on every other suite (a duplicate does not inherit it). */
    origin: SuiteOrigin | null;
    testCount: number;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface NewSuiteInput {
    projectId: string;
    name: string;
    description?: string;
    settings?: SuiteSettings;
    testIds?: string[];
    createdBy?: string | null;
    origin?: SuiteOrigin | null;
}

export type SuiteRunTrigger = "manual" | "schedule";

export interface SuiteRunRow {
    jobId: string;
    suiteId: string;
    trigger: SuiteRunTrigger;
    scheduleId: string | null;
    testCount: number;
    createdAt: string;
}

const now = () => new Date().toISOString();

/** `browsers_json`: the plain list of extra browsers, or `{ browsers, origin }` for a generated suite. */
const readBrowsersJson = (raw: string | null | undefined): { browsers: unknown; origin: SuiteOrigin | null } => {
    try {
        const parsed = JSON.parse(raw ?? "[]");
        if (Array.isArray(parsed)) return { browsers: parsed, origin: null };
        const o = parsed?.origin;
        const origin: SuiteOrigin | null =
            o && o.kind === "requirement" && typeof o.requirementId === "string" ? { kind: "requirement", requirementId: o.requirementId, added: Array.isArray(o.added) ? o.added.filter((x: unknown): x is string => typeof x === "string") : [] } : null;
        return { browsers: parsed?.browsers, origin };
    } catch {
        return { browsers: [], origin: null };
    }
};
const writeBrowsersJson = (browsers: SuiteSettings["browsers"], origin: SuiteOrigin | null): string =>
    origin ? JSON.stringify({ browsers, origin: { ...origin, added: [...new Set(origin.added)].slice(-MAX_ORIGIN_ADDED) } }) : JSON.stringify(browsers);

const toSettings = (r: Row): SuiteSettings => {
    const raw = readBrowsersJson(r.browsers_json).browsers;
    const browsers: SuiteSettings["browsers"] = Array.isArray(raw) ? raw.filter((b): b is SuiteSettings["browsers"][number] => (EXTRA_VARIANT_IDS as readonly string[]).includes(b)) : [];
    return { environment: r.environment ?? null, confirmProduction: Number(r.confirm_production) === 1, browsers, retries: Number(r.retries) || 0, stopOnFirstFailure: Number(r.stop_on_failure) === 1 };
};

const toSuite = (r: Row): Suite => ({
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    description: r.description ?? "",
    settings: toSettings(r),
    origin: readBrowsersJson(r.browsers_json).origin,
    testCount: Number(r.test_count ?? 0),
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});

const SELECT = "SELECT s.*, (SELECT COUNT(*) FROM built_suite_tests i WHERE i.suite_id = s.id) AS test_count FROM built_suites s";

export class SuiteStore {
    constructor(private readonly sql: Sql) {}

    async list(projectId: string): Promise<Suite[]> {
        return (await this.sql.all(`${SELECT} WHERE s.project_id = ? ORDER BY s.created_at, s.id`, projectId)).map(toSuite);
    }

    async get(id: string): Promise<Suite | undefined> {
        const r = await this.sql.get(`${SELECT} WHERE s.id = ?`, id);
        return r ? toSuite(r) : undefined;
    }

    /** A suite of this project with this name, whatever its case (names are unique in a project so people can tell suites apart). */
    async findByName(projectId: string, name: string): Promise<Suite | undefined> {
        const key = name.trim().toLowerCase();
        return (await this.list(projectId)).find((s) => s.name.trim().toLowerCase() === key);
    }

    async create(input: NewSuiteInput): Promise<Suite> {
        return (await this.createMany([input]))[0]!;
    }

    /** Several suites in one transaction: all of them are saved, or none (a failing insert undoes the ones before it). */
    async createMany(inputs: readonly NewSuiteInput[]): Promise<Suite[]> {
        const made = inputs.map(() => randomUUID());
        const t = now();
        await this.sql.tx(async (q) => {
            for (let n = 0; n < inputs.length; n++) {
                const input = inputs[n]!;
                const id = made[n]!;
                const s = input.settings ?? DEFAULT_SUITE_SETTINGS;
                await q.run(
                    "INSERT INTO built_suites (id, project_id, name, description, environment, confirm_production, browsers_json, retries, stop_on_failure, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    id,
                    input.projectId,
                    input.name,
                    input.description ?? "",
                    s.environment,
                    s.confirmProduction ? 1 : 0,
                    writeBrowsersJson(s.browsers, input.origin ?? null),
                    s.retries,
                    s.stopOnFirstFailure ? 1 : 0,
                    input.createdBy ?? null,
                    t,
                    t,
                );
                const ids = [...new Set(input.testIds ?? [])];
                for (let i = 0; i < ids.length; i++) await q.run("INSERT INTO built_suite_tests (suite_id, test_case_id, position) VALUES (?,?,?)", id, ids[i]!, i);
            }
        });
        const out: Suite[] = [];
        for (const id of made) out.push((await this.get(id))!);
        return out;
    }

    async update(id: string, patch: { name?: string; description?: string; settings?: SuiteSettings }): Promise<Suite | undefined> {
        const cur = await this.get(id);
        if (!cur) return undefined;
        const s = patch.settings ?? cur.settings;
        await this.sql.run(
            "UPDATE built_suites SET name = ?, description = ?, environment = ?, confirm_production = ?, browsers_json = ?, retries = ?, stop_on_failure = ?, updated_at = ? WHERE id = ?",
            patch.name ?? cur.name,
            patch.description ?? cur.description,
            s.environment,
            s.confirmProduction ? 1 : 0,
            // A generated suite keeps its origin whatever else changes.
            writeBrowsersJson(s.browsers, cur.origin),
            s.retries,
            s.stopOnFirstFailure ? 1 : 0,
            now(),
            id,
        );
        return this.get(id);
    }

    async delete(id: string): Promise<boolean> {
        return (await this.sql.run("DELETE FROM built_suites WHERE id = ?", id)).changes > 0;
    }

    /** The suite's tests (test_cases.id), in the order they run. */
    async testIds(suiteId: string): Promise<string[]> {
        return (await this.sql.all<{ test_case_id: string }>("SELECT test_case_id FROM built_suite_tests WHERE suite_id = ? ORDER BY position, test_case_id", suiteId)).map((r) => r.test_case_id);
    }

    /** Puts the tests in exactly this order (the caller checked it is the suite's own tests, each once). */
    private async write(q: Sql, suiteId: string, ids: string[]): Promise<void> {
        await q.run("DELETE FROM built_suite_tests WHERE suite_id = ?", suiteId);
        for (let i = 0; i < ids.length; i++) await q.run("INSERT INTO built_suite_tests (suite_id, test_case_id, position) VALUES (?,?,?)", suiteId, ids[i]!, i);
        await q.run("UPDATE built_suites SET updated_at = ? WHERE id = ?", now(), suiteId);
    }

    /** Adds tests that are not in the suite yet, at `position` (default: the end), keeping the order given. Returns how many were added. */
    async addTests(suiteId: string, testIds: string[], position?: number): Promise<number> {
        return this.sql.tx(async (q) => {
            const cur = (await q.all<{ test_case_id: string }>("SELECT test_case_id FROM built_suite_tests WHERE suite_id = ? ORDER BY position, test_case_id", suiteId)).map((r) => r.test_case_id);
            const have = new Set(cur);
            const fresh = [...new Set(testIds)].filter((x) => !have.has(x));
            if (!fresh.length) return 0;
            const at = position === undefined ? cur.length : Math.max(0, Math.min(cur.length, position));
            await this.write(q, suiteId, [...cur.slice(0, at), ...fresh, ...cur.slice(at)]);
            return fresh.length;
        });
    }

    /**
     * A generation's update of the suite it made: adds `fresh` at the end (those not in the suite yet) and remembers every script in
     * `seen` as one the generation has handled, in one transaction. Returns how many were added.
     */
    async addGenerated(suiteId: string, fresh: string[], seen: string[]): Promise<number> {
        return this.sql.tx(async (q) => {
            const row = await q.get<{ browsers_json: string }>("SELECT browsers_json FROM built_suites WHERE id = ?", suiteId);
            if (!row) return 0;
            const { browsers, origin } = readBrowsersJson(row.browsers_json);
            if (!origin) return 0;
            const cur = (await q.all<{ test_case_id: string }>("SELECT test_case_id FROM built_suite_tests WHERE suite_id = ? ORDER BY position, test_case_id", suiteId)).map((r) => r.test_case_id);
            const have = new Set(cur);
            const add = [...new Set(fresh)].filter((x) => !have.has(x));
            const kept = Array.isArray(browsers) ? browsers.filter((b): b is SuiteSettings["browsers"][number] => (EXTRA_VARIANT_IDS as readonly string[]).includes(b)) : [];
            await q.run("UPDATE built_suites SET browsers_json = ? WHERE id = ?", writeBrowsersJson(kept, { ...origin, added: [...origin.added, ...seen, ...add] }), suiteId);
            if (add.length) await this.write(q, suiteId, [...cur, ...add]);
            return add.length;
        });
    }

    async removeTest(suiteId: string, testId: string): Promise<boolean> {
        return this.sql.tx(async (q) => {
            const cur = (await q.all<{ test_case_id: string }>("SELECT test_case_id FROM built_suite_tests WHERE suite_id = ? ORDER BY position, test_case_id", suiteId)).map((r) => r.test_case_id);
            if (!cur.includes(testId)) return false;
            await this.write(q, suiteId, cur.filter((x) => x !== testId));
            return true;
        });
    }

    /** Sets the whole order. Refused (false) unless `testIds` is exactly the suite's tests, each once. */
    async reorder(suiteId: string, testIds: string[]): Promise<boolean> {
        return this.sql.tx(async (q) => {
            const cur = (await q.all<{ test_case_id: string }>("SELECT test_case_id FROM built_suite_tests WHERE suite_id = ?", suiteId)).map((r) => r.test_case_id);
            const same = testIds.length === cur.length && new Set(testIds).size === testIds.length && testIds.every((x) => cur.includes(x));
            if (!same) return false;
            await this.write(q, suiteId, testIds);
            return true;
        });
    }

    /** A copy with the same tests, order and settings, under a new name. Its runs and schedules stay with the original. */
    async duplicate(id: string, name: string, createdBy?: string | null): Promise<Suite | undefined> {
        const cur = await this.get(id);
        if (!cur) return undefined;
        return this.create({ projectId: cur.projectId, name, description: cur.description, settings: cur.settings, testIds: await this.testIds(id), createdBy });
    }

    // ── runs ─────────────────────────────────────────────────────────────────

    async recordRun(r: { suiteId: string; jobId: string; trigger: SuiteRunTrigger; scheduleId?: string | null; testCount: number }): Promise<void> {
        await this.sql.run("INSERT INTO built_suite_runs (job_id, suite_id, trigger_kind, schedule_id, test_count, created_at) VALUES (?,?,?,?,?,?)", r.jobId, r.suiteId, r.trigger, r.scheduleId ?? null, r.testCount, now());
    }

    /** The suite's latest runs, newest first. */
    async runs(suiteId: string, limit = 10): Promise<SuiteRunRow[]> {
        const rows = await this.sql.all("SELECT * FROM built_suite_runs WHERE suite_id = ? ORDER BY created_at DESC, job_id LIMIT ?", suiteId, limit);
        return rows.map((r) => ({ jobId: r.job_id, suiteId: r.suite_id, trigger: r.trigger_kind, scheduleId: r.schedule_id ?? null, testCount: Number(r.test_count), createdAt: r.created_at }));
    }

    /** The suite a job ran, if it was a suite run. */
    async suiteOfJob(jobId: string): Promise<string | null> {
        return (await this.sql.get<{ suite_id: string }>("SELECT suite_id FROM built_suite_runs WHERE job_id = ?", jobId))?.suite_id ?? null;
    }

    // ── schedules ────────────────────────────────────────────────────────────

    /** The suite a schedule runs, or null for a schedule that runs what it ran before suites existed. */
    async scheduleLink(scheduleId: string): Promise<string | null> {
        return (await this.sql.get<{ suite_id: string }>("SELECT suite_id FROM built_suite_schedules WHERE schedule_id = ?", scheduleId))?.suite_id ?? null;
    }

    async setScheduleLink(scheduleId: string, suiteId: string | null): Promise<void> {
        if (suiteId === null) await this.sql.run("DELETE FROM built_suite_schedules WHERE schedule_id = ?", scheduleId);
        else await this.sql.run("INSERT INTO built_suite_schedules (schedule_id, suite_id) VALUES (?,?) ON CONFLICT(schedule_id) DO UPDATE SET suite_id = excluded.suite_id", scheduleId, suiteId);
    }

    /** The schedules that start this suite. */
    async schedulesOf(suiteId: string): Promise<Array<{ id: string; name: string; enabled: boolean }>> {
        const rows = await this.sql.all("SELECT s.id, s.name, s.enabled FROM built_suite_schedules l JOIN schedules s ON s.id = l.schedule_id WHERE l.suite_id = ? ORDER BY s.created_at, s.id", suiteId);
        return rows.map((r) => ({ id: r.id, name: r.name, enabled: Number(r.enabled) === 1 }));
    }
}
