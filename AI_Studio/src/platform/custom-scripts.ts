/**
 * Hand-written (custom) tests, the operations: take over a generated test, restore it, save a script (a new version), restore a
 * version, write a test from scratch, keep shared helper modules. The routes (routes/custom-scripts.ts) and the Git import call this.
 *
 * Rules that hold everywhere here:
 *  - a custom test's script is its source of truth; its (archived) spec is never rewritten (`Repo.updateTest` ignores it);
 *  - every save passes the static guard first (engine/custom/guard.ts); with an error nothing is stored;
 *  - saving never runs the script by itself: a validation job is queued the normal way, which the run policy gates
 *    (platform/custom-policy.ts). When it cannot run, the test stays "Not validated" and the answer says why.
 */
import path from "node:path";
import { checkScript, describeErrors, guardAvailable, type Diagnostic } from "../engine/custom/guard.js";
import { isHelperName, MAX_HELPER_BYTES } from "../engine/custom/helpers.js";
import { defaultAdapterFor, hasAdapter, renderWithAdapter } from "../engine/frameworks/index.js";
import { isAppUri } from "../engine/desktop/target.js";
import { refNames } from "../engine/locators/refs.js";
import { TestSpecSchema, type TestSpec } from "../engine/spec/schema.js";
import type { Platform } from "./bootstrap.js";
import { CustomScriptStore, HelperLimitError, customInfo, type CustomInfo, type GitProvenance, type VersionKind } from "./custom-script-store.js";
import { DataSetStore } from "./environments-store.js";
import { HttpError } from "./http-error.js";
import { blocksFor } from "./block-store.js";
import { LocatorStore } from "./locator-store.js";
import { storeScript } from "./repo-sink.js";
import { draftRunNote, ReviewStore, trackTestVersion } from "./review-store.js";
import { TERMINAL_STATES, type JobRow, type Repo, type TestRow } from "./repo.js";
import { slugify } from "./storage.js";

/** The guard refused the code: the routes answer 422 with the diagnostics. */
export class GuardRefusal extends Error {
    constructor(
        message: string,
        readonly diagnostics: Diagnostic[],
    ) {
        super(message);
    }
}

export interface SaveResult {
    version: number;
    diagnostics: Diagnostic[];
    jobId: string | null;
    /** Plain words about why no job was queued, when none was. */
    note?: string;
}

export interface Services {
    p: Platform;
    repo: Repo;
    applicationFor(projectId: string, baseUrl?: string): Promise<{ id: string; url: string }>;
    startValidationJob(projectId: string, applicationId: string, testIds: string[]): Promise<JobRow>;
}

const KEY_PREFIX = { web: "WEB", api: "API" } as const;
export type CustomKind = keyof typeof KEY_PREFIX;

export class CustomScripts {
    readonly store: CustomScriptStore;

    constructor(private readonly s: Services) {
        this.store = new CustomScriptStore(s.p.db);
    }

    private get repo(): Repo {
        return this.s.repo;
    }

    /** The `custom` block of a test, or undefined for a generated one. */
    info(testId: string): CustomInfo | undefined {
        const c = this.store.get(testId);
        return c ? customInfo(c) : undefined;
    }

    // ── the guard ───────────────────────────────────────────────────────────

    /** The guard and the syntax check, plus a warning for each helper the code imports that the project does not have. */
    check(projectId: string, content: string, kind: "test" | "helper" = "test"): { diagnostics: Diagnostic[]; ok: boolean; helperImports: string[] } {
        const r = checkScript(content, { kind });
        const diagnostics = [...r.diagnostics];
        if (guardAvailable()) {
            const have = new Set(this.store.allHelpers(projectId).map((h) => h.name));
            for (const name of r.helperImports) {
                if (have.has(name)) continue;
                const at = locateImport(content, name);
                diagnostics.push({ severity: "warning", line: at.line, column: at.column, rule: "helper-missing", message: `The helper “${name}” does not exist in this project yet. Add it, or the test will fail when it runs.` });
            }
        }
        return { diagnostics, ok: r.ok, helperImports: r.helperImports };
    }

