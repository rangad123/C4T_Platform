/**
 * A project's GitHub repository, read over the REST API with a fine-grained personal access token (Phase 6, change-aware testing):
 * the pull request, its changed files with their patches, its commits, a branch, and the repository's files at a commit (the source
 * impact analysis reads). Read-only; nothing here writes to GitHub.
 *
 * Every call goes through the issue trackers' request (issues/http.ts): the address guard, no redirect followed, a short timeout and
 * plain-language errors that never hold the token. The token is only ever sent to api.github.com or to the GitHub Enterprise API
 * this server was set up with (CODE_HOST_GITHUB_API_URL); any other address is refused before a request is made.
 */
import { z } from "zod";
import { trackerRequest, TrackerError } from "../issues/http.js";
import { GithubSettings } from "../issues/types.js";

export const GITHUB_API = "https://api.github.com";
/** GitHub's own limits: the files of a pull request list at most 3,000 entries, its commits at most 250. */
export const MAX_PR_FILES = 3000;
export const MAX_PR_COMMITS = 250;
const PER_PAGE = 100;
const API_VERSION = "2022-11-28";

/** What a user enters to connect a repository for code. The token is a fine-grained one (read access to contents and pull requests). */
export const GithubCodeSettings = GithubSettings.omit({ kind: true }).extend({
    /** The secret GitHub signs webhook deliveries with (checked by the webhook, G2). */
    webhookSecret: z.string().min(16, "Use a webhook secret of at least 16 characters").max(200).optional(),
});
export type GithubCodeSettings = z.infer<typeof GithubCodeSettings>;

export interface GithubCodeConfig {
    owner: string;
    repo: string;
    /** The API base; GitHub's own when absent. */
    apiUrl?: string;
}

