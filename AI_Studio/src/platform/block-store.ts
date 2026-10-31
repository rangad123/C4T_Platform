/**
 * Reusable steps ("blocks"): named groups of steps per project (migration slot 25).
 *
 * Which tests use a block is not stored: it is computed from the specs every time it is asked (`scanBlockUsage`), so the answer cannot drift
 * from what the tests really contain. Nothing here knows how a block is expanded; that is engine/blocks/expand.ts.
 */
import { randomUUID } from "node:crypto";
import { BLOCK_MARK, blockClosure, blockNames, blockOfStep, hasBlocks, indexBlocks, nameKey, sourceIndexes, tryExpandBlocks, type BlockIndex, type BlockKind, type BlockParam, type CheckedBlock } from "../engine/blocks/index.js";
import type { Step, TestSpec } from "../engine/spec/schema.js";
import type { Db, Row } from "./db.js";

export const BLOCKS_MIGRATION = `
CREATE TABLE step_blocks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,                   -- what a useBlock step refers to (exact text)
    name_key TEXT NOT NULL,               -- lower case: names are unique per project ignoring case
    description TEXT,
    kind TEXT NOT NULL,                   -- web | api | any
    params_json TEXT NOT NULL,            -- [{ name, description?, default? }]
    steps_json TEXT NOT NULL,             -- the block's steps, same shape as a spec's
    version INTEGER NOT NULL DEFAULT 1,   -- bumped by every change
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (project_id, name_key)
);
CREATE INDEX idx_step_blocks_project ON step_blocks(project_id);
`;

export interface StoredBlock {
    id: string;
    projectId: string;
    name: string;
    description: string | null;
    kind: BlockKind;
    params: BlockParam[];
    steps: Step[];
    version: number;
    createdAt: string;
    updatedAt: string;
}

const toBlock = (r: Row): StoredBlock => ({
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    description: r.description ?? null,
    kind: r.kind,
    params: JSON.parse(r.params_json),
    steps: JSON.parse(r.steps_json),
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});

const now = () => new Date().toISOString();

/** The name is taken by another block of the project (compared ignoring case). */
export class BlockNameTakenError extends Error {
    constructor(readonly name: string) {
        super(`This project already has reusable steps called '${name}'. Names are not case sensitive; pick another one.`);
    }
}

export class BlockStore {
    constructor(private readonly db: Db) {}

    list(projectId: string): StoredBlock[] {
        return this.db.all("SELECT * FROM step_blocks WHERE project_id = ? ORDER BY name_key", projectId).map(toBlock);
    }

    count(projectId: string): number {
        return Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM step_blocks WHERE project_id = ?", projectId)?.n ?? 0);
    }

    /** By name, ignoring case (the name in a URL or typed by a person). */
    get(projectId: string, name: string): StoredBlock | undefined {
        const r = this.db.get("SELECT * FROM step_blocks WHERE project_id = ? AND name_key = ?", projectId, nameKey(name));
        return r ? toBlock(r) : undefined;
    }

    /** The lookup table specs are expanded against, or undefined when the project has no blocks (nothing to expand). */
    index(projectId: string): BlockIndex | undefined {
        const all = this.list(projectId);
        return all.length ? indexBlocks(all) : undefined;
    }

    create(projectId: string, b: CheckedBlock): StoredBlock {
        if (this.get(projectId, b.name)) throw new BlockNameTakenError(b.name);
        const id = randomUUID();
        const t = now();
        this.db.run(
            "INSERT INTO step_blocks (id, project_id, name, name_key, description, kind, params_json, steps_json, version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)",
            id, projectId, b.name, nameKey(b.name), b.description ?? null, b.kind, JSON.stringify(b.params), JSON.stringify(b.steps), t, t,
        );
        return this.get(projectId, b.name)!;
    }

