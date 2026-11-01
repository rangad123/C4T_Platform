/**
 * Requirements as records (migration slot 38): what the application must do, and which test cases check it.
 *
 * A requirement belongs to one project and has a reference people use (REQ-12), unique in the project whatever its case. Test
 * cases cover requirements through `requirement_links`, many to many: an automated test (`test_cases`) or a manual case. Every
 * lookup is by project and id together, so one project never reads or changes another's.
 *
 * Coverage is computed, never stored: a requirement with no linked test is not covered; one whose linked tests all passed at their
 * latest result is passing; one with any linked test failing at its latest result is failing; otherwise (linked, but some not run
 * yet) it is covered. An automated test's latest result is its current state (passing once validated, failing when it failed or
 * found a problem); a manual case's is its most recent result in a release.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseRequirements, parseRequirementsDeterministic, type Requirement as ParsedRequirement } from "../engine/requirements/parse.js";
import type { EngineContext } from "../engine/context.js";
import { currentActor } from "./auth/actor.js";
import type { Db, Row } from "./db.js";
import type { Sql } from "./sql.js";

export const REQUIREMENT_STATUSES = ["draft", "active", "retired"] as const;
export const REQUIREMENT_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export const REQUIREMENT_SOURCES = ["typed", "imported", "ai"] as const;
export const COVERAGE_STATES = ["not_covered", "covered", "passing", "failing"] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];
export type RequirementPriority = (typeof REQUIREMENT_PRIORITIES)[number];
export type RequirementSource = (typeof REQUIREMENT_SOURCES)[number];
export type Coverage = (typeof COVERAGE_STATES)[number];
export type TestResult = "passed" | "failed" | "not_run";

export const MAX_REQUIREMENTS = 2000;
export const MAX_REF = 40;
export const MAX_TITLE = 200;
export const MAX_TEXT = 4000;
/** Tests linked in one request. */
export const MAX_LINK_BATCH = 200;
/** A reference: letters, digits and . _ # - (the parser's ids, like FR-2.1 or REQ-3#2, fit). */
export const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._#-]*$/;

export interface RequirementInput {
    ref?: string;
    title: string;
    description?: string;
    acceptanceCriteria?: string;
    priority?: RequirementPriority;
    status?: RequirementStatus;
}

export interface RequirementRecord {
    id: string;
    projectId: string;
    ref: string;
    title: string;
    description: string;
    acceptanceCriteria: string;
    priority: RequirementPriority;
    status: RequirementStatus;
    source: RequirementSource;
    createdAt: string;
    updatedAt: string;
    createdBy: string;
    updatedBy: string;
}

export interface CoverageCounts {
    linked: number;
    passed: number;
    failed: number;
    notRun: number;
}

export interface RequirementSummary extends RequirementRecord {
    coverage: Coverage;
    tests: CoverageCounts;
}

export interface LinkedTest {
    kind: "automated" | "manual";
    id: string;
    /** The automated test's key (WEB-001); empty for a manual case. */
    key: string;
    title: string;
    result: TestResult;
    /** When that result was recorded, when known. */
    resultAt: string | null;
    /** The automated test's own state word (VALIDATED, NEEDS_REVIEW...), or the manual result word (passed, blocked...). */
    detail: string | null;
    origin: "person" | "generated";
    linkedAt: string;
}

export interface CoverageSummary {
    /** Requirements that are not retired: the ones coverage is about. */
    total: number;
    notCovered: number;
    covered: number;
    passing: number;
    failing: number;
    retired: number;
}

/** A refusal the routes turn into a plain 4xx. */
export class RequirementError extends Error {
    constructor(
        readonly code: "duplicate" | "limit" | "not-found",
        message: string,
    ) {
        super(message);
        this.name = "RequirementError";
    }
}

// ── the rules ──────────────────────────────────────────────────────────────────