const trimBase = (u: URL) => `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;

/** The API bases a token may be sent to: GitHub's, and the GitHub Enterprise API set for this server. */
export function allowedApiBases(): string[] {
    const ghe = process.env.CODE_HOST_GITHUB_API_URL?.trim();
    const extra = ghe && URL.canParse(ghe) ? [trimBase(new URL(ghe))] : [];
    return [GITHUB_API, ...extra.filter((b) => b !== GITHUB_API)];
}

/** The API base for a connection, or a "blocked" error when it is not an allowed one. */
export function allowedApiBase(apiUrl?: string): string {
    if (!apiUrl) return GITHUB_API;
    const base = URL.canParse(apiUrl) ? trimBase(new URL(apiUrl)) : "";
    if (/^https?:\/\//.test(base) && allowedApiBases().includes(base)) return base;
    throw new TrackerError("blocked", "This server connects only to GitHub (api.github.com) or the GitHub Enterprise address it was set up with.");
}

export interface PullRequest {
    number: number;
    title: string;
    state: "open" | "closed";
    draft: boolean;
    merged: boolean;
    author?: string;
    url: string;
    head: { ref: string; sha: string; repo?: string };
    base: { ref: string; sha: string; repo?: string };
    /** The head branch lives in another repository (a fork): its code is not this repository's. */
    fromFork: boolean;
    changedFiles: number;
    commits: number;
}

export interface PrFile {
    path: string;
    previousPath?: string;
    status: string;
    additions: number;
    deletions: number;
    /** Absent for binary files and for patches GitHub finds too large to show. */
    patch?: string;
}

export interface PrCommit {
    sha: string;
    message: string;
    author?: string;
    date?: string;
}

export interface TreeFile {
    path: string;
    /** The blob's sha (blob() reads it). */
    sha: string;
    size: number;
}

export interface Branch {
    name: string;
    sha: string;
    protected: boolean;
}

type Json = Record<string, any>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const fmt = (n: number) => n.toLocaleString("en-US");
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const sha = (s: string): string => {
    if (!SHA.test(s)) throw new TrackerError("rejected", "A commit or file id is 40 (or 64) hexadecimal characters.");
    return s;
};

export class GithubCodeHost {
    private readonly base: string;

    constructor(
        private readonly cfg: GithubCodeConfig,
        private readonly token: string,
    ) {
        this.base = allowedApiBase(cfg.apiUrl);
    }

    private async get(path: string): Promise<unknown> {
        const { json } = await trackerRequest({
            method: "GET",
            url: `${this.base}/repos/${encodeURIComponent(this.cfg.owner)}/${encodeURIComponent(this.cfg.repo)}${path}`,
            authorization: `Bearer ${this.token}`,
            headers: { accept: "application/vnd.github+json", "x-github-api-version": API_VERSION },
            service: "GitHub",
        });
        return json;
    }

    /** Every page of a list, up to `cap` entries; `capped` when the cap was reached on a full page. */
    private async list(path: string, cap: number): Promise<{ items: Json[]; capped: boolean }> {
        const items: Json[] = [];
        for (let page = 1; items.length < cap; page++) {
            const json = await this.get(`${path}?per_page=${PER_PAGE}&page=${page}`);
            if (!Array.isArray(json)) throw new TrackerError("rejected", "GitHub answered with something other than a list.");
            items.push(...json);
            if (json.length < PER_PAGE) return { items, capped: false };
        }
        return { items: items.slice(0, cap), capped: true };
    }

    private static number(n: number): number {
        if (!Number.isInteger(n) || n < 1 || n > 1e9) throw new TrackerError("rejected", "A pull request number is a whole number from 1.");
        return n;
    }

    /** A real call that proves the repository and the token work. */
    async verify(): Promise<string> {
        const repo = (await this.get("")) as Json | undefined;
        return `Connected to ${str(repo?.full_name) ?? `${this.cfg.owner}/${this.cfg.repo}`}.`;
    }

    async pr(n: number): Promise<PullRequest> {
        const p = (await this.get(`/pulls/${GithubCodeHost.number(n)}`)) as Json | undefined;
        if (!p || typeof p.number !== "number") throw new TrackerError("rejected", "GitHub did not return the pull request.");
        const head = { ref: str(p.head?.ref) ?? "", sha: str(p.head?.sha) ?? "", ...(str(p.head?.repo?.full_name) ? { repo: p.head.repo.full_name as string } : {}) };
        const base = { ref: str(p.base?.ref) ?? "", sha: str(p.base?.sha) ?? "", ...(str(p.base?.repo?.full_name) ? { repo: p.base.repo.full_name as string } : {}) };
        return {
            number: p.number,
            title: str(p.title) ?? "",
            state: p.state === "closed" ? "closed" : "open",
            draft: p.draft === true,
            merged: p.merged === true,
            ...(str(p.user?.login) ? { author: p.user.login as string } : {}),
            url: str(p.html_url) ?? "",
            head,
            base,
            // A deleted fork has no repository; it is still not this one.
            fromFork: head.repo !== base.repo || !head.repo,
            changedFiles: num(p.changed_files),
            commits: num(p.commits),
        };
    }

    /** The changed files with their patches. Past GitHub's 3,000 files, `limit` says what was left out, in a sentence. */
    async files(n: number): Promise<{ files: PrFile[]; limit?: string }> {
        const { items, capped } = await this.list(`/pulls/${GithubCodeHost.number(n)}/files`, MAX_PR_FILES);
        const files = items.map(
            (f): PrFile => ({
                path: str(f.filename) ?? "",
                ...(str(f.previous_filename) ? { previousPath: f.previous_filename as string } : {}),
                status: str(f.status) ?? "modified",
                additions: num(f.additions),
                deletions: num(f.deletions),
                ...(str(f.patch) !== undefined ? { patch: f.patch as string } : {}),
            }),
        );
        if (!capped) return { files };
        const total = (await this.pr(n)).changedFiles;
        if (total <= MAX_PR_FILES) return { files };
        return { files, limit: `This pull request changes ${fmt(total)} files; GitHub lists only the first ${fmt(MAX_PR_FILES)}, so the other ${fmt(total - MAX_PR_FILES)} are not part of this analysis.` };
    }

    /** The commits, oldest first (GitHub lists at most 250). */
    async commits(n: number): Promise<PrCommit[]> {
        const { items } = await this.list(`/pulls/${GithubCodeHost.number(n)}/commits`, MAX_PR_COMMITS);
        return items.map((c) => ({
            sha: str(c.sha) ?? "",
            message: str(c.commit?.message) ?? "",
            ...(str(c.author?.login) ?? str(c.commit?.author?.name) ? { author: (str(c.author?.login) ?? str(c.commit?.author?.name))! } : {}),
            ...(str(c.commit?.author?.date) ? { date: c.commit.author.date as string } : {}),
        }));
    }

    async branch(name: string): Promise<Branch> {
        // Git refuses these in branch names too; checking first keeps the path from walking anywhere else.
        if (!name || name.length > 255 || /[\u0000-\u001f\u007f ~^:?*[\\]|\.\.|^\/|\/$/.test(name)) throw new TrackerError("rejected", "That is not a branch name Git allows.");
        const b = (await this.get(`/branches/${encodeURIComponent(name)}`)) as Json | undefined;
        if (!b || typeof b.name !== "string") throw new TrackerError("rejected", "GitHub did not return the branch.");
        return { name: b.name, sha: str(b.commit?.sha) ?? "", protected: b.protected === true };
    }

    /** The head commit of the repository's default branch (the code root cause reads, findings/code-source.ts). */
    async head(): Promise<string> {
        const name = str(((await this.get("")) as Json | undefined)?.default_branch);
        if (!name) throw new TrackerError("rejected", "GitHub did not say which branch is the repository's default.");
        return sha((await this.branch(name)).sha);
    }

    /** Every file of the repository at a commit, in one call; `truncated` when GitHub cut the list (it lists about 100,000 entries). */
    async tree(commit: string): Promise<{ files: TreeFile[]; truncated: boolean }> {
        const t = (await this.get(`/git/trees/${sha(commit)}?recursive=1`)) as Json | undefined;
        if (!t || !Array.isArray(t.tree)) throw new TrackerError("rejected", "GitHub did not return the repository's files.");
        const files = (t.tree as Json[]).flatMap((e) => (e.type === "blob" && str(e.path) && str(e.sha) && SHA.test(e.sha) ? [{ path: e.path as string, sha: e.sha as string, size: num(e.size) }] : []));
        return { files, truncated: t.truncated === true };
    }

    /** A file's text by its blob id. */
    async blob(id: string): Promise<string> {
        const b = (await this.get(`/git/blobs/${sha(id)}`)) as Json | undefined;
        if (!b || typeof b.content !== "string") throw new TrackerError("rejected", "GitHub did not return the file.");
        return b.encoding === "base64" ? Buffer.from(b.content, "base64").toString("utf8") : b.content;
    }
}
