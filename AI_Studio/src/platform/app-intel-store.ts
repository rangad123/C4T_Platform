/**
 * Application intelligence (testing-engine Phase 1, migration slot 62): versioned application models and the business rules found in them.
 *
 * A model version is one analysis: its pages, workflows, entities, relationships and scenarios as JSON (the shape is engine/intel/model.ts),
 * numbered per project, never changed afterwards. Rules are rows of their own, because people confirm or reject them and later work asks for
 * them by status and source. A rule is always added "unverified"; only `decide`, called for a person, makes it confirmed or rejected, so a
 * guess never becomes a verified rule by itself. Nothing in test generation reads this yet.
 */
import { randomUUID } from "node:crypto";
import { AppModelSchema, AppVersionSchema, diffModels, RuleSchema, ruleFingerprint, workflowFingerprint, SourceRecordSchema, type AppModel, type AppVersion, type ModelDiff, type Rule, type RuleStatus, type SourceKind, type SourceStatus } from "../engine/intel/model.js";
import type { CarriedRule } from "../engine/intel/carry-forward.js";
import { HttpError } from "./http-error.js";
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

/**
 * Slot 64: where knowledge came from and which build it describes. One row per connected source (kind and reference unique in a project)
 * with its fingerprint, status, when it was processed, why it failed and the version it went into; each model version records the
 * application version and the source fingerprints it was built from; each rule its fingerprint (kind, expected, links), so a decision can
 * follow the same rule into a later analysis. Additive only: rules stored before have no fingerprint and get one worked out when read.
 */
export const APP_INTEL_V2_MIGRATION = `
CREATE TABLE app_sources (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                   -- engine/intel/model.ts SOURCE_KINDS
    ref TEXT NOT NULL,
    fingerprint TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,                 -- connected processed failed
    processed_at TEXT,
    error TEXT,
    model_version_id TEXT REFERENCES app_model_versions(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX idx_app_sources_ref ON app_sources(project_id, kind, ref);
ALTER TABLE app_model_versions ADD COLUMN app_version_json TEXT;
ALTER TABLE app_model_versions ADD COLUMN source_fingerprints_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE app_rules ADD COLUMN fingerprint TEXT;
CREATE INDEX idx_app_rules_fingerprint ON app_rules(project_id, fingerprint);
`;

/**
 * Slot 65: what people decided about workflows. One row per project and workflow fingerprint (its steps), so a decision follows the same
 * workflow into later analyses; the name and steps the person decided about are kept with it.
 */
export const APP_WORKFLOW_DECISIONS_MIGRATION = `
CREATE TABLE app_workflow_decisions (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,            -- engine/intel/model.ts workflowFingerprint
    status TEXT NOT NULL,                 -- confirmed rejected
    decided_name TEXT NOT NULL,
    decided_steps_json TEXT NOT NULL DEFAULT '[]',
    decided_by TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    PRIMARY KEY (project_id, fingerprint)
);
`;

export const WORKFLOW_CHANGED = "This workflow changed since you read it. Read it again, then confirm or reject it.";

type Workflow = AppModel["workflows"][number];
/** A person's decision about a workflow, as the API shows it. */
export interface WorkflowDecision {
    status: "confirmed" | "rejected";
    decidedBy: string;
    decidedAt: string;
}
/**
 * A workflow with its fingerprint and what a person decided about it. A decided workflow keeps the name the person decided about; a later
 * analysis's other name for the same steps is shown as `rewordedName`.
 */
export type DecidedWorkflow = Workflow & { fingerprint: string; decision: WorkflowDecision | null; rewordedName?: string };
type WorkflowDecisionRow = { project_id: string; fingerprint: string; status: string; decided_name: string; decided_steps_json: string; decided_by: string; decided_at: string };

