/**
 * Reusable steps (blocks), platform side: save, change, delete and extract blocks, and keep the tests that use them right.
 *
 * Rules that hold everywhere here (they mirror the object repository's, see routes/locators.ts):
 *  - nothing is stored when anything is wrong (all-or-nothing), and the answer says in plain words what to fix;
 *  - a block is judged the way a test that uses it would be: the same address guard, sign-in rule, secret checks and renderer, on the steps
 *    that will really run (`SpecEditService.evaluate` with the proposed blocks), so a block that saves is a block that renders;
 *  - a change to a block is judged against every test that uses it, directly or through another block: if one of them would break, nothing is saved
 *    and the answer lists them; otherwise those tests are rendered again and validated again like after a shared-element change;
 *  - a block that is used cannot be deleted; code tests are never touched (their script is the source of truth).
 */
import { blockClosure, expandBlocks, renameBlockRefs, scanBlockUsage, blockGraphProblems, checkBlockInput, indexBlocks, BLOCK_MARK, MAX_BLOCKS, MAX_BLOCK_STEPS, type BlockDef, type BlockIndex, type BlockUsage, type CheckedBlock } from "../engine/blocks/index.js";
import { blockSecretProblems, errorsOf, isEditableKind } from "../engine/builder/index.js";
import type { ObjectIndex } from "../engine/locators/refs.js";
import { defaultAdapterFor } from "../engine/frameworks/index.js";
import { TestSpecSchema, type Step, type TestSpec } from "../engine/spec/schema.js";
import { BlockNameTakenError, BlockStore, type StoredBlock } from "./block-store.js";
import { CustomScriptStore } from "./custom-script-store.js";
import { HttpError } from "./http-error.js";
import type { TestRow } from "./repo.js";
import { locatorServices, type Propagation } from "./routes/locators.js";
import type { RouteCtx } from "./routes/types.js";
import { SpecEditService } from "./spec-edit-service.js";

const SHOWN_TESTS = 5;
/** A value for a parameter that has none, when a block is checked on its own: a placeholder is never mistaken for a typed secret. */
const EXAMPLE_VALUE = "{{env.EXAMPLE}}";

const briefTest = (u: { id: string; testKey: string; title: string }) => ({ id: u.id, testId: u.testKey, title: u.title });
const testsLine = (users: Array<{ testKey: string; title: string }>): string => {
    const shown = users.slice(0, SHOWN_TESTS).map((u) => `${u.testKey} ${u.title}`);
    return shown.join(", ") + (users.length > shown.length ? ` and ${users.length - shown.length} more` : "");
};
const namesLine = (names: string[]): string => names.slice(0, SHOWN_TESTS).map((n) => `“${n}”`).join(", ") + (names.length > SHOWN_TESTS ? ` and ${names.length - SHOWN_TESTS} more` : "");

