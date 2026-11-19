/**
 * Migration 68 (the AI response cache): a database left by the release before it keeps its AI usage rows, which gain the cached-call counts
 * at 0; it gains the empty cache table, removed with its project; a fresh database and an upgraded one end with the same schema; opening
 * again re-runs nothing. A database at slot 66 (a project's AI model, the slot before candidate findings) opens to 68 too.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabaseAtVersion, Db, knownSchemaVersion } from "../src/platform/db.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-cache68-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const at = "2026-11-18T10:00:00.000Z";
const schemaOf = (db: Db) => ({
    columns: db.all("SELECT name, type, \"notnull\" AS nn, dflt_value AS d, pk FROM pragma_table_info('llm_response_cache') ORDER BY name"),
    indexes: db.all("SELECT name, \"unique\" AS u FROM pragma_index_list('llm_response_cache') ORDER BY name"),
    fks: db.all("SELECT \"table\" AS t, \"from\" AS f, on_delete AS d FROM pragma_foreign_key_list('llm_response_cache')"),
    usage: db.all("SELECT name, type, \"notnull\" AS nn, dflt_value AS d FROM pragma_table_info('ai_usage') ORDER BY name"),
});

function oldDatabase(file: string): void {
    createDatabaseAtVersion(file, 67);
    const raw = new DatabaseSync(file);
    raw.prepare("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)").run("u-1", "one@people.example", "One", at, "owner", "active");
    raw.prepare("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)").run("p1", "u-1", "Shop", at, at);
    raw.prepare("INSERT INTO ai_usage (job_id, project_id, purpose, model, day, calls, input_tokens, output_tokens) VALUES (?,?,?,?,?,?,?,?)").run("j1", "p1", "analysis", "m", "2026-11-18", 3, 900, 100);
    raw.close();
}

describe("migration 68", () => {
    it("is known to this code", () => {
        expect(knownSchemaVersion()).toBeGreaterThanOrEqual(68);
    });

    it("keeps every usage row with no cached calls, and adds the cache empty; a project's answers go with it", () => {
        const file = path.join(dir, "old.db");
        oldDatabase(file);
        const db = new Db(file);
        expect(db.get<{ v: number }>("SELECT MAX(version) AS v FROM schema_version")!.v).toBe(knownSchemaVersion());
        expect(db.all("SELECT job_id, calls, input_tokens, cached_calls, saved_input_tokens, saved_output_tokens FROM ai_usage")).toEqual([{ job_id: "j1", calls: 3, input_tokens: 900, cached_calls: 0, saved_input_tokens: 0, saved_output_tokens: 0 }]);
        expect(db.all("SELECT * FROM llm_response_cache")).toEqual([]);
        db.run("INSERT INTO llm_response_cache (project_id, cache_key, call_id, answer_json, bytes, created_at, last_used_at) VALUES (?,?,?,?,?,?,?)", "p1", "k", "rules", "{}", 2, at, at);
        db.run("DELETE FROM projects WHERE id = ?", "p1");
        expect(db.all("SELECT * FROM llm_response_cache")).toEqual([]);
        db.close();
    });

    it("opens a database at slot 66 (a project's AI model) to 68, keeping each project's AI model", () => {
        const file = path.join(dir, "at66.db");
        createDatabaseAtVersion(file, 66);
        const raw = new DatabaseSync(file);
        raw.prepare("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)").run("u-1", "one@people.example", "One", at, "owner", "active");
        raw.prepare("INSERT INTO projects (id, owner_id, name, created_at, updated_at, ai_provider, ai_model) VALUES (?,?,?,?,?,?,?)").run("p1", "u-1", "Shop", at, at, "anthropic", "claude-haiku");
        raw.close();
        const db = new Db(file);
        expect(db.all("SELECT version FROM schema_version WHERE version > 66 ORDER BY version")).toEqual([{ version: 67 }, { version: 68 }]);
        expect(db.all("SELECT id, ai_provider, ai_model FROM projects")).toEqual([{ id: "p1", ai_provider: "anthropic", ai_model: "claude-haiku" }]);
        expect(db.all("SELECT * FROM llm_response_cache")).toEqual([]);
        const fresh = new Db(":memory:");
        expect(schemaOf(db)).toEqual(schemaOf(fresh));
        fresh.close();
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
        expect(again.all("SELECT version FROM schema_version WHERE version = 68")).toHaveLength(1);
        again.close();
    });
});
