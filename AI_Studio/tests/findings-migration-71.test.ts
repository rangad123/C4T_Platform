/**
 * Migration 71 (Phase 5 finding lifecycle): a database at the slot before it keeps every candidate finding, each now in state `candidate`
 * with no class, severity, group or attempts yet; it gains empty finding_events and finding_groups, removed with their project; a fresh
 * database and an upgraded one end with the same schema; a database already at 71 opens again without re-running anything.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabaseAtVersion, Db, knownSchemaVersion } from "../src/platform/db.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-find71-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const at = "2026-11-21T10:00:00.000Z";
const TABLES = ["candidate_findings", "finding_events", "finding_groups"];
const schemaOf = (db: Db) =>
    TABLES.map((t) => ({
        t,
        columns: db.all(`SELECT name, type, "notnull" AS nn, dflt_value AS d, pk FROM pragma_table_info('${t}') ORDER BY name`),
        indexes: db.all(`SELECT name, "unique" AS u FROM pragma_index_list('${t}') ORDER BY name`),
        fks: db.all(`SELECT "table" AS t, "from" AS f, on_delete AS d FROM pragma_foreign_key_list('${t}') ORDER BY "from"`),
    }));

function databaseAt70(file: string): void {
    createDatabaseAtVersion(file, 70);
    const raw = new DatabaseSync(file);
    raw.prepare("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)").run("u-1", "one@people.example", "One", at, "owner", "active");
    for (const p of ["p1", "p2"]) raw.prepare("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)").run(p, "u-1", p, at, at);
    const ins = raw.prepare("INSERT INTO candidate_findings (id, project_id, fingerprint, status, confidence, capture, finding_json, seen_count, first_seen_at, last_seen_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
    ins.run("f1", "p1", "a".repeat(64), "candidate", "high", "captured", '{"x":1}', 3, at, at, at, at);
    ins.run("f2", "p1", "b".repeat(64), "candidate", "low", "observed_only", '{"x":2}', 1, at, at, at, at);
    ins.run("f3", "p2", "a".repeat(64), "candidate", "medium", "captured", '{"x":3}', 2, at, at, at, at);
    raw.close();
}

describe("migration 71", () => {
    it("is known to this code", () => {
        expect(knownSchemaVersion()).toBeGreaterThanOrEqual(71);
    });

    it("keeps every candidate finding of a slot-70 database, each in state candidate, and adds the history and groups empty", () => {
        const file = path.join(dir, "at70.db");
        databaseAt70(file);
        const db = new Db(file);
        expect(db.get<{ v: number }>("SELECT MAX(version) AS v FROM schema_version")!.v).toBe(knownSchemaVersion());
        expect(db.all("SELECT version FROM schema_version WHERE version IN (70, 71) ORDER BY version")).toEqual([{ version: 70 }, { version: 71 }]);
        expect(db.all("SELECT id, project_id, fingerprint, status, confidence, capture, finding_json, seen_count, state, class, severity, confidence_json, group_id, attempts_json, app_version FROM candidate_findings ORDER BY id")).toEqual([
            { id: "f1", project_id: "p1", fingerprint: "a".repeat(64), status: "candidate", confidence: "high", capture: "captured", finding_json: '{"x":1}', seen_count: 3, state: "candidate", class: null, severity: null, confidence_json: null, group_id: null, attempts_json: "[]", app_version: null },
            { id: "f2", project_id: "p1", fingerprint: "b".repeat(64), status: "candidate", confidence: "low", capture: "observed_only", finding_json: '{"x":2}', seen_count: 1, state: "candidate", class: null, severity: null, confidence_json: null, group_id: null, attempts_json: "[]", app_version: null },
            { id: "f3", project_id: "p2", fingerprint: "a".repeat(64), status: "candidate", confidence: "medium", capture: "captured", finding_json: '{"x":3}', seen_count: 2, state: "candidate", class: null, severity: null, confidence_json: null, group_id: null, attempts_json: "[]", app_version: null },
        ]);
        expect(db.all("SELECT * FROM finding_events")).toEqual([]);
        expect(db.all("SELECT * FROM finding_groups")).toEqual([]);
        db.run("INSERT INTO finding_groups (id, project_id, signature_json, created_at, updated_at) VALUES (?,?,?,?,?)", "g1", "p1", "{}", at, at);
        db.run("UPDATE candidate_findings SET group_id = ? WHERE id = ?", "g1", "f1");
        db.run("INSERT INTO finding_events (id, project_id, finding_id, seq, at, actor, by_kind, from_state, to_state) VALUES (?,?,?,?,?,?,?,?,?)", "e1", "p1", "f1", 1, at, "Engine", "engine", "candidate", "verification_pending");
        db.run("DELETE FROM finding_groups WHERE id = ?", "g1");
        expect(db.get("SELECT group_id FROM candidate_findings WHERE id = ?", "f1")).toEqual({ group_id: null });
        db.run("DELETE FROM projects WHERE id = ?", "p1");
        expect(db.all("SELECT id FROM candidate_findings")).toEqual([{ id: "f3" }]);
        expect(db.all("SELECT * FROM finding_events")).toEqual([]);
        db.close();
    });

    it("leaves an upgraded database with the same schema as a fresh one", () => {
        const file = path.join(dir, "at70b.db");
        databaseAt70(file);
        const upgraded = new Db(file);
        const fresh = new Db(":memory:");
        expect(schemaOf(upgraded)).toEqual(schemaOf(fresh));
        upgraded.close();
        fresh.close();
    });

    it("opens a database already at 71 without re-running a slot, keeping its lifecycle data", () => {
        const file = path.join(dir, "at71.db");
        createDatabaseAtVersion(file, 71);
        const raw = new DatabaseSync(file);
        raw.prepare("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)").run("u-1", "one@people.example", "One", at, "owner", "active");
        raw.prepare("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)").run("p1", "u-1", "p1", at, at);
        raw.prepare("INSERT INTO candidate_findings (id, project_id, fingerprint, status, confidence, capture, finding_json, first_seen_at, last_seen_at, created_at, updated_at, state, class) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run("f1", "p1", "a".repeat(64), "candidate", "high", "captured", "{}", at, at, at, at, "confirmed", "app_defect");
        raw.close();
        const db = new Db(file);
        expect(db.all("SELECT version FROM schema_version WHERE version IN (70, 71) ORDER BY version")).toEqual([{ version: 70 }, { version: 71 }]);
        expect(db.all("SELECT id, state, class FROM candidate_findings")).toEqual([{ id: "f1", state: "confirmed", class: "app_defect" }]);
        db.close();
    });
});
