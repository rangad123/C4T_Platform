/**
 * What an approved test version depends on outside its own steps and code (migration slot 54), so that a change there holds it back.
 *
 * An approved version's steps and code never change (review-store.ts), but a run also uses parts the project shares between tests:
 * reusable steps and shared elements for a test made of steps, helpers for a test written as code. When one of those changes, the
 * test does something nobody approved. So each approval records a fingerprint of what those parts make the test do, and a run
 * compares it before the test runs (review-store.ts `toRun`, called by `pinRun` and by suite runs): a test whose fingerprint changed
 * is held back until it is approved again.
 *
 * What the fingerprint covers:
 *  - a test made of steps: its steps as they really run, with reusable steps put in place and shared elements replaced by their
 *    locators, and with the names they came from left out, so renaming reusable steps or an element changes nothing. An element's
 *    other locators, page and notes are not covered: they do not change what the steps do (a repair that uses the other locators makes
 *    a new version, which is reviewed as a repair). When the steps cannot be put in place (a part is missing), the fingerprint is
 *    made of the parts themselves, so adding the missing part later is a change too.
 *  - a test written as code: the code of every helper it imports, through other helpers too. A helper it imports that does not
 *    exist counts as missing, so adding it later is a change too.
 * Test data sets and the application's address are not covered: they are settings of a run, not parts of a test.
 *
 * `covers` names each part with a fingerprint of its own, so a held-back test can say which part changed. A part's fingerprint leaves
 * names out too (shared elements count by their locator, reusable steps by their own steps), so a rename is never named as a change.
 */
import { createHash } from "node:crypto";
import { BLOCK_MARK, blockClosure, blockNames, indexBlocks, isUseBlock, tryExpandBlocks, type BlockIndex } from "../engine/blocks/index.js";
import { helperClosure } from "../engine/custom/helpers.js";
import { refNames, refOf, tryResolveSpecRefs, type ObjectIndex } from "../engine/locators/refs.js";
import type { Step, TestSpec } from "../engine/spec/schema.js";
import { BlockStore } from "./block-store.js";
import { CustomScriptStore } from "./custom-script-store.js";
import type { Db } from "./db.js";
import { LocatorStore } from "./locator-store.js";

export const APPROVAL_DEPS_MIGRATION = `
-- What an approved test version depends on: the reusable steps and shared elements its steps use, or the helpers its code imports.
-- hash: a fingerprint of what those parts make the test do; covers_json: [{ kind: steps | element | helper, name, hash }], a part that
-- did not exist has the hash 'missing'. recorded: approval (when it was approved) | carried (copied from the approved version a
-- rename replaced) | first_check (approved before this table existed: recorded the first time a run checked it) | policy (approved
-- again by the project's review policy after a part changed). A version without a row was approved before this table existed.
CREATE TABLE test_version_deps (
    version_id TEXT PRIMARY KEY REFERENCES test_versions(id) ON DELETE CASCADE,
    hash TEXT NOT NULL,
    covers_json TEXT NOT NULL,
    recorded TEXT NOT NULL,
    recorded_at TEXT NOT NULL
);
`;

export type DepKind = "steps" | "element" | "helper";
export interface DepPart {
    kind: DepKind;
    name: string;
    /** A fingerprint of the part's content, or MISSING when the project has no part of that name. */
    hash: string;
}
export interface VersionDeps {
    hash: string;
    covers: DepPart[];
}
export type DepsRecorded = "approval" | "carried" | "first_check" | "policy";
export interface DepsRecord extends VersionDeps {
    recorded: DepsRecorded;
    recordedAt: string;
}

export const MISSING = "missing";
/** The hash of a version approved before records existed whose part changed on the project's pages: unknown, so never the same as now. */
export const UNKNOWN_DEPS = "unknown";

