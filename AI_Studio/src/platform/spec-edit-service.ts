/**
 * The step editor's platform side: read a generated test's steps, check an edited version, save it (new script, history, a normal
 * validation job) and start a test from scratch. The routes (routes/spec-edit.ts) call this.
 *
 * Rules that hold everywhere here:
 *  - the canonical spec stays the source of truth: a save stores the spec, then the script is rendered from it again (never edited);
 *  - a code test is not edited here (its script is the source of truth; the answer says "take it over" instead);
 *  - what is checked on a save is exactly what is checked on a preview, so a preview that looks fine is a save that works;
 *  - nothing is stored when anything is wrong (all-or-nothing), and a preview never stores anything;
 *  - saving never runs the test by itself: the normal validation job is queued, or the answer says in plain words why not.
 */
import { blockOfStep, expandBlocks, sourceIndexes } from "../engine/blocks/expand.js";
import type { BlockIndex } from "../engine/blocks/model.js";
import type { ObjectIndex } from "../engine/locators/refs.js";
import { blocksFor } from "./block-store.js";
import { blankSpec, builderCatalog, checkSpecInput, errorsOf, isEditableKind, normalised, type BuilderDiagnostic } from "../engine/builder/index.js";
import { isAppUri } from "../engine/desktop/target.js";
import { defaultAdapterFor, getAdapter, hasAdapter, renderWithAdapter } from "../engine/frameworks/index.js";
import { dataSetNameOf } from "../engine/testdata/dataset.js";
import { allowedCredentialOrigins, credentialOriginProblems } from "../engine/spec/credential-origin.js";
import { interpolate, type TestSpec } from "../engine/spec/schema.js";
import { IdentityStore, toPublic as publicRole } from "./identity-store.js";
import { SecretBox } from "./secrets.js";
import { CustomScripts } from "./custom-scripts.js";
import { DataSetStore } from "./environments-store.js";
import { environmentStore } from "./environment-run.js";
import { FrameworkSettingsStore, turnedOffForSpecs } from "./framework-settings-store.js";
import { HttpError } from "./http-error.js";
import { LocatorStore } from "./locator-store.js";
import { placeholderCanMoveAddress } from "../engine/spec/run-address.js";
import { assertAllowedTarget } from "./net-guard.js";
import { storeScript } from "./repo-sink.js";
import { TERMINAL_STATES, type TestRow } from "./repo.js";
import { dataDrivenSpecIssues, dataSetsFor } from "./routes/environments.js";
import { locatorServices } from "./routes/locators.js";
import type { RouteCtx } from "./routes/types.js";
import { SpecVersionStore } from "./spec-version-store.js";
import { slugify } from "./storage.js";

const KEY_PREFIX = { web: "WEB", api: "API" } as const;
/** Stands in for the application's address when reusable steps are checked in a project that has no application yet (nothing is ever sent there). */
export const PLACEHOLDER_ORIGIN = "https://application.invalid";

export interface EditState {
    editable: boolean;
    reason?: string;
    /** True when the only thing in the way is a run in progress: asking again later works. */
    busy?: boolean;
    custom?: boolean;
}

export interface Evaluated {
    spec?: TestSpec;
    diagnostics: BuilderDiagnostic[];
    script?: { content: string; filename: string };
}

export class SpecEditService {
    readonly versions: SpecVersionStore;
    private readonly custom: CustomScripts;

    constructor(private readonly ctx: RouteCtx) {
        this.versions = new SpecVersionStore(ctx.p.db);
        this.custom = new CustomScripts({ p: ctx.p, repo: ctx.repo, applicationFor: ctx.applicationFor, startValidationJob: ctx.startValidationJob });
    }

    private get repo() {
        return this.ctx.repo;
    }

    test(id: string): TestRow {
        const t = this.repo.getTest(id);
        if (!t) throw new HttpError(404, "Test not found");
        return t;
    }

    private projectBusy(projectId: string): boolean {
        return this.repo.listJobs(projectId).some((j) => !TERMINAL_STATES.includes(j.status));
    }

    /** Can this test's steps be edited right now, and if not, why not in plain words. */
    editState(t: TestRow): EditState {
        if (this.custom.store.isCustom(t.id)) return { editable: false, custom: true, reason: "This is a code test, so its script is the source of truth. Edit the code instead." };
        if (!isEditableKind(t.kind)) return { editable: false, reason: "Only web and API tests can be edited step by step for now." };
        if (!hasAdapter(t.framework)) return { editable: false, reason: "This test uses a testing framework that is not available here, so its steps cannot be edited." };
        if (!this.repo.getLatestApplicationPublic(t.projectId)) return { editable: false, reason: "This project has no application yet, so the script cannot be created from the steps." };
        if (this.projectBusy(t.projectId)) return { editable: false, busy: true, reason: "A run is in progress for this project. Wait for it to finish, then edit the steps." };
        return { editable: true };
    }

