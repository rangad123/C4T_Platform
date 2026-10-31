/**
 * Text tests, platform side: read and write a test as text. Nothing here is new machinery:
 *  - a new test goes through the platform's own spec import (POST /specs), so every import rule applies (address guard, stored sign-in
 *    details only on the application's own site, shared elements, reusable steps, switched-off frameworks, rendering, validation job);
 *  - an edit goes through the step editor's save (SpecEditService.save): the same checks, a new version in the history, the script
 *    rendered again from the stored spec, a normal validation job;
 *  - the text of a test that has parts text cannot show is read-only: saving it would lose those parts, so it is refused.
 * The parser and printer are pure (src/engine/dsl/*); this file only connects them to the stored tests.
 */
import { checkSpecInput, errorsOf, isEditableKind, type BuilderDiagnostic } from "../engine/builder/index.js";
import { DSL_LIMITS, parseDsl, printSpec, type DslDiagnostic, type ParseResult, type PrintResult } from "../engine/dsl/index.js";
import { dataSetNameOf } from "../engine/testdata/dataset.js";
import { TestSpecSchema, type TestSpec } from "../engine/spec/schema.js";
import { blocksFor } from "./block-store.js";
import { CustomScriptStore } from "./custom-script-store.js";
import { HttpError } from "./http-error.js";
import { LocatorStore } from "./locator-store.js";
import { dataSetsFor } from "./routes/environments.js";
import type { RouteCtx } from "./routes/types.js";
import { SpecEditService } from "./spec-edit-service.js";

export const DEFAULT_TEXT_CATEGORY = "Written as text";

export type ApiDiagnostic = DslDiagnostic & { severity: "error" | "warning"; stepIndex?: number };

const asError = (d: DslDiagnostic): ApiDiagnostic => ({ ...d, severity: "error" });

/** A message about one step (from the step editor's rules) placed on the line that step was written on. */
function onLine(d: BuilderDiagnostic, stepLines: number[]): ApiDiagnostic {
    const line = d.stepIndex !== undefined ? (stepLines[d.stepIndex] ?? 1) : 1;
    return { line, column: 1, endColumn: 2, message: d.message, severity: d.severity, ...(d.stepIndex !== undefined ? { stepIndex: d.stepIndex } : {}) };
}

/** An HttpError that carries line diagnostics; the route sends them next to the message. */
export class DslRefusal extends HttpError {
    constructor(
        status: number,
        message: string,
        readonly diagnostics: ApiDiagnostic[],
    ) {
        super(status, message);
    }
}

export class DslService {
    private readonly edit: SpecEditService;

    constructor(private readonly ctx: RouteCtx) {
        this.edit = new SpecEditService(ctx);
    }

    /** Pure: the text read as a test. Nothing is stored. */
    parse(text: string): { spec: TestSpec | null; diagnostics: ApiDiagnostic[]; truncated: boolean; stepLines: number[] } & Pick<ParseResult, "present"> {
        const r = parseDsl(text);
        return { spec: r.spec, diagnostics: r.diagnostics.map(asError), truncated: r.truncated, stepLines: r.stepLines, present: r.present };
    }

    /** Pure: a test (for example the steps view with changes not saved yet) written as text. Nothing is stored. */
    print(spec: unknown): PrintResult {
        const r = TestSpecSchema.safeParse(spec);
        if (!r.success) throw new HttpError(422, "These steps cannot be written as text yet: they are not a valid test.");
        return printSpec(r.data);
    }

    // ── reading a stored test ───────────────────────────────────────────────

