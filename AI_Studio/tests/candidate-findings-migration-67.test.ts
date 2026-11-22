/**
 * Migration 67 (candidate findings, testing-engine Phase 3): a database left by the release before it keeps every row; it gains the
 * candidate findings table (one per project and fingerprint, removed with the project; a deleted run or test leaves the finding without
 * it); a fresh database and an upgraded one end with the same schema; opening again re-runs nothing.
 *
 * Slot 66 is a project's AI model (sheet #4), which reached main first: a database main left at 66 (its SQL copied below) goes to 68
 * too and keeps the AI model on its projects, and so does one left at 65. Main also recorded 67 as a placeholder (`-- reserved`) and ran
 * 68 (the AI response cache) after it: such a database gets the candidate findings table when it opens (LATE_FILLED_SLOTS, by its table),
 * keeping its rows. One this branch opened before the merge (66 recorded as a placeholder, 67 run) gets main's 66 columns the same way.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabaseAtVersion, Db, knownSchemaVersion } from "../src/platform/db.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-cand67-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const at = "2026-11-17T10:00:00.000Z";
const schemaOf = (db: Db) => ({
    columns: db.all("SELECT name, type, \"notnull\" AS nn, dflt_value AS d, pk FROM pragma_table_info('candidate_findings') ORDER BY name"),
    indexes: db.all("SELECT name, \"unique\" AS u FROM pragma_index_list('candidate_findings') ORDER BY name"),
    fks: db.all("SELECT \"table\" AS t, \"from\" AS f, on_delete AS d FROM pragma_foreign_key_list('candidate_findings') ORDER BY f"),
});

type Exec = { prepare(sql: string): { run(...p: unknown[]): unknown } };
function seed(raw: Exec): void {
    const ins = (sql: string, ...p: unknown[]) => raw.prepare(sql).run(...p);
    ins("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)", "u-1", "one@people.example", "One", at, "owner", "active");
    ins("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)", "p1", "u-1", "Shop", at, at);
    ins("INSERT INTO applications (id, project_id, url, origin, config_json, created_at) VALUES (?,?,?,?,?,?)", "a1", "p1", "https://shop.example", "https://shop.example", "{}", at);
    ins("INSERT INTO generation_jobs (id, project_id, application_id, status, options_json, progress_json, counters_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", "j1", "p1", "a1", "done", "{}", "{}", "{}", at, at);
    ins("INSERT INTO test_suites (id, project_id, name, slug, created_at) VALUES (?,?,?,?,?)", "s1", "p1", "Suite", "suite", at);
    ins("INSERT INTO test_cases (id, project_id, suite_id, job_id, test_key, title, kind, type, priority, validation_status, framework, spec_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", "t1", "p1", "s1", "j1", "WEB-001", "Cart total", "web", "functional", "high", "NEEDS_REVIEW", "playwright", "{}", at, at);
    ins("INSERT INTO app_model_versions (id, project_id, version, model_json, created_at) VALUES (?,?,?,?,?)", "v1", "p1", 1, "{}", at);
    ins("INSERT INTO app_workflow_decisions (project_id, fingerprint, status, decided_name, decided_steps_json, decided_by, decided_at) VALUES (?,?,?,?,?,?,?)", "p1", "f".repeat(64), "confirmed", "Checkout", "[]", "u-1", at);
}

/** Main's slot 66, as sheet #4 ships it (AI_Studio/src/platform/db.ts on branch sheet-push). */
const MAIN_SLOT_66 = `ALTER TABLE projects ADD COLUMN ai_provider TEXT;
ALTER TABLE projects ADD COLUMN ai_model TEXT;`;

function oldDatabase(file: string): void {
    createDatabaseAtVersion(file, 65);
    const raw = new DatabaseSync(file);
    seed(raw);
    raw.close();
}

/** A database main left at 66: slots 1-65, main's 66 recorded as run, a project with its AI model. */
function mainDatabaseAt66(file: string): void {
    oldDatabase(file);
    const raw = new DatabaseSync(file);
    raw.exec(MAIN_SLOT_66);
    raw.prepare("INSERT INTO schema_version (version) VALUES (?)").run(66);
    raw.prepare("UPDATE projects SET ai_provider = ?, ai_model = ? WHERE id = ?").run("anthropic", "claude-sonnet", "p1");
    raw.close();
}