    /** Applies a change and bumps the version. Renaming does not touch the specs: the caller rewrites them in the same transaction. */
    update(projectId: string, id: string, b: CheckedBlock): StoredBlock {
        const cur = this.db.get("SELECT * FROM step_blocks WHERE project_id = ? AND id = ?", projectId, id);
        if (!cur) throw new Error("Reusable steps not found");
        if (this.db.get("SELECT 1 AS x FROM step_blocks WHERE project_id = ? AND name_key = ? AND id <> ?", projectId, nameKey(b.name), id)) throw new BlockNameTakenError(b.name);
        this.db.run(
            "UPDATE step_blocks SET name = ?, name_key = ?, description = ?, kind = ?, params_json = ?, steps_json = ?, version = version + 1, updated_at = ? WHERE id = ?",
            b.name, nameKey(b.name), b.description ?? null, b.kind, JSON.stringify(b.params), JSON.stringify(b.steps), now(), id,
        );
        return this.get(projectId, b.name)!;
    }

    remove(id: string): void {
        this.db.run("DELETE FROM step_blocks WHERE id = ?", id);
    }
}

/** The project's lookup table for rendering (undefined = no blocks, so nothing can be expanded and nothing is looked up). */
export const blocksFor = (db: Db, projectId: string): BlockIndex | undefined => new BlockStore(db).index(projectId);

/**
 * A function that returns a spec with its reusable steps put in place, for code that has to look at what a test really does (a safety
 * decision such as "does this test change data", or a report). The index is read once, and only if some spec uses a block. It never
 * throws: a spec whose blocks cannot be put in place is returned as it is (the run itself refuses it with the plain reason).
 */
export function blockView(db: Db, projectId: string): (spec: TestSpec) => TestSpec {
    let index: BlockIndex | undefined | null = null;
    return (spec) => {
        if (!hasBlocks(spec)) return spec;
        if (index === null) index = blocksFor(db, projectId);
        try {
            const r = tryExpandBlocks(spec, index);
            return r.ok ? r.spec : spec;
        } catch {
            // Whatever went wrong, a read of the test list must keep answering: the run itself refuses the test with the reason.
            return spec;
        }
    };
}

/** The tests with their reusable steps put in place, for reports that judge what a test does (quality, coverage). Tests that use no block are returned as they are. */
export function withExpandedSpecs<T extends { spec: TestSpec }>(db: Db, projectId: string, tests: T[]): T[] {
    const view = blockView(db, projectId);
    return tests.map((t) => {
        const spec = view(t.spec);
        return spec === t.spec ? t : { ...t, spec };
    });
}

/**
 * The steps that really run for a test that uses reusable steps, each with the step of the stored test it belongs to (`from`) and the block it
 * came from. The numbers of a run's step results follow this list, not the stored one. Undefined when the test uses no block, or when its blocks
 * cannot be put in place (the run says why).
 */
export function runStepsOf(db: Db, projectId: string, spec: TestSpec): Array<{ index: number; from: number; block?: string; step: Step }> | undefined {
    if (!hasBlocks(spec)) return undefined;
    const r = tryExpandBlocks(spec, blocksFor(db, projectId));
    if (!r.ok) return undefined;
    const where = sourceIndexes(spec, r.spec);
    return r.spec.steps.map((s, index) => {
        const inBlock = blockOfStep(s);
        // The note the engine keeps on an expanded step is not part of what a person sees.
        const plain = JSON.parse(JSON.stringify(s, (k, v) => (k === BLOCK_MARK ? undefined : v))) as Step;
        return { index, from: where[index] ?? index, ...(inBlock ? { block: inBlock.block } : {}), step: plain };
    });
}

/** A block as it travels in an export file / import body: no ids, no counters (the shape a backup's blocks.json uses too). */
export interface ExportedBlock {
    name: string;
    description?: string;
    kind: BlockKind;
    params: BlockParam[];
    steps: Step[];
}

/**
 * The project's blocks the given specs use, directly or through other blocks (what an export carries so its tests can be imported elsewhere).
 * Empty when no spec uses a block, so an export of a project without blocks stays exactly what it was.
 */
export function exportBlocksUsedBy(db: Db, projectId: string, specs: Array<Pick<TestSpec, "steps">>): ExportedBlock[] {
    const names = new Set(specs.flatMap((s) => blockNames(s)));
    if (!names.size) return [];
    const all = new BlockStore(db).list(projectId);
    const wanted = blockClosure(names, indexBlocks(all));
    return all.filter((b) => wanted.has(b.name)).map((b) => ({ name: b.name, ...(b.description ? { description: b.description } : {}), kind: b.kind, params: b.params, steps: b.steps }));
}
