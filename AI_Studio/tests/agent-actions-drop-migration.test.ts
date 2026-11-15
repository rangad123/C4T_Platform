/**
 * Migration 63: the authoring agents' tool-call records (agent_actions) are dropped. A database left at slot 62 with agent action rows
 * ends at 63 without the table, with every other table, index and row it had still there (agent runs included); opening it again
 * re-runs nothing; a fresh database never has the table.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabaseAtVersion, Db, knownSchemaVersion } from "../src/platform/db.js";

type Raw = import("node:sqlite").DatabaseSync;
type R = Record<string, unknown>;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-agent-actions-mig-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const t0 = new Date(Date.now() - 3_600_000).toISOString();

function openRaw(file: string): Raw {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const raw = new DatabaseSync(file);
    raw.exec("PRAGMA foreign_keys = ON");
    return raw;
}

const tables = (all: (sql: string) => R[]) => all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => String(r.name));
const indexes = (all: (sql: string) => R[]) => all("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => `${r.tbl_name}.${r.name}`);
const triggers = (all: (sql: string) => R[]) => all("SELECT name, sql FROM sqlite_master WHERE type IN ('trigger', 'view') ORDER BY name").map((r) => `${r.name}: ${r.sql}`);

function oldDatabase(file: string): { tables: string[]; indexes: string[]; triggers: string[]; rows: Map<string, R[]> } {
    createDatabaseAtVersion(file, 62);
    const raw = openRaw(file);
    try {
        const run = (sql: string, ...p: Array<string | number | null>) => raw.prepare(sql).run(...p);
        run("INSERT INTO users (id, email, name, created_at) VALUES (?,?,?,?)", "u1", "u1@people.example", "u1", t0);
        run("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)", "p1", "u1", "Shop", t0, t0);
        run("INSERT INTO applications (id, project_id, url, origin, config_json, created_at) VALUES (?,?,?,?,?,?)", "a1", "p1", "https://app.example", "https://app.example", "{}", t0);
        run(
            "INSERT INTO generation_jobs (id, project_id, application_id, status, options_json, progress_json, counters_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
            "j1", "p1", "a1", "COMPLETED", "{}", "{}", "{}", t0, t0,
        );
        run("INSERT INTO agent_runs (id, job_id, role, subject, status, summary, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?)", "r1", "j1", "author", "WEB-001", "DONE", "ok", t0, t0);
        run("INSERT INTO agent_events (job_id, stage, kind, level, message, created_at) VALUES (?,?,?,?,?,?)", "j1", "author", "note", "info", "Started", t0);
        for (let i = 0; i < 5; i++) run("INSERT INTO agent_actions (run_id, tool, args_json, ok, observation, created_at) VALUES (?,?,?,?,?,?)", "r1", `t${i}`, "{}", 1, "url=https://app.example/", t0);
        expect((raw.prepare("SELECT COUNT(*) AS n FROM agent_actions").get() as { n: number }).n).toBe(5);
        const all = (s: string) => raw.prepare(s).all() as R[];
        // No trigger or view uses the table, so dropping it breaks none of them.
        expect(triggers(all).filter((t) => /agent_actions/.test(t))).toEqual([]);
        const t = tables(all);
        const rows = new Map(t.map((name) => [name, all(`SELECT * FROM "${name}" ORDER BY rowid`)]));
        return { tables: t, indexes: indexes(all), triggers: triggers(all), rows };
    } finally {
        raw.close();
    }
}

describe("migration 63: agent_actions is dropped", () => {
    it("is the last slot this code knows", () => {
        expect(knownSchemaVersion()).toBe(63);
    });

    it("upgrades a slot-62 database with agent action rows: the table is gone, every other table, index and row stays", () => {
        const file = path.join(dir, "at62.db");
        const before = oldDatabase(file);
        expect(before.tables).toContain("agent_actions");

        const db = new Db(file);
        try {
            const all = (s: string) => db.all(s);
            expect(db.get<{ v: number }>("SELECT MAX(version) AS v FROM schema_version")!.v).toBe(63);
            const after = tables(all);
            expect(after).not.toContain("agent_actions");
            expect(after).toEqual(before.tables.filter((t) => t !== "agent_actions"));
            expect(indexes(all).filter((i) => i.startsWith("agent_actions."))).toEqual([]);
            expect(indexes(all)).toEqual(expect.arrayContaining(before.indexes.filter((i) => !i.startsWith("agent_actions."))));
            expect(triggers(all)).toEqual(before.triggers);
            expect(db.get("SELECT 1 FROM sqlite_sequence WHERE name = 'agent_actions'")).toBeUndefined();
            for (const [name, rows] of before.rows) {
                if (name === "agent_actions") continue;
                // schema_version gains exactly the row for 63 (checked below); its earlier rows stay as they were.
                const now = db.all(`SELECT * FROM "${name}" ORDER BY rowid`).filter((r) => name !== "schema_version" || r.version !== 63);
                // Columns the open adds without a slot (addActorColumns, addCacheColumns) may be new; every value that was there stays.
                expect(now.map((r, i) => Object.fromEntries(Object.keys(rows[i] ?? {}).map((k) => [k, r[k]]))), name).toEqual(rows);
                expect(now.length, name).toBe(rows.length);
            }
            expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM schema_version WHERE version = 63")!.n).toBe(1);
            expect(db.get("SELECT status, summary FROM agent_runs WHERE id = 'r1'")).toEqual({ status: "DONE", summary: "ok" });
            expect(db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        } finally {
            db.close();
        }

        // Opening again re-runs nothing.
        const again = new Db(file);
        try {
            expect(again.get<{ n: number }>("SELECT COUNT(*) AS n FROM schema_version WHERE version = 63")!.n).toBe(1);
            expect(again.get("SELECT 1 FROM sqlite_master WHERE name = 'agent_actions'")).toBeUndefined();
        } finally {
            again.close();
        }
    });

    it("a fresh database ends at 63 without the table, with the same tables as an upgraded one", () => {
        const fresh = new Db(":memory:");
        const upgraded = new Db(path.join(dir, "at62.db"));
        try {
            expect(fresh.get<{ v: number }>("SELECT MAX(version) AS v FROM schema_version")!.v).toBe(63);
            expect(fresh.get("SELECT 1 FROM sqlite_master WHERE name = 'agent_actions'")).toBeUndefined();
            expect(tables((s) => fresh.all(s))).toEqual(tables((s) => upgraded.all(s)));
        } finally {
            fresh.close();
            upgraded.close();
        }
    });
});
