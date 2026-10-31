/**
 * Earlier versions of a generated test's steps (migration slot 23), kept when someone edits them in the step editor.
 * Version 1 is the test as it was before the first edit, so a person can always see what the editor changed. At most
 * `MAX_SPEC_VERSIONS` are kept per test; the oldest is dropped first.
 */
import type { TestSpec } from "../engine/spec/schema.js";
import type { Db } from "./db.js";
import { retryOnUniqueViolation } from "./sql-dialect.js";

export const SPEC_VERSIONS_MIGRATION = `
CREATE TABLE spec_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    spec_json TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (test_case_id, version)
);
`;

export const MAX_SPEC_VERSIONS = 20;

export interface SpecVersionRow {
    version: number;
    createdAt: string;
    note: string | null;
    steps: number;
}

export class SpecVersionStore {
    constructor(private readonly db: Db) {}

    latest(testId: string): number {
        return this.db.get<{ v: number | null }>("SELECT MAX(version) AS v FROM spec_versions WHERE test_case_id = ?", testId)?.v ?? 0;
    }

    add(testId: string, spec: TestSpec, note: string | null): number {
        // The next number is taken in the insert itself; a concurrent writer that took it first fails UNIQUE (test_case_id, version), and the insert is tried again.
        const version = retryOnUniqueViolation(this.db.dialect, () =>
            Number(
                this.db.get<{ version: number }>(
                    "INSERT INTO spec_versions (test_case_id, version, spec_json, note, created_at) SELECT ?, COALESCE(MAX(version), 0) + 1, ?, ?, ? FROM spec_versions WHERE test_case_id = ? RETURNING version",
                    testId, JSON.stringify(spec), note?.slice(0, 200) ?? null, new Date().toISOString(), testId,
                )!.version,
            ),
        );
        this.db.run("DELETE FROM spec_versions WHERE test_case_id = ? AND version <= ?", testId, version - MAX_SPEC_VERSIONS);
        return version;
    }

    list(testId: string): SpecVersionRow[] {
        return this.db
            .all("SELECT version, spec_json, note, created_at FROM spec_versions WHERE test_case_id = ? ORDER BY version DESC", testId)
            .map((r) => ({ version: r.version as number, createdAt: r.created_at as string, note: (r.note as string | null) ?? null, steps: (JSON.parse(r.spec_json as string) as TestSpec).steps.length }));
    }

    get(testId: string, version: number): { version: number; spec: TestSpec; note: string | null; createdAt: string } | undefined {
        const r = this.db.get("SELECT version, spec_json, note, created_at FROM spec_versions WHERE test_case_id = ? AND version = ?", testId, version);
        return r ? { version: r.version as number, spec: JSON.parse(r.spec_json as string) as TestSpec, note: (r.note as string | null) ?? null, createdAt: r.created_at as string } : undefined;
    }
}
