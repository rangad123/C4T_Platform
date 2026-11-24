/**
 * Read-only access to an application's source code for root cause (testing-engine Phase 5, spec §5.1 item 6). One interface, three
 * backings: a local folder (the bench apps' source), the git-import checkout (platform/git-checkout.ts: files read from git's object
 * store, nothing checked out), and the Phase 6 repository connection (its files read at one commit, platform/code-host/source.ts).
 *
 * Nothing here runs code. Paths are repository paths (forward slashes, relative, no `..`); a local folder resolves each one and refuses
 * anything whose real path leaves the folder (a symlink out of it included). Files over MAX_SOURCE_BYTES read as missing.
 */
import fs from "node:fs";
import path from "node:path";
import { isSafeRepoPath } from "../gitimport/files.js";

export const MAX_SOURCE_BYTES = 1024 * 1024;
export const MAX_SOURCE_FILES = 5000;

export interface SourceCommit {
    sha: string;
    at: string;
    subject: string;
}

export interface CodeSource {
    /** What the backing is, said to the person ("the bench source", "the imported repository at abc1234"). */
    readonly label: string;
    /** Repository paths of the files (capped at MAX_SOURCE_FILES; dependency and hidden folders left out). */
    files(): Promise<string[]>;
    has(file: string): Promise<boolean>;
    /** Lines `from`..`to` (1-based, inclusive; the whole file without them); undefined when the file is not there or too large. */
    read(file: string, from?: number, to?: number): Promise<string[] | undefined>;
    /** The newest `n` commits that touched the file; [] when the backing has no history. */
    log(file: string, n: number): Promise<SourceCommit[]>;
}

const SKIP_DIR = (name: string) => name === "node_modules" || name.startsWith(".");
const slice = (text: string, from?: number, to?: number) => {
    const lines = text.split(/\r?\n/);
    return from === undefined ? lines : lines.slice(Math.max(0, from - 1), to ?? lines.length);
};

/** A folder on this computer (the bench apps under examples/). History: none (a plain folder). */
export function localCodeSource(root: string, label = "the local source folder"): CodeSource {
    const base = fs.realpathSync(root);
    const resolve = (file: string): string | undefined => {
        if (!isSafeRepoPath(file)) return undefined;
        try {
            const real = fs.realpathSync(path.join(base, file));
            if (!real.startsWith(base + path.sep)) return undefined;
            const st = fs.statSync(real);
            return st.isFile() && st.size <= MAX_SOURCE_BYTES ? real : undefined;
        } catch {
            return undefined;
        }
    };
    return {
        label,
        async files() {
            const out: string[] = [];
            const walk = (dir: string, rel: string) => {
                for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (out.length >= MAX_SOURCE_FILES) return;
                    const r = rel ? `${rel}/${e.name}` : e.name;
                    if (e.isDirectory() && !SKIP_DIR(e.name)) walk(path.join(dir, e.name), r);
                    else if (e.isFile()) out.push(r);
                }
            };
            walk(base, "");
            return out.sort();
        },
        async has(file) {
            return resolve(file) !== undefined;
        },
        async read(file, from, to) {
            const real = resolve(file);
            return real ? slice(fs.readFileSync(real, "utf8"), from, to) : undefined;
        },
        async log() {
            return [];
        },
    };
}

/** What a git-import checkout gives (platform/git-checkout.ts `Checkout`), without importing the platform. */
export interface CheckoutLike {
    commit: string;
    entries: ReadonlyArray<{ path: string; type: string; sha: string; size: number }>;
    read(shas: string[]): Promise<Map<string, Buffer>>;
}

/**
 * The git-import checkout, while its folder exists (inside `withCheckout`). History: the import is one commit deep, so no file has
 * commits of its own to show; [].
 */
export function checkoutCodeSource(c: CheckoutLike): CodeSource {
    const blobs = new Map(c.entries.filter((e) => e.type === "blob" && e.size <= MAX_SOURCE_BYTES).map((e) => [e.path, e.sha]));
    const cache = new Map<string, string>();
    const text = async (file: string) => {
        const sha = blobs.get(file);
        if (!sha) return undefined;
        if (!cache.has(file)) cache.set(file, (await c.read([sha])).get(sha)?.toString("utf8") ?? "");
        return cache.get(file);
    };
    return {
        label: `the imported repository at ${c.commit.slice(0, 7)}`,
        async files() {
            return [...blobs.keys()].filter((f) => !f.split("/").slice(0, -1).some(SKIP_DIR)).slice(0, MAX_SOURCE_FILES).sort();
        },
        async has(file) {
            return blobs.has(file);
        },
        async read(file, from, to) {
            const t = await text(file);
            return t === undefined ? undefined : slice(t, from, to);
        },
        async log() {
            return [];
        },
    };
}

/**
 * The project's repository connection (Phase 6, code-host/github.ts): its code files at `commit`, already read (`sources`, by path).
 * shortcut: no commit history (the connection reads no per-file commits yet); add it through the commits API when root cause needs it.
 */
export function repositoryCodeSource(repo: { owner: string; repo: string }, commit: string, sources: Readonly<Record<string, string>>): CodeSource {
    const files = Object.keys(sources)
        .filter((f) => isSafeRepoPath(f) && !f.split("/").slice(0, -1).some(SKIP_DIR))
        .sort()
        .slice(0, MAX_SOURCE_FILES);
    const known = new Set(files);
    return {
        label: `the connected repository ${repo.owner}/${repo.repo} at ${commit.slice(0, 7)}`,
        async files() {
            return files;
        },
        async has(file) {
            return known.has(file);
        },
        async read(file, from, to) {
            return known.has(file) ? slice(sources[file]!, from, to) : undefined;
        },
        async log() {
            return [];
        },
    };
}
