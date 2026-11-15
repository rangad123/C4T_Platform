/**
 * Application intelligence (testing-engine Phase 1, migration slot 62): versioned application models and the business rules found in them.
 *
 * A model version is one analysis: its pages, workflows, entities, relationships and scenarios as JSON (the shape is engine/intel/model.ts),
 * numbered per project, never changed afterwards. Rules are rows of their own, because people confirm or reject them and later work asks for
 * them by status and source. A rule is always added "unverified"; only `decide`, called for a person, makes it confirmed or rejected, so a
 * guess never becomes a verified rule by itself. Nothing in test generation reads this yet.
 */
import { randomUUID } from "node:crypto";
import { AppModelSchema, diffModels, RuleSchema, type AppModel, type ModelDiff, type Rule, type RuleStatus } from "../engine/intel/model.js";
import type { Sql } from "./sql.js";

export const APP_INTEL_MIGRATION = `
CREATE TABLE app_model_versions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    application_id TEXT REFERENCES applications(id) ON DELETE SET NULL,
    version INTEGER NOT NULL,
    app_type TEXT NOT NULL DEFAULT '',
    context_sources_json TEXT NOT NULL DEFAULT '[]',
    model_json TEXT NOT NULL,             -- engine/intel/model.ts AppModel
    diff_json TEXT,                       -- what changed since the version before (null for the first)
    note TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_app_model_versions_project ON app_model_versions(project_id, version);
CREATE TABLE app_rules (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    model_version_id TEXT REFERENCES app_model_versions(id) ON DELETE SET NULL,
    ref TEXT NOT NULL,                    -- R-12, unique in the project
    kind TEXT NOT NULL,
    description TEXT NOT NULL,
    expected TEXT NOT NULL,
    source_type TEXT NOT NULL,            -- engine/intel/model.ts SOURCE_TYPES
    source_ref TEXT NOT NULL DEFAULT '',
    evidence_json TEXT NOT NULL DEFAULT '[]',
    explicitness TEXT NOT NULL,           -- explicit inferred
    confidence REAL NOT NULL,
    links_json TEXT NOT NULL DEFAULT '{}', -- { entities, workflows, endpoints }
    status TEXT NOT NULL,                 -- unverified confirmed rejected
    decided_by TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_app_rules_ref ON app_rules(project_id, ref);
CREATE INDEX idx_app_rules_status ON app_rules(project_id, status);
`;

export const MAX_RULES_PER_PROJECT = 2000;
export const MAX_MODEL_BYTES = 4_000_000;

export interface ModelVersionRecord {
    id: string;
    projectId: string;
    applicationId: string | null;
    version: number;
    model: AppModel;
    diff: ModelDiff | null;
    note: string;
    createdBy: string | null;
    createdAt: string;
}