/** The workflows of a model with the decisions people made about them (matched by fingerprint, so they follow across analyses). */
export function withWorkflowDecisions(workflows: readonly Workflow[], decisions: ReadonlyMap<string, WorkflowDecisionRow>): DecidedWorkflow[] {
    return workflows.map((w) => {
        const fingerprint = workflowFingerprint(w);
        const d = decisions.get(fingerprint);
        if (!d) return { ...w, fingerprint, decision: null };
        const decision: WorkflowDecision = { status: d.status as WorkflowDecision["status"], decidedBy: d.decided_by, decidedAt: d.decided_at };
        return { ...w, name: d.decided_name, fingerprint, decision, ...(d.decided_name !== w.name ? { rewordedName: w.name } : {}) };
    });
}

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
    /** Which build the model describes; "unversioned" (with the analysis time) when nobody said. */
    appVersion: AppVersion;
    /** "kind:ref" → fingerprint of each source the version was built from. */
    sourceFingerprints: Record<string, string>;
}

export interface SourceRow {
    id: string;
    projectId: string;
    kind: SourceKind;
    ref: string;
    fingerprint: string;
    status: SourceStatus;
    processedAt: string | null;
    error: string | null;
    modelVersionId: string | null;
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
    /** Matches the same rule across analyses (engine/intel/model.ts ruleFingerprint). */
    fingerprint: string;
    /** Set when a later analysis no longer found the rule's evidence: for a person to look at; the rule and its decision stay. */
    evidenceGone?: { version: number; at: string };
    /**
     * A later analysis worded the same rule (same fingerprint) differently after a person confirmed or rejected it. The rule keeps the
     * wording the person decided about (that is what reaches prompts); the new wording is shown here until they decide again or undo.
     */
    rewordedDescription?: string;
    rewordedExpected?: string;
}

type VersionRow = {
    id: string;
    project_id: string;
    application_id: string | null;
    version: number;
    model_json: string;
    diff_json: string | null;
    note: string;
    created_by: string | null;
    created_at: string;
    app_version_json: string | null;
    source_fingerprints_json: string | null;
};
type SourceDbRow = { id: string; project_id: string; kind: string; ref: string; fingerprint: string; status: string; processed_at: string | null; error: string | null; model_version_id: string | null };
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
    fingerprint: string | null;
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
    appVersion: r.app_version_json ? (JSON.parse(r.app_version_json) as AppVersion) : { source: "unversioned", label: "", analysedAt: r.created_at },
    sourceFingerprints: JSON.parse(r.source_fingerprints_json || "{}") as Record<string, string>,
});

const toSource = (r: SourceDbRow): SourceRow => ({
    id: r.id,
    projectId: r.project_id,
    kind: r.kind as SourceKind,
    ref: r.ref,
    fingerprint: r.fingerprint,
    status: r.status as SourceStatus,
    processedAt: r.processed_at,
    error: r.error,
    modelVersionId: r.model_version_id,
});

type Links = { entities?: string[]; workflows?: string[]; endpoints?: string[]; evidenceGone?: { version: number; at: string }; reworded?: { description: string; expected: string } };

/**
 * The wording a rule is stored with. A decided rule keeps the text the person decided about when an analysis finds the same rule (same
 * fingerprint) worded differently; the new wording is kept beside it as "reworded". Anything else takes the new wording.
 */
function wordingOf(stored: { status: string; description: string; expected: string; fingerprint: string } | undefined, rule: { description: string; expected: string }, fingerprint: string): { description: string; expected: string; reworded?: { description: string; expected: string } } {
    if (!stored || stored.status === "unverified" || stored.fingerprint !== fingerprint) return { description: rule.description, expected: rule.expected };
    const same = stored.description === rule.description && stored.expected === rule.expected;
    return { description: stored.description, expected: stored.expected, ...(same ? {} : { reworded: { description: rule.description, expected: rule.expected } }) };
}

