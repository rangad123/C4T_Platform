/**
 * Object repository routes: named, shared UI elements per project (see docs/features/object-repository.md).
 *
 * Elements are the one place a locator is kept for every test that refers to it. Editing one re-renders those tests' scripts and
 * has them validated again; deleting one that is used is refused; renaming rewrites the specs in the same transaction. The
 * helpers exported at the bottom are shared with the healing route (a repair of a shared step edits the element once).
 */
import { withProjectNotes } from "../render-context.js";
import { dataSetsFor } from "./environments.js";
import path from "node:path";
import { z } from "zod";
import { isAppUri } from "../../engine/desktop/target.js";
import { getAdapter, hasAdapter, renderWithAdapter } from "../../engine/frameworks/index.js";
import {
    checkElement,
    describeLocatorWords,
    ELEMENT_KINDS,
    locatorKey,
    MAX_ELEMENTS,
    proposeExtraction,
    refNames,
    renameRefs,
    scanUsage,
    useRefsAt,
    type ElementKind,
    type ExtractProposal,
    type ObjectIndex,
} from "../../engine/locators/index.js";
import { indexOf, locatorOf, refOf } from "../../engine/locators/refs.js";
import { blocksHoldingElements, elementUsageThroughBlocks } from "../../engine/blocks/element-usage.js";
import type { Locator } from "../../engine/spec/schema.js";
import { HttpError } from "../http-error.js";
import { CustomScriptStore } from "../custom-script-store.js";
import { BlockStore, blocksFor, blockView } from "../block-store.js";
import { ReviewStore } from "../review-store.js";
import { LocatorStore, NameTakenError, type ElementUser, type StoredElement } from "../locator-store.js";
import { storeScript } from "../repo-sink.js";
import { putText } from "../object-store.js";
import { TERMINAL_STATES, type TestRow } from "../repo.js";
import type { RouteCtx } from "./types.js";

const MESSAGE_MAX_TESTS = 5;

/** The project's lookup table for rendering (undefined = no elements, so nothing can be resolved and nothing is looked up). */
export const objectsFor = (repo: RouteCtx["repo"], projectId: string): ObjectIndex | undefined => new LocatorStore(repo.db).index(projectId);

/** An element as it travels in an export file / import body: no ids, no counters. */
export interface ExportedElement {
    name: string;
    kind: ElementKind;
    page?: string;
    locator: Locator;
    notes?: string;
    alternatives?: Locator[];
}
const toExported = (e: StoredElement): ExportedElement => ({ name: e.name, kind: e.kind, ...(e.page ? { page: e.page } : {}), locator: e.locator, ...(e.notes ? { notes: e.notes } : {}), ...(e.alternatives?.length ? { alternatives: e.alternatives } : {}) });

/** The elements the given specs refer to, in export form (what a spec export carries so it can be imported elsewhere). */
export function exportObjectsUsedBy(repo: RouteCtx["repo"], projectId: string, specs: Array<Parameters<typeof refNames>[0]>): ExportedElement[] {
    const names = new Set(specs.flatMap((s) => refNames(s)));
    if (!names.size) return [];
    return new LocatorStore(repo.db).list(projectId).filter((e) => names.has(e.name)).map(toExported);
}

/**
 * Elements that come with an imported set of specs. Validated as a whole before anything is stored; a name that already exists
 * must have exactly the same locator (the import never changes what other tests use). `persist` stores the new ones.
 */
