/**
 * A throwaway, shallow, check-out-free copy of a repository. Files are read straight out of git's object store (`cat-file`), so
 * nothing is ever written into a working tree: no hooks run, no symlink is created, no submodule is fetched, and no file from
 * the repository is executed. The folder is removed when the work is done, whatever happened.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cloneArgs, catFileBatchArgs, fetchCommitArgs, friendlyGitError, gitEnv, headArgs, initArgs, listTreeArgs, lsRemoteArgs, safetyConfig, scrub, GIT_TIMEOUT_MS } from "../engine/gitimport/git-args.js";
import { MAX_CHECKOUT_BYTES, MAX_CHECKOUT_FILES, isSafeRepoPath } from "../engine/gitimport/files.js";
import type { RepoAddress } from "../engine/gitimport/url.js";
import { HttpError } from "./http-error.js";
import { runGit, type GitCommand, type GitRunResult } from "./git-runner.js";

export interface GitOptions {
    /** Folder under which throwaway work folders are made. */
    scratchRoot: string;
    /** Test seam: lets a local path, file:// or http:// address through, and swaps the git program. Never set by the HTTP API. */
    allowLocal?: boolean;
    git?: GitCommand;
    timeoutMs?: number;
    maxCheckoutBytes?: number;
    maxFiles?: number;
    /** What the run would see as its environment (tests only). */
    baseEnv?: NodeJS.ProcessEnv;
}

export interface TreeEntry {
    path: string;
    mode: string;
    type: string;
    sha: string;
    size: number;
}

export interface Checkout {
    commit: string;
    /** The branch that was fetched (the repository's default branch when none was asked for), or the tag/commit given. */
    ref: string;
    entries: TreeEntry[];
    /** Contents of blobs by object id. */
    read(shas: string[]): Promise<Map<string, Buffer>>;
}

export class GitSession {
    readonly timeoutMs: number;
    readonly maxBytes: number;
    readonly maxFiles: number;
    private gitChecked: boolean | undefined;

    constructor(readonly opts: GitOptions) {
        this.timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
        this.maxBytes = opts.maxCheckoutBytes ?? MAX_CHECKOUT_BYTES;
        this.maxFiles = opts.maxFiles ?? MAX_CHECKOUT_FILES;
    }

    private get cmd(): GitCommand {
        return this.opts.git ?? { file: "git" };
    }

    /** Remove work folders a crashed process left behind (older than an hour). */
    sweepStale(): void {
        try {
            for (const name of fs.readdirSync(this.opts.scratchRoot)) {
                const p = path.join(this.opts.scratchRoot, name);
                if (name.startsWith("run-") && Date.now() - fs.statSync(p).mtimeMs > 3_600_000) fs.rmSync(p, { recursive: true, force: true });
            }
        } catch {
            /* nothing to sweep */
        }
    }

    /** Folders still present under the scratch root (tests assert this is empty). */
    leftovers(): string[] {
        try {
            return fs.readdirSync(this.opts.scratchRoot).filter((n) => n.startsWith("run-"));
        } catch {
            return [];
        }
    }

    private async ensureGit(): Promise<void> {
        if (this.gitChecked) return;
        const dir = this.makeWorkDir();
        try {
            const r = await runGit(this.cmd, ["--version"], { cwd: dir.root, env: this.env(dir), timeoutMs: 15_000 });
            if (r.missing || r.code !== 0) throw new HttpError(422, "Git isn't installed on the computer that runs the platform. Install Git there and try again.");
            this.gitChecked = true;
        } finally {
            this.removeDir(dir.root);
        }
    }

    private makeWorkDir() {
        const root = path.join(this.opts.scratchRoot, `run-${randomUUID()}`);
        const hooks = path.join(root, "no-hooks");
        const home = path.join(root, "home");
        fs.mkdirSync(hooks, { recursive: true });
        fs.mkdirSync(home, { recursive: true });
        const emptyConfig = path.join(home, "gitconfig");
        fs.writeFileSync(emptyConfig, "");
        return { root, hooks, home, emptyConfig, repo: path.join(root, "repo") };
    }

    private env(dir: { home: string; emptyConfig: string }, address?: RepoAddress, token?: string): Record<string, string> {
        const origin = address && address.cloneUrl.startsWith("http") ? new URL(address.cloneUrl).origin : undefined;
        return gitEnv({ base: this.opts.baseEnv ?? process.env, scratch: dir.home, emptyConfig: dir.emptyConfig, origin, token, allowLocal: !!this.opts.allowLocal });
    }

    private removeDir(root: string): void {
        try {
            fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
        } catch {
            /* reported by leftovers() */
        }
    }

    private fail(r: GitRunResult, token: string | undefined): never {
        if (r.missing) throw new HttpError(422, "Git isn't installed on the computer that runs the platform. Install Git there and try again.");
        const stderr = scrub(r.stderr, [token]);
        throw new HttpError(422, friendlyGitError(stderr, { timedOut: r.timedOut, tooLarge: r.tooLarge, hasToken: !!token }));
    }