    // ── take over / restore ─────────────────────────────────────────────────

    /** What taking over gives up for this test, in words, and whether it can be done now. */
    takeOverInfo(testId: string): { allowed: boolean; reason?: string; losses: string[] } {
        const t = this.repo.getTest(testId);
        if (!t) throw new HttpError(404, "Test not found");
        const losses = this.lossesOf(t);
        const reason = this.takeOverProblem(t);
        return reason ? { allowed: false, reason, losses } : { allowed: true, losses };
    }

    private takeOverProblem(t: TestRow): string | undefined {
        if (this.store.isCustom(t.id)) return "This is already a code test.";
        if (t.kind !== "web" && t.kind !== "api") return "Only web and API tests can be taken over for now.";
        if (!hasAdapter(t.framework)) return "This kind of test cannot be edited as code.";
        // Only Playwright scripts pass through the guard and the custom-script runner; a test of another framework (for example a web test
        // rendered by Taqwright) is run by a runner that knows nothing about hand-written code.
        if (t.framework !== "playwright" && t.framework !== "playwright-api") return "Only tests that run with Playwright can be taken over for now.";
        if (!this.repo.getCurrentScript(t.id)) return "This test has no script yet. Run it once, then take it over.";
        if (this.repo.listJobs(t.projectId).some((j) => !TERMINAL_STATES.includes(j.status))) return "A run is in progress for this project. Wait for it to finish, then take the test over.";
        return undefined;
    }

    private lossesOf(t: TestRow): string[] {
        const out = ["The script becomes the only source of this test. The steps shown for it stop driving anything."];
        if (t.kind === "web") out.push("Repair suggestions stop for this test.");
        if (refNames(t.spec).length > 0) out.push("Changes to shared elements no longer apply to it.");
        if (t.spec.source.origin === "plain-english") out.push("It can no longer be rewritten from its plain-English description.");
        if (t.spec.source.origin === "recorded") out.push("It can no longer be shared from the recording.");
        out.push("You can go back to the generated version at any time; your edits stay in the history.");
        return out;
    }

    async takeOver(testId: string, by?: string): Promise<TestRow> {
        const t = this.repo.getTest(testId);
        if (!t) throw new HttpError(404, "Test not found");
        const problem = this.takeOverProblem(t);
        if (problem) throw new HttpError(409, problem);
        const script = this.repo.getCurrentScript(t.id)!;
        const content = script.content as string;
        const scan = checkScript(content, { kind: "test" });
        this.s.p.db.tx(() => {
            // The spec stays where it is and is archived here; the script becomes version 1. Version 0 is the generated one.
            this.store.mark(t.id, t.projectId, { origin: "taken-over", specArchive: t.spec, imports: scan.helperImports });
            // Taken over again after going back to the generated version: version 0 is still there and the history simply continues.
            if (!this.store.getVersion(t.id, 0)) this.store.addVersion(t.id, { content, kind: "generated", note: "The generated script", by: null, force: true, version: 0 });
            this.store.addVersion(t.id, { content, kind: "taken-over", note: "Taken over", by: by ?? null, force: true });
            // The test no longer follows shared elements: drop its usage rows so deleting an element is not blocked by it.
            this.s.p.db.run("DELETE FROM locator_usage WHERE test_case_id = ?", t.id);
            this.store.audit(t.projectId, t.id, "take-over", `${t.testKey} was taken over`);
        });
        // The code is the script that already ran, so the test keeps the review state it had (review-store.ts).
        trackTestVersion(this.s.p.db, t.id, "takeover");
        return this.repo.getTest(t.id)!;
    }