export function importObjectsFor(repo: RouteCtx["repo"], projectId: string, raw: unknown[] | undefined): { index: ObjectIndex | undefined; persist(): void } {
    const store = new LocatorStore(repo.db);
    const existing = store.list(projectId);
    if (!raw?.length) return { index: existing.length ? indexOf(existing) : undefined, persist() {} };
    const checked: ExportedElement[] = [];
    const details: Array<{ index: number; issues: unknown }> = [];
    const seen = new Set<string>();
    raw.forEach((r, index) => {
        const c = checkElement(r);
        if (!c.ok) return void details.push({ index, issues: [{ message: c.error }] });
        const key = c.element.name.toLowerCase();
        if (seen.has(key)) return void details.push({ index, issues: [{ message: `'${c.element.name}' appears twice in the elements.` }] });
        seen.add(key);
        checked.push(c.element);
    });
    if (details.length) throw new HttpError(400, "Invalid elements", details);
    const fresh: ExportedElement[] = [];
    for (const e of checked) {
        const have = existing.find((x) => x.name.toLowerCase() === e.name.toLowerCase());
        if (!have) fresh.push(e);
        else if (have.name !== e.name || have.kind !== e.kind || locatorKey(have.kind, have.locator) !== locatorKey(e.kind, e.locator)) {
            throw new HttpError(409, `The object repository already has '${have.name}' with a different locator. Rename or change one of them, then import again.`);
        }
    }
    if (existing.length + fresh.length > MAX_ELEMENTS) throw new HttpError(400, `A project can have at most ${MAX_ELEMENTS} shared elements.`);
    const merged = indexOf([...existing, ...fresh]);
    return {
        index: merged,
        persist() {
            for (const e of fresh) store.create(projectId, e);
        },
    };
}

const testsLine = (users: Array<{ testKey: string; title: string }>): string => {
    const shown = users.slice(0, MESSAGE_MAX_TESTS).map((u) => `${u.testKey} ${u.title}`);
    return shown.join(", ") + (users.length > shown.length ? ` and ${users.length - shown.length} more` : "");
};

const Page = z.string().max(200).nullable().optional();
const UpdateBody = z.object({
    name: z.string().max(200).optional(),
    kind: z.enum(ELEMENT_KINDS).optional(),
    locator: z.unknown().optional(),
    page: Page,
    notes: z.string().max(2000).nullable().optional(),
    /** Other ways to find the element (repair without AI); [] removes them, absent keeps them. Checked by checkElement. */
    alternatives: z.unknown().optional(),
    /** Optimistic check: refuse when someone changed the element since this version. */
    expectedVersion: z.number().int().positive().optional(),
});
const ImportBody = z.object({ elements: z.array(z.unknown()).max(MAX_ELEMENTS, `Import at most ${MAX_ELEMENTS} elements at a time`), overwrite: z.boolean().default(false) });
const ExtractBody = z.object({
    dryRun: z.boolean().default(true),
    all: z.boolean().optional(),
    apply: z.array(z.object({ key: z.string().min(1).max(2000), name: z.string().max(200).optional() })).max(MAX_ELEMENTS).optional(),
    /** Count a locator used in fewer places too (the person picks it). Default 2. */
    minUses: z.number().int().min(1).max(50).optional(),
});
const ShareBody = z.object({
    name: z.string().min(1).max(200).optional(),
    page: z.string().max(200).optional(),
    notes: z.string().max(2000).optional(),
    /** Also use the element in every other step that spells out exactly this locator. */
    everywhere: z.boolean().default(false),
});