/** JSON with object keys sorted and undefined left out: the same content always gives the same text. */
const stable = (v: unknown): string => {
    const sort = (x: unknown): unknown =>
        Array.isArray(x)
            ? x.map(sort)
            : x && typeof x === "object"
              ? Object.fromEntries(
                    Object.keys(x as object)
                        .sort()
                        .filter((k) => (x as Record<string, unknown>)[k] !== undefined)
                        .map((k) => [k, sort((x as Record<string, unknown>)[k])]),
                )
              : x;
    return JSON.stringify(sort(v)) ?? "null";
};
const fingerprint = (v: unknown): string => createHash("sha256").update(stable(v)).digest("hex");

/** A step as it runs, without where it came from: the note of the reusable steps it was put in from, and the name of its shared element. */
function plainStep(step: Step): unknown {
    const { [BLOCK_MARK]: _mark, ...rest } = step as Step & { [BLOCK_MARK]?: unknown };
    const l = (rest as { locator?: unknown }).locator;
    if (l && typeof l === "object" && !Array.isArray(l) && "ref" in l) {
        const { ref: _ref, ...locator } = l as Record<string, unknown>;
        return { ...rest, locator };
    }
    return rest;
}

const stepsOf = (spec: unknown): Step[] => {
    const s = (spec as { steps?: unknown } | null)?.steps;
    return Array.isArray(s) ? (s as Step[]) : [];
};

interface ProjectParts {
    blocks: BlockIndex;
    objects: ObjectIndex | undefined;
    helpers: Map<string, string>;
}

/**
 * Reads the shared parts of projects and works out a version's dependencies. Each project's parts are read once per reader, so make
 * one reader per check (a run's pinning, a suite's choice, one approval) and never keep it: a later change would not be seen.
 */
export class DepsReader {
    private readonly projects = new Map<string, ProjectParts>();
    constructor(private readonly db: Db) {}

    private parts(projectId: string): ProjectParts {
        let p = this.projects.get(projectId);
        if (!p) {
            p = {
                blocks: indexBlocks(new BlockStore(this.db).list(projectId)),
                objects: new LocatorStore(this.db).index(projectId),
                helpers: new Map(new CustomScriptStore(this.db).allHelpers(projectId).map((h) => [h.name, h.content])),
            };
            this.projects.set(projectId, p);
        }
        return p;
    }

    /** What the version depends on now, with the parts as they are in the project at this moment. */
    of(v: { projectId: string; spec: unknown; code: string | null }): VersionDeps {
        const p = this.parts(v.projectId);
        return v.code !== null ? codeDeps(v.code, p) : stepDeps(v.spec, p);
    }
}