/** An automated test's latest result, from its current state. */
export function automatedResult(validationStatus: string | null | undefined): TestResult {
    if (validationStatus === "VALIDATED") return "passed";
    if (validationStatus === "FAILED_VALIDATION" || validationStatus === "NEEDS_REVIEW") return "failed";
    return "not_run";
}

/** A manual case's latest result in a release (skipped and not run say nothing about the requirement). */
export function manualResult(result: string | null | undefined): TestResult {
    if (result === "passed") return "passed";
    if (result === "failed" || result === "blocked") return "failed";
    return "not_run";
}

/** The coverage of a requirement from the latest results of its linked tests. */
export function coverageOf(results: readonly TestResult[]): Coverage {
    if (results.length === 0) return "not_covered";
    if (results.some((r) => r === "failed")) return "failing";
    if (results.every((r) => r === "passed")) return "passing";
    return "covered";
}

const countsOf = (results: readonly TestResult[]): CoverageCounts => ({
    linked: results.length,
    passed: results.filter((r) => r === "passed").length,
    failed: results.filter((r) => r === "failed").length,
    notRun: results.filter((r) => r === "not_run").length,
});

/** The key a reference is unique by. */
export const refKey = (ref: string): string => ref.trim().toUpperCase();

// ── import ─────────────────────────────────────────────────────────────────────

export interface ImportCandidate {
    ref: string;
    title: string;
    description: string;
    /** The heading it was under in the document, when it had one. */
    section: string | null;
    kind: ParsedRequirement["kind"];
}

