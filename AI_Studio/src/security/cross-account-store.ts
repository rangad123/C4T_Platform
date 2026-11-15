/**
 * The cross-account designation of an application (assessment/cross-account.ts): which two test accounts are A and B, and the resources
 * whose owner the person knows. One row per application, created on first use like the other security tables (`ensureSecurityTables`);
 * the row goes with its application. No value of an account or a resource's content is kept: names, paths and the ownership field only.
 */
import type { Db, Row } from "../platform/db.js";
import { DesignationSchema, type Designation } from "./assessment/cross-account.js";

export const CROSS_ACCOUNT_MIGRATION = `
CREATE TABLE IF NOT EXISTS security_cross_account (
    application_id TEXT PRIMARY KEY REFERENCES security_applications(id) ON DELETE CASCADE,
    designation_json TEXT NOT NULL,           -- { accountA, accountB, resources: [{ path, kind, owner, label }], ownerField?, ownerValueA?, ownerValueB? }
    updated_by TEXT,
    updated_at TEXT NOT NULL
);
`;

const ensured = new WeakSet<Db>();
export function ensureCrossAccountTables(db: Db): void {
    if (ensured.has(db)) return;
    db.raw.exec(CROSS_ACCOUNT_MIGRATION);
    ensured.add(db);
}

/** The application's designation, or undefined (none set, or a stored one that no longer reads: then the step does not run). */
export function readDesignation(db: Db, appId: string): Designation | undefined {
    ensureCrossAccountTables(db);
    const r = db.get<Row>("SELECT designation_json FROM security_cross_account WHERE application_id = ?", appId);
    if (!r) return undefined;
    try {
        const p = DesignationSchema.safeParse(JSON.parse(String(r.designation_json)));
        return p.success ? p.data : undefined;
    } catch {
        return undefined;
    }
}

export function writeDesignation(db: Db, appId: string, d: Designation, by: string | null): void {
    ensureCrossAccountTables(db);
    db.run(
        `INSERT INTO security_cross_account (application_id, designation_json, updated_by, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(application_id) DO UPDATE SET designation_json = excluded.designation_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        appId,
        JSON.stringify(d),
        by,
        new Date().toISOString(),
    );
}

export function deleteDesignation(db: Db, appId: string): boolean {
    ensureCrossAccountTables(db);
    return Number(db.run("DELETE FROM security_cross_account WHERE application_id = ?", appId).changes) > 0;
}