const addFinding = (db: Db, fingerprint: string, project = "p1") =>
    db.run(
        "INSERT INTO candidate_findings (id, project_id, first_job_id, last_job_id, test_id, fingerprint, status, confidence, capture, finding_json, seen_count, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        `cf-${fingerprint.slice(0, 4)}-${project}`, project, "j1", "j1", "t1", fingerprint, "candidate", "medium", "captured", "{}", 1, at, at, at, at,
    );

describe("migration 67", () => {
    it("is known to this code", () => {
        expect(knownSchemaVersion()).toBeGreaterThanOrEqual(67);
    });

    it("keeps every row of a slot-65 database and adds the candidate findings empty", () => {
        const file = path.join(dir, "old.db");
        oldDatabase(file);
        const db = new Db(file);
        expect(db.get<{ v: number }>("SELECT MAX(version) AS v FROM schema_version")!.v).toBe(knownSchemaVersion());
        expect(db.all("SELECT version FROM schema_version WHERE version BETWEEN 66 AND 68 ORDER BY version")).toEqual([{ version: 66 }, { version: 67 }, { version: 68 }]);
        expect(db.all("SELECT id FROM projects")).toEqual([{ id: "p1" }]);
        expect(db.all("SELECT id, status FROM generation_jobs")).toEqual([{ id: "j1", status: "done" }]);
        expect(db.all("SELECT id, validation_status FROM test_cases")).toEqual([{ id: "t1", validation_status: "NEEDS_REVIEW" }]);
        expect(db.all("SELECT id, version FROM app_model_versions")).toEqual([{ id: "v1", version: 1 }]);
        expect(db.all("SELECT status, decided_name FROM app_workflow_decisions")).toEqual([{ status: "confirmed", decided_name: "Checkout" }]);
        expect(db.all("SELECT * FROM candidate_findings")).toEqual([]);
        db.close();
    });

    it("leaves an upgraded database with the same schema as a fresh one, and re-runs nothing when opened again", () => {
        const file = path.join(dir, "old2.db");
        oldDatabase(file);
        const upgraded = new Db(file);
        const fresh = new Db(":memory:");
        expect(schemaOf(upgraded).columns.length).toBeGreaterThan(0);
        expect(schemaOf(upgraded)).toEqual(schemaOf(fresh));
        upgraded.close();
        fresh.close();
        const again = new Db(file);
        expect(again.all("SELECT version FROM schema_version WHERE version = 67")).toHaveLength(1);
        again.close();
    });

    it("takes a database main left at 66 to 68, keeping its projects' AI model and adding the candidate findings", () => {
        const file = path.join(dir, "main66.db");
        mainDatabaseAt66(file);
        const db = new Db(file);
        expect(db.all("SELECT version FROM schema_version WHERE version <= 68 ORDER BY version").map((r) => r.version).slice(-4)).toEqual([65, 66, 67, 68]);
        expect(db.all("SELECT id, ai_provider, ai_model FROM projects")).toEqual([{ id: "p1", ai_provider: "anthropic", ai_model: "claude-sonnet" }]);
        expect(db.all("SELECT status, decided_name FROM app_workflow_decisions")).toEqual([{ status: "confirmed", decided_name: "Checkout" }]);
        expect(db.all("SELECT * FROM candidate_findings")).toEqual([]);
        const fresh = new Db(":memory:");
        expect(schemaOf(db)).toEqual(schemaOf(fresh));
        fresh.close();
        addFinding(db, "b".repeat(64));
        expect(db.all("SELECT fingerprint FROM candidate_findings")).toEqual([{ fingerprint: "b".repeat(64) }]);
        db.close();
        const again = new Db(file);
        expect(again.all("SELECT version FROM schema_version WHERE version BETWEEN 66 AND 68")).toHaveLength(3);
        expect(again.all("SELECT ai_model FROM projects")).toEqual([{ ai_model: "claude-sonnet" }]);
        again.close();
    });

    it("gives a database main left at 68, with 67 recorded as a placeholder, the candidate findings table and keeps its rows", () => {
        // Main's 67 was `-- reserved`: its database has every table of 1-68 except candidate_findings, and records 67 and 68 as run.
        const file = path.join(dir, "main68.db");
        createDatabaseAtVersion(file, 68);
        const raw = new DatabaseSync(file);
        raw.exec("DROP TABLE candidate_findings");
        seed(raw);
        raw.prepare("UPDATE projects SET ai_provider = ?, ai_model = ? WHERE id = ?").run("anthropic", "claude-sonnet", "p1");
        raw.prepare("INSERT INTO llm_response_cache (project_id, cache_key, call_id, answer_json, bytes, created_at, last_used_at) VALUES (?,?,?,?,?,?,?)").run("p1", "k", "rules", "{}", 2, at, at);
        raw.close();
        const db = new Db(file);
        expect(db.all("SELECT version FROM schema_version WHERE version BETWEEN 66 AND 68 ORDER BY version")).toEqual([{ version: 66 }, { version: 67 }, { version: 68 }]);
        expect(db.all("SELECT * FROM candidate_findings")).toEqual([]);
        const fresh = new Db(":memory:");
        expect(schemaOf(db)).toEqual(schemaOf(fresh));
        fresh.close();
        expect(db.all("SELECT id, ai_provider, ai_model FROM projects")).toEqual([{ id: "p1", ai_provider: "anthropic", ai_model: "claude-sonnet" }]);
        expect(db.all("SELECT cache_key FROM llm_response_cache")).toEqual([{ cache_key: "k" }]);
        expect(db.all("SELECT id, validation_status FROM test_cases")).toEqual([{ id: "t1", validation_status: "NEEDS_REVIEW" }]);
        addFinding(db, "c".repeat(64));
        db.close();
        const again = new Db(file);
        expect(again.all("SELECT fingerprint FROM candidate_findings")).toEqual([{ fingerprint: "c".repeat(64) }]);
        expect(again.all("SELECT version FROM schema_version WHERE version BETWEEN 66 AND 68")).toHaveLength(3);
        again.close();
    });

    it("gives a database this branch opened before the merge (66 a placeholder, 67 run) main's slot 66 columns, keeping its findings", () => {
        const file = path.join(dir, "branch67.db");
        createDatabaseAtVersion(file, 67);
        const raw = new DatabaseSync(file);
        raw.exec("ALTER TABLE projects DROP COLUMN ai_model; ALTER TABLE projects DROP COLUMN ai_provider");
        seed(raw);
        raw.prepare("INSERT INTO candidate_findings (id, project_id, first_job_id, last_job_id, test_id, fingerprint, status, confidence, capture, finding_json, seen_count, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("cf-e", "p1", "j1", "j1", "t1", "e".repeat(64), "candidate", "medium", "captured", "{}", 1, at, at, at, at);
        raw.close();
        const db = new Db(file);
        expect(db.all("SELECT id, ai_provider, ai_model FROM projects")).toEqual([{ id: "p1", ai_provider: null, ai_model: null }]);
        expect(db.all("SELECT fingerprint FROM candidate_findings")).toEqual([{ fingerprint: "e".repeat(64) }]);
        expect(db.all("SELECT version FROM schema_version WHERE version BETWEEN 66 AND 68 ORDER BY version")).toEqual([{ version: 66 }, { version: 67 }, { version: 68 }]);
        db.close();
    });

    it("keeps one finding per project and fingerprint; a deleted run or test leaves it, a deleted project removes it", () => {
        const db = new Db(":memory:");
        seed(db.raw);
        addFinding(db, "a".repeat(64));
        expect(() => addFinding(db, "a".repeat(64))).toThrow(/UNIQUE|PRIMARY/);
        db.run("DELETE FROM test_cases WHERE id = ?", "t1");
        db.run("DELETE FROM generation_jobs WHERE id = ?", "j1");
        expect(db.all("SELECT first_job_id, last_job_id, test_id FROM candidate_findings")).toEqual([{ first_job_id: null, last_job_id: null, test_id: null }]);
        db.run("DELETE FROM projects WHERE id = ?", "p1");
        expect(db.all("SELECT * FROM candidate_findings")).toEqual([]);
        db.close();
    });
});