function codeDeps(code: string, p: ProjectParts): VersionDeps {
    const closure = helperClosure([code], (n) => p.helpers.get(n));
    const covers: DepPart[] = [
        ...closure.helpers.map((h) => ({ kind: "helper" as const, name: h.name, hash: fingerprint(h.content) })),
        ...closure.missing.map((name) => ({ kind: "helper" as const, name, hash: MISSING })),
    ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { hash: fingerprint({ helpers: covers }), covers };
}

/**
 * A fingerprint of reusable steps by their own content: the reusable steps and shared elements used inside them count as parts of
 * their own (listed beside them), so only the part that changed is named, and a rename of either changes nothing here.
 */
function blockHash(name: string, p: ProjectParts): string {
    const def = p.blocks.get(name);
    if (!def) return MISSING;
    const steps = def.steps.map((st) => {
        const plain = plainStep(st) as Record<string, unknown>;
        if (isUseBlock(st)) return { ...plain, block: "" };
        return refOf((st as { locator?: unknown }).locator) === undefined ? plain : { ...plain, locator: "" };
    });
    return fingerprint({ kind: def.kind, params: def.params, steps });
}

function stepDeps(rawSpec: unknown, p: ProjectParts): VersionDeps {
    const steps = stepsOf(rawSpec);
    const spec = { ...(rawSpec as object), steps } as TestSpec;
    const covers: DepPart[] = [];
    const elements = new Set(refNames(spec));
    for (const name of [...blockClosure(blockNames(spec), p.blocks)].sort()) {
        const def = p.blocks.get(name);
        covers.push({ kind: "steps", name, hash: blockHash(name, p) });
        if (def) for (const r of refNames({ steps: def.steps } as TestSpec)) elements.add(r);
    }
    for (const name of [...elements].sort()) {
        const e = p.objects?.get(name);
        covers.push({ kind: "element", name, hash: e ? fingerprint({ kind: e.kind, locator: e.locator }) : MISSING });
    }
    let running: unknown[] | undefined;
    try {
        const expanded = tryExpandBlocks(spec, p.blocks.size ? p.blocks : undefined);
        const resolved = expanded.ok ? tryResolveSpecRefs(expanded.spec, p.objects) : undefined;
        if (resolved?.ok) running = resolved.spec.steps.map(plainStep);
    } catch {
        running = undefined; // a spec the engine cannot read is judged by its parts, like one with a part missing
    }
    return { hash: running ? fingerprint({ steps: running }) : fingerprint({ unresolved: covers, steps }), covers };
}

// ── stored records ──────────────────────────────────────────────────────────

export function readDeps(db: Db, versionId: string): DepsRecord | undefined {
    const r = db.get<{ hash: string; covers_json: string; recorded: DepsRecorded; recorded_at: string }>("SELECT hash, covers_json, recorded, recorded_at FROM test_version_deps WHERE version_id = ?", versionId);
    if (!r) return undefined;
    let covers: DepPart[] = [];
    try {
        const parsed = JSON.parse(r.covers_json);
        if (Array.isArray(parsed)) covers = parsed as DepPart[];
    } catch {
        covers = [];
    }
    return { hash: r.hash, covers, recorded: r.recorded, recordedAt: r.recorded_at };
}

/** Records a version's dependencies. `keep`: only when it has no record yet (a record made at approval is never written over by a check). */
export function writeDeps(db: Db, versionId: string, deps: VersionDeps, recorded: DepsRecorded, keep = false): void {
    const at = new Date().toISOString();
    const covers = JSON.stringify(deps.covers);
    db.run(
        `INSERT INTO test_version_deps (version_id, hash, covers_json, recorded, recorded_at) VALUES (?,?,?,?,?) ON CONFLICT (version_id) DO ${keep ? "NOTHING" : "UPDATE SET hash = excluded.hash, covers_json = excluded.covers_json, recorded = excluded.recorded, recorded_at = excluded.recorded_at"}`,
        versionId,
        deps.hash,
        covers,
        recorded,
        at,
    );
}

// ── what changed, in words ──────────────────────────────────────────────────

/**
 * The parts whose content is new since the record: a part counts by its content, not its name, so a renamed part is not listed. When
 * nothing is new, the parts that are gone (listed with the hash MISSING).
 */
export function changedParts(before: readonly DepPart[], now: readonly DepPart[]): DepPart[] {
    const key = (d: DepPart) => `${d.kind}\u0000${d.hash}`;
    const was = new Set(before.map(key));
    const changed = now.filter((d) => !was.has(key(d)));
    if (changed.length) return changed;
    const is = new Set(now.map(key));
    return before.filter((d) => d.hash !== MISSING && !is.has(key(d))).map((d) => ({ kind: d.kind, name: d.name, hash: MISSING }));
}

const KIND_WORDS: Record<DepKind, string> = { steps: "the reusable steps", element: "the shared element", helper: "the helper" };
const partWords = (d: DepPart) => `${KIND_WORDS[d.kind]} “${d.name.slice(0, 80)}”${d.hash === MISSING ? " (no longer there)" : ""}`;

/** The parts by name, at most three, for a sentence. */
export function describeParts(parts: readonly DepPart[]): string {
    const named = parts.slice(0, 3).map(partWords);
    const more = parts.length - named.length;
    const list = named.length <= 1 ? (named[0] ?? "") : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
    return more > 0 ? `${list}, and ${more} more` : list;
}

/** What a run says about a test it held back because a shared part changed after the test was approved. */
export const DEPENDENCY_CHANGED = "A shared step it uses changed after approval; approve it again to run it.";
export const dependencyChangedMessage = (parts: readonly DepPart[]): string => (parts.length ? `${DEPENDENCY_CHANGED} Changed: ${describeParts(parts)}.` : DEPENDENCY_CHANGED);