    async restoreGenerated(testId: string, by?: string): Promise<{ test: TestRow } & Pick<SaveResult, "jobId" | "note">> {
        const t = this.repo.getTest(testId);
        if (!t) throw new HttpError(404, "Test not found");
        const c = this.store.get(testId);
        if (!c) throw new HttpError(409, "This is not a code test, so there is nothing to restore.");
        if (c.specArchive === undefined) throw new HttpError(409, "This test was written by hand or imported from Git, so it has no generated version to go back to.");
        if (this.repo.listJobs(t.projectId).some((j) => !TERMINAL_STATES.includes(j.status))) throw new HttpError(409, "A run is in progress for this project. Wait for it to finish, then restore the generated version.");
        const parsed = TestSpecSchema.safeParse(c.specArchive);
        if (!parsed.success) throw new HttpError(409, "The saved steps of this test can no longer be read, so it cannot be restored.");
        const spec = parsed.data;
        const application = this.repo.getLatestApplicationPublic(t.projectId);
        if (!application) throw new HttpError(409, "This project has no application yet, so the script cannot be created again.");
        const url = application.url as string;
        const origin = isAppUri(url) ? url : new URL(url).origin;
        const objects = new LocatorStore(this.s.p.db).index(t.projectId);
        const blocks = blocksFor(this.s.p.db, t.projectId);
        let script;
        try {
            script = renderWithAdapter(spec, t.framework, { baseUrl: origin, dataSets: new DataSetStore(this.s.p.db).asMap(t.projectId), ...(objects ? { objects } : {}), ...(blocks ? { blocks } : {}) });
        } catch (e) {
            throw new HttpError(409, `The generated script could not be created again: ${e instanceof Error ? e.message : String(e)}`);
        }
        const slug = (this.repo.getSuite(t.suiteId)?.slug as string | undefined) ?? "general";
        await storeScript(this.repo, this.s.p.store, t.projectId, t.id, slug, script, true);
        this.s.p.db.tx(() => {
            this.store.addVersion(t.id, { content: script.content, kind: "restored", note: "Restored the generated version", by: by ?? null, force: true });
            this.store.unmark(t.id);
            this.repo.updateTest(t.id, { spec, validationStatus: "PENDING", reason: "The generated version was restored. Run this test again." });
            this.store.audit(t.projectId, t.id, "restore-generated", `${t.testKey} went back to its generated version`);
        });
        const queued = await this.queueValidation(t.projectId, [t.id]);
        return { test: this.repo.getTest(t.id)!, ...queued };
    }

    // ── saving ──────────────────────────────────────────────────────────────

    /** Saves new code for a custom test as a new version and queues a validation run. Throws GuardRefusal on an error diagnostic. */
    async saveScript(testId: string, content: string, o: { note?: string | null; by?: string | null; kind?: VersionKind; git?: GitProvenance; queue?: boolean } = {}): Promise<SaveResult & { changed: boolean }> {
        const t = this.repo.getTest(testId);
        if (!t) throw new HttpError(404, "Test not found");
        const c = this.store.get(testId);
        if (!c) throw new HttpError(422, "Only code tests can be edited as code. Switch the test to code first.");
        const r = this.check(t.projectId, content, "test");
        if (!r.ok) throw new GuardRefusal(`The script was not saved: ${describeErrors(r.diagnostics)}`, r.diagnostics);
        const cur = this.repo.getCurrentScript(testId);
        const filename = (cur?.filename as string | undefined) ?? `${t.testKey}.spec.ts`;
        const slug = (this.repo.getSuite(t.suiteId)?.slug as string | undefined) ?? "general";
        const v = this.store.addVersion(testId, { content, kind: o.kind ?? "edited", note: o.note ?? null, by: o.by ?? null });
        if (!v.created) return { version: v.version, diagnostics: r.diagnostics, jobId: null, note: "Nothing changed: this is the same script as the saved version.", changed: false };
        await storeScript(this.repo, this.s.p.store, t.projectId, testId, slug, { framework: t.framework, filename, content, language: "typescript" }, true);
        this.store.setImports(testId, r.helperImports);
        if (o.git) this.store.setGit(testId, o.git);
        this.repo.updateTest(testId, { validationStatus: "PENDING", reason: "The script was changed. Run this test again." });
        this.store.audit(t.projectId, testId, o.kind === "git" ? "git-update" : o.kind === "restored" ? "restore-version" : "save", `${t.testKey} version ${v.version}`);
        const queued = o.queue === false ? { jobId: null } : await this.queueValidation(t.projectId, [testId]);
        return { version: v.version, diagnostics: r.diagnostics, changed: true, ...queued };
    }