export function registerLocatorRoutes(ctx: RouteCtx): void {
    const { app, p, repo, project } = ctx;
    const store = new LocatorStore(p.db);
    const svc = locatorServices(ctx);

    const element = (projectId: string, oid: string): StoredElement => {
        const e = store.get(projectId, oid);
        if (!e) throw new HttpError(404, "Element not found");
        return e;
    };
    /** A test that uses an element, with the reusable steps it reaches it through (absent when it spells the element out itself only). */
    type UserView = ElementUser & { viaBlocks?: string[] };
    /**
     * Who uses each element of a project: tests that spell it out (the stored usage) and tests that reach it through reusable steps, which the stored
     * usage cannot know (a spec holds only the `useBlock` step). Read from the specs and the blocks every time, so it cannot drift from them.
     */
    const usersByElement = (projectId: string): Map<string, UserView[]> => {
        const out = new Map<string, UserView[]>(store.usersByElement(projectId));
        const blocks = new BlockStore(p.db).list(projectId);
        if (!blocks.length) return out;
        const hand = new CustomScriptStore(repo.db).forProject(projectId);
        const tests = repo.listTests(projectId).filter((t) => !hand.has(t.id));
        const via = elementUsageThroughBlocks(tests.map((t) => ({ id: t.id, spec: t.spec })), blocks);
        if (!via.size) return out;
        const byId = new Map(tests.map((t) => [t.id, t]));
        for (const e of store.list(projectId)) {
            const reached = via.get(e.name);
            if (!reached) continue;
            const merged = new Map<string, UserView>((out.get(e.id) ?? []).map((u) => [u.id, { ...u }]));
            for (const [testId, how] of reached) {
                const t = byId.get(testId);
                if (!t) continue;
                const have = merged.get(testId);
                merged.set(testId, { id: testId, testKey: t.testKey, title: t.title, validationStatus: t.validationStatus, steps: (have?.steps ?? 0) + how.steps, viaBlocks: how.blocks });
            }
            out.set(e.id, [...merged.values()].sort((a, b) => a.testKey.localeCompare(b.testKey)));
        }
        return out;
    };
    const usersOfElement = (e: StoredElement): UserView[] => usersByElement(e.projectId).get(e.id) ?? [];
    /** The reusable steps that hold each element (an element a set holds cannot be deleted, so the page must say it is in use). */
    const heldBy = (projectId: string): Map<string, string[]> => blocksHoldingElements(new BlockStore(p.db).list(projectId));
    const publicElement = (e: StoredElement, users: UserView[], all = false, held: Map<string, string[]> = heldBy(e.projectId)) => ({
        id: e.id,
        name: e.name,
        kind: e.kind,
        page: e.page,
        locator: e.locator,
        description: describeLocatorWords(e.locator),
        notes: e.notes,
        ...(e.alternatives?.length ? { alternatives: e.alternatives } : {}),
        version: e.version,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        usedBy: {
            count: users.length,
            steps: users.reduce((n, u) => n + u.steps, 0),
            tests: users.slice(0, all ? 200 : 3).map((u) => ({ id: u.id, testId: u.testKey, title: u.title, ...(u.viaBlocks?.length ? { viaBlocks: u.viaBlocks } : {}) })),
            ...(held.get(e.name)?.length ? { blocks: held.get(e.name) } : {}),
        },
    });
    const taken = (e: unknown): never => {
        if (e instanceof NameTakenError) throw new HttpError(409, e.message);
        throw e;
    };

    // ── list / read ───────────────────────────────────────────────────────────
    app.get("/api/projects/:id/objects", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        const q = z.object({ q: z.string().max(100).optional(), test: z.string().max(64).optional(), kind: z.enum(ELEMENT_KINDS).optional() }).parse(req.query);
        const users = usersByElement(id);
        const held = heldBy(id);
        let list = store.list(id);
        if (q.kind) list = list.filter((e) => e.kind === q.kind);
        if (q.q) {
            const needle = q.q.toLowerCase();
            list = list.filter((e) => e.name.toLowerCase().includes(needle) || (e.page ?? "").toLowerCase().includes(needle) || describeLocatorWords(e.locator).toLowerCase().includes(needle));
        }
        if (q.test) list = list.filter((e) => (users.get(e.id) ?? []).some((u) => u.id === q.test));
        return { total: store.count(id), limit: MAX_ELEMENTS, elements: list.map((e) => publicElement(e, users.get(e.id) ?? [], false, held)) };
    });

    app.get("/api/projects/:id/objects/export", async (req, reply) => {
        const { id } = req.params as { id: string };
        project(id);
        return reply.header("content-disposition", 'attachment; filename="object-repository.json"').send({ version: 1, elements: store.list(id).map(toExported) });
    });

    app.get("/api/projects/:id/objects/:oid", async (req) => {
        const { id, oid } = req.params as { id: string; oid: string };
        project(id);
        const e = element(id, oid);
        return publicElement(e, usersOfElement(e), true);
    });

    // ── create ────────────────────────────────────────────────────────────────
    app.post("/api/projects/:id/objects", async (req, reply) => {
        const { id } = req.params as { id: string };
        project(id);
        const c = checkElement(req.body);
        if (!c.ok) throw new HttpError(400, c.error);
        if (store.count(id) >= MAX_ELEMENTS) throw new HttpError(400, `A project can have at most ${MAX_ELEMENTS} shared elements.`);
        try {
            return reply.code(201).send(publicElement(store.create(id, c.element), []));
        } catch (e) {
            return taken(e);
        }
    });

    // ── change: rename and/or new locator ─────────────────────────────────────
    app.put("/api/projects/:id/objects/:oid", async (req) => {
        const { id, oid } = req.params as { id: string; oid: string };
        project(id);
        const body = UpdateBody.parse(req.body);
        const cur = element(id, oid);
        if (body.kind !== undefined && body.kind !== cur.kind) throw new HttpError(400, "The kind of an element can't be changed. Create a new element instead.");
        if (body.expectedVersion !== undefined && body.expectedVersion !== cur.version) throw new HttpError(409, "Someone changed this element since you opened it. Reload it and try again.");
        const c = checkElement({
            name: body.name ?? cur.name,
            kind: cur.kind,
            locator: body.locator ?? cur.locator,
            page: body.page === undefined ? (cur.page ?? undefined) : (body.page ?? undefined),
            notes: body.notes === undefined ? (cur.notes ?? undefined) : (body.notes ?? undefined),
            ...(body.alternatives !== undefined ? { alternatives: body.alternatives } : cur.alternatives ? { alternatives: cur.alternatives } : {}),
        });
        if (!c.ok) throw new HttpError(400, c.error);
        const next = c.element;
        const alternativesChanged = JSON.stringify(next.alternatives ?? []) !== JSON.stringify(cur.alternatives ?? []);
        const locatorChanged = locatorKey(cur.kind, cur.locator) !== locatorKey(cur.kind, next.locator);
        const renamed = next.name !== cur.name;
        const detailsChanged = (next.page ?? null) !== cur.page || (next.notes ?? null) !== cur.notes || alternativesChanged;
        if (!locatorChanged && !renamed && !detailsChanged) return { ...publicElement(cur, usersOfElement(cur), true), appliesTo: 0, tests: [], revalidation: { status: "none" as const }, problems: [] };

        let updated: StoredElement;
        try {
            updated = p.db.tx(() => {
                const u = store.update(id, cur.id, { name: next.name, locator: next.locator, page: next.page ?? null, notes: next.notes ?? null, alternatives: next.alternatives ?? [] });
                // Every spec that referred to the old name now refers to the new one, or none of this happened.
                if (renamed) for (const t of repo.listTests(id)) if (refNames(t.spec).includes(cur.name)) repo.updateTest(t.id, { spec: renameRefs(t.spec, cur.name, next.name), versionSource: "shared" });
                // Reusable steps that use the element follow the new name too.
                if (renamed) {
                    const blockStore = new BlockStore(p.db);
                    for (const b of blockStore.list(id)) {
                        const asSpec = { steps: b.steps } as Parameters<typeof refNames>[0];
                        if (refNames(asSpec).includes(cur.name)) blockStore.update(id, b.id, { name: b.name, kind: b.kind, params: b.params, steps: renameRefs(asSpec, cur.name, next.name).steps, ...(b.description ? { description: b.description } : {}) });
                    }
                }
                return u;
            });
        } catch (e) {
            return taken(e);
        }
        const users = svc.usersOf(id, updated.name);
        let outcome: Propagation = { appliesTo: users.length, tests: users.map(briefTest), revalidation: { status: "none" }, problems: [] };
        if (locatorChanged) outcome = await svc.propagate(id, users.map((u) => u.id), updated.name);
        else if (renamed || detailsChanged) outcome.problems = await svc.rerender(id, users.map((u) => u.id));
        return { ...publicElement(updated, usersOfElement(updated), true), ...outcome };
    });

    // ── delete ────────────────────────────────────────────────────────────────
    app.delete("/api/projects/:id/objects/:oid", async (req, reply) => {
        const { id, oid } = req.params as { id: string; oid: string };
        project(id);
        const e = element(id, oid);
        const users = svc.usersOf(id, e.name);
        if (users.length) {
            throw new HttpError(409, `'${e.name}' is used by ${users.length} test${users.length === 1 ? "" : "s"}: ${testsLine(users)}. Change those steps first, then delete the element.`, { tests: users.map(briefTest) });
        }
        // Reusable steps that refer to the element would break the next time a test uses them.
        const inBlocks = new BlockStore(p.db).list(id).filter((b) => refNames({ steps: b.steps } as Parameters<typeof refNames>[0]).includes(e.name));
        if (inBlocks.length) {
            throw new HttpError(409, `'${e.name}' is used by the reusable steps ${inBlocks.slice(0, MESSAGE_MAX_TESTS).map((b) => `“${b.name}”`).join(", ")}${inBlocks.length > MESSAGE_MAX_TESTS ? ` and ${inBlocks.length - MESSAGE_MAX_TESTS} more` : ""}. Change those steps first, then delete the element.`, { blocks: inBlocks.map((b) => b.name) });
        }
        store.remove(e.id);
        return reply.code(204).send();
    });

    // ── import ────────────────────────────────────────────────────────────────
    app.post("/api/projects/:id/objects/import", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        const body = ImportBody.parse(req.body);
        const details: Array<{ index: number; issues: unknown }> = [];
        const incoming: ExportedElement[] = [];
        const seen = new Set<string>();
        body.elements.forEach((raw, index) => {
            const c = checkElement(raw);
            if (!c.ok) return void details.push({ index, issues: [{ message: c.error }] });
            const key = c.element.name.toLowerCase();
            if (seen.has(key)) return void details.push({ index, issues: [{ message: `'${c.element.name}' appears twice in the file.` }] });
            seen.add(key);
            incoming.push(c.element);
        });
        if (details.length) throw new HttpError(400, "Invalid elements", details);
        const existing = new Map(store.list(id).map((e) => [e.name.toLowerCase(), e]));
        const fresh = incoming.filter((e) => !existing.has(e.name.toLowerCase()));
        const clashes = incoming.filter((e) => {
            const have = existing.get(e.name.toLowerCase());
            return have && (have.kind !== e.kind || locatorKey(have.kind, have.locator) !== locatorKey(e.kind, e.locator));
        });
        if (clashes.length && !body.overwrite) {
            throw new HttpError(409, `${clashes.length} element${clashes.length === 1 ? " is" : "s are"} already in the repository with a different locator: ${clashes.slice(0, MESSAGE_MAX_TESTS).map((c) => `'${c.name}'`).join(", ")}. Import again with overwrite to replace ${clashes.length === 1 ? "it" : "them"}.`, { names: clashes.map((c) => c.name) });
        }
        if (existing.size + fresh.length > MAX_ELEMENTS) throw new HttpError(400, `A project can have at most ${MAX_ELEMENTS} shared elements.`);
        const kindChanges = clashes.filter((c) => existing.get(c.name.toLowerCase())!.kind !== c.kind);
        if (kindChanges.length) throw new HttpError(400, `'${kindChanges[0]!.name}' is in the repository as another kind of element; the kind can't change.`);
        p.db.tx(() => {
            for (const e of fresh) store.create(id, e);
            for (const e of clashes) {
                const have = existing.get(e.name.toLowerCase())!;
                store.update(id, have.id, { locator: e.locator, page: e.page ?? null, notes: e.notes ?? null, alternatives: e.alternatives ?? [] });
            }
        });
        // Replaced elements are edits like any other: the tests that use them are rendered again and validated again.
        const touched = new Set<string>();
        for (const e of clashes) for (const u of svc.usersOf(id, existing.get(e.name.toLowerCase())!.name)) touched.add(u.id);
        const outcome = touched.size ? await svc.propagate(id, [...touched], clashes.map((c) => c.name).join(", ")) : undefined;
        return {
            created: fresh.length,
            updated: clashes.length,
            unchanged: incoming.length - fresh.length - clashes.length,
            ...(outcome ? { appliesTo: outcome.appliesTo, revalidation: outcome.revalidation } : {}),
        };
    });

    // ── extract shared locators ───────────────────────────────────────────────
    const proposals = (projectId: string, minUses?: number): ExtractProposal[] =>
        proposeExtraction(
            // A hand-written test is not generated from steps, so there is nothing to share elements into.
            repo.listTests(projectId).filter((t) => !new CustomScriptStore(repo.db).isCustom(t.id)).map((t) => ({ id: t.id, testKey: t.testKey, title: t.title, spec: t.spec })),
            { existing: store.list(projectId), ...(minUses ? { minUses } : {}) },
        );
    const publicProposal = (x: ExtractProposal) => ({
        key: x.key,
        name: x.name,
        kind: x.kind,
        page: x.page ?? null,
        locator: x.locator,
        description: describeLocatorWords(x.locator),
        uses: x.uses.length,
        tests: [...new Map(x.uses.map((u) => [u.testId, u])).values()].slice(0, 5).map((u) => ({ id: u.testId, testId: u.testKey, title: u.title })),
        testCount: new Set(x.uses.map((u) => u.testId)).size,
        existing: x.existing ?? null,
    });

    app.post("/api/projects/:id/objects/extract", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        const body = ExtractBody.parse(req.body ?? {});
        if (body.dryRun) return { dryRun: true, proposals: proposals(id, body.minUses).map(publicProposal) };
        // A locator the person picked from a preview is found even if it is used in one place only (they asked for it by name).
        const found = proposals(id, body.all ? body.minUses : 1);

        // Nothing is rewritten unless the person says which proposals to apply.
        if (!body.all && !body.apply?.length) throw new HttpError(400, "Choose which shared elements to create (apply: [{ key }]), or pass all: true after looking at the preview.");
        const chosen = body.all ? found.map((x) => ({ x, name: undefined as string | undefined })) : body.apply!.map((a) => ({ x: found.find((f) => f.key === a.key), name: a.name })).filter((c): c is { x: ExtractProposal; name: string | undefined } => Boolean(c.x));
        const skipped = body.all ? [] : body.apply!.filter((a) => !found.some((f) => f.key === a.key)).map((a) => ({ key: a.key, reason: "No test uses this locator any more." }));
        if (!chosen.length) throw new HttpError(409, "None of those proposals is available any more. Look at the preview again.");

        // Names are decided and checked before anything changes.
        const plan: Array<{ x: ExtractProposal; name: string; create: boolean; page?: string }> = [];
        const used = new Set(store.list(id).map((e) => e.name.toLowerCase()));
        for (const { x, name } of chosen) {
            if (x.existing) {
                plan.push({ x, name: x.existing, create: false });
                continue;
            }
            const c = checkElement({ name: name ?? x.name, kind: x.kind, locator: x.locator, page: x.page });
            if (!c.ok) throw new HttpError(400, c.error);
            if (used.has(c.element.name.toLowerCase())) throw new HttpError(409, `The name '${c.element.name}' is already taken (or chosen twice). Pick another one.`);
            used.add(c.element.name.toLowerCase());
            plan.push({ x, name: c.element.name, create: true, ...(c.element.page ? { page: c.element.page } : {}) });
        }
        if (store.count(id) + plan.filter((q) => q.create).length > MAX_ELEMENTS) throw new HttpError(400, `A project can have at most ${MAX_ELEMENTS} shared elements.`);

        const created: StoredElement[] = [];
        let stepsRewritten = 0;
        const touched = new Set<string>();
        p.db.tx(() => {
            const byTest = new Map<string, Map<number, string>>();
            for (const q of plan) {
                if (q.create) created.push(store.create(id, { name: q.name, kind: q.x.kind, locator: q.x.locator, ...(q.page ? { page: q.page } : {}) }));
                for (const u of q.x.uses) {
                    const m = byTest.get(u.testId) ?? new Map<number, string>();
                    m.set(u.stepIndex, q.name);
                    byTest.set(u.testId, m);
                }
            }
            for (const [testId, names] of byTest) {
                const t = repo.getTest(testId);
                if (!t) continue;
                repo.updateTest(testId, { spec: useRefsAt(t.spec, names) });
                stepsRewritten += names.size;
                touched.add(testId);
            }
        });
        return { dryRun: false, created: created.map((e) => publicElement(e, store.usersOf(e.id))), reused: plan.filter((q) => !q.create).length, tests: touched.size, steps: stepsRewritten, skipped };
    });

    // ── make one step's locator shared ────────────────────────────────────────
    app.post("/api/tests/:id/steps/:index/share", async (req, reply) => {
        const { id, index } = req.params as { id: string; index: string };
        const t = repo.getTest(id);
        if (!t) throw new HttpError(404, "Test not found");
        const body = ShareBody.parse(req.body ?? {});
        const i = Number(index);
        const step = Number.isInteger(i) ? t.spec.steps[i] : undefined;
        if (!step) throw new HttpError(404, "Step not found");
        const loc = locatorOf(step);
        if (!loc) throw new HttpError(409, "That step does not look for an element.");
        if (refOf(loc) !== undefined) throw new HttpError(409, `That step already uses the shared element '${refOf(loc)}'.`);
        if (!(ELEMENT_KINDS as readonly string[]).includes(t.spec.kind)) throw new HttpError(409, "Only web, mobile and desktop tests have elements to share.");
        const kind = t.spec.kind as ElementKind;

        const same = proposals(t.projectId, 1).find((x) => x.kind === kind && locatorKey(kind, x.locator) === locatorKey(kind, loc));
        // The suggestion for the name comes from the same rules the extraction uses.
        const wanted = body.name ?? same?.name;
        if (!wanted) throw new HttpError(409, "This locator can't be shared as it is (it depends on test data).");
        const existing = same?.existing ? store.getByName(t.projectId, same.existing) : undefined;
        let created: StoredElement | undefined;
        let el = existing;
        const uses = body.everywhere && same ? same.uses : [{ testId: t.id, testKey: t.testKey, title: t.title, stepIndex: i }];
        p.db.tx(() => {
            if (!el) {
                const c = checkElement({ name: wanted, kind, locator: loc, page: body.page ?? same?.page, notes: body.notes });
                if (!c.ok) throw new HttpError(400, c.error);
                if (store.count(t.projectId) >= MAX_ELEMENTS) throw new HttpError(400, `A project can have at most ${MAX_ELEMENTS} shared elements.`);
                try {
                    created = el = store.create(t.projectId, c.element);
                } catch (e) {
                    taken(e);
                }
            }
            const byTest = new Map<string, Map<number, string>>();
            for (const u of uses) byTest.set(u.testId, (byTest.get(u.testId) ?? new Map<number, string>()).set(u.stepIndex, el!.name));
            for (const [testId, names] of byTest) {
                const row = repo.getTest(testId);
                if (row) repo.updateTest(testId, { spec: useRefsAt(row.spec, names) });
            }
        });
        const users = store.usersOf(el!.id);
        return reply.code(created ? 201 : 200).send({ element: publicElement(el!, users, true), steps: uses.length, tests: new Set(uses.map((u) => u.testId)).size });
    });
}

