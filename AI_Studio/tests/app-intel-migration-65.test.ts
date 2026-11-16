/**
 * Migration 65 (decisions about workflows): a database left by the release before it keeps every model version and rule; it gains the
 * table of workflow decisions (one per project and workflow fingerprint, removed with the project); a fresh database and an upgraded one
 * end with the same schema; opening again re-runs nothing.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabaseAtVersion, Db, knownSchemaVersion } from "../src/platform/db.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-intel65-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const at = "2026-11-16T10:00:00.000Z";
const schemaOf = (db: Db) => ({
    columns: db.all("SELECT name, type, \"notnull\" AS nn, dflt_value AS d, pk FROM pragma_table_info('app_workflow_decisions') ORDER BY name"),
    indexes: db.all("SELECT name, \"unique\" AS u FROM pragma_index_list('app_workflow_decisions') ORDER BY name"),
    fks: db.all("SELECT \"table\" AS t, \"from\" AS f, on_delete AS d FROM pragma_foreign_key_list('app_workflow_decisions')"),
});

function oldDatabase(file: string): void {
    createDatabaseAtVersion(file, 64);
    const raw = new DatabaseSync(file);
    raw.prepare("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)").run("u-1", "one@people.example", "One", at, "owner", "active");
    raw.prepare("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)").run("p1", "u-1", "Shop", at, at);
    raw.prepare("INSERT INTO app_model_versions (id, project_id, version, model_json, created_at) VALUES (?,?,?,?,?)").run("v1", "p1", 1, "{}", at);
    raw.prepare("INSERT INTO app_rules (id, project_id, ref, kind, description, expected, source_type, explicitness, confidence, status, decided_by, decided_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("r1", "p1", "R-1", "constraint", "Q", "Between 1 and 10", "requirement", "explicit", 0.9, "confirmed", "u-1", at, at, at);
    raw.close();
}

describe("migration 65", () => {
    it("is known to this code", () => {
        expect(knownSchemaVersion()).toBeGreaterThanOrEqual(65);
    });

    it("keeps every version and rule, with its decision, and adds the workflow decisions empty", () => {
        const file = path.join(dir, "old.db");
        oldDatabase(file);
        const db = new Db(file);
        expect(db.get<{ v: number }>("SELECT MAX(version) AS v FROM schema_version")!.v).toBe(knownSchemaVersion());
        expect(db.all("SELECT id, version FROM app_model_versions")).toEqual([{ id: "v1", version: 1 }]);
        expect(db.all("SELECT id, status, decided_by FROM app_rules")).toEqual([{ id: "r1", status: "confirmed", decided_by: "u-1" }]);
        expect(db.all("SELECT * FROM app_workflow_decisions")).toEqual([]);
        db.close();
    });

    it("leaves an upgraded database with the same schema as a fresh one, and re-runs nothing when opened again", () => {
        const file = path.join(dir, "old2.db");
        oldDatabase(file);
        const upgraded = new Db(file);
        const fresh = new Db(":memory:");
        expect(schemaOf(upgraded)).toEqual(schemaOf(fresh));
        upgraded.close();
        fresh.close();
        const again = new Db(file);
        expect(again.all("SELECT version FROM schema_version WHERE version = 65")).toHaveLength(1);
        again.close();
    });

    it("keeps one decision per project and workflow fingerprint, and removes them with the project", () => {
        const db = new Db(":memory:");
        db.run("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)", "u-1", "one@people.example", "One", at, "owner", "active");
        db.run("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)", "p1", "u-1", "Shop", at, at);
        const add = () => db.run("INSERT INTO app_workflow_decisions (project_id, fingerprint, status, decided_name, decided_steps_json, decided_by, decided_at) VALUES (?,?,?,?,?,?,?)", "p1", "f".repeat(64), "confirmed", "Checkout", "[]", "u-1", at);
        add();
        expect(add).toThrow(/UNIQUE|PRIMARY/);
        db.run("DELETE FROM projects WHERE id = ?", "p1");
        expect(db.all("SELECT * FROM app_workflow_decisions")).toEqual([]);
        db.close();
    });
});