    /** What the project offers as {{placeholders}}: names only, never a value. */
    placeholders(t: TestRow): { values: string[]; credentials: string[]; env: string[]; dataSet?: string } {
        const projectId = t.projectId;
        const dataSet = dataSetNameOf(t.spec.testData);
        const columns = dataSet ? (new DataSetStore(this.ctx.p.db).get(projectId, dataSet)?.columns ?? []) : [];
        const values = ["unique", ...columns, ...Object.keys(t.spec.testData).filter((k) => k !== "dataSet")];
        const credentials = ["credentials.username", "credentials.password", "credentials.totp"];
        try {
            for (const r of new IdentityStore(this.ctx.p.db, new SecretBox(this.ctx.p.config.dataDir, this.ctx.p.config.SECRET_KEY)).get(projectId).map(publicRole)) {
                credentials.push(`credentials.${r.name}.username`);
                if (r.hasPassword) credentials.push(`credentials.${r.name}.password`);
                if (r.hasTotp) credentials.push(`credentials.${r.name}.totp`);
            }
        } catch {
            /* an unreadable roles blob (the encryption key changed) just offers the basic names */
        }
        const env = new Set<string>();
        for (const e of environmentStore(this.repo, this.ctx.p.config).list(projectId)) for (const k of Object.keys(e.variables)) env.add(`env.${k}`);
        return { values: [...new Set(values)], credentials, env: [...env].sort(), ...(dataSet ? { dataSet } : {}) };
    }

    describe(testId: string) {
        const t = this.test(testId);
        const state = this.editState(t);
        return {
            testId: t.id,
            projectId: t.projectId,
            key: t.testKey,
            kind: t.kind,
            title: t.title,
            validationStatus: t.validationStatus,
            spec: t.spec,
            ...state,
            kinds: builderCatalog(),
            placeholders: this.placeholders(t),
            versions: this.versions.latest(t.id),
        };
    }

    // ── checking ────────────────────────────────────────────────────────────

    /** The address of the application the test runs against, as the scripts see it. */
    private origin(projectId: string): string {
        const url = this.repo.getLatestApplicationPublic(projectId)?.url as string | undefined;
        if (!url) throw new HttpError(409, "This project has no application yet, so the script cannot be created from the steps.");
        return isAppUri(url) ? url : new URL(url).origin;
    }