// ───────────────────────────────────────────────────────────────────────────────
// Shared by the routes above and by healing: finding the users of an element, rendering their scripts again and having them
// validated again.
// ───────────────────────────────────────────────────────────────────────────────

export interface BriefTest {
    id: string;
    testId: string;
    title: string;
}
const briefTest = (u: { id: string; testKey: string; title: string }): BriefTest => ({ id: u.id, testId: u.testKey, title: u.title });

export interface Propagation {
    /** How many tests use the element (and so changed with it). */
    appliesTo: number;
    tests: BriefTest[];
    revalidation: { status: "started"; jobId: string } | { status: "waiting"; message: string } | { status: "none"; message?: string };
    /** Tests whose script could not be rendered again, with the plain reason. */
    problems: Array<{ testId: string; error: string }>;
}

export function locatorServices(ctx: RouteCtx) {
    const { p, repo } = ctx;
    const store = new LocatorStore(p.db);

    /** The tests whose specs refer to `name`, read from the specs themselves (never from a cached table). */
    const usersOf = (projectId: string, name: string) => {
        const hand = new CustomScriptStore(repo.db).forProject(projectId);
        const tests = repo.listTests(projectId).filter((t) => !hand.has(t.id));
        // A test that uses the element through reusable steps uses it too: look at the steps it really has.
        const view = blockView(p.db, projectId);
        return scanUsage(tests.map((t) => ({ id: t.id, testKey: t.testKey, title: t.title, spec: view(t.spec) }))).get(name) ?? [];
    };

    /** Render each test's scripts again from its spec and the current elements. An unchanged script is not versioned again. */
    const rerender = async (projectId: string, testIds: string[]): Promise<Propagation["problems"]> => {
        const problems: Propagation["problems"] = [];
        const application = repo.getLatestApplicationPublic(projectId);
        if (!application) return problems;
        const url = application.url as string;
        const origin = isAppUri(url) ? url : new URL(url).origin;
        const objects = store.index(projectId);
        const blocks = blocksFor(p.db, projectId);
        const dataSets = dataSetsFor(repo, projectId);
        const renderCtx = await withProjectNotes(p.db, projectId, { baseUrl: origin, dataSets, ...(objects ? { objects } : {}), ...(blocks ? { blocks } : {}) });
        const hand = new CustomScriptStore(repo.db);
        for (const id of testIds) {
            const t = repo.getTest(id);
            // A hand-written test's script is the person's own code: it is never rendered again from its steps.
            if (!t || hand.isCustom(id)) continue;
            const slug = (repo.getSuite(t.suiteId)?.slug as string | undefined) ?? "general";
            const frameworks = [...new Set([t.framework as string, ...repo.listScripts(t.id).map((s) => String(s.framework))])];
            for (const fw of frameworks) {
                if (!hasAdapter(fw)) continue;
                try {
                    const adapter = getAdapter(fw);
                    const script = renderWithAdapter(t.spec, fw, renderCtx);
                    if (fw === t.framework) await storeScript(repo, p.store, projectId, t.id, slug, script, adapter.executable);
                    else {
                        // A script made for another framework (for example the mobile version of a web test) lives next to the main one.
                        const current = repo.getCurrentScript(t.id, fw);
                        if (current && current.content === script.content) continue;
                        const rel = path.posix.join(projectId, "_other", script.filename);
                        const stored = await putText(p.store, rel, script.content);
                        repo.addScript(t.id, { framework: script.framework, filename: script.filename, content: script.content, hash: stored.hash, storagePath: rel, executable: adapter.executable });
                    }
                } catch (e) {
                    problems.push({ testId: t.testKey, error: e instanceof Error ? e.message : String(e) });
                }
            }
        }
        return problems;
    };

    /**
     * An element's locator changed: render every test that uses it again, then have them validated again. If another job is
     * running (or the project cannot be run right now) the tests are marked as waiting for a run instead, with the reason.
     */
    const propagate = async (projectId: string, testIds: string[], elementName: string, subject: "shared element" | "reusable steps" = "shared element"): Promise<Propagation> => {
        const handWritten = new CustomScriptStore(repo.db);
        const tests = testIds.map((i) => repo.getTest(i)).filter((t): t is TestRow => t !== undefined && !handWritten.isCustom(t.id));
        const base = { appliesTo: tests.length, tests: tests.map((t) => ({ id: t.id, testId: t.testKey, title: t.title })) };
        if (!tests.length) return { ...base, revalidation: { status: "none", message: subject === "shared element" ? "No test uses this element yet." : "No test uses these steps yet." }, problems: [] };
        // An approved test that uses it does something nobody approved now: it waits to be approved again, unless a change by this person would not (review-store.ts).
        new ReviewStore(p.db).sharedPartChanged(tests.map((t) => t.id), `the ${subject} “${elementName}”`);
        const problems = await rerender(projectId, testIds);
        const reason = `The ${subject} “${elementName}” changed. Run this test again.`;
        let application: { id: string } | undefined;
        try {
            application = await ctx.applicationFor(projectId);
        } catch {
            application = undefined;
        }
        // From here on everything is synchronous: the busy check, the status change and the new job cannot be interleaved by another request.
        const busy = repo.listJobs(projectId).some((j) => !TERMINAL_STATES.includes(j.status));
        for (const t of tests) repo.updateTest(t.id, { validationStatus: "PENDING", reason });
        if (!application) return { ...base, revalidation: { status: "waiting", message: "The tests will be validated again the next time you run them." }, problems };
        if (busy) return { ...base, revalidation: { status: "waiting", message: "A run is in progress. These tests are marked as waiting; run them again when it has finished." }, problems };
        try {
            const job = await ctx.startValidationJob(projectId, application.id, tests.map((t) => t.id));
            return { ...base, revalidation: { status: "started", jobId: job.id }, problems };
        } catch (e) {
            const why = e instanceof HttpError ? e.message : "The run could not be started.";
            return { ...base, revalidation: { status: "waiting", message: `${why} The tests are marked as waiting; run them again when you can.` }, problems };
        }
    };

    return { store, usersOf, rerender, propagate };
}