export interface RuleRecord extends Rule {
    id: string;
    projectId: string;
    modelVersionId: string | null;
    status: RuleStatus;
    decidedBy: string | null;
    decidedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

type VersionRow = { id: string; project_id: string; application_id: string | null; version: number; model_json: string; diff_json: string | null; note: string; created_by: string | null; created_at: string };
type RuleRow = {
    id: string;
    project_id: string;
    model_version_id: string | null;
    ref: string;
    kind: string;
    description: string;
    expected: string;
    source_type: string;
    source_ref: string;
    evidence_json: string;
    explicitness: string;
    confidence: number;
    links_json: string;
    status: string;
    decided_by: string | null;
    decided_at: string | null;
    created_at: string;
    updated_at: string;
};

const toVersion = (r: VersionRow): ModelVersionRecord => ({
    id: r.id,
    projectId: r.project_id,
    applicationId: r.application_id,
    version: Number(r.version),
    model: AppModelSchema.parse(JSON.parse(r.model_json)),
    diff: r.diff_json ? (JSON.parse(r.diff_json) as ModelDiff) : null,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
});

const toRule = (r: RuleRow): RuleRecord => {
    const links = JSON.parse(r.links_json || "{}") as { entities?: string[]; workflows?: string[]; endpoints?: string[] };
    return {
        id: r.id,
        projectId: r.project_id,
        modelVersionId: r.model_version_id,
        ref: r.ref,
        kind: r.kind as Rule["kind"],
        description: r.description,
        expected: r.expected,
        sourceType: r.source_type as Rule["sourceType"],
        sourceRef: r.source_ref,
        evidence: JSON.parse(r.evidence_json || "[]") as Rule["evidence"],
        explicitness: r.explicitness as Rule["explicitness"],
        confidence: Number(r.confidence),
        entities: links.entities ?? [],
        workflows: links.workflows ?? [],
        endpoints: links.endpoints ?? [],
        status: r.status as RuleStatus,
        decidedBy: r.decided_by,
        decidedAt: r.decided_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
};

export class AppIntelStore {
    constructor(
        private readonly sql: Sql,
        private readonly now: () => string = () => new Date().toISOString(),
    ) {}

    /** Records a new analysis as the next version, with what changed since the one before. The model is validated first. */
    async addVersion(input: { projectId: string; applicationId?: string | null; model: unknown; note?: string; createdBy?: string | null }): Promise<ModelVersionRecord> {
        const model = AppModelSchema.parse(input.model);
        const json = JSON.stringify(model);
        if (json.length > MAX_MODEL_BYTES) throw new Error(`An application model is at most ${MAX_MODEL_BYTES} bytes.`);
        return this.sql.tx(async (t) => {
            const before = await t.get<VersionRow>("SELECT * FROM app_model_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1", input.projectId);
            const version = before ? Number(before.version) + 1 : 1;
            const diff = before ? diffModels(AppModelSchema.parse(JSON.parse(before.model_json)), model) : null;
            const id = randomUUID();
            await t.run(
                "INSERT INTO app_model_versions (id, project_id, application_id, version, app_type, context_sources_json, model_json, diff_json, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                id,
                input.projectId,
                input.applicationId ?? null,
                version,
                model.appType,
                JSON.stringify(model.contextSources),
                json,
                diff ? JSON.stringify(diff) : null,
                (input.note ?? "").slice(0, 500),
                input.createdBy ?? null,
                this.now(),
            );
            return toVersion((await t.get<VersionRow>("SELECT * FROM app_model_versions WHERE id = ?", id))!);
        });
    }

    async latest(projectId: string): Promise<ModelVersionRecord | undefined> {
        const r = await this.sql.get<VersionRow>("SELECT * FROM app_model_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1", projectId);
        return r ? toVersion(r) : undefined;
    }

    async version(projectId: string, version: number): Promise<ModelVersionRecord | undefined> {
        const r = await this.sql.get<VersionRow>("SELECT * FROM app_model_versions WHERE project_id = ? AND version = ?", projectId, version);
        return r ? toVersion(r) : undefined;
    }

    /** The versions of a project, newest first, without their models (the list a page shows). */
    async versions(projectId: string): Promise<Array<{ id: string; version: number; note: string; createdAt: string; diff: ModelDiff | null }>> {
        const rows = await this.sql.all<VersionRow>("SELECT id, version, note, created_at, diff_json FROM app_model_versions WHERE project_id = ? ORDER BY version DESC", projectId);
        return rows.map((r) => ({ id: r.id, version: Number(r.version), note: r.note, createdAt: r.created_at, diff: r.diff_json ? (JSON.parse(r.diff_json) as ModelDiff) : null }));
    }

    /**
     * Adds a rule, always unverified, whatever the caller says: `decide` is the only way to confirm one. A rule whose ref exists is updated
     * in its text, source and evidence, and goes back to unverified when what it expects changed (a person confirmed the old wording, not this).
     */
    async addRule(projectId: string, input: unknown, o: { modelVersionId?: string | null } = {}): Promise<RuleRecord> {
        const rule = RuleSchema.parse(input);
        return this.sql.tx(async (t) => {
            const existing = await t.get<RuleRow>("SELECT * FROM app_rules WHERE project_id = ? AND ref = ?", projectId, rule.ref);
            const at = this.now();
            const links = JSON.stringify({ entities: rule.entities, workflows: rule.workflows, endpoints: rule.endpoints });
            if (existing) {
                const changed = existing.expected !== rule.expected || existing.description !== rule.description;
                await t.run(
                    "UPDATE app_rules SET model_version_id = COALESCE(?, model_version_id), kind = ?, description = ?, expected = ?, source_type = ?, source_ref = ?, evidence_json = ?, explicitness = ?, confidence = ?, links_json = ?, status = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?",
                    o.modelVersionId ?? null,
                    rule.kind,
                    rule.description,
                    rule.expected,
                    rule.sourceType,
                    rule.sourceRef,
                    JSON.stringify(rule.evidence),
                    rule.explicitness,
                    rule.confidence,
                    links,
                    changed ? "unverified" : existing.status,
                    changed ? null : existing.decided_by,
                    changed ? null : existing.decided_at,
                    at,
                    existing.id,
                );
                return toRule((await t.get<RuleRow>("SELECT * FROM app_rules WHERE id = ?", existing.id))!);
            }
            const n = Number((await t.get<{ n: number }>("SELECT COUNT(*) AS n FROM app_rules WHERE project_id = ?", projectId))?.n ?? 0);
            if (n >= MAX_RULES_PER_PROJECT) throw new Error(`A project can have at most ${MAX_RULES_PER_PROJECT} rules.`);
            const id = randomUUID();
            await t.run(
                "INSERT INTO app_rules (id, project_id, model_version_id, ref, kind, description, expected, source_type, source_ref, evidence_json, explicitness, confidence, links_json, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                id,
                projectId,
                o.modelVersionId ?? null,
                rule.ref,
                rule.kind,
                rule.description,
                rule.expected,
                rule.sourceType,
                rule.sourceRef,
                JSON.stringify(rule.evidence),
                rule.explicitness,
                rule.confidence,
                links,
                "unverified",
                at,
                at,
            );
            return toRule((await t.get<RuleRow>("SELECT * FROM app_rules WHERE id = ?", id))!);
        });
    }

    async rules(projectId: string, filter: { status?: RuleStatus; explicitness?: "explicit" | "inferred" } = {}): Promise<RuleRecord[]> {
        const where = ["project_id = ?"];
        const params: string[] = [projectId];
        if (filter.status) (where.push("status = ?"), params.push(filter.status));
        if (filter.explicitness) (where.push("explicitness = ?"), params.push(filter.explicitness));
        return (await this.sql.all<RuleRow>(`SELECT * FROM app_rules WHERE ${where.join(" AND ")} ORDER BY ref`, ...params)).map(toRule);
    }

    async rule(projectId: string, id: string): Promise<RuleRecord | undefined> {
        const r = await this.sql.get<RuleRow>("SELECT * FROM app_rules WHERE project_id = ? AND id = ?", projectId, id);
        return r ? toRule(r) : undefined;
    }

    /** A person confirms or rejects a rule (or puts it back to unverified). The only way a rule's status changes to confirmed. */
    async decide(projectId: string, id: string, status: RuleStatus, personId: string): Promise<RuleRecord | undefined> {
        if (!personId) throw new Error("Only a person can confirm or reject a rule.");
        const at = this.now();
        const decided = status === "unverified" ? [null, null] : [personId, at];
        const r = await this.sql.run("UPDATE app_rules SET status = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE project_id = ? AND id = ?", status, decided[0], decided[1], at, projectId, id);
        return r.changes ? this.rule(projectId, id) : undefined;
    }
}