    describe(testId: string) {
        const t = this.edit.test(testId);
        const state = this.edit.editState(t);
        if (state.custom) throw new HttpError(409, "This is a code test, so it has no text form. Open it in the code editor instead.");
        if (!isEditableKind(t.kind)) throw new HttpError(409, "Only web and API tests can be written as text for now.");
        const printed = printSpec(t.spec);
        return {
            testId: t.id,
            projectId: t.projectId,
            key: t.testKey,
            kind: t.kind,
            title: t.title,
            text: printed.text,
            expressible: printed.expressible,
            reasons: printed.reasons,
            editable: state.editable && printed.expressible,
            ...(state.busy ? { busy: true } : {}),
            ...(!state.editable ? { editReason: state.reason } : !printed.expressible ? { editReason: `This test cannot be edited as text: ${printed.reasons[0] ?? "part of it has no text form."}` } : {}),
        };
    }

    // ── saving an edit ──────────────────────────────────────────────────────

    async save(testId: string, text: string, note?: string, opts?: { run?: boolean }) {
        const t = this.edit.test(testId);
        const state = this.edit.editState(t);
        if (state.custom) throw new HttpError(409, "This is a code test, so it has no text form. Edit the code in the code editor instead.");
        if (!isEditableKind(t.kind)) throw new HttpError(409, "Only web and API tests can be written as text for now.");
        const printed = printSpec(t.spec);
        if (!printed.expressible) {
            throw new HttpError(409, `This test is not fully expressible in text, so saving the text would lose part of it${printed.reasons[0] ? ` (${printed.reasons[0]})` : ""}. Edit it with the step editor instead.`);
        }
        const read = parseDsl(text);
        if (!read.spec) throw new DslRefusal(422, `The text was not saved: line ${read.diagnostics[0]?.line ?? 1}, ${lowerFirst(read.diagnostics[0]?.message ?? "it could not be read.")}`, read.diagnostics.map(asError));
        const spec = read.spec;
        const problems: ApiDiagnostic[] = [];
        if (spec.kind !== t.kind) problems.push({ line: 1, column: 1, endColumn: 2, severity: "error", message: `This test is a ${t.kind} test. Its kind cannot be changed here: create a new test instead.` });
        if (read.present.category && spec.category !== t.spec.category) problems.push({ line: 1, column: 1, endColumn: 2, severity: "error", message: "The category of an existing test cannot be changed here. Remove the Category line or put back the original." });
        if (problems.length) throw new DslRefusal(422, `The text was not saved: ${lowerFirst(problems[0]!.message)}`, problems);

        // The same document the step editor sends; the stored test keeps its id, kind, category and source.
        const input = {
            title: spec.title,
            description: spec.description,
            type: spec.type,
            priority: spec.priority,
            preconditions: spec.preconditions,
            steps: spec.steps,
            expectedResults: spec.expectedResults,
            testData: spec.testData,
            tags: spec.tags,
        };
        try {
            return await this.edit.save(testId, input, note ?? "Edited as text", undefined, opts);
        } catch (e) {
            const diagnostics = (e as { diagnostics?: BuilderDiagnostic[] }).diagnostics;
            if (e instanceof HttpError && e.status === 422 && diagnostics) throw new DslRefusal(422, e.message, diagnostics.map((d) => onLine(d, read.stepLines)));
            throw e;
        }
    }

    // ── a new test ──────────────────────────────────────────────────────────

