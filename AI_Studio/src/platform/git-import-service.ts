/**
 * Git import: bring hand-written Playwright test files from a repository into a project as custom tests.
 *
 * What it does with a repository: reads files out of a shallow copy (see git-checkout.ts), looks at them as text, runs the static
 * guard over each one, and stores the ones that pass as custom tests with a record of where they came from. Nothing from the
 * repository is executed. The tests themselves, the guard and the repository table belong to the custom-script feature and are
 * reached through the small `GitImportPorts` interface, so this file knows nothing about how they are stored.
 */
import {
    MAX_FILE_BYTES,
    MAX_TEST_FILES,
    classifyPath,
    cleanTitle,
    decodeUtf8,
    importProblems,
    isUnder,
    scanTestFile,
    type FileScan,
} from "../engine/gitimport/files.js";
import { validateToken } from "../engine/gitimport/git-args.js";
import { buildProvenance, type GitProvenance } from "../engine/gitimport/provenance.js";
import { GitInputError, normalizeSubpath, parseRef, parseRepoUrl, type RepoAddress } from "../engine/gitimport/url.js";
import { GitSession, type Checkout, type GitOptions } from "./git-checkout.js";
import { HttpError } from "./http-error.js";
import { assertAllowedTarget } from "./net-guard.js";

export interface GuardDiagnostic {
    severity: "error" | "warning";
    line: number;
    column: number;
    message: string;
    rule?: string;
}

export interface RepoRecord {
    id: string;
    projectId: string;
    host: string;
    path: string;
    ref: string;
    commit: string;
    importedAt: string;
    url?: string;
    subpath?: string;
}

/** The repository table (AQ's `GitRepoStore`), seen from here. */
export interface GitRepoPort {
    /** `url` is the address git was given (never with credentials) and `subpath` the folder imported. */
    create(r: Omit<RepoRecord, "id"> & { url: string; subpath: string }): RepoRecord;
    list(projectId: string): RepoRecord[];
    get(projectId: string, id: string): RepoRecord | undefined;
    update(id: string, patch: Partial<Pick<RepoRecord, "ref" | "commit" | "importedAt">>): void;
    delete(projectId: string, id: string): void;
}

export interface UpsertedTest {
    testId: string;
    created: boolean;
    /** A new version was stored (always true for a created test). */
    changed: boolean;
}

/** Custom tests (AQ's model), seen from here. */
export interface CustomTestPort {
    /** Create or update the custom test for (repository, file). A new version is stored only when the text differs. */
    upsert(projectId: string, repoId: string, file: { path: string; title: string; content: string; provenance: GitProvenance }): Promise<UpsertedTest>;
    /**
     * The tests imported from a repository, with their current script text. `importedContent` is the text of the newest version a Git import stored; when it
     * differs from `content` the script was edited here since.
     */
    forRepo(repoId: string): Array<{ testId: string; path: string; content: string; importedContent?: string }>;
    /** Queue the normal validation job; `jobId` is null (with a note) when it cannot run now. */
    queueValidation(projectId: string, testIds: string[]): Promise<{ jobId: string | null; note?: string }>;
}

export interface GitImportPorts {
    /** The static guard (syntax and rules) over a script. */
    checkScript(content: string, fileName: string): GuardDiagnostic[];
    /** Names of the helper modules the project already has. */
    helperNames(projectId: string): string[];
    /** Most bytes of script text one import runs the safety check over (default GUARD_BUDGET_BYTES). A test can lower it. */
    guardBudgetBytes?: number;
    repos: GitRepoPort;
    tests: CustomTestPort;
}

export interface ImportRequest {
    url: string;
    ref?: string;
    path?: string;
    token?: string;
    dryRun?: boolean;
}

export interface PreviewFile {
    path: string;
    title: string;
    bytes: number;
    tests: number;
    problems: string[];
    warnings: string[];
}
export interface SkippedFile {
    path: string;
    reason: string;
    /** The file was changed by hand here since the last import, so a refresh left it alone. */
    editedHere?: true;
}
export interface Preview {
    commit: string;
    files: PreviewFile[];
    skipped: SkippedFile[];
}
export interface ImportResult {
    commit: string;
    imported: Array<{ testId: string; path: string; created: boolean; changed: boolean }>;
    skipped: SkippedFile[];
    jobId: string | null;
    note?: string;
}
export interface CheckResult {
    upToDate: boolean;
    newCommit?: string;
    changed: Array<{ testId: string; path: string; removed?: boolean; editedHere?: true }>;
    added: string[];
}

