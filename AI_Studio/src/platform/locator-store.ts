/**
 * The object repository: named, shared UI elements per project, and which tests use them (migration slot 20).
 *
 * Usage is not typed in by anyone: `syncLocatorUsage` rebuilds a test's rows from its spec every time the spec is stored (repo.ts
 * calls it from insertTest / updateTest), so the table cannot drift from the specs. `rebuildProject` recomputes a whole project.
 */
import { randomUUID } from "node:crypto";
import { nameKey, tidy, type ElementKind } from "../engine/locators/model.js";
import { indexOf, refCounts, type ObjectIndex } from "../engine/locators/refs.js";
import type { Locator, TestSpec } from "../engine/spec/schema.js";
import type { Db, Row } from "./db.js";

export const LOCATORS_MIGRATION = `
CREATE TABLE locator_elements (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,                   -- what specs refer to (exact text)
    name_key TEXT NOT NULL,               -- lower case: names are unique per project ignoring case
    kind TEXT NOT NULL,                   -- web | mobile | desktop
    page TEXT,
    locator_json TEXT NOT NULL,           -- a concrete locator, same shape as a spec step's
    notes TEXT,
    version INTEGER NOT NULL DEFAULT 1,   -- bumped by every change
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (project_id, name_key)
);
CREATE INDEX idx_locator_elements_name ON locator_elements(project_id, name);
-- Which tests refer to which element; rebuilt from the specs whenever a spec is stored.
CREATE TABLE locator_usage (
    element_id TEXT NOT NULL REFERENCES locator_elements(id) ON DELETE CASCADE,
    test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    steps INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (element_id, test_case_id)
);
CREATE INDEX idx_locator_usage_test ON locator_usage(test_case_id);
`;

export interface StoredElement {
    id: string;
    projectId: string;
    name: string;
    kind: ElementKind;
    page: string | null;
    locator: Locator;
    notes: string | null;
    /** Other ways to find it (repair without AI); absent when none were given. Kept in locator_json next to the locator (no migration). */
    alternatives?: Locator[];
    version: number;
    createdAt: string;
    updatedAt: string;
}

export interface ElementUser {
    id: string;
    testKey: string;
    title: string;
    validationStatus: string;
    steps: number;
}

/** locator_json holds the locator and, only when some were given, `alternatives` beside its keys. */
const decodeLocator = (json: string): { locator: Locator; alternatives?: Locator[] } => {
    const raw = JSON.parse(json) as Locator & { alternatives?: Locator[] };
    if (!Array.isArray(raw.alternatives)) return { locator: raw };
    const { alternatives, ...locator } = raw;
    return { locator, ...(alternatives.length ? { alternatives } : {}) };
};
const encodeLocator = (l: Locator, alternatives?: Locator[]): string => JSON.stringify(alternatives?.length ? { ...tidy(l), alternatives: alternatives.map(tidy) } : tidy(l));