const toRule = (r: RuleRow): RuleRecord => {
    const links = JSON.parse(r.links_json || "{}") as Links;
    const linked = { kind: r.kind as Rule["kind"], expected: r.expected, entities: links.entities ?? [], workflows: links.workflows ?? [], endpoints: links.endpoints ?? [] };
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
        // Rules stored before fingerprints existed have none in their row.
        fingerprint: r.fingerprint ?? ruleFingerprint(linked),
        ...(links.evidenceGone ? { evidenceGone: links.evidenceGone } : {}),
        ...(links.reworded && links.reworded.description !== r.description ? { rewordedDescription: links.reworded.description } : {}),
        ...(links.reworded && links.reworded.expected !== r.expected ? { rewordedExpected: links.reworded.expected } : {}),
    };
};

export class AppIntelStore {
    constructor(
        private readonly sql: Sql,
        private readonly now: () => string = () => new Date().toISOString(),
    ) {}

    /** Records a new analysis as the next version, with what changed since the one before. The model is validated first. */
    async addVersion(input: {
        projectId: string;
        applicationId?: string | null;
        model: unknown;
        note?: string;
        createdBy?: string | null;
        /** Which build the model describes; never inferred: absent means unversioned at this time. */
        appVersion?: AppVersion;
        sourceFingerprints?: Record<string, string>;
        /** A transaction to run in (the analysis stores a version and its rules together); else one of its own. */
        tx?: Sql;
    }): Promise<ModelVersionRecord> {
        const model = AppModelSchema.parse(input.model);
        const appVersion = AppVersionSchema.parse(input.appVersion ?? model.appVersion ?? { source: "unversioned", label: "", analysedAt: this.now() });
        const fingerprints = Object.fromEntries(Object.entries(input.sourceFingerprints ?? {}).map(([k, v]) => [String(k).slice(0, 600), String(v).slice(0, 100)]));
        const json = JSON.stringify(model);
        if (json.length > MAX_MODEL_BYTES) throw new Error(`An application model is at most ${MAX_MODEL_BYTES} bytes.`);
        return this.inTx(input.tx, async (t) => {
            const before = await t.get<VersionRow>("SELECT * FROM app_model_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1", input.projectId);
            const version = before ? Number(before.version) + 1 : 1;
            const diff = before ? diffModels(AppModelSchema.parse(JSON.parse(before.model_json)), model) : null;
            const id = randomUUID();
            await t.run(
                "INSERT INTO app_model_versions (id, project_id, application_id, version, app_type, context_sources_json, model_json, diff_json, note, created_by, created_at, app_version_json, source_fingerprints_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
                JSON.stringify(appVersion),
                JSON.stringify(fingerprints),
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
    async versions(projectId: string): Promise<Array<{ id: string; version: number; note: string; createdAt: string; diff: ModelDiff | null; appVersion: AppVersion }>> {
        const rows = await this.sql.all<VersionRow>("SELECT id, version, note, created_at, diff_json, app_version_json FROM app_model_versions WHERE project_id = ? ORDER BY version DESC", projectId);
        return rows.map((r) => ({
            id: r.id,
            version: Number(r.version),
            note: r.note,
            createdAt: r.created_at,
            diff: r.diff_json ? (JSON.parse(r.diff_json) as ModelDiff) : null,
            appVersion: r.app_version_json ? (JSON.parse(r.app_version_json) as AppVersion) : { source: "unversioned", label: "", analysedAt: r.created_at },
        }));
    }

    /** The project's workflow decisions by fingerprint. */
    async workflowDecisions(projectId: string): Promise<Map<string, WorkflowDecisionRow>> {
        return new Map((await this.sql.all<WorkflowDecisionRow>("SELECT * FROM app_workflow_decisions WHERE project_id = ?", projectId)).map((r) => [r.fingerprint, r]));
    }

    /** The latest model's workflows with the decisions people made about them. */
    async decidedWorkflows(projectId: string): Promise<{ modelVersionId: string; workflows: DecidedWorkflow[] } | undefined> {
        const latest = await this.latest(projectId);
        return latest ? { modelVersionId: latest.id, workflows: withWorkflowDecisions(latest.model.workflows, await this.workflowDecisions(projectId)) } : undefined;
    }

    /**
     * A person confirms or rejects a workflow of the latest analysis (or undoes the decision). `fingerprint` names the steps they read: when
     * the workflow's steps are other ones now, nothing changes (409). Undefined when the latest analysis has no workflow with that id.
     */
    async decideWorkflow(projectId: string, workflowId: string, status: "confirmed" | "rejected" | "unverified", personId: string, fingerprint: string): Promise<DecidedWorkflow | undefined> {
        if (!personId) throw new Error("Only a person can confirm or reject a workflow.");
        return this.sql.tx(async (t) => {
            const latest = await t.get<VersionRow>("SELECT * FROM app_model_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1", projectId);
            const w = latest ? AppModelSchema.parse(JSON.parse(latest.model_json)).workflows.find((x) => x.id === workflowId) : undefined;
            if (!w) return undefined;
            const fp = workflowFingerprint(w);
            if (fp !== fingerprint) throw new HttpError(409, WORKFLOW_CHANGED);
            if (status === "unverified") await t.run("DELETE FROM app_workflow_decisions WHERE project_id = ? AND fingerprint = ?", projectId, fp);
            else
                await t.run(
                    "INSERT INTO app_workflow_decisions (project_id, fingerprint, status, decided_name, decided_steps_json, decided_by, decided_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT (project_id, fingerprint) DO UPDATE SET status = excluded.status, decided_name = excluded.decided_name, decided_steps_json = excluded.decided_steps_json, decided_by = excluded.decided_by, decided_at = excluded.decided_at",
                    projectId,
                    fp,
                    status,
                    w.name,
                    JSON.stringify(w.steps),
                    personId,
                    this.now(),
                );
            const rows = await t.all<WorkflowDecisionRow>("SELECT * FROM app_workflow_decisions WHERE project_id = ? AND fingerprint = ?", projectId, fp);
            return withWorkflowDecisions([w], new Map(rows.map((r) => [r.fingerprint, r])))[0];
        });
    }

    /** A person names the build the latest analysis describes. Undefined when the project has no analysis yet. */
    async labelLatest(projectId: string, label: string): Promise<ModelVersionRecord | undefined> {
        const latest = await this.latest(projectId);
        if (!latest) return undefined;
        const appVersion = AppVersionSchema.parse({ source: "person", label, analysedAt: latest.appVersion.analysedAt });
        await this.sql.run("UPDATE app_model_versions SET app_version_json = ? WHERE project_id = ? AND id = ?", JSON.stringify(appVersion), projectId, latest.id);
        return this.latest(projectId);
    }

    private inTx<T>(tx: Sql | undefined, fn: (t: Sql) => Promise<T>): Promise<T> {
        return tx ? fn(tx) : this.sql.tx(fn);
    }

    /** A model version id is usable in a project only when it is one of that project's versions. */
    private async ownVersion(t: Sql, projectId: string, id: string | null | undefined): Promise<string | null> {
        if (!id) return null;
        if (!(await t.get("SELECT id FROM app_model_versions WHERE project_id = ? AND id = ?", projectId, id))) throw new HttpError(404, "Application model not found");
        return id;
    }

    /**
     * Connects a source, or updates the one with the same kind and reference: its fingerprint, status, the sentence saying why it failed
     * (only for a failed one) and the version it went into. A processed or failed source records when.
     */
    async upsertSource(projectId: string, input: { kind: SourceKind; ref: string; status: SourceStatus; fingerprint?: string; error?: string; modelVersionId?: string | null }): Promise<SourceRow> {
        const { modelVersionId, ...record } = input;
        const s = SourceRecordSchema.parse(record);
        return this.sql.tx(async (t) => {
            const versionId = await this.ownVersion(t, projectId, modelVersionId);
            const existing = await t.get<SourceDbRow>("SELECT * FROM app_sources WHERE project_id = ? AND kind = ? AND ref = ?", projectId, s.kind, s.ref);
            const processedAt = s.status === "connected" ? (existing?.processed_at ?? null) : this.now();
            // A failed source keeps the fingerprint of what was last processed: nothing new was read.
            const fingerprint = s.fingerprint || existing?.fingerprint || "";
            if (existing) {
                await t.run(
                    "UPDATE app_sources SET fingerprint = ?, status = ?, processed_at = ?, error = ?, model_version_id = COALESCE(?, model_version_id) WHERE id = ?",
                    fingerprint,
                    s.status,
                    processedAt,
                    s.error ?? null,
                    versionId,
                    existing.id,
                );
                return toSource((await t.get<SourceDbRow>("SELECT * FROM app_sources WHERE id = ?", existing.id))!);
            }
            const id = randomUUID();
            await t.run("INSERT INTO app_sources (id, project_id, kind, ref, fingerprint, status, processed_at, error, model_version_id) VALUES (?,?,?,?,?,?,?,?,?)", id, projectId, s.kind, s.ref, fingerprint, s.status, processedAt, s.error ?? null, versionId);
            return toSource((await t.get<SourceDbRow>("SELECT * FROM app_sources WHERE id = ?", id))!);
        });
    }

    /** Removes a source row of this project; what is kept for it in the object store is the caller's to remove (app-analysis.ts). */
    async deleteSource(projectId: string, id: string): Promise<boolean> {
        return (await this.sql.run("DELETE FROM app_sources WHERE project_id = ? AND id = ?", projectId, id)).changes > 0;
    }

    async source(projectId: string, id: string): Promise<SourceRow | undefined> {
        const r = await this.sql.get<SourceDbRow>("SELECT * FROM app_sources WHERE project_id = ? AND id = ?", projectId, id);
        return r ? toSource(r) : undefined;
    }

    async sources(projectId: string): Promise<SourceRow[]> {
        return (await this.sql.all<SourceDbRow>("SELECT * FROM app_sources WHERE project_id = ? ORDER BY kind, ref", projectId)).map(toSource);
    }

    /**
     * Adds a rule, always unverified, whatever the caller says: `decide` is the only way to confirm one. A rule whose ref exists is updated
     * in its text, source and evidence, and goes back to unverified when its fingerprint changed (what it expects, its kind or its links): a
     * person decided about that rule, not this one. A reworded description alone keeps the decision.
     */
    async addRule(projectId: string, input: unknown, o: { modelVersionId?: string | null } = {}): Promise<RuleRecord> {
        const rule = RuleSchema.parse(input);
        const fingerprint = ruleFingerprint(rule);
        return this.sql.tx(async (t) => {
            const versionId = await this.ownVersion(t, projectId, o.modelVersionId);
            const existing = await t.get<RuleRow>("SELECT * FROM app_rules WHERE project_id = ? AND ref = ?", projectId, rule.ref);
            const at = this.now();
            const links = JSON.stringify({ entities: rule.entities, workflows: rule.workflows, endpoints: rule.endpoints });
            if (existing) {
                const before = toRule(existing);
                const changed = before.fingerprint !== fingerprint;
                const w = wordingOf(before, rule, fingerprint);
                await t.run(
                    "UPDATE app_rules SET model_version_id = COALESCE(?, model_version_id), kind = ?, description = ?, expected = ?, source_type = ?, source_ref = ?, evidence_json = ?, explicitness = ?, confidence = ?, links_json = ?, status = ?, decided_by = ?, decided_at = ?, updated_at = ?, fingerprint = ? WHERE id = ?",
                    versionId,
                    rule.kind,
                    w.description,
                    w.expected,
                    rule.sourceType,
                    rule.sourceRef,
                    JSON.stringify(rule.evidence),
                    rule.explicitness,
                    rule.confidence,
                    w.reworded ? JSON.stringify({ ...(JSON.parse(links) as object), reworded: w.reworded }) : links,
                    changed ? "unverified" : existing.status,
                    changed ? null : existing.decided_by,
                    changed ? null : existing.decided_at,
                    at,
                    fingerprint,
                    existing.id,
                );
                return toRule((await t.get<RuleRow>("SELECT * FROM app_rules WHERE id = ?", existing.id))!);
            }
            const n = Number((await t.get<{ n: number }>("SELECT COUNT(*) AS n FROM app_rules WHERE project_id = ?", projectId))?.n ?? 0);
            if (n >= MAX_RULES_PER_PROJECT) throw new Error(`A project can have at most ${MAX_RULES_PER_PROJECT} rules.`);
            const id = randomUUID();
            await t.run(
                "INSERT INTO app_rules (id, project_id, model_version_id, ref, kind, description, expected, source_type, source_ref, evidence_json, explicitness, confidence, links_json, status, created_at, updated_at, fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                id,
                projectId,
                versionId,
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
                fingerprint,
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

    /** The project's rules by fingerprint (several rules can share one: every one is listed), to carry decisions into a new analysis. */
    async rulesByFingerprint(projectId: string): Promise<Map<string, RuleRecord[]>> {
        const out = new Map<string, RuleRecord[]>();
        for (const r of await this.rules(projectId)) out.set(r.fingerprint, [...(out.get(r.fingerprint) ?? []), r]);
        return out;
    }

    /**
     * Saves the rules of an analysis after decisions were carried forward (engine/intel/carry-forward.ts), in one transaction. A rule with an
     * `id` updates that stored rule's text, source, evidence and "evidence gone" mark and keeps its status and decision; so does a rule whose
     * fingerprint a stored rule already has. Any other rule is new and stored unverified, whatever status it carries, under its ref or, when
     * that ref is taken by a different rule, a longer one. Rules over the project's cap are counted in `leftOut`, never dropped silently.
     */
    async saveCarried(projectId: string, carried: readonly CarriedRule[], o: { modelVersionId?: string | null; tx?: Sql } = {}): Promise<{ saved: number; leftOut: number }> {
        return this.inTx(o.tx, async (t) => {
            const versionId = await this.ownVersion(t, projectId, o.modelVersionId);
            const rows = (await t.all<RuleRow>("SELECT * FROM app_rules WHERE project_id = ?", projectId)).map(toRule);
            const byId = new Map(rows.map((r) => [r.id, r]));
            const byFp = new Map<string, RuleRecord>();
            for (const r of rows) if (!byFp.has(r.fingerprint)) byFp.set(r.fingerprint, r);
            const refs = new Set(rows.map((r) => r.ref));
            let count = rows.length;
            let saved = 0;
            let leftOut = 0;
            const at = this.now();
            for (const c of carried) {
                const rule = RuleSchema.parse({ ref: c.ref, kind: c.kind, description: c.description, expected: c.expected, sourceType: c.sourceType, sourceRef: c.sourceRef, evidence: c.evidence, explicitness: c.explicitness, confidence: c.confidence, entities: c.entities, workflows: c.workflows, endpoints: c.endpoints });
                const fingerprint = ruleFingerprint(rule);
                const stored = (c.id ? byId.get(c.id) : undefined) ?? byFp.get(fingerprint);
                const w = wordingOf(stored, rule, fingerprint);
                const links = JSON.stringify({ entities: rule.entities, workflows: rule.workflows, endpoints: rule.endpoints, ...(c.evidenceGone ? { evidenceGone: c.evidenceGone } : {}), ...(w.reworded ? { reworded: w.reworded } : {}) });
                if (stored) {
                    // The decision belongs to the stored rule's fingerprint: if this one differs, the person has not decided about it.
                    const same = stored.fingerprint === fingerprint;
                    await t.run(
                        "UPDATE app_rules SET model_version_id = COALESCE(?, model_version_id), kind = ?, description = ?, expected = ?, source_type = ?, source_ref = ?, evidence_json = ?, explicitness = ?, confidence = ?, links_json = ?, fingerprint = ?, status = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE project_id = ? AND id = ?",
                        versionId,
                        rule.kind,
                        w.description,
                        w.expected,
                        rule.sourceType,
                        rule.sourceRef,
                        JSON.stringify(rule.evidence),
                        rule.explicitness,
                        rule.confidence,
                        links,
                        fingerprint,
                        same ? stored.status : "unverified",
                        same ? stored.decidedBy : null,
                        same ? stored.decidedAt : null,
                        at,
                        projectId,
                        stored.id,
                    );
                    saved++;
                    continue;
                }
                if (count >= MAX_RULES_PER_PROJECT) {
                    leftOut++;
                    continue;
                }
                let ref = rule.ref;
                for (let n = 16; refs.has(ref); n += 8) ref = n >= 64 ? `R-${fingerprint}` : `R-${fingerprint.slice(0, n)}`;
                if (refs.has(ref)) ref = `R-${randomUUID()}`;
                refs.add(ref);
                const id = randomUUID();
                await t.run(
                    "INSERT INTO app_rules (id, project_id, model_version_id, ref, kind, description, expected, source_type, source_ref, evidence_json, explicitness, confidence, links_json, status, created_at, updated_at, fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    id,
                    projectId,
                    versionId,
                    ref,
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
                    fingerprint,
                );
                byFp.set(fingerprint, { ...rule, id, projectId, modelVersionId: versionId, fingerprint, status: "unverified", decidedBy: null, decidedAt: null, createdAt: at, updatedAt: at });
                count++;
                saved++;
            }
            return { saved, leftOut };
        });
    }

    /**
     * A later analysis (`version`) no longer found the rule's evidence. The rule is kept with its status and decision and marked for a person
     * to look at; adding it again (found again) clears the mark.
     */
    async markEvidenceGone(projectId: string, id: string, version: number): Promise<RuleRecord | undefined> {
        return this.sql.tx(async (t) => {
            const r = await t.get<RuleRow>("SELECT * FROM app_rules WHERE project_id = ? AND id = ?", projectId, id);
            if (!r) return undefined;
            const at = this.now();
            const links = { ...(JSON.parse(r.links_json || "{}") as object), evidenceGone: { version, at } };
            await t.run("UPDATE app_rules SET links_json = ?, updated_at = ? WHERE project_id = ? AND id = ?", JSON.stringify(links), at, projectId, id);
            return toRule((await t.get<RuleRow>("SELECT * FROM app_rules WHERE id = ?", id))!);
        });
    }

    /**
     * A person confirms or rejects a rule (or puts it back to unverified). The only way a rule's status changes to confirmed. `fingerprint`
     * names the version of the rule the person read: when the rule's fingerprint is another one now, nothing changes (409).
     */
    async decide(projectId: string, id: string, status: RuleStatus, personId: string, fingerprint?: string): Promise<RuleRecord | undefined> {
        if (!personId) throw new Error("Only a person can confirm or reject a rule.");
        return this.sql.tx(async (t) => {
            const row = await t.get<RuleRow>("SELECT * FROM app_rules WHERE project_id = ? AND id = ?", projectId, id);
            if (!row) return undefined;
            if (fingerprint && toRule(row).fingerprint !== fingerprint) throw new HttpError(409, "This rule changed since you read it. Read it again, then confirm or reject it.");
            const at = this.now();
            const decided = status === "unverified" ? [null, null] : [personId, at];
            // Undone: no decision holds the old wording any more, so the newest wording becomes the rule's.
            const { reworded, ...links } = JSON.parse(row.links_json || "{}") as Links;
            const text = status === "unverified" && reworded ? reworded : { description: row.description, expected: row.expected };
            await t.run(
                "UPDATE app_rules SET status = ?, decided_by = ?, decided_at = ?, description = ?, expected = ?, links_json = ?, updated_at = ? WHERE project_id = ? AND id = ?",
                status,
                decided[0],
                decided[1],
                text.description,
                text.expected,
                JSON.stringify(status === "unverified" || !reworded ? links : { ...links, reworded }),
                at,
                projectId,
                id,
            );
            return toRule((await t.get<RuleRow>("SELECT * FROM app_rules WHERE id = ?", id))!);
        });
    }
}