    /** Every address a step can reach goes through the same outbound guard as an imported spec. */
    private async addressProblems(spec: TestSpec, origin: string): Promise<BuilderDiagnostic[]> {
        const out: BuilderDiagnostic[] = [];
        if (isAppUri(origin)) return out;
        for (const [i, step] of spec.steps.entries()) {
            const raw = step.action === "navigate" ? step.url : step.action === "request" ? step.path : undefined;
            if (raw === undefined) continue;
            const value = interpolate(raw, spec.testData).trim();
            if (/^\{\{/.test(value) && process.env.BLOCK_PRIVATE_TARGETS === "true") {
                out.push({ stepIndex: i, severity: "error", message: `Step ${i + 1}: the address must not start with a {{placeholder}}.` });
                continue;
            }
            // Nor may one change the scheme or the host further on (`f{{p}}`, `https://{{p}}.example/`, `/{{p}}`).
            if (placeholderCanMoveAddress(value) && process.env.BLOCK_PRIVATE_TARGETS === "true") {
                out.push({ stepIndex: i, severity: "error", message: `Step ${i + 1}: a {{placeholder}} must come after the site's address.` });
                continue;
            }
            let target: URL;
            try {
                target = new URL(value, origin);
            } catch {
                out.push({ stepIndex: i, severity: "error", message: `Step ${i + 1}: “${raw.slice(0, 80)}” is not a valid address.` });
                continue;
            }
            if (target.origin === new URL(origin).origin) continue;
            try {
                await assertAllowedTarget(target.href);
            } catch (e) {
                out.push({ stepIndex: i, severity: "error", message: `Step ${i + 1}: ${e instanceof Error ? e.message : String(e)}` });
            }
        }
        return out;
    }

    /** The shared check of a save and a preview. Never stores anything. */
    async evaluate(t: TestRow, input: unknown, o: { blocks?: BlockIndex; noApplicationOk?: boolean; objects?: ObjectIndex } = {}): Promise<Evaluated> {
        if (!isEditableKind(t.kind)) throw new HttpError(409, "Only web and API tests can be edited step by step for now.");
        const projectId = t.projectId;
        const raw = input && typeof input === "object" ? (input as { testData?: unknown }) : {};
        const setName = raw.testData && typeof raw.testData === "object" ? dataSetNameOf(raw.testData as Record<string, string>) : undefined;
        const dataSets = dataSetsFor(this.repo, projectId);
        // `o.objects`: the shared elements as an import brings them (not stored yet).
        const objects = o.objects ?? new LocatorStore(this.ctx.p.db).index(projectId);
        // `o.blocks` is a proposed set of reusable steps (a block about to be saved): the test is judged as it would be with them.
        const blocks = o.blocks ?? blocksFor(this.ctx.p.db, projectId);
        const checked = checkSpecInput(input, {
            testId: t.testKey,
            kind: t.kind,
            category: t.spec.category,
            source: t.spec.source,
            current: t.spec,
            ...(objects ? { objects } : {}),
            ...(blocks ? { blocks } : {}),
            dataColumns: setName ? (dataSets[setName]?.columns ?? []) : [],
        });
        const diagnostics = [...checked.diagnostics];
        if (!checked.spec) return { diagnostics };
        const spec = checked.spec;
        // From here on the checks look at the steps that will really run (reusable steps put in place); a message about one of them is shown on
        // the step the person sees.
        const seen = expandBlocks(spec, blocks);
        const where = sourceIndexes(spec, seen);
        const remap = (d: BuilderDiagnostic): BuilderDiagnostic => {
            if (d.stepIndex === undefined || seen === spec) return d;
            const from = where[d.stepIndex] ?? d.stepIndex;
            const inBlock = seen.steps[d.stepIndex] ? blockOfStep(seen.steps[d.stepIndex]!) : undefined;
            const inner = d.stepIndex - where.indexOf(from) + 1;
            return { ...d, stepIndex: from, message: d.message.replace(/^Step \d+/, `Step ${from + 1}${inBlock ? ` (step ${inner} of the reusable steps “${inBlock.block}”)` : ""}`) };
        };

        for (const issue of dataDrivenSpecIssues(this.repo, projectId, [seen])) {
            for (const i of issue.issues as Array<{ message: string }>) diagnostics.push({ severity: "error", message: i.message });
        }
        // Reusable steps can be checked before the project has an application: the checks that need its address use a stand-in one (a step that
        // reaches another site, or uses stored sign-in details elsewhere, is refused all the same), and the answer says it was a stand-in.
        const noApplication = o.noApplicationOk === true && !this.repo.getLatestApplicationPublic(projectId);
        const origin = noApplication ? PLACEHOLDER_ORIGIN : this.origin(projectId);
        diagnostics.push(...(await this.addressProblems(seen, origin)).map(remap));
        // Stored sign-in details only go to the application's own site (a step that sends them elsewhere is refused, with the step named).
        if (t.kind === "web" || t.kind === "api") {
            const apiBase = (this.repo.getLatestApplicationPublic(projectId)?.config as { apiBaseUrl?: string } | undefined)?.apiBaseUrl;
            for (const p of credentialOriginProblems(seen, allowedCredentialOrigins(t.kind, origin, apiBase))) diagnostics.push(remap({ stepIndex: p.stepIndex, severity: "error", message: p.message }));
        }
        if (errorsOf(diagnostics).length) return { diagnostics };

        try {
            const script = renderWithAdapter(spec, t.framework, { baseUrl: origin, dataSets, ...(objects ? { objects } : {}), ...(blocks ? { blocks } : {}) });
            return { spec, diagnostics, script: { content: script.content, filename: script.filename } };
        } catch (e) {
            diagnostics.push({ severity: "error", message: `The script could not be created from these steps: ${e instanceof Error ? e.message : String(e)}` });
            return { diagnostics };
        }
    }

    async preview(testId: string, input: unknown) {
        const t = this.test(testId);
        const r = await this.evaluate(t, input);
        return { ok: errorsOf(r.diagnostics).length === 0, script: r.script?.content ?? null, filename: r.script?.filename ?? null, diagnostics: r.diagnostics };
    }

    // ── saving ──────────────────────────────────────────────────────────────

    /** Throws a 409 with the reason when the test cannot be edited now. A run in progress is a 409 too: nothing is saved. */
    private assertEditable(t: TestRow): void {
        const s = this.editState(t);
        if (!s.editable) throw new HttpError(409, s.custom ? `${s.reason} Choose Edit the code on the test page.` : (s.reason ?? "This test cannot be edited right now."));
    }

    /** `opts.run: false` saves without starting a run ("Save" next to "Save and run"): the test stays "Not run yet" and says so. */
    async save(testId: string, input: unknown, note?: string, by?: string, opts?: { run?: boolean }) {
        const t = this.test(testId);
        this.assertEditable(t);
        const r = await this.evaluate(t, input);
        if (!r.spec) {
            const e = new HttpError(422, "The steps were not saved: " + (errorsOf(r.diagnostics)[0]?.message ?? "they are not valid."));
            (e as HttpError & { diagnostics?: BuilderDiagnostic[] }).diagnostics = r.diagnostics;
            throw e;
        }
        const spec = r.spec;
        const current = this.repo.getCurrentScript(t.id);
        // Nothing changed (the editor sends the whole test back): no new version, no run.
        if (normalised(spec) === normalised(t.spec)) {
            return { testId: t.id, scriptVersion: (current?.version as number | undefined) ?? undefined, changed: false, diagnostics: r.diagnostics, jobId: null as string | null, note: "Nothing changed, so nothing was saved or run." };
        }

        this.ctx.p.db.tx(() => {
            // The first edit also keeps the test as it was, so the history always shows what the editor changed.
            if (this.versions.latest(t.id) === 0) this.versions.add(t.id, t.spec, "Before the first edit");
            this.versions.add(t.id, spec, note ?? null);
            this.repo.updateTest(t.id, { spec, validationStatus: "PENDING", reason: "The steps were changed. Run this test again." });
            this.custom.store.audit(t.projectId, t.id, "edit-steps", `${t.testKey} steps changed${by ? ` by ${by}` : ""}`);
        });
        // Scripts are rendered again from the stored spec (every framework the test has one for).
        const problems = await locatorServices(this.ctx).rerender(t.projectId, [t.id]);
        const out: BuilderDiagnostic[] = [...r.diagnostics, ...problems.map((p) => ({ severity: "warning" as const, message: `A script for another framework could not be created again: ${p.error}` }))];
        const queued: { jobId: string | null; note?: string } = opts?.run === false ? { jobId: null, note: "Saved. The test has not been run since this change: choose Run to see the result." } : await this.custom.queueValidation(t.projectId, [t.id]);
        return { testId: t.id, scriptVersion: (this.repo.getCurrentScript(t.id)?.version as number | undefined) ?? undefined, changed: true, diagnostics: out, jobId: queued.jobId, ...(queued.note ? { note: queued.note } : {}) };
    }

    // ── a test from nothing ─────────────────────────────────────────────────

    async createBlank(projectId: string, o: { title: string; kind: "web" | "api"; startUrl?: string; category?: string }): Promise<{ testId: string }> {
        const application = this.repo.getLatestApplicationPublic(projectId);
        if (!application) throw new HttpError(400, "This project has no application yet. Run an analysis or import a test first so there is an address to test.");
        const switchedOff = turnedOffForSpecs(new FrameworkSettingsStore(this.repo.db), projectId, [o.kind]);
        if (switchedOff) throw new HttpError(409, switchedOff);
        const url = application.url as string;
        const origin = isAppUri(url) ? url : new URL(url).origin;
        let startPath = o.kind === "api" || isAppUri(url) ? "/" : `${new URL(url).pathname}${new URL(url).search}`;
        if (o.startUrl?.trim()) {
            startPath = o.startUrl.trim();
            if (!isAppUri(origin)) {
                let target: URL;
                try {
                    target = new URL(startPath, origin);
                } catch {
                    throw new HttpError(400, "That is not a valid address to start from.");
                }
                if (target.origin !== new URL(origin).origin) {
                    try {
                        await assertAllowedTarget(target.href);
                    } catch (e) {
                        throw new HttpError(400, e instanceof Error ? e.message : String(e));
                    }
                }
            }
        }
        const category = (o.category ?? "Built in the editor").trim() || "Built in the editor";
        const key = this.ctx.p.db.tx(() => this.repo.nextTestKey(projectId, KEY_PREFIX[o.kind]));
        const spec = blankSpec({ testId: key, title: o.title, kind: o.kind, category, startPath });
        const adapter = defaultAdapterFor(o.kind);
        const dataSets = new DataSetStore(this.ctx.p.db).asMap(projectId);
        const script = renderWithAdapter(spec, adapter.id, { baseUrl: origin, dataSets });
        const slug = slugify(category);
        const suiteId = this.repo.getOrCreateSuite(projectId, category, slug);
        const id = this.repo.insertTest({ projectId, suiteId, jobId: null, spec, framework: adapter.id as TestRow["framework"], validationStatus: "PENDING", meta: { authoring: "built-in-editor" } });
        this.repo.updateTest(id, { reason: "Not run yet. Add the steps, then save and run." });
        await storeScript(this.repo, this.ctx.p.store, projectId, id, slug, script, getAdapter(adapter.id).executable);
        this.custom.store.audit(projectId, id, "build", `${key} ${o.title.slice(0, 80)}`);
        return { testId: id };
    }
}