const toElement = (r: Row): StoredElement => {
    const { locator, alternatives } = decodeLocator(r.locator_json);
    return {
        id: r.id,
        projectId: r.project_id,
        name: r.name,
        kind: r.kind,
        page: r.page ?? null,
        locator,
        notes: r.notes ?? null,
        ...(alternatives ? { alternatives } : {}),
        version: r.version,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
};

const now = () => new Date().toISOString();

/** The name is taken by another element of the project (compared ignoring case). */
export class NameTakenError extends Error {
    constructor(readonly name: string) {
        super(`This project already has an element called '${name}'. Names are not case sensitive; pick another one.`);
    }
}

export class LocatorStore {
    constructor(private readonly db: Db) {}

    list(projectId: string): StoredElement[] {
        return this.db.all("SELECT * FROM locator_elements WHERE project_id = ? ORDER BY COALESCE(page, ''), name_key", projectId).map(toElement);
    }

    count(projectId: string): number {
        return Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM locator_elements WHERE project_id = ?", projectId)?.n ?? 0);
    }

    get(projectId: string, id: string): StoredElement | undefined {
        const r = this.db.get("SELECT * FROM locator_elements WHERE project_id = ? AND id = ?", projectId, id);
        return r ? toElement(r) : undefined;
    }

    getByName(projectId: string, name: string): StoredElement | undefined {
        const r = this.db.get("SELECT * FROM locator_elements WHERE project_id = ? AND name = ?", projectId, name);
        return r ? toElement(r) : undefined;
    }

    /** The lookup table specs are resolved against, or undefined when the project has no elements (nothing to resolve). */
    index(projectId: string): ObjectIndex | undefined {
        const all = this.list(projectId);
        return all.length ? indexOf(all) : undefined;
    }

    create(projectId: string, e: { name: string; kind: ElementKind; locator: Locator; page?: string; notes?: string; alternatives?: Locator[] }): StoredElement {
        if (this.db.get("SELECT 1 AS x FROM locator_elements WHERE project_id = ? AND name_key = ?", projectId, nameKey(e.name))) throw new NameTakenError(e.name);
        const id = randomUUID();
        const t = now();
        this.db.run(
            "INSERT INTO locator_elements (id, project_id, name, name_key, kind, page, locator_json, notes, version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)",
            id, projectId, e.name, nameKey(e.name), e.kind, e.page ?? null, encodeLocator(e.locator, e.alternatives), e.notes ?? null, t, t,
        );
        return this.get(projectId, id)!;
    }

    /** Applies a change and bumps the version. Renaming does not touch the specs: the caller rewrites them in the same transaction. */
    update(projectId: string, id: string, patch: { name?: string; locator?: Locator; page?: string | null; notes?: string | null; /** undefined keeps them, [] removes them. */ alternatives?: Locator[] }): StoredElement {
        const cur = this.get(projectId, id);
        if (!cur) throw new Error("Element not found");
        const name = patch.name ?? cur.name;
        if (name !== cur.name && this.db.get("SELECT 1 AS x FROM locator_elements WHERE project_id = ? AND name_key = ? AND id <> ?", projectId, nameKey(name), id)) throw new NameTakenError(name);
        this.db.run(
            "UPDATE locator_elements SET name = ?, name_key = ?, page = ?, locator_json = ?, notes = ?, version = version + 1, updated_at = ? WHERE id = ?",
            name, nameKey(name), patch.page === undefined ? cur.page : patch.page, encodeLocator(patch.locator ?? cur.locator, patch.alternatives ?? cur.alternatives), patch.notes === undefined ? cur.notes : patch.notes, now(), id,
        );
        return this.get(projectId, id)!;
    }

    remove(id: string): void {
        this.db.run("DELETE FROM locator_elements WHERE id = ?", id);
    }

    /** The tests that use an element (stored usage), by test key. */
    usersOf(elementId: string): ElementUser[] {
        return this.db
            .all(
                "SELECT t.id, t.test_key, t.title, t.validation_status, u.steps FROM locator_usage u JOIN test_cases t ON t.id = u.test_case_id WHERE u.element_id = ? ORDER BY t.test_key",
                elementId,
            )
            .map((r) => ({ id: r.id, testKey: r.test_key, title: r.title, validationStatus: r.validation_status, steps: Number(r.steps) }));
    }

    /** Users of every element of a project in one query: element id -> tests. */
    usersByElement(projectId: string): Map<string, ElementUser[]> {
        const out = new Map<string, ElementUser[]>();
        const rows = this.db.all(
            `SELECT u.element_id, t.id, t.test_key, t.title, t.validation_status, u.steps
             FROM locator_usage u JOIN test_cases t ON t.id = u.test_case_id JOIN locator_elements e ON e.id = u.element_id
             WHERE e.project_id = ? ORDER BY t.test_key`,
            projectId,
        );
        for (const r of rows) {
            const list = out.get(r.element_id) ?? [];
            list.push({ id: r.id, testKey: r.test_key, title: r.title, validationStatus: r.validation_status, steps: Number(r.steps) });
            out.set(r.element_id, list);
        }
        return out;
    }

    /** Elements a test uses (for the test page). */
    usedByTest(projectId: string, testId: string): StoredElement[] {
        return this.db
            .all("SELECT e.* FROM locator_usage u JOIN locator_elements e ON e.id = u.element_id WHERE u.test_case_id = ? AND e.project_id = ? ORDER BY e.name_key", testId, projectId)
            .map(toElement);
    }

    /** Recomputes the usage of every test of a project from the stored specs (used after bulk changes and as a safety net). */
    rebuildProject(projectId: string): void {
        const tests = this.db.all("SELECT id, spec_json FROM test_cases WHERE project_id = ?", projectId);
        this.db.tx(() => {
            for (const t of tests) syncLocatorUsage(this.db, projectId, t.id, JSON.parse(t.spec_json) as TestSpec);
        });
    }
}

/**
 * Makes the usage rows of one test match its spec. Called whenever a spec is stored. A name that is not in the repository is
 * skipped here (it is refused at save and render time, with a plain message); it never throws.
 */
export function syncLocatorUsage(db: Db, projectId: string, testId: string, spec: TestSpec): void {
    db.run("DELETE FROM locator_usage WHERE test_case_id = ?", testId);
    for (const [name, steps] of refCounts(spec)) {
        const el = db.get<{ id: string }>("SELECT id FROM locator_elements WHERE project_id = ? AND name = ?", projectId, name);
        if (el) db.run("INSERT INTO locator_usage (element_id, test_case_id, steps) VALUES (?,?,?) ON CONFLICT (element_id, test_case_id) DO UPDATE SET steps = excluded.steps", el.id, testId, steps);
    }
}
