/**
 * The cross-account designation of an application (assessment/cross-account.ts): which two test accounts are A and B, and the resources
 * whose owner the person knows. One row per application, created on first use like the other security tables (`ensureSecurityTables`);
 * the row goes with its application. No value of an account or a resource's content is kept: names, paths and the ownership field only.
 */
import { z } from "zod";
import type { ApiListRow } from "../engine/identity/access.js";
import type { Db, Row } from "../platform/db.js";
import { DesignationSchema, refusalOf, type Designation } from "./assessment/cross-account.js";

export const CROSS_ACCOUNT_MIGRATION = `
CREATE TABLE IF NOT EXISTS security_cross_account (
    application_id TEXT PRIMARY KEY REFERENCES security_applications(id) ON DELETE CASCADE,
    designation_json TEXT NOT NULL,           -- { accountA, accountB, resources: [{ path, kind, owner, label }], ownerField?, ownerValueA?, ownerValueB? }
    updated_by TEXT,
    updated_at TEXT NOT NULL
);
-- A designation drafted from a test run's two-account evidence. Never read by an assessment: it counts only once a person saves it.
CREATE TABLE IF NOT EXISTS security_cross_account_draft (
    application_id TEXT PRIMARY KEY REFERENCES security_applications(id) ON DELETE CASCADE,
    designation_json TEXT NOT NULL,
    source_json TEXT NOT NULL,                -- { runId, findings: [test ids] }: the engine findings it came with
    created_at TEXT NOT NULL
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

/** A person's designation (the PUT route). Saving one also settles any draft: it was confirmed, changed or replaced. */
export function writeDesignation(db: Db, appId: string, d: Designation, by: string | null): void {
    ensureCrossAccountTables(db);
    db.run("DELETE FROM security_cross_account_draft WHERE application_id = ?", appId);
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

// ── drafts from a test run (testing-engine Phase 4 C11 hand-over) ─────────────

export const DraftSourceSchema = z.object({ runId: z.string().min(1).max(100), findings: z.array(z.string().min(1).max(100)).max(20) }).strict();
export type DraftSource = z.infer<typeof DraftSourceSchema>;
export interface DesignationDraft {
    designation: Designation;
    source: DraftSource;
    createdAt: string;
}

/**
 * A designation from the access stage's list evidence (engine/identity/access.ts ApiListRow): for the first list where one account lists
 * a record the other does not, and each lists one of its own, A = the viewer, B = the other account, with B's record and A's record.
 * Account names are the test accounts' names. Undefined without such evidence. Only ids reach it, never other content.
 */
export function designationFromListEvidence(rows: readonly ApiListRow[]): Designation | undefined {
    for (const row of rows) {
        const names = Object.keys(row.items).filter((n) => n !== "anonymous");
        for (const a of names)
            for (const b of names) {
                if (a === b) continue;
                const aIds = new Set(row.items[a]!.map((x) => x.id));
                const bIds = new Set(row.items[b]!.map((x) => x.id));
                const theirs = row.items[b]!.find((x) => !aIds.has(x.id));
                const mine = row.items[a]!.find((x) => !bIds.has(x.id));
                if (!theirs || !mine) continue;
                const at = (id: string) => row.detail.replace(/\{[^/{}]+\}$/, encodeURIComponent(id));
                const resources = [
                    { path: at(theirs.id), kind: "item", owner: "B", label: `In ${b}'s list of ${row.list}, not in ${a}'s` },
                    { path: at(mine.id), kind: "item", owner: "A", label: `In ${a}'s list of ${row.list}, not in ${b}'s` },
                ].filter((r) => !refusalOf(r.path));
                const d = DesignationSchema.safeParse({ accountA: a, accountB: b, resources });
                if (d.success) return d.data;
            }
    }
    return undefined;
}

/**
 * Keep a draft for the project's application at the run's origin (the first one whose target has that origin). It is never applied:
 * readDesignation does not see it, so no assessment uses it until a person saves a designation (the PUT route), which removes the draft.
 * Undefined (nothing kept) without evidence or without such an application.
 */
export function writeDesignationDraft(db: Db, input: { projectId: string; origin: string; rows: readonly ApiListRow[]; source: DraftSource }): { applicationId: string; applicationName: string } | undefined {
    ensureCrossAccountTables(db);
    const designation = designationFromListEvidence(input.rows);
    if (!designation) return undefined;
    const source = DraftSourceSchema.parse(input.source);
    const origin = (u: string) => {
        try {
            return new URL(u).origin;
        } catch {
            return undefined;
        }
    };
    const want = origin(input.origin);
    const app = db.all<Row>("SELECT id, name, target_url FROM security_applications WHERE project_id = ? ORDER BY created_at", input.projectId).find((r) => want && origin(String(r.target_url)) === want);
    if (!app) return undefined;
    db.run(
        `INSERT INTO security_cross_account_draft (application_id, designation_json, source_json, created_at) VALUES (?,?,?,?)
         ON CONFLICT(application_id) DO UPDATE SET designation_json = excluded.designation_json, source_json = excluded.source_json, created_at = excluded.created_at`,
        String(app.id),
        JSON.stringify(designation),
        JSON.stringify(source),
        new Date().toISOString(),
    );
    return { applicationId: String(app.id), applicationName: String(app.name) };
}

/** The application's draft, for the person to review (the GET route), or undefined. */
export function readDesignationDraft(db: Db, appId: string): DesignationDraft | undefined {
    ensureCrossAccountTables(db);
    const r = db.get<Row>("SELECT designation_json, source_json, created_at FROM security_cross_account_draft WHERE application_id = ?", appId);
    if (!r) return undefined;
    try {
        const d = DesignationSchema.safeParse(JSON.parse(String(r.designation_json)));
        const s = DraftSourceSchema.safeParse(JSON.parse(String(r.source_json)));
        return d.success && s.success ? { designation: d.data, source: s.data, createdAt: String(r.created_at) } : undefined;
    } catch {
        return undefined;
    }
}