/** A requirement's text as a record: the text itself as the title when it is short, else its first words and the whole text below. */
export function candidateOf(r: ParsedRequirement): ImportCandidate {
    const text = r.text.replace(/\s+/g, " ").trim();
    let title = text;
    let description = "";
    if (text.length > 160) {
        const sentence = /^(.{20,160}?[.!?])\s/.exec(text)?.[1];
        title = sentence ?? `${text.slice(0, 157).replace(/\s+\S*$/, "")}…`;
        description = text;
    }
    // The parser's ids already fit a reference; one the AI copied from the document may not (a space, a slash).
    const ref = r.id.replace(/[^A-Za-z0-9._#-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, MAX_REF);
    return { ref, title: title.slice(0, MAX_TITLE), description: description.slice(0, MAX_TEXT), section: r.section ?? null, kind: r.kind };
}

/** The deterministic pass of the requirements parser (engine/requirements/parse.ts) over a document's text: no AI. */
export function candidatesFromText(text: string): ImportCandidate[] {
    return parseRequirementsDeterministic(text).map(candidateOf);
}

/**
 * The parser with the AI model. The parser never throws for a model that fails: it falls back to its rule-based result and says so in
 * a warning event, and that fallback must not be presented as the AI's work, so `note` carries it to the person.
 */
export async function candidatesWithAi(ctx: Pick<EngineContext, "config" | "llm">, text: string): Promise<{ candidates: ImportCandidate[]; usedAi: boolean; note: string | null }> {
    let note: string | null = null;
    const requirements = await parseRequirements(
        {
            ...ctx,
            emit: (e) => {
                if (e.kind === "requirements_parsed" && (e.level === "warn" || /no LLM configured/.test(e.message))) note = "The AI could not read these, so this list comes from the rules, without AI.";
            },
        },
        text,
    );
    return { candidates: requirements.map(candidateOf), usedAi: note === null, note };
}

// ── storage ────────────────────────────────────────────────────────────────────

const now = () => new Date().toISOString();
const actorName = () => currentActor().name.slice(0, 200);

const toRecord = (r: Row): RequirementRecord => ({
    id: r.id,
    projectId: r.project_id,
    ref: r.ref,
    title: r.title,
    description: r.description,
    acceptanceCriteria: r.acceptance_criteria,
    priority: r.priority,
    status: r.status,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
});

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

export class RequirementStore {
    constructor(private readonly sql: Sql) {}

    async count(projectId: string): Promise<number> {
        return Number((await this.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM requirements WHERE project_id = ?", projectId))!.c);
    }

    async get(projectId: string, id: string): Promise<RequirementRecord | undefined> {
        const r = await this.sql.get("SELECT * FROM requirements WHERE id = ? AND project_id = ?", id, projectId);
        return r ? toRecord(r) : undefined;
    }

    async refExists(projectId: string, ref: string, exceptId?: string): Promise<boolean> {
        const r = await this.sql.get<{ id: string }>("SELECT id FROM requirements WHERE project_id = ? AND ref_key = ?", projectId, refKey(ref));
        return Boolean(r && r.id !== exceptId);
    }

    /** The refs of the project that are already taken, by their key. */
    async takenRefs(projectId: string): Promise<Set<string>> {
        return new Set((await this.sql.all<{ ref_key: string }>("SELECT ref_key FROM requirements WHERE project_id = ?", projectId)).map((r) => r.ref_key));
    }

    /** The next free REQ-n of the project. */
    async nextRef(projectId: string): Promise<string> {
        const taken = await this.takenRefs(projectId);
        let max = 0;
        for (const k of taken) {
            const m = /^REQ-(\d+)$/.exec(k);
            if (m) max = Math.max(max, Number(m[1]));
        }
        let n = max + 1;
        while (taken.has(`REQ-${n}`)) n++;
        return `REQ-${n}`;
    }

    /** Every requirement of the project with its coverage, in reference order. */
    async list(projectId: string): Promise<RequirementSummary[]> {
        const rows = (await this.sql.all("SELECT * FROM requirements WHERE project_id = ?", projectId)).map(toRecord);
        const results = await this.resultsByRequirement(projectId);
        return rows
            .map((r) => {
                const res = results.get(r.id) ?? [];
                return { ...r, coverage: coverageOf(res), tests: countsOf(res) };
            })
            .sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true, sensitivity: "base" }));
    }

    /** The coverage of the project's requirements that are not retired. */
    async summary(projectId: string): Promise<CoverageSummary> {
        const all = await this.list(projectId);
        const live = all.filter((r) => r.status !== "retired");
        const n = (c: Coverage) => live.filter((r) => r.coverage === c).length;
        return { total: live.length, notCovered: n("not_covered"), covered: n("covered"), passing: n("passing"), failing: n("failing"), retired: all.length - live.length };
    }

    /** The latest result of every linked test, per requirement. */
    private async resultsByRequirement(projectId: string): Promise<Map<string, TestResult[]>> {
        const links = await this.sql.all<{ requirement_id: string; test_case_id: string | null; manual_case_id: string | null; validation_status: string | null }>(
            `SELECT l.requirement_id, l.test_case_id, l.manual_case_id, t.validation_status
             FROM requirement_links l LEFT JOIN test_cases t ON t.id = l.test_case_id WHERE l.project_id = ?`,
            projectId,
        );
        const manual = links.some((l) => l.manual_case_id) ? await this.latestManual(projectId) : new Map<string, { result: string; at: string }>();
        const out = new Map<string, TestResult[]>();
        for (const l of links) {
            const r = l.test_case_id ? automatedResult(l.validation_status) : manualResult(manual.get(l.manual_case_id!)?.result);
            const list = out.get(l.requirement_id);
            if (list) list.push(r);
            else out.set(l.requirement_id, [r]);
        }
        return out;
    }

    /** Each manual case's most recent result in any release of the project (not-run rows say nothing). */
    private async latestManual(projectId: string): Promise<Map<string, { result: string; at: string; release: string }>> {
        const rows = await this.sql.all<{ case_id: string; result: string; at: string; name: string }>(
            `SELECT r.case_id, r.result, r.at, rel.name FROM release_results r JOIN releases rel ON rel.id = r.release_id
             WHERE rel.project_id = ? AND r.result <> 'not_run' ORDER BY r.at DESC`,
            projectId,
        );
        const out = new Map<string, { result: string; at: string; release: string }>();
        for (const r of rows) if (!out.has(r.case_id)) out.set(r.case_id, { result: r.result, at: r.at, release: r.name });
        return out;
    }

    /** The tests linked to one requirement, each with its latest result. */
    async linkedTests(projectId: string, id: string): Promise<LinkedTest[]> {
        const auto = await this.sql.all(
            `SELECT l.origin, l.created_at AS linked_at, t.id, t.test_key, t.title, t.validation_status,
                (SELECT MAX(e.finished_at) FROM test_executions e WHERE e.test_case_id = t.id AND e.variant IS NULL AND e.environment IS NULL) AS last_at
             FROM requirement_links l JOIN test_cases t ON t.id = l.test_case_id
             WHERE l.requirement_id = ? AND l.project_id = ? ORDER BY t.test_key`,
            id,
            projectId,
        );
        const man = await this.sql.all(
            `SELECT l.origin, l.created_at AS linked_at, m.id, m.title FROM requirement_links l JOIN manual_cases m ON m.id = l.manual_case_id
             WHERE l.requirement_id = ? AND l.project_id = ? ORDER BY m.title`,
            id,
            projectId,
        );
        const latest = man.length ? await this.latestManual(projectId) : new Map<string, { result: string; at: string }>();
        return [
            ...auto.map(
                (t): LinkedTest => ({ kind: "automated", id: t.id, key: t.test_key, title: t.title, result: automatedResult(t.validation_status), resultAt: t.last_at ?? null, detail: t.validation_status, origin: t.origin, linkedAt: t.linked_at }),
            ),
            ...man.map((m): LinkedTest => {
                const l = latest.get(m.id);
                return { kind: "manual", id: m.id, key: "", title: m.title, result: manualResult(l?.result), resultAt: l?.at ?? null, detail: l?.result ?? null, origin: m.origin, linkedAt: m.linked_at };
            }),
        ];
    }

    /** Throws RequirementError (duplicate, limit). `ref` empty: the next REQ-n. */
    async create(projectId: string, input: RequirementInput, source: RequirementSource): Promise<RequirementRecord> {
        if ((await this.count(projectId)) >= MAX_REQUIREMENTS) throw new RequirementError("limit", `A project can have at most ${MAX_REQUIREMENTS} requirements.`);
        const ref = input.ref?.trim() || (await this.nextRef(projectId));
        if (await this.refExists(projectId, ref)) throw new RequirementError("duplicate", `${ref} is already a requirement of this project. Choose another reference.`);
        const id = randomUUID();
        try {
            await this.insert(this.sql, projectId, id, ref, input, source);
        } catch (e) {
            // Two people took the same reference at once: the unique index decided.
            if (this.sql.dialect.isUniqueViolation(e)) throw new RequirementError("duplicate", `${ref} is already a requirement of this project. Choose another reference.`);
            throw e;
        }
        return (await this.get(projectId, id))!;
    }

    private async insert(sql: Sql, projectId: string, id: string, ref: string, input: RequirementInput, source: RequirementSource): Promise<void> {
        const t = now();
        const by = actorName();
        await sql.run(
            `INSERT INTO requirements (id, project_id, ref, ref_key, title, description, acceptance_criteria, priority, status, source, created_at, updated_at, created_by, updated_by)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            id,
            projectId,
            ref,
            refKey(ref),
            input.title,
            input.description ?? "",
            input.acceptanceCriteria ?? "",
            input.priority ?? "medium",
            input.status ?? "active",
            source,
            t,
            t,
            by,
            by,
        );
    }

    /** Changes the given fields. Throws RequirementError (duplicate) for a reference another requirement has. */
    async update(projectId: string, id: string, patch: Partial<RequirementInput>): Promise<RequirementRecord | undefined> {
        const current = await this.get(projectId, id);
        if (!current) return undefined;
        const ref = patch.ref?.trim() || current.ref;
        if (refKey(ref) !== refKey(current.ref) && (await this.refExists(projectId, ref, id))) throw new RequirementError("duplicate", `${ref} is already a requirement of this project. Choose another reference.`);
        await this.sql.run(
            `UPDATE requirements SET ref = ?, ref_key = ?, title = ?, description = ?, acceptance_criteria = ?, priority = ?, status = ?, updated_at = ?, updated_by = ?
             WHERE id = ? AND project_id = ?`,
            ref,
            refKey(ref),
            patch.title ?? current.title,
            patch.description ?? current.description,
            patch.acceptanceCriteria ?? current.acceptanceCriteria,
            patch.priority ?? current.priority,
            patch.status ?? current.status,
            now(),
            actorName(),
            id,
            projectId,
        );
        return this.get(projectId, id);
    }

    async linkCount(projectId: string, id: string): Promise<number> {
        return Number((await this.sql.get<{ c: number }>("SELECT COUNT(*) AS c FROM requirement_links WHERE requirement_id = ? AND project_id = ?", id, projectId))!.c);
    }

    /** Removes the requirement and its links (the tests stay). */
    async remove(projectId: string, id: string): Promise<boolean> {
        return (await this.sql.run("DELETE FROM requirements WHERE id = ? AND project_id = ?", id, projectId)).changes > 0;
    }

    /**
     * Links tests of this project to a requirement. Throws RequirementError (not-found) when an id is not one of the project's
     * automated tests or manual cases, and links nothing then. Returns how many links are new (linking twice changes nothing).
     */
    async link(projectId: string, id: string, ids: { automated: string[]; manual: string[] }, origin: "person" | "generated" = "person"): Promise<number> {
        const automated = [...new Set(ids.automated)];
        const manual = [...new Set(ids.manual)];
        const known = async (table: string, list: string[]) =>
            list.length ? (await this.sql.all<{ id: string }>(`SELECT id FROM ${table} WHERE project_id = ? AND id IN (${placeholders(list.length)})`, projectId, ...list)).length : 0;
        if ((await known("test_cases", automated)) !== automated.length) throw new RequirementError("not-found", "A test to link is not one of this project's automated tests.");
        if ((await known("manual_cases", manual)) !== manual.length) throw new RequirementError("not-found", "A test to link is not one of this project's manual cases.");
        return this.sql.tx(async (t) => {
            let added = 0;
            const by = actorName();
            for (const [column, list] of [["test_case_id", automated], ["manual_case_id", manual]] as const) {
                for (const testId of list) {
                    if (await t.get(`SELECT 1 AS x FROM requirement_links WHERE requirement_id = ? AND ${column} = ?`, id, testId)) continue;
                    await t.run(`INSERT INTO requirement_links (id, requirement_id, project_id, ${column}, origin, created_at, created_by) VALUES (?,?,?,?,?,?,?)`, randomUUID(), id, projectId, testId, origin, now(), by);
                    added++;
                }
            }
            if (added) await t.run("UPDATE requirements SET updated_at = ?, updated_by = ? WHERE id = ? AND project_id = ?", now(), by, id, projectId);
            return added;
        });
    }

    /** Unlinks one test (automated or manual, by its id) from a requirement. */
    async unlink(projectId: string, id: string, testId: string): Promise<boolean> {
        const r = await this.sql.run("DELETE FROM requirement_links WHERE requirement_id = ? AND project_id = ? AND (test_case_id = ? OR manual_case_id = ?)", id, projectId, testId, testId);
        if (r.changes > 0) await this.sql.run("UPDATE requirements SET updated_at = ?, updated_by = ? WHERE id = ? AND project_id = ?", now(), actorName(), id, projectId);
        return r.changes > 0;
    }

    /** The requirements one test (automated or manual) covers. */
    async forTest(projectId: string, testId: string): Promise<Array<Pick<RequirementRecord, "id" | "ref" | "title" | "status" | "priority"> & { origin: string }>> {
        const rows = await this.sql.all(
            `SELECT r.id, r.ref, r.title, r.status, r.priority, l.origin FROM requirement_links l JOIN requirements r ON r.id = l.requirement_id
             WHERE l.project_id = ? AND (l.test_case_id = ? OR l.manual_case_id = ?)`,
            projectId,
            testId,
            testId,
        );
        return rows
            .map((r) => ({ id: r.id, ref: r.ref, title: r.title, status: r.status, priority: r.priority, origin: r.origin }))
            .sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true, sensitivity: "base" }));
    }

    /** Every link of the project, with the requirement's reference: for lists of tests that show what each covers. */
    async allLinks(projectId: string): Promise<Array<{ requirementId: string; ref: string; title: string; kind: "automated" | "manual"; testId: string }>> {
        const rows = await this.sql.all(
            `SELECT l.requirement_id, l.test_case_id, l.manual_case_id, r.ref, r.title FROM requirement_links l JOIN requirements r ON r.id = l.requirement_id WHERE l.project_id = ?`,
            projectId,
        );
        return rows.map((r) => ({ requirementId: r.requirement_id, ref: r.ref, title: r.title, kind: r.test_case_id ? "automated" : "manual", testId: r.test_case_id ?? r.manual_case_id }));
    }

    /**
     * Saves imported requirements in one transaction. A reference the project already has (or one repeated in the list) is left
     * out and counted; nothing is saved when the project would pass its limit.
     */
    async importMany(projectId: string, inputs: RequirementInput[], source: RequirementSource): Promise<{ created: RequirementRecord[]; duplicates: string[] }> {
        const taken = await this.takenRefs(projectId);
        const fresh: Array<RequirementInput & { ref: string }> = [];
        const duplicates: string[] = [];
        let next = 0;
        for (const input of inputs) {
            let ref = input.ref?.trim() ?? "";
            if (!ref) {
                // Numbered after the project's own REQ-n, skipping any taken.
                if (!next) next = Number(/^REQ-(\d+)$/.exec(await this.nextRef(projectId))![1]);
                while (taken.has(`REQ-${next}`)) next++;
                ref = `REQ-${next++}`;
            }
            if (taken.has(refKey(ref))) {
                duplicates.push(ref);
                continue;
            }
            taken.add(refKey(ref));
            fresh.push({ ...input, ref });
        }
        if ((await this.count(projectId)) + fresh.length > MAX_REQUIREMENTS) throw new RequirementError("limit", `Importing these would pass the ${MAX_REQUIREMENTS} requirements a project can have. Nothing was imported.`);
        const ids = fresh.map(() => randomUUID());
        await this.sql.tx(async (t) => {
            for (let i = 0; i < fresh.length; i++) await this.insert(t, projectId, ids[i]!, fresh[i]!.ref, fresh[i]!, source);
        });
        const created: RequirementRecord[] = [];
        for (const id of ids) created.push((await this.get(projectId, id))!);
        return { created, duplicates };
    }
}

/**
 * Generation (repo-sink.ts): a test the AI wrote from a requirements document names the requirement ids it covers
 * (`spec.source.requirements`). Each id that is the reference of one of the project's requirements gets a link. Synchronous, for the
 * job's ordered write queue. Returns how many links were made.
 */
export function linkGeneratedTest(db: Db, projectId: string, testId: string, refs: readonly string[] | undefined): number {
    if (!refs?.length) return 0;
    const keys = [...new Set(refs.map(refKey).filter(Boolean))];
    if (!keys.length) return 0;
    const reqs = db.all<{ id: string }>(`SELECT id FROM requirements WHERE project_id = ? AND ref_key IN (${placeholders(keys.length)})`, projectId, ...keys);
    let made = 0;
    for (const r of reqs) {
        if (db.get("SELECT 1 AS x FROM requirement_links WHERE requirement_id = ? AND test_case_id = ?", r.id, testId)) continue;
        db.run("INSERT INTO requirement_links (id, requirement_id, project_id, test_case_id, origin, created_at, created_by) VALUES (?,?,?,?,?,?,?)", randomUUID(), r.id, projectId, testId, "generated", now(), "AI generation");
        made++;
    }
    return made;
}

// ── backup ─────────────────────────────────────────────────────────────────────

/** One requirement in a project backup: its tests are named the way the backup names them, so they survive new ids. */
export const RequirementBackupSchema = z.object({
    ref: z.string().min(1).max(MAX_REF),
    title: z.string().min(1).max(MAX_TITLE),
    description: z.string().max(MAX_TEXT),
    acceptanceCriteria: z.string().max(MAX_TEXT),
    priority: z.enum(REQUIREMENT_PRIORITIES),
    status: z.enum(REQUIREMENT_STATUSES),
    source: z.enum(REQUIREMENT_SOURCES),
    createdAt: z.string(),
    updatedAt: z.string(),
    createdBy: z.string(),
    updatedBy: z.string(),
    links: z.array(z.object({ testKey: z.string().optional(), caseRef: z.string().optional(), origin: z.enum(["person", "generated"]), createdAt: z.string(), createdBy: z.string() })),
});
export type RequirementBackup = z.infer<typeof RequirementBackupSchema>;

/** The project's requirements and links for a backup. `keyOfId`: a test's id to its key; a manual case's ref in a backup is its id. */
export function backupRequirements(db: Db, projectId: string, keyOfId: ReadonlyMap<string, string>): RequirementBackup[] {
    const links = db.all("SELECT * FROM requirement_links WHERE project_id = ?", projectId);
    return db.all("SELECT * FROM requirements WHERE project_id = ?", projectId).map((row) => {
        const r = toRecord(row);
        return {
            ref: r.ref,
            title: r.title,
            description: r.description,
            acceptanceCriteria: r.acceptanceCriteria,
            priority: r.priority,
            status: r.status,
            source: r.source,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            createdBy: r.createdBy,
            updatedBy: r.updatedBy,
            links: links
                .filter((l) => l.requirement_id === r.id)
                .map((l) => ({ ...(l.test_case_id ? { testKey: keyOfId.get(l.test_case_id) ?? l.test_case_id } : { caseRef: l.manual_case_id as string }), origin: l.origin, createdAt: l.created_at, createdBy: l.created_by })),
        };
    });
}

/** Writes a backup's requirements into the new project; a link to a test or case the backup does not hold is left out. */
export function restoreRequirements(db: Db, projectId: string, docs: readonly RequirementBackup[], idOfKey: ReadonlyMap<string, string>, caseIds: ReadonlyMap<string, string>): number {
    for (const d of docs) {
        const id = randomUUID();
        db.run(
            `INSERT INTO requirements (id, project_id, ref, ref_key, title, description, acceptance_criteria, priority, status, source, created_at, updated_at, created_by, updated_by)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            id, projectId, d.ref, refKey(d.ref), d.title, d.description, d.acceptanceCriteria, d.priority, d.status, d.source, d.createdAt, d.updatedAt, d.createdBy, d.updatedBy,
        );
        for (const l of d.links) {
            const testId = l.testKey ? idOfKey.get(l.testKey) : undefined;
            const caseId = l.caseRef ? caseIds.get(l.caseRef) : undefined;
            if (!testId && !caseId) continue;
            db.run("INSERT INTO requirement_links (id, requirement_id, project_id, test_case_id, manual_case_id, origin, created_at, created_by) VALUES (?,?,?,?,?,?,?,?)", randomUUID(), id, projectId, testId ?? null, caseId ?? null, l.origin, l.createdAt, l.createdBy);
        }
    }
    return docs.length;
}
