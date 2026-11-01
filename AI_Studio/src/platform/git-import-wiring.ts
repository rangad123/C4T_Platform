/**
 * Connects the Git import to the platform's own stores: the repository table and the custom-test model (custom-script-store.ts),
 * the static guard (engine/custom/guard.ts), the test and script tables (repo.ts) and the normal validation job.
 */
import path from "node:path";
import { checkScript } from "../engine/custom/guard.js";
import { TestSpecSchema } from "../engine/spec/schema.js";
import { CustomScriptStore, GitRepoStore, type GitProvenance as StoredProvenance } from "./custom-script-store.js";
import type { CustomTestPort, GitImportPorts, GitRepoPort } from "./git-import-service.js";
import { HttpError } from "./http-error.js";
import { trackTestVersion } from "./review-store.js";
import type { RouteCtx } from "./routes/types.js";
import { slugify } from "./storage.js";
import { putText } from "./object-store.js";

/** The suite hand-written tests live in. */
const SUITE = { name: "Custom", slug: "custom" };

export function buildGitImportPorts(ctx: RouteCtx): GitImportPorts {
    const { p, repo } = ctx;
    const custom = new CustomScriptStore(p.db);
    const gitRepos = new GitRepoStore(p.db);

    const repos: GitRepoPort = {
        create: (r) => gitRepos.create(r.projectId, { host: r.host, path: r.path, ref: r.ref, commit: r.commit, importedAt: r.importedAt, url: r.url, subpath: r.subpath }),
        list: (projectId) => gitRepos.list(projectId),
        get: (projectId, id) => gitRepos.get(projectId, id),
        update: (id, patch) => {
            const row = p.db.get<{ project_id: string }>("SELECT project_id FROM git_repos WHERE id = ?", id);
            if (row) gitRepos.update(row.project_id, id, patch);
        },
        delete: (projectId, id) => void gitRepos.delete(projectId, id),
    };

    /** The test already imported for (repository, file); failing that, one whose link was dropped earlier and that came from the same file. */
    const findTest = (projectId: string, repoId: string, host: string, repoPath: string, file: string): string | undefined => {
        const linked = gitRepos.testsOf(projectId, repoId).find((t) => t.file === file);
        if (linked) return linked.testId;
        for (const [testId, state] of custom.forProject(projectId)) {
            const g = state.git;
            if (state.origin === "git" && g && !g.repoId && g.host === host && g.path === repoPath && g.file === file) return testId;
        }
        return undefined;
    };

    const tests: CustomTestPort = {
        async upsert(projectId, repoId, f) {
            const prov: StoredProvenance = { host: f.provenance.host, path: f.provenance.path, ref: f.provenance.ref, commit: f.provenance.commit, importedAt: f.provenance.importedAt, repoId, file: f.path };
            const guard = checkScript(f.content);
            if (!guard.ok) throw new HttpError(422, `${f.path} did not pass the safety check, so it was not imported.`);
            const note = `Imported from ${f.provenance.path}@${f.provenance.commit.slice(0, 8)}`;
            const existingId = findTest(projectId, repoId, prov.host, prov.path, f.path);

            if (existingId) {
                const current = repo.getCurrentScript(existingId, "playwright");
                const changed = !current || (current.content as string) !== f.content;
                if (changed) {
                    const t = repo.getTest(existingId);
                    const suite = t ? repo.getSuite(t.suiteId) : undefined;
                    const filename = (current?.filename as string | undefined) ?? `${t?.testKey ?? existingId}.spec.ts`;
                    const rel = path.posix.join(projectId, (suite?.slug as string | undefined) ?? SUITE.slug, filename);
                    const stored = await putText(p.store, rel, f.content);
                    // (addScript and addVersion are each all-or-nothing; the order leaves a consistent test if one fails)
                    repo.addScript(existingId, { framework: "playwright", filename, content: f.content, hash: stored.hash, storagePath: rel, executable: true });
                    custom.addVersion(existingId, { content: f.content, kind: "git", note, by: "git import" });
                    repo.updateTest(existingId, { validationStatus: "PENDING", reason: null });
                    custom.setImports(existingId, guard.helperImports);
                }
                custom.setGit(existingId, prov);
                p.db.run("UPDATE test_cases SET title = ? WHERE id = ?", f.title, existingId);
                return { testId: existingId, created: false, changed };
            }

            const suiteId = repo.getOrCreateSuite(projectId, SUITE.name, SUITE.slug);
            const key = repo.nextTestKey(projectId, "WEB");
            const filename = `${key}.spec.ts`;
            const rel = path.posix.join(projectId, slugify(SUITE.slug), filename);
            const stored = await putText(p.store, rel, f.content);
            // The platform lists every test with a spec; a hand-written test carries a placeholder that nothing renders from.
            const spec = TestSpecSchema.parse({
                testId: key,
                title: f.title.length >= 3 ? f.title : `${f.title} test`,
                description: `Imported from ${f.provenance.path}, file ${f.path}.`,
                kind: "web",
                category: SUITE.name,
                steps: [{ action: "navigate", url: "/" }],
                source: { origin: "imported" },
            });
            const testId = repo.insertTest({ projectId, suiteId, jobId: null, spec, framework: "playwright", validationStatus: "PENDING", meta: { source: "git-import" } });
            try {
                repo.addScript(testId, { framework: "playwright", filename, content: f.content, hash: stored.hash, storagePath: rel, executable: true });
                custom.mark(testId, projectId, { origin: "git", git: prov, imports: guard.helperImports });
                custom.addVersion(testId, { content: f.content, kind: "git", note, by: "git import" });
                // The script was stored before the test was marked as code: the code is recorded as a version here (a run never approves what it finds; review-store.ts).
                trackTestVersion(p.db, testId, "import");
                custom.audit(projectId, testId, "git-import", `${f.path} from ${f.provenance.path}`);
            } catch (e) {
                // Never leave a test that is half made (a test without its script or custom marking).
                p.db.run("DELETE FROM test_cases WHERE id = ?", testId);
                throw e;
            }
            return { testId, created: true, changed: true };
        },

        forRepo(repoId) {
            const row = p.db.get<{ project_id: string }>("SELECT project_id FROM git_repos WHERE id = ?", repoId);
            if (!row) return [];
            return gitRepos
                .testsOf(row.project_id, repoId)
                .filter((t): t is { testId: string; file: string } => !!t.file)
                .map((t) => {
                    const lastImport = custom.listVersions(t.testId).find((v) => v.kind === "git");
                    const importedContent = lastImport ? custom.getVersion(t.testId, lastImport.version)?.content : undefined;
                    return { testId: t.testId, path: t.file, content: (repo.getCurrentScript(t.testId, "playwright")?.content as string | undefined) ?? "", ...(importedContent !== undefined ? { importedContent } : {}) };
                });
        },

        async queueValidation(projectId, testIds) {
            try {
                await ctx.assertNoActiveJob(projectId);
                const application = await ctx.applicationFor(projectId);
                return { jobId: (await ctx.startValidationJob(projectId, application.id, testIds)).id };
            } catch (e) {
                // The tests are stored either way; they stay "Not validated" until someone runs them.
                if (e instanceof HttpError) return { jobId: null, note: e.message };
                throw e;
            }
        },
    };

    return {
        checkScript: (content) => checkScript(content).diagnostics,
        helperNames: (projectId) => custom.listHelpers(projectId).map((h) => h.name),
        repos,
        tests,
    };
}