    /** Puts an older version back as the newest one (history is never rewritten). */
    async restoreVersion(testId: string, version: number, by?: string | null): Promise<SaveResult> {
        const old = this.store.getVersion(testId, version);
        if (!old) throw new HttpError(404, "That version does not exist.");
        const out = await this.saveScript(testId, old.content, { kind: "restored", note: `Restored version ${version}`, by });
        return out;
    }

    // ── writing from scratch (and importing) ────────────────────────────────

    async createTest(o: { projectId: string; title: string; kind: CustomKind; content: string; category?: string; origin?: "written" | "git"; git?: GitProvenance; note?: string; by?: string | null; queue?: boolean }): Promise<SaveResult & { testId: string; testKey: string }> {
        const { projectId } = o;
        const application = this.repo.getLatestApplicationPublic(projectId);
        if (o.kind === "web" && !application) throw new HttpError(400, "This project has no application yet. Run an analysis or import a test first so there is an address to test.");
        const r = this.check(projectId, o.content, "test");
        if (!r.ok) throw new GuardRefusal(`The script was not saved: ${describeErrors(r.diagnostics)}`, r.diagnostics);
        const category = (o.category ?? "Custom").trim() || "Custom";
        const adapter = defaultAdapterFor(o.kind);
        // The spec of a code test is a placeholder: it keeps the lists, the filters and the reports working. The script is what runs.
        const key = this.s.p.db.tx(() => this.repo.nextTestKey(projectId, KEY_PREFIX[o.kind]));
        const spec: TestSpec = TestSpecSchema.parse({
            testId: key,
            title: o.title,
            description: "A hand-written test. Its script is the source of truth.",
            kind: o.kind,
            category,
            steps: o.kind === "web" ? [{ action: "navigate", url: "/" }] : [{ action: "request", method: "GET", path: "/" }],
            tags: ["hand-written"],
            source: { origin: "manual" },
        });
        const slug = slugify(category);
        const suiteId = this.repo.getOrCreateSuite(projectId, category, slug);
        const id = this.repo.insertTest({ projectId, suiteId, jobId: null, spec, framework: adapter.id as TestRow["framework"], validationStatus: "PENDING", meta: { authoring: o.origin === "git" ? "git" : "hand-written" } });
        this.repo.updateTest(id, { reason: "Not run yet." });
        const filename = `${key}.spec.ts`;
        await storeScript(this.repo, this.s.p.store, projectId, id, slug, { framework: adapter.id as TestRow["framework"], filename, content: o.content, language: "typescript" }, true);
        const kind: VersionKind = o.origin === "git" ? "git" : "edited";
        this.store.mark(id, projectId, { origin: o.origin ?? "written", imports: r.helperImports, ...(o.git ? { git: o.git } : {}) });
        const v = this.store.addVersion(id, { content: o.content, kind, note: o.note ?? (o.origin === "git" ? "Imported from Git" : "Written from scratch"), by: o.by ?? null, force: true });
        // The script was stored before the test was marked as code, so the hook in Repo.addScript did not see it: the code is recorded
        // as a version here, as the person's change it is (a run never approves what it finds; review-store.ts).
        trackTestVersion(this.s.p.db, id, o.origin === "git" ? "import" : "person");
        this.store.audit(projectId, id, o.origin === "git" ? "git-import" : "write", `${key} ${o.title.slice(0, 80)}`);
        const queued = o.queue === false ? { jobId: null } : await this.queueValidation(projectId, [id]);
        return { testId: id, testKey: key, version: v.version, diagnostics: r.diagnostics, ...queued };
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    async putHelper(projectId: string, name: string, content: string, by?: string | null): Promise<{ diagnostics: Diagnostic[]; created: boolean; revalidating: { tests: number; jobId: string | null; note?: string } }> {
        if (!isHelperName(name)) throw new HttpError(400, "Helper names use lower-case letters, digits and hyphens (for example login-steps), start with a letter and are at most 41 characters.");
        if (Buffer.byteLength(content, "utf8") > MAX_HELPER_BYTES) throw new HttpError(413, `A helper can be at most ${MAX_HELPER_BYTES / 1000} KB.`);
        const r = this.check(projectId, content, "helper");
        if (!r.ok) throw new GuardRefusal(`The helper was not saved: ${describeErrors(r.diagnostics)}`, r.diagnostics);
        let res;
        try {
            res = this.store.putHelper(projectId, name, content, r.helperImports);
        } catch (e) {
            if (e instanceof HelperLimitError) throw new HttpError(422, e.message);
            throw e;
        }
        this.store.audit(projectId, null, "helper", `${name}${res.created ? " added" : res.changed ? " changed" : " unchanged"}${by ? ` by ${by}` : ""}`);
        // Tests that import it (through other helpers too) are marked and run again, like tests that use a changed shared element.
        let revalidating: { tests: number; jobId: string | null; note?: string } = { tests: 0, jobId: null };
        if (res.changed && !res.created) {
            const users = this.store.usersOfHelper(projectId, name);
            if (users.length) {
                // An approved test that imports it waits to be approved again, unless a change by this person would not (review-store.ts).
                new ReviewStore(this.repo.db).sharedPartChanged(users, `the helper “${name}”`);
                for (const id of users) this.repo.updateTest(id, { validationStatus: "PENDING", reason: `The helper “${name}” changed. Run this test again.` });
                revalidating = { tests: users.length, ...(await this.queueValidation(projectId, users)) };
            }
        }
        return { diagnostics: r.diagnostics, created: res.created, revalidating };
    }

    /** Throws 409 naming the tests while any custom test imports the helper. */
    deleteHelper(projectId: string, name: string): void {
        if (!this.store.getHelper(projectId, name)) throw new HttpError(404, "Helper not found");
        const users = this.store.usersOfHelper(projectId, name);
        if (users.length) {
            const keys = users.map((id) => this.repo.getTest(id)?.testKey ?? id);
            throw new HttpError(409, `The helper “${name}” is used by ${keys.slice(0, 5).join(", ")}${keys.length > 5 ? ` and ${keys.length - 5} more` : ""}. Change those tests first.`, { tests: users.map((id) => ({ id, testId: this.repo.getTest(id)?.testKey ?? id })) });
        }
        this.store.deleteHelper(projectId, name);
        this.store.audit(projectId, null, "helper", `${name} deleted`);
    }

    // ── running ─────────────────────────────────────────────────────────────

    /** Queue a normal validation job for the given tests, or say in plain words why not. Never throws. */
    async queueValidation(projectId: string, testIds: string[]): Promise<{ jobId: string | null; note?: string }> {
        let application: { id: string } | undefined;
        try {
            application = await this.s.applicationFor(projectId);
        } catch (e) {
            return { jobId: null, note: `${e instanceof HttpError ? e.message : "The project has no application to run against yet."} The test stays Not validated.` };
        }
        // Synchronous from here: the busy check and the job cannot be interleaved with another request.
        if (this.repo.listJobs(projectId).some((j) => !TERMINAL_STATES.includes(j.status))) return { jobId: null, note: "A run is in progress. The test is marked Not validated; run it again when it has finished." };
        try {
            const job = await this.s.startValidationJob(projectId, application.id, testIds);
            const note = draftRunNote(this.repo.db, testIds);
            return { jobId: job.id, ...(note ? { note } : {}) };
        } catch (e) {
            const why = e instanceof HttpError ? e.message : "The run could not be started.";
            return { jobId: null, note: `${why} The test stays Not validated.` };
        }
    }
}

/** Where `name` is imported in the code (first match of its module path in an import line), for a warning's place. */
function locateImport(content: string, name: string): { line: number; column: number } {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const col = lines[i]!.indexOf(`/${name}"`);
        const alt = col >= 0 ? col : lines[i]!.indexOf(`/${name}'`);
        if (alt >= 0 && /\bfrom\b|import|export/.test(lines[i]!)) return { line: i + 1, column: alt + 1 };
    }
    return { line: 1, column: 1 };
}

/** A path safe to show to a person: only the file name. */
export const shortName = (p: string): string => path.basename(p);