const MAX_SKIPPED_LISTED = 100;
/** Script text one import checks with the static guard, in bytes (about 40 files of the largest allowed size; ordinary test files are a few KB). */
export const GUARD_BUDGET_BYTES = 8_000_000;
/** Imports running at the same time on the whole platform (each downloads up to 100 MB and runs git). */
export const MAX_CONCURRENT_IMPORTS = 2;
export const EDITED_HERE = "Edited here since the last import, so it was left as it is.";
const editedHere = (m: { content: string; importedContent?: string }): boolean => m.importedContent !== undefined && m.importedContent !== m.content;

interface Scanned {
    preview: Preview;
    /** Text of the files that may be imported, by path. */
    importable: Map<string, { title: string; content: string; scan: FileScan }>;
}

export class GitImportService {
    readonly session: GitSession;
    private readonly busy = new Set<string>();
    private running = 0;

    constructor(
        opts: GitOptions,
        private readonly ports: GitImportPorts,
    ) {
        this.session = new GitSession(opts);
        this.session.sweepStale();
    }

    private async lock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
        if (this.busy.has(projectId)) throw new HttpError(409, "Another Git import is already running for this project. Wait for it to finish and try again.");
        if (this.running >= MAX_CONCURRENT_IMPORTS) throw new HttpError(429, "Other Git imports are running right now. Wait a minute and try again.");
        this.busy.add(projectId);
        this.running += 1;
        try {
            return await fn();
        } finally {
            this.running -= 1;
            this.busy.delete(projectId);
        }
    }

    /** Validate the request and apply the address guard. Input mistakes are 400s with a plain sentence. */
    private async prepare(req: ImportRequest): Promise<{ address: RepoAddress; ref: ReturnType<typeof parseRef>; subpath: string; token: string | undefined }> {
        try {
            const address = parseRepoUrl(req.url, { allowLocal: !!this.session.opts.allowLocal });
            const ref = parseRef(req.ref);
            const subpath = normalizeSubpath(req.path);
            const token = validateToken(req.token);
            if (address.transport === "https") await assertAllowedTarget(address.cloneUrl);
            return { address, ref, subpath, token: address.cloneUrl.startsWith("http") ? token : undefined };
        } catch (e) {
            if (e instanceof GitInputError) throw new HttpError(400, e.message);
            throw e;
        }
    }

    /** Look at every candidate file in a checkout: titles, counts, problems. Nothing is stored. */
    private async scan(projectId: string, checkout: Checkout, subpath: string): Promise<Scanned> {
        const helpers = new Set(this.ports.helperNames(projectId));
        const skipped: SkippedFile[] = [];
        let ignoredInFolders = 0;
        const candidates = [];
        for (const e of checkout.entries) {
            if (!isUnder(e.path, subpath)) continue;
            const kind = classifyPath(e.path);
            if (kind === "ignore") continue;
            if (kind !== "candidate") {
                ignoredInFolders += 1;
                continue;
            }
            if (e.mode === "120000") skipped.push({ path: e.path, reason: "A symbolic link, which is never followed." });
            else if (e.type !== "blob") skipped.push({ path: e.path, reason: "Not a regular file." });
            else if (e.size > MAX_FILE_BYTES) skipped.push({ path: e.path, reason: `Larger than ${MAX_FILE_BYTES / 1024} KB; a test file that big is probably not a test.` });
            else candidates.push(e);
        }
        if (ignoredInFolders) skipped.push({ path: "", reason: `${ignoredInFolders} test file${ignoredInFolders === 1 ? "" : "s"} inside node_modules or hidden folders ${ignoredInFolders === 1 ? "was" : "were"} left out.` });
        if (candidates.length === 0) return { preview: { commit: checkout.commit, files: [], skipped }, importable: new Map() };
        if (candidates.length > MAX_TEST_FILES) {
            throw new HttpError(422, `That ${subpath ? "folder" : "repository"} has ${candidates.length} test files, more than the ${MAX_TEST_FILES} that can be imported at once. Set the folder to a smaller part of the repository.`);
        }
        const blobs = await checkout.read([...new Set(candidates.map((c) => c.sha))]);
        const files: PreviewFile[] = [];
        const importable = new Map<string, { title: string; content: string; scan: FileScan }>();
        let guarded = 0;
        for (const c of candidates) {
            const buf = blobs.get(c.sha);
            const content = buf ? decodeUtf8(buf) : null;
            if (content === null) {
                skipped.push({ path: c.path, reason: "Not a text file (binary content or not UTF-8)." });
                continue;
            }
            // The safety check is cheap but not free, and a repository is not ours: a total budget of checked code per import, and a breath for the
            // server between files, so a repository full of large files cannot hold up every other request.
            guarded += buf!.length;
            if (guarded > (this.ports.guardBudgetBytes ?? GUARD_BUDGET_BYTES)) {
                skipped.push({ path: c.path, reason: `This import holds more code than can be checked at once (${Math.round((this.ports.guardBudgetBytes ?? GUARD_BUDGET_BYTES) / 1_000_000)} MB). Import a smaller folder.` });
                continue;
            }
            await new Promise<void>((resolve) => setImmediate(resolve));
            const scan = scanTestFile(content, c.path);
            const reported = importProblems(scan, helpers);
            const diagnostics = this.ports.checkScript(content, c.path.split("/").pop()!);
            const problems = [...reported];
            for (const d of diagnostics) {
                if (d.severity !== "error") continue;
                // The friendlier sentence above already covers an import the guard also names.
                if (scan.imports.some((i) => i && d.message.includes(i) && reported.some((r) => r.includes(i)))) continue;
                const text = d.line ? `Line ${d.line}: ${d.message}` : d.message;
                if (!problems.includes(text)) problems.push(text);
            }
            const warnings = diagnostics.filter((d) => d.severity === "warning").map((d) => (d.line ? `Line ${d.line}: ${d.message}` : d.message));
            files.push({ path: c.path, title: cleanTitle(scan.title), bytes: c.size, tests: scan.tests, problems: problems.slice(0, 10).map(cap), warnings: warnings.slice(0, 10).map(cap) });
            if (problems.length === 0) importable.set(c.path, { title: cleanTitle(scan.title), content, scan });
        }
        files.sort((a, b) => a.path.localeCompare(b.path));
        return { preview: { commit: checkout.commit, files, skipped: capSkipped(skipped) }, importable };
    }

    /** Preview: what would be imported. Touches nothing in the database. */
    async dryRun(projectId: string, req: ImportRequest): Promise<Preview> {
        return this.lock(projectId, async () => {
            const { address, ref, subpath, token } = await this.prepare(req);
            return this.session.withCheckout(address, ref, token, async (c) => (await this.scan(projectId, c, subpath)).preview);
        });
    }

    async import(projectId: string, req: ImportRequest): Promise<ImportResult> {
        return this.lock(projectId, async () => {
            const { address, ref, subpath, token } = await this.prepare(req);
            return this.session.withCheckout(address, ref, token, (c) => this.store(projectId, address, c, subpath, undefined, c.ref));
        });
    }

    /** Store the importable files of a scanned checkout. `existing` is the repository row when refreshing. */
    private async store(projectId: string, address: RepoAddress, checkout: Checkout, subpath: string, existing: RepoRecord | undefined, ref: string): Promise<ImportResult> {
        const { preview, importable } = await this.scan(projectId, checkout, subpath);
        const skipped = [...preview.skipped];
        for (const f of preview.files) if (f.problems.length) skipped.push({ path: f.path, reason: cap(f.problems.join(" ")) });
        if (preview.files.length === 0 && preview.skipped.every((s) => s.path === "")) {
            throw new HttpError(422, `No test files were found${subpath ? ` in ${subpath}` : ""}. Test files are named *.spec.ts, *.spec.js, *.test.ts or *.test.js.`);
        }
        const now = new Date();
        const found = existing ?? this.findRepo(projectId, address, ref, subpath);
        const repo = found ?? this.createRepo(projectId, address, ref, checkout.commit, subpath, now);
        if (found) this.ports.repos.update(found.id, { ref, commit: checkout.commit, importedAt: now.toISOString() });
        const result: ImportResult["imported"] = [];
        const mine = new Map(this.ports.tests.forRepo(repo.id).map((m) => [m.path, m]));
        try {
            for (const [file, f] of importable) {
                // A hand edit is never overwritten without being asked: the file is reported and left as it is.
                const have = mine.get(file);
                if (have && editedHere(have) && have.content !== f.content) {
                    skipped.push({ path: file, reason: EDITED_HERE, editedHere: true });
                    continue;
                }
                const provenance = buildProvenance({ host: address.host, path: address.path, ref, commit: checkout.commit, repoId: repo.id, file, now });
                const r = await this.ports.tests.upsert(projectId, repo.id, { path: file, title: f.title, content: f.content, provenance });
                result.push({ testId: r.testId, path: file, created: r.created, changed: r.changed });
            }
        } catch (e) {
            // A repository link with no tests behind it would only confuse; keep the tests stored so far when there are some.
            if (!found && result.length === 0) this.ports.repos.delete(projectId, repo.id);
            throw e;
        }
        const toValidate = result.filter((r) => r.changed || r.created).map((r) => r.testId);
        const queued: { jobId: string | null; note?: string } = toValidate.length ? await this.ports.tests.queueValidation(projectId, toValidate) : { jobId: null };
        return { commit: checkout.commit, imported: result, skipped: capSkipped(skipped), jobId: queued.jobId, ...(queued.note ? { note: queued.note } : {}) };
    }

    private findRepo(projectId: string, address: RepoAddress, ref: string, subpath: string): RepoRecord | undefined {
        return this.ports.repos.list(projectId).find((r) => r.host === address.host && r.path === address.path && r.ref === ref && (r.subpath ?? "") === subpath);
    }

    private createRepo(projectId: string, address: RepoAddress, ref: string, commit: string, subpath: string, now: Date): RepoRecord {
        // Only the address git was given (never credentials: the parser refuses them) and the folder are kept.
        return this.ports.repos.create({ projectId, host: address.host, path: address.path, ref, commit, importedAt: now.toISOString(), url: address.cloneUrl, subpath });
    }

    list(projectId: string): Array<RepoRecord & { tests: number }> {
        return this.ports.repos.list(projectId).map((r) => ({ ...r, tests: this.ports.tests.forRepo(r.id).length }));
    }

    private repoOrThrow(projectId: string, gid: string): { repo: RepoRecord; source: { url: string; subpath: string } } {
        const repo = this.ports.repos.get(projectId, gid);
        const source = repo?.url ? { url: repo.url, subpath: repo.subpath ?? "" } : undefined;
        if (!repo || !source) throw new HttpError(404, "That repository is not linked to this project.");
        return { repo, source };
    }

    /** Is there something new upstream, and which imported files differ? Downloads only when the remote head moved. */
    async check(projectId: string, gid: string, token?: string): Promise<CheckResult> {
        const { repo, source } = this.repoOrThrow(projectId, gid);
        return this.lock(projectId, async () => {
            const { address, ref, token: tk } = await this.prepare({ url: source.url, ref: repo.ref, token });
            if (ref.isCommit) return { upToDate: true, changed: [], added: [] };
            const head = await this.session.remoteHead(address, ref.ref, tk);
            if (head && head === repo.commit) return { upToDate: true, changed: [], added: [] };
            return this.session.withCheckout(address, ref, tk, async (c) => {
                const { importable } = await this.scan(projectId, c, source.subpath);
                const mine = this.ports.tests.forRepo(repo.id);
                const known = new Set(mine.map((m) => m.path));
                const changed: CheckResult["changed"] = [];
                for (const m of mine) {
                    const now = importable.get(m.path);
                    const edited = editedHere(m) ? { editedHere: true as const } : {};
                    if (!now) changed.push({ testId: m.testId, path: m.path, removed: true, ...edited });
                    // Compared with what the last import stored: a hand edit alone is not "the repository changed".
                    else if (now.content !== (m.importedContent ?? m.content)) changed.push({ testId: m.testId, path: m.path, ...edited });
                }
                const added = [...importable.keys()].filter((p) => !known.has(p));
                return { upToDate: c.commit === repo.commit && changed.length === 0 && added.length === 0, newCommit: c.commit === repo.commit ? undefined : c.commit, changed, added };
            });
        });
    }

    async refresh(projectId: string, gid: string, token?: string): Promise<ImportResult> {
        const { repo, source } = this.repoOrThrow(projectId, gid);
        return this.lock(projectId, async () => {
            const { address, ref, token: tk } = await this.prepare({ url: source.url, ref: repo.ref, token });
            return this.session.withCheckout(address, ref, tk, (c) => this.store(projectId, address, c, source.subpath, repo, repo.ref));
        });
    }

    /** Drop the link. The tests stay, as custom tests with their history. */
    remove(projectId: string, gid: string): void {
        const { repo } = this.repoOrThrow(projectId, gid);
        this.ports.repos.delete(projectId, repo.id);
    }
}

const cap = (s: string) => (s.length > 300 ? `${s.slice(0, 299)}…` : s);

function capSkipped(list: SkippedFile[]): SkippedFile[] {
    if (list.length <= MAX_SKIPPED_LISTED) return list;
    return [...list.slice(0, MAX_SKIPPED_LISTED), { path: "", reason: `${list.length - MAX_SKIPPED_LISTED} more files were skipped.` }];
}
