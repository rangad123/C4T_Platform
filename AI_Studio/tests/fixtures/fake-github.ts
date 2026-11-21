/**
 * A local stand-in for the few GitHub REST endpoints the code-host client reads (repository, pull request, its files and commits, a
 * branch). The answers keep the shape and the extra fields of GitHub's documented responses (REST API 2022-11-28), so a client that
 * passes them on unfiltered would be caught. It listens on 127.0.0.1 on a free port; nothing here ever reaches github.com.
 *
 * Every request is recorded (method, path with query, the Authorization header) so a test can prove where a token was sent.
 * Only `Bearer <token>` is accepted; anything else gets GitHub's 401 "Bad credentials".
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

type Pr = { title?: string; author?: string; state?: string; draft?: boolean; merged?: boolean; headRef?: string; headSha?: string; headRepo?: string; files?: FakeFile[]; commits?: FakeCommit[] };
type FakeFile = { filename: string; status?: string; additions?: number; deletions?: number; patch?: string; previous_filename?: string };
type FakeCommit = { sha: string; message?: string; author?: string; login?: string; date?: string };
export interface FakeGithub {
    url: string;
    port: number;
    requests: Array<{ method: string; url: string; authorization?: string }>;
    close: () => Promise<void>;
}

const repoBody = (owner: string, repo: string, port: number) => ({
    id: 1296269,
    node_id: "MDEwOlJlcG9zaXRvcnkxMjk2MjY5",
    name: repo,
    full_name: `${owner}/${repo}`,
    private: true,
    owner: { login: owner, id: 1, type: "Organization" },
    html_url: `https://github.example/${owner}/${repo}`,
    default_branch: "main",
    archived: false,
    has_issues: true,
    permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
    url: `http://127.0.0.1:${port}/repos/${owner}/${repo}`,
});

/** One pull request as GitHub returns it (trimmed to the fields a client might read, plus some it must drop). */
const prBody = (owner: string, repo: string, n: number, pr: Pr) => ({
    url: `https://api.github.example/repos/${owner}/${repo}/pulls/${n}`,
    id: 1000 + n,
    number: n,
    state: pr.state ?? "open",
    locked: false,
    title: pr.title ?? `Change ${n}`,
    user: { login: pr.author ?? "octocat", id: 583231, type: "User" },
    body: "PR-BODY-SENTINEL",
    draft: pr.draft ?? false,
    merged: pr.merged ?? false,
    html_url: `https://github.example/${owner}/${repo}/pull/${n}`,
    head: { label: `${owner}:${pr.headRef ?? "feature"}`, ref: pr.headRef ?? "feature", sha: pr.headSha ?? "6dcb09b5b57875f334f61aebed695e2e4193db5e", repo: { full_name: pr.headRepo ?? `${owner}/${repo}` } },
    base: { label: `${owner}:main`, ref: "main", sha: "e5bd3914e2e596debea16f433f57875b5b90bcd6", repo: { full_name: `${owner}/${repo}` } },
    commits: pr.commits?.length ?? 0,
    additions: 10,
    deletions: 3,
    changed_files: pr.files?.length ?? 0,
});

const fileBody = (f: FakeFile) => ({
    sha: "bbcd538c8e72b8c175046e27cc8f907076331401",
    filename: f.filename,
    status: f.status ?? "modified",
    additions: f.additions ?? 1,
    deletions: f.deletions ?? 0,
    changes: (f.additions ?? 1) + (f.deletions ?? 0),
    blob_url: `https://github.example/blob/${f.filename}`,
    raw_url: `https://github.example/raw/${f.filename}`,
    contents_url: `https://api.github.example/contents/${f.filename}`,
    ...(f.patch !== undefined ? { patch: f.patch } : {}),
    ...(f.previous_filename ? { previous_filename: f.previous_filename } : {}),
});

const commitBody = (c: FakeCommit) => ({
    sha: c.sha,
    node_id: "MDY6Q29tbWl0NmRjYjA5YjViNTc4NzVmMzM0ZjYxYWViZWQ2OTVlMmU0MTkzZGI1ZQ==",
    commit: { author: { name: c.author ?? "Monalisa Octocat", email: "AUTHOR-EMAIL-SENTINEL@example.com", date: c.date ?? "2026-11-01T10:00:00Z" }, message: c.message ?? "Fix all the bugs", tree: { sha: "6dcb09b5" } },
    author: { login: c.login ?? "octocat" },
    parents: [],
});

export async function startFakeGithub(opts: { token: string; owner?: string; repo?: string; prs?: Record<number, Pr>; branches?: Record<string, { sha: string; protected?: boolean }> }): Promise<FakeGithub> {
    const owner = opts.owner ?? "acme";
    const repo = opts.repo ?? "shop";
    const requests: FakeGithub["requests"] = [];
    const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "x-github-api-version-selected": "2022-11-28", ...headers });
        res.end(JSON.stringify(body));
    };
    const page = <T>(list: T[], q: URLSearchParams): T[] => {
        const per = Math.min(100, Number(q.get("per_page") ?? 30));
        const p = Math.max(1, Number(q.get("page") ?? 1));
        return list.slice((p - 1) * per, p * per);
    };
    let port = 0;
    const server = http.createServer((req, res) => {
        const u = new URL(req.url ?? "/", "http://127.0.0.1");
        requests.push({ method: req.method ?? "", url: `${u.pathname}${u.search}`, authorization: req.headers.authorization });
        if (req.headers.authorization !== `Bearer ${opts.token}`) return send(res, 401, { message: "Bad credentials", documentation_url: "https://docs.github.com/rest" });
        const base = `/repos/${owner}/${repo}`;
        if (!u.pathname.startsWith(base)) return send(res, 404, { message: "Not Found" });
        const rest = u.pathname.slice(base.length);
        if (rest === "") return send(res, 200, repoBody(owner, repo, port));
        let m = /^\/pulls\/(\d+)(\/files|\/commits)?$/.exec(rest);
        if (m) {
            const n = Number(m[1]);
            const pr = opts.prs?.[n];
            if (!pr) return send(res, 404, { message: "Not Found" });
            if (!m[2]) return send(res, 200, prBody(owner, repo, n, pr));
            // GitHub's own limits on these lists: 3,000 files and 250 commits, whatever the pull request holds.
            if (m[2] === "/files") return send(res, 200, page((pr.files ?? []).slice(0, 3000), u.searchParams).map(fileBody));
            return send(res, 200, page((pr.commits ?? []).slice(0, 250), u.searchParams).map(commitBody));
        }
        m = /^\/branches\/(.+)$/.exec(rest);
        if (m) {
            const name = decodeURIComponent(m[1]!);
            const b = opts.branches?.[name];
            if (!b) return send(res, 404, { message: "Branch not found" });
            return send(res, 200, { name, commit: { sha: b.sha, commit: { message: "COMMIT-MESSAGE-SENTINEL" } }, protected: b.protected ?? false, protection_url: "https://api.github.example/protection" });
        }
        return send(res, 404, { message: "Not Found" });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    return {
        url: `http://127.0.0.1:${port}`,
        port,
        requests,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}