    /** Creates a test from text through the platform's own import. `headers` carries the caller's API key to the inner call. */
    async create(projectId: string, text: string, headers: Record<string, string>) {
        this.ctx.project(projectId);
        const read = parseDsl(text);
        if (!read.spec) throw new DslRefusal(422, `The test was not created: line ${read.diagnostics[0]?.line ?? 1}, ${lowerFirst(read.diagnostics[0]?.message ?? "the text could not be read.")}`, read.diagnostics.map(asError));
        const spec: TestSpec = { ...read.spec, category: read.present.category ? read.spec.category : DEFAULT_TEXT_CATEGORY };

        // The step editor's own rules (caps, secrets typed into a test, reusable steps of THIS project, shared elements, placeholders).
        const db = this.ctx.p.db;
        const setName = dataSetNameOf(spec.testData);
        const checked = checkSpecInput(spec, {
            testId: spec.testId,
            kind: spec.kind as "web" | "api",
            category: spec.category,
            source: spec.source,
            ...(new LocatorStore(db).index(projectId) ? { objects: new LocatorStore(db).index(projectId)! } : {}),
            ...(blocksFor(db, projectId) ? { blocks: blocksFor(db, projectId)! } : {}),
            dataColumns: setName ? (dataSetsFor(this.ctx.repo, projectId)[setName]?.columns ?? []) : [],
        });
        const mapped = checked.diagnostics.map((d) => onLine(d, read.stepLines));
        if (!checked.spec) {
            const first = errorsOf(checked.diagnostics)[0];
            throw new DslRefusal(422, `The test was not created: ${first ? lowerFirst(first.message) : "it is not valid."}`, mapped);
        }

        let validate = true;
        try {
            await this.ctx.assertNoActiveJob(projectId);
        } catch (e) {
            if (!(e instanceof HttpError) || e.status !== 409) throw e;
            validate = false;
        }
        // testId is left out so the platform gives the next free one.
        const { testId: _ignored, ...rest } = checked.spec;
        void _ignored;
        const post = (v: boolean) => this.ctx.app.inject({ method: "POST", url: `/api/projects/${projectId}/specs`, payload: { specs: [rest], validate: v }, headers });
        let res = await post(validate);
        if (res.statusCode === 409 && validate) {
            validate = false;
            res = await post(false);
        }
        const answer = (res.body ? JSON.parse(res.body) : {}) as { jobId?: string | null; tests?: Array<{ id: string; testId: string }>; error?: string; details?: unknown };
        if (res.statusCode >= 400) throw this.refusal(res.statusCode, answer, read.stepLines);
        const made = answer.tests?.[0];
        if (!made) throw new HttpError(500, "The test could not be created.");
        new CustomScriptStore(db).audit(projectId, made.id, "write-text", `${made.testId} ${spec.title.slice(0, 80)}`);
        return {
            testId: made.id,
            key: made.testId,
            tests: answer.tests,
            jobId: answer.jobId ?? null,
            diagnostics: mapped,
            ...(!validate ? { note: "Another run is in progress for this project, so the test was saved but not run. Run it when the current run has finished." } : {}),
        };
    }

    /** The answer of the platform's import, put in the words of a text test (the first problem as the message, every problem as a line). */
    private refusal(status: number, answer: { error?: string; details?: unknown }, stepLines: number[]): HttpError {
        const messages: string[] = [];
        const take = (x: unknown) => {
            if (!x || typeof x !== "object") return;
            const o = x as { message?: unknown; issues?: unknown };
            if (typeof o.message === "string") messages.push(o.message);
            if (Array.isArray(o.issues)) for (const i of o.issues) take(i);
        };
        if (Array.isArray(answer.details)) for (const d of answer.details) take(d);
        // The address guard names the step as `specs[0].steps[2]: why`: say it as a step of this test.
        const guard = /^specs\[\d+\]\.steps\[(\d+)\]: (.*)$/.exec(answer.error ?? "");
        if (!messages.length && guard) messages.push(`Step ${Number(guard[1]) + 1}: ${guard[2]}`);
        if (!messages.length) return new HttpError(status, answer.error ?? "The test could not be created.");
        const diagnostics: ApiDiagnostic[] = messages.slice(0, DSL_LIMITS.diagnostics).map((message) => {
            const m = /^Step (\d+)/.exec(message);
            const stepIndex = m ? Number(m[1]) - 1 : undefined;
            return { line: stepIndex !== undefined ? (stepLines[stepIndex] ?? 1) : 1, column: 1, endColumn: 2, message, severity: "error" as const, ...(stepIndex !== undefined ? { stepIndex } : {}) };
        });
        return new DslRefusal(status === 400 ? 422 : status, `The test was not created: ${lowerFirst(messages[0]!)}`, diagnostics);
    }
}

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