/** The same steps without the notes the engine adds to expanded ones, in one comparable text. */
const plainJson = (steps: readonly Step[]): string =>
    JSON.stringify(steps, (k, v) => (k === BLOCK_MARK ? undefined : v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

export interface ExtractBody {
    testId: string;
    from: number;
    to: number;
    name: string;
    description?: string;
    params?: Array<{ name: string; description?: string; default?: string; replace?: string }>;
}

export class BlockService {
    readonly store: BlockStore;
    private readonly edit: SpecEditService;
    private readonly shared: ReturnType<typeof locatorServices>;
    private readonly custom: CustomScriptStore;

    constructor(private readonly ctx: RouteCtx) {
        this.store = new BlockStore(ctx.p.db);
        this.edit = new SpecEditService(ctx);
        this.shared = locatorServices(ctx);
        this.custom = new CustomScriptStore(ctx.repo.db);
    }

    private get repo() {
        return this.ctx.repo;
    }

    /** The project's tests that are generated from steps (a code test uses no blocks). */
    private stepTests(projectId: string): TestRow[] {
        const hand = this.custom.forProject(projectId);
        return this.repo.listTests(projectId).filter((t) => !hand.has(t.id));
    }

    /** Who uses each block, from the specs and the blocks themselves. */
    usage(projectId: string, blocks: StoredBlock[] = this.store.list(projectId)): Map<string, BlockUsage> {
        return scanBlockUsage(this.stepTests(projectId).map((t) => ({ id: t.id, testKey: t.testKey, title: t.title, spec: t.spec })), blocks);
    }

    /** The {{values}} the step editor offers inside a block: the saved sign-in placeholders and the project's environment settings (a block has no test values of its own). */
    placeholders(projectId: string) {
        return this.edit.placeholders({ projectId, spec: { testData: {} } } as unknown as TestRow);
    }

    // ── checking ────────────────────────────────────────────────────────────

    /** A test-shaped stand-in used to judge a block on its own: it does nothing but run the block. */
    private standIn(projectId: string, kind: "web" | "api", def: BlockDef): { row: TestRow; input: unknown } {
        const spec = TestSpecSchema.parse({ testId: kind === "web" ? "WEB-000" : "API-000", title: "Check of reusable steps", kind, category: "Reusable steps", steps: [{ action: "navigate", url: "/" }], source: { origin: "manual" } });
        const args: Record<string, string> = {};
        for (const p of def.params) args[p.name] = p.default ?? EXAMPLE_VALUE;
        const row = { id: "", projectId, testKey: spec.testId, title: spec.title, kind, framework: defaultAdapterFor(kind).id, spec } as unknown as TestRow;
        return { row, input: { title: spec.title, description: "", testData: {}, steps: [{ action: "useBlock", block: def.name, ...(def.params.length ? { args } : {}) }] } };
    }

    /** What is wrong with one block of the proposed set when it is used on its own (empty = it renders and passes every rule). */
    private async standalone(projectId: string, proposed: BlockIndex, name: string, objects?: ObjectIndex): Promise<string[]> {
        const def = proposed.get(name);
        if (!def) return [`The reusable steps “${name}” are not in this project.`];
        const kinds: Array<"web" | "api"> = def.kind === "any" ? ["web", "api"] : [def.kind];
        let first: string[] | undefined;
        for (const kind of kinds) {
            const { row, input } = this.standIn(projectId, kind, def);
            const r = await this.edit.evaluate(row, input, { blocks: proposed, noApplicationOk: true, ...(objects ? { objects } : {}) });
            const problems = errorsOf(r.diagnostics).map((d) => d.message.replace(/^Step 1 \(step (\d+) of the reusable steps “[^”]*”\):\s*/, "Step $1: ").replace(/^Step 1:\s*/, ""));
            if (problems.length === 0) return [];
            first ??= problems;
        }
        return first ?? [];
    }

    /** The tests among `users` that would no longer be valid with the proposed blocks, each with the first reason. */
    private async breaking(projectId: string, proposed: BlockIndex, users: TestRow[], rename?: { from: string; to: string }): Promise<Array<{ test: TestRow; message: string }>> {
        const out: Array<{ test: TestRow; message: string }> = [];
        for (const t of users) {
            const spec = rename ? renameBlockRefs(t.spec, rename.from, rename.to) : t.spec;
            if (isEditableKind(t.kind)) {
                const r = await this.edit.evaluate({ ...t, spec } as TestRow, spec, { blocks: proposed, noApplicationOk: true });
                const errors = errorsOf(r.diagnostics);
                if (errors.length) out.push({ test: t, message: errors[0]!.message });
            } else {
                try {
                    expandBlocks(spec, proposed);
                } catch (e) {
                    out.push({ test: t, message: e instanceof Error ? e.message : String(e) });
                }
            }
        }
        return out;
    }

    /**
     * What to tell the person besides "saved", when the checks could not be complete:
     *  - the project has no application yet, so the address guard and the sign-in rule ran against a stand-in address;
     *  - reusable steps saved before the project's first application have not passed those checks against the real address yet (at most 20 are
     *    looked at per save; this only informs, it never stops a save).
     * Empty when there is nothing to say, so an answer stays what it was.
     */
    async notes(projectId: string, savedName?: string): Promise<string[]> {
        const app = this.repo.getLatestApplicationPublic(projectId);
        if (!app) return ["This project has no application yet, so these reusable steps were checked against a stand-in address. They are checked against the real one when a test uses them."];
        const first = this.ctx.p.db.get<{ at: string }>("SELECT MIN(created_at) AS at FROM applications WHERE project_id = ?", projectId)?.at;
        if (!first) return [];
        const all = this.store.list(projectId);
        const stale = all.filter((b) => b.updatedAt < first && b.name !== savedName).slice(0, 20);
        if (stale.length === 0) return [];
        const index = indexBlocks(all);
        const out: string[] = [];
        for (const b of stale) {
            const problems = await this.standalone(projectId, index, b.name);
            if (problems.length) out.push(`The reusable steps “${b.name}” were saved before this project had an application and do not pass the address and sign-in checks against it: ${problems[0]}`);
        }
        return out;
    }

    /**
     * What a change to the block `name` was judged against, in one comparable text: every set of reusable steps (and its version) and, for each test
     * that uses the block, its steps. Checking a change awaits (addresses are looked up), so it is read again inside the transaction that stores the
     * change: if it differs, someone changed something meanwhile and nothing is stored.
     */
    private basis(projectId: string, name: string): string {
        const blocks = this.store.list(projectId).map((b) => `${b.id}:${b.version}`);
        const users = (this.usage(projectId).get(name)?.tests ?? []).map((u) => `${u.id}:${JSON.stringify(this.repo.getTest(u.id)?.spec ?? null)}`);
        return JSON.stringify([blocks, users]);
    }

    private changedMeanwhile(): HttpError {
        return new HttpError(409, "Something that these reusable steps depend on was changed while they were being checked (another change to them, or to a test that uses them). Nothing was saved. Reload and try again.");
    }

    private refuse(message: string, problems: string[], status = 400): never {
        throw new HttpError(status, message, { problems });
    }

    // ── create ──────────────────────────────────────────────────────────────

    async create(projectId: string, input: unknown, by?: string): Promise<StoredBlock> {
        const c = checkBlockInput(input);
        if (!c.ok) throw new HttpError(400, c.error);
        if (this.store.count(projectId) >= MAX_BLOCKS) throw new HttpError(400, `A project can have at most ${MAX_BLOCKS} sets of reusable steps.`);
        if (this.store.get(projectId, c.block.name)) throw new BlockNameTakenError(c.block.name);
        const proposed = indexBlocks([...this.store.list(projectId), this.draft(c.block)]);
        await this.assertSound(projectId, proposed, [c.block.name]);
        const made = this.ctx.p.db.tx(() => this.store.create(projectId, c.block));
        this.custom.audit(projectId, null, "block-create", `Reusable steps “${made.name}” created${by ? ` by ${by}` : ""}`);
        return made;
    }

    private draft(b: CheckedBlock): BlockDef {
        return { name: b.name, kind: b.kind, params: b.params, steps: b.steps };
    }

    /** The graph rules and the standalone judgement of the named blocks; throws a 400 with the reasons. */
    private async assertSound(projectId: string, proposed: BlockIndex, names: string[]): Promise<void> {
        const graph = blockGraphProblems(proposed);
        if (graph.length) this.refuse(graph[0]!, graph);
        for (const n of names) {
            const problems = await this.standalone(projectId, proposed, n);
            if (problems.length) this.refuse(`The reusable steps “${n}” were not saved: ${problems[0]}`, problems);
        }
    }

    // ── import (a spec import that brings its reusable steps along) ─────────

    /**
     * The reusable steps an imported set of specs brings, judged as a whole before anything is stored: each one passes the rules of the blocks API
     * (size caps, names, a typed secret, a circle or too deep a chain, the address guard and the sign-in rule when it is used on its own).
     * A name the project already has must be the same steps (then it is reused); a different one with that name refuses the import.
     * `persist` stores the new ones. `objects` are the shared elements the same import brings, which a block may refer to.
     */
    async prepareImport(projectId: string, raw: unknown[] | undefined, objects?: ObjectIndex): Promise<{ index: BlockIndex | undefined; persist(): void }> {
        const existing = this.store.list(projectId);
        if (!raw?.length) return { index: existing.length ? indexBlocks(existing) : undefined, persist() {} };
        const checked: CheckedBlock[] = [];
        const details: Array<{ index: number; issues: unknown }> = [];
        const seen = new Set<string>();
        raw.forEach((r, index) => {
            const c = checkBlockInput(r);
            if (!c.ok) return void details.push({ index, issues: [{ message: c.error }] });
            const secrets = blockSecretProblems(c.block);
            if (secrets.length) return void details.push({ index, issues: [{ message: `The reusable steps “${c.block.name.slice(0, 40)}” hold what looks like a real secret. ${secrets[0]}` }] });
            const key = c.block.name.toLowerCase();
            if (seen.has(key)) return void details.push({ index, issues: [{ message: `The reusable steps “${c.block.name.slice(0, 40)}” appear twice in this import.` }] });
            seen.add(key);
            checked.push(c.block);
        });
        if (details.length) throw new HttpError(400, "Invalid reusable steps", details);
        const fresh: CheckedBlock[] = [];
        for (const b of checked) {
            const have = existing.find((x) => x.name.toLowerCase() === b.name.toLowerCase());
            if (!have) fresh.push(b);
            else if (have.name !== b.name || have.kind !== b.kind || plainJson(have.steps) !== plainJson(b.steps) || plainJson(have.params as never) !== plainJson(b.params as never)) {
                throw new HttpError(409, `This project already has reusable steps called “${have.name.slice(0, 60)}” that are different from the ones in this import. Rename or change one of them, then import again.`);
            }
        }
        if (existing.length + fresh.length > MAX_BLOCKS) throw new HttpError(400, `A project can have at most ${MAX_BLOCKS} sets of reusable steps.`);
        const merged = indexBlocks([...existing, ...fresh.map((b) => this.draft(b))]);
        const graph = blockGraphProblems(merged);
        if (graph.length) this.refuse(`The reusable steps in this import were not accepted: ${graph[0]}`, graph);
        for (const b of fresh) {
            const problems = await this.standalone(projectId, merged, b.name, objects);
            if (problems.length) this.refuse(`The reusable steps “${b.name}” in this import were not accepted: ${problems[0]}`, problems);
        }
        return {
            index: merged,
            persist: () => {
                this.ctx.p.db.tx(() => {
                    for (const b of fresh) {
                        this.store.create(projectId, b);
                        this.custom.audit(projectId, null, "block-create", `Reusable steps “${b.name}” created by a spec import`);
                    }
                });
            },
        };
    }

    // ── change ──────────────────────────────────────────────────────────────

    async update(projectId: string, name: string, input: unknown, o: { expectedVersion?: number; by?: string } = {}): Promise<{ block: StoredBlock; outcome: Propagation }> {
        const cur = this.store.get(projectId, name);
        if (!cur) throw new HttpError(404, "Reusable steps not found");
        if (o.expectedVersion !== undefined && o.expectedVersion !== cur.version) throw new HttpError(409, "Someone changed these reusable steps since you opened them. Reload them and try again.");
        const merged = { name: cur.name, description: cur.description ?? undefined, kind: cur.kind, params: cur.params, steps: cur.steps, ...(input && typeof input === "object" ? input : {}) };
        const c = checkBlockInput(merged);
        if (!c.ok) throw new HttpError(400, c.error);
        const next = c.block;
        const renamed = next.name !== cur.name;
        const stepsChanged = plainJson(next.steps) !== plainJson(cur.steps) || JSON.stringify(next.params) !== JSON.stringify(cur.params) || next.kind !== cur.kind;
        const detailsChanged = (next.description ?? null) !== cur.description;
        if (!stepsChanged && !renamed && !detailsChanged) return { block: cur, outcome: { appliesTo: 0, tests: [], revalidation: { status: "none" }, problems: [] } };

        const others = this.store.list(projectId).filter((b) => b.id !== cur.id);
        if (renamed && others.some((b) => b.name.toLowerCase() === next.name.toLowerCase())) throw new BlockNameTakenError(next.name);
        // The proposed set: this block changed, and the other blocks that used it under its old name follow a rename.
        const renameInOthers = (b: StoredBlock): BlockDef => ({ name: b.name, kind: b.kind, params: b.params, steps: renamed ? renameBlockRefs({ steps: b.steps }, cur.name, next.name).steps : b.steps });
        const proposed = indexBlocks([...others.map(renameInOthers), this.draft(next)]);

        const usage = this.usage(projectId).get(cur.name);
        const users = usage ? usage.tests.map((u) => this.repo.getTest(u.id)).filter((t): t is TestRow => t !== undefined) : [];
        const basis = this.basis(projectId, cur.name);
        // Every other block that reaches this one (directly or through a third) is judged too: a changed parameter can break the call inside it.
        const before = indexBlocks(this.store.list(projectId));
        const affectedBlocks = others.filter((b) => blockClosure([b.name], before).has(cur.name)).map((b) => b.name);

        if (stepsChanged || renamed) {
            await this.assertSound(projectId, proposed, [next.name, ...affectedBlocks]);
            const broken = await this.breaking(projectId, proposed, users, renamed ? { from: cur.name, to: next.name } : undefined);
            if (broken.length) {
                throw new HttpError(
                    409,
                    `This change would break ${broken.length} test${broken.length === 1 ? "" : "s"}: ${testsLine(broken.map((b) => b.test))}. ${broken[0]!.test.testKey}: ${broken[0]!.message} Nothing was saved.`,
                    { tests: broken.map((b) => ({ ...briefTest(b.test), problem: b.message })) },
                );
            }
        }

        const updated: StoredBlock = this.ctx.p.db.tx(() => {
                // One transaction, with what the checks relied on read again inside it (there is no await in here): no lost update.
                if (this.basis(projectId, cur.name) !== basis) throw this.changedMeanwhile();
                const u = this.store.update(projectId, cur.id, next);
                if (renamed) {
                    // Every spec and every block that used the old name now uses the new one, or none of this happened.
                    for (const t of this.stepTests(projectId)) {
                        const changed = renameBlockRefs(t.spec, cur.name, next.name);
                        if (changed !== t.spec) this.repo.updateTest(t.id, { spec: changed });
                    }
                    for (const b of others) {
                        const steps = renameBlockRefs({ steps: b.steps }, cur.name, next.name).steps;
                        if (steps !== b.steps) this.store.update(projectId, b.id, { name: b.name, kind: b.kind, params: b.params, steps, ...(b.description ? { description: b.description } : {}) });
                    }
                }
                return u;
            });
        this.custom.audit(projectId, null, "block-update", `Reusable steps “${updated.name}” changed${renamed ? ` (was “${cur.name}”)` : ""}${o.by ? ` by ${o.by}` : ""}`);

        // Tests that use the block, directly or through another block, are rendered again; when the steps changed they are validated again.
        const fresh = this.usage(projectId).get(updated.name);
        const ids = (fresh?.tests ?? []).map((t) => t.id);
        let outcome: Propagation = { appliesTo: ids.length, tests: (fresh?.tests ?? []).map(briefTest), revalidation: { status: "none" }, problems: [] };
        if (stepsChanged) outcome = await this.shared.propagate(projectId, ids, updated.name, "reusable steps");
        else if (renamed) outcome.problems = await this.shared.rerender(projectId, ids);
        return { block: updated, outcome };
    }

    // ── delete ──────────────────────────────────────────────────────────────

    delete(projectId: string, name: string, by?: string): void {
        const b = this.store.get(projectId, name);
        if (!b) throw new HttpError(404, "Reusable steps not found");
        const u = this.usage(projectId).get(b.name);
        if (u && (u.tests.length || u.blocks.length)) {
            const parts = [u.tests.length ? `${u.tests.length} test${u.tests.length === 1 ? "" : "s"}: ${testsLine(u.tests)}` : "", u.blocks.length ? `the reusable steps ${namesLine(u.blocks)}` : ""].filter(Boolean);
            throw new HttpError(409, `“${b.name}” is used by ${parts.join(" and by ")}. Change those first, then delete these steps.`, { tests: u.tests.map(briefTest), blocks: u.blocks });
        }
        this.store.remove(b.id);
        this.custom.audit(projectId, null, "block-delete", `Reusable steps “${b.name}” deleted${by ? ` by ${by}` : ""}`);
    }

    // ── extract steps of a test ─────────────────────────────────────────────

    async extract(projectId: string, body: ExtractBody, by?: string): Promise<{ block: StoredBlock; testId: string; steps: number }> {
        const t = this.repo.getTest(body.testId);
        if (!t || t.projectId !== projectId) throw new HttpError(404, "Test not found");
        if (this.custom.isCustom(t.id)) throw new HttpError(409, "This is a code test, so it has no steps to turn into reusable steps.");
        const state = this.edit.editState(t);
        if (!state.editable) throw new HttpError(409, state.reason ?? "This test cannot be changed right now.");
        const steps = t.spec.steps;
        if (!Number.isInteger(body.from) || !Number.isInteger(body.to) || body.from < 0 || body.to < body.from || body.to >= steps.length) throw new HttpError(400, `Choose consecutive steps of this test (it has ${steps.length}).`);
        const range = steps.slice(body.from, body.to + 1);
        if (range.length > MAX_BLOCK_STEPS) throw new HttpError(400, `Reusable steps can have at most ${MAX_BLOCK_STEPS} steps; you chose ${range.length}.`);
        if (this.store.count(projectId) >= MAX_BLOCKS) throw new HttpError(400, `A project can have at most ${MAX_BLOCKS} sets of reusable steps.`);

        // Parameters: the text a parameter stands for is replaced by {{name}} in the block, and the call gives that text back, so the script does not change.
        let blockSteps: Step[] = JSON.parse(JSON.stringify(range)) as Step[];
        const params: Array<{ name: string; description?: string; default?: string }> = [];
        const args: Record<string, string> = {};
        for (const p of body.params ?? []) {
            if (p.replace !== undefined && p.replace !== "") {
                blockSteps = replaceText(blockSteps, p.replace, `{{${p.name}}}`);
                if (!JSON.stringify(blockSteps).includes(`{{${p.name}}}`)) throw new HttpError(400, `The text “${p.replace.slice(0, 40)}” for the parameter “${p.name}” is not in the steps you chose.`);
                args[p.name] = p.replace;
                params.push({ name: p.name, ...(p.description ? { description: p.description } : {}), default: p.default ?? p.replace });
            } else if (p.default !== undefined && p.default !== "") {
                params.push({ name: p.name, ...(p.description ? { description: p.description } : {}), default: p.default });
            } else throw new HttpError(400, `The parameter “${p.name}” needs a default value, or the text in the steps that it stands for.`);
        }
        const c = checkBlockInput({ name: body.name, description: body.description, kind: t.kind, params, steps: blockSteps });
        if (!c.ok) throw new HttpError(400, c.error);
        if (this.store.get(projectId, c.block.name)) throw new BlockNameTakenError(c.block.name);

        const call: Step = { action: "useBlock", block: c.block.name, description: "", ...(Object.keys(args).length ? { args } : {}) } as Step;
        const existing = this.store.list(projectId);
        const basisBlocks = JSON.stringify(existing.map((b) => `${b.id}:${b.version}`));
        const proposed = indexBlocks([...existing, this.draft(c.block)]);
        const nextSpec: TestSpec = { ...t.spec, steps: [...steps.slice(0, body.from), call, ...steps.slice(body.to + 1)] };

        await this.assertSound(projectId, proposed, [c.block.name]);
        // The test as it would be: judged by the same rules as a save in the step editor (this is where the sign-in rule can refuse a range).
        const r = await this.edit.evaluate(t, nextSpec, { blocks: proposed, noApplicationOk: true });
        const errors = errorsOf(r.diagnostics);
        if (errors.length) this.refuse(`These steps can't become reusable steps: ${errors[0]!.message}`, errors.map((e) => e.message), 409);
        // The steps that run must be exactly the steps that ran before, so the script does not change and the test needs no new run.
        const before = expandBlocks(t.spec, indexBlocks(existing)).steps;
        const after = expandBlocks(nextSpec, proposed).steps;
        if (plainJson(before) !== plainJson(after)) this.refuse("These steps can't become reusable steps without changing what the test does. Choose other steps or other parameters.", [], 409);

        const made = this.ctx.p.db.tx(() => {
            // The test and the sets are read again inside the transaction: a save of the same test (or a set with this name) meanwhile means nothing is stored.
            const now = this.repo.getTest(t.id);
            if (!now || JSON.stringify(now.spec) !== JSON.stringify(t.spec) || JSON.stringify(this.store.list(projectId).map((b) => `${b.id}:${b.version}`)) !== basisBlocks) throw this.changedMeanwhile();
            const b = this.store.create(projectId, c.block);
            if (this.edit.versions.latest(t.id) === 0) this.edit.versions.add(t.id, t.spec, "Before the first edit");
            this.edit.versions.add(t.id, nextSpec, `Steps ${body.from + 1} to ${body.to + 1} became the reusable steps “${b.name}”`);
            this.repo.updateTest(t.id, { spec: nextSpec });
            this.custom.audit(projectId, t.id, "block-extract", `${t.testKey} steps ${body.from + 1} to ${body.to + 1} became “${b.name}”${by ? ` by ${by}` : ""}`);
            return b;
        });
        // Same script, so the validation result stays; the stored copy is rendered again for every framework the test has.
        await this.shared.rerender(projectId, [t.id]);
        return { block: made, testId: t.id, steps: range.length };
    }
}

/** The steps with every occurrence of `from` in their text fields replaced by `to` (the words that say what a step does, and how an element is found, stay as they are). */
function replaceText(steps: Step[], from: string, to: string): Step[] {
    const walk = (v: unknown, path: string[]): unknown => {
        if (typeof v === "string") {
            const structural = (path.length === 1 && ["action", "check", "method", "auth", "block"].includes(path[0]!)) || (path.length === 2 && path[0] === "locator" && (path[1] === "by" || path[1] === "ref"));
            return structural ? v : v.split(from).join(to);
        }
        if (path.length > 30) return v;
        if (Array.isArray(v)) return v.map((x) => walk(x, [...path, ""]));
        if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, [...path, k])]));
        return v;
    };
    return steps.map((s) => walk(s, []) as Step);
}