    /** The commit a ref points at on the server, without downloading the repository. Undefined when the ref is a commit id or not found. */
    async remoteHead(address: RepoAddress, ref: string, token?: string): Promise<string | undefined> {
        await this.ensureGit();
        const dir = this.makeWorkDir();
        try {
            const cfg = safetyConfig({ hooksDir: dir.hooks, allowLocal: !!this.opts.allowLocal, hasToken: !!token });
            const r = await runGit(this.cmd, lsRemoteArgs(cfg, address.cloneUrl, ref), { cwd: dir.root, env: this.env(dir, address, token), timeoutMs: this.timeoutMs });
            if (r.code !== 0) this.fail(r, token);
            const lines = r.stdout.toString("utf8").split("\n").map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 2);
            const byName = new Map(lines.map(([sha, name]) => [name!, sha!]));
            if (!ref) return byName.get("HEAD");
            return byName.get(`refs/heads/${ref}`) ?? byName.get(`refs/tags/${ref}^{}`) ?? byName.get(`refs/tags/${ref}`) ?? byName.get(ref);
        } finally {
            this.removeDir(dir.root);
        }
    }

    /** Download, list, hand to `fn`, and always remove the folder afterwards. */
    async withCheckout<T>(address: RepoAddress, ref: { ref: string; isCommit: boolean }, token: string | undefined, fn: (c: Checkout) => Promise<T>): Promise<T> {
        await this.ensureGit();
        const dir = this.makeWorkDir();
        const cfg = safetyConfig({ hooksDir: dir.hooks, allowLocal: !!this.opts.allowLocal, hasToken: !!token });
        const env = this.env(dir, address, token);
        const base = { cwd: dir.root, env, timeoutMs: this.timeoutMs };
        try {
            if (ref.isCommit) {
                // A single commit is fetched by its id; servers may refuse that, in which case the message says so.
                fs.mkdirSync(dir.repo, { recursive: true });
                let r = await runGit(this.cmd, initArgs(cfg, dir.repo), base);
                if (r.code !== 0) this.fail(r, token);
                r = await runGit(this.cmd, fetchCommitArgs(cfg, address.cloneUrl, ref.ref), { ...base, cwd: dir.repo, watchDir: dir.repo, maxDirBytes: this.maxBytes * 2 });
                if (r.code !== 0) this.fail(r, token);
                r = await runGit(this.cmd, [...cfg, "update-ref", "HEAD", "FETCH_HEAD"], { ...base, cwd: dir.repo });
                if (r.code !== 0) this.fail(r, token);
            } else {
                const r = await runGit(this.cmd, cloneArgs(cfg, { url: address.cloneUrl, dir: dir.repo, ref: ref.ref, allowLocal: !!this.opts.allowLocal }), { ...base, watchDir: dir.repo, maxDirBytes: this.maxBytes * 2 });
                if (r.code !== 0) this.fail(r, token);
            }
            const inRepo = { ...base, cwd: dir.repo };
            const head = await runGit(this.cmd, headArgs(cfg), inRepo);
            const commit = head.stdout.toString("utf8").trim();
            if (head.code !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) this.fail(head, token);
            const tree = await runGit(this.cmd, listTreeArgs(cfg), { ...inRepo, maxStdout: 8 * 1024 * 1024 });
            if (tree.code !== 0 || tree.tooLarge) this.fail(tree, token);
            const entries = parseTree(tree.stdout.toString("utf8"));
            if (entries.length > this.maxFiles) throw new HttpError(422, `That repository has more than ${this.maxFiles} files, which is too many to import. Point to a smaller repository.`);
            if (entries.reduce((n, e) => n + e.size, 0) > this.maxBytes) throw new HttpError(422, "That repository is too large to import (the limit is 50 MB). Point to a smaller repository.");
            let resolvedRef = ref.ref;
            if (!resolvedRef) {
                const sym = await runGit(this.cmd, [...cfg, "symbolic-ref", "--short", "HEAD"], inRepo);
                resolvedRef = sym.code === 0 ? sym.stdout.toString("utf8").trim() : "HEAD";
            }
            return await fn({
                commit,
                ref: resolvedRef,
                entries,
                read: async (shas) => {
                    const out = new Map<string, Buffer>();
                    if (!shas.length) return out;
                    const r = await runGit(this.cmd, catFileBatchArgs(cfg), { ...inRepo, input: shas.map((s) => `${s}\n`).join(""), maxStdout: 64 * 1024 * 1024 });
                    if (r.code !== 0 || r.tooLarge) this.fail(r, token);
                    let pos = 0;
                    const buf = r.stdout;
                    for (const sha of shas) {
                        const nl = buf.indexOf(10, pos);
                        if (nl < 0) break;
                        const header = buf.subarray(pos, nl).toString("utf8").split(" ");
                        const size = Number(header[2]);
                        if (header[1] === "missing" || !Number.isFinite(size)) {
                            pos = nl + 1;
                            continue;
                        }
                        out.set(sha, buf.subarray(nl + 1, nl + 1 + size));
                        pos = nl + 1 + size + 1;
                    }
                    return out;
                },
            });
        } finally {
            this.removeDir(dir.root);
        }
    }
}

/** `git ls-tree -r -l -z` output: `<mode> <type> <sha> <size>\t<path>\0`. Unsafe paths are dropped here, once. */
export function parseTree(text: string): TreeEntry[] {
    const out: TreeEntry[] = [];
    for (const rec of text.split("\0")) {
        const m = /^(\d+) (\w+) ([0-9a-f]{40,64}) +(\d+|-)\t([\s\S]+)$/.exec(rec);
        if (!m) continue;
        const [, mode, type, sha, size, p] = m;
        if (!isSafeRepoPath(p!)) continue;
        out.push({ path: p!, mode: mode!, type: type!, sha: sha!, size: size === "-" ? 0 : Number(size) });
    }
    return out;
}
