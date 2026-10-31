import { toMarkdown, type IssueDraft } from "./content.js";
import { trackerRequest, TrackerError } from "./http.js";
import type { CreatedIssue, IntegrationConfig, IssueProvider } from "./types.js";

type Cfg = Extract<IntegrationConfig, { kind: "github" }>;

const API_VERSION = "2022-11-28";

/** GitHub Issues (github.com, or GitHub Enterprise via `apiUrl`). */
export class GithubProvider implements IssueProvider {
    constructor(
        private readonly cfg: Cfg,
        private readonly token: string,
    ) {}

    private url(path: string): string {
        const base = (this.cfg.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
        return `${base}/repos/${encodeURIComponent(this.cfg.owner)}/${encodeURIComponent(this.cfg.repo)}${path}`;
    }
    private call(method: "GET" | "POST", path: string, body?: unknown) {
        return trackerRequest({
            method,
            url: this.url(path),
            authorization: `Bearer ${this.token}`,
            headers: { accept: "application/vnd.github+json", "x-github-api-version": API_VERSION },
            body,
            service: "GitHub",
        });
    }

    async verify(): Promise<string> {
        const { json } = await this.call("GET", "");
        const repo = json as { full_name?: string; has_issues?: boolean; archived?: boolean } | undefined;
        if (repo?.archived) throw new TrackerError("rejected", "That repository is archived, so issues cannot be created in it.");
        if (repo?.has_issues === false) throw new TrackerError("rejected", "Issues are turned off for that repository. Turn them on in its settings first.");
        return `Connected to ${repo?.full_name ?? `${this.cfg.owner}/${this.cfg.repo}`}.`;
    }

    async createIssue(draft: IssueDraft): Promise<CreatedIssue> {
        const { json } = await this.call("POST", "/issues", { title: draft.title, body: toMarkdown(draft.blocks), labels: draft.labels });
        const issue = json as { number?: number; html_url?: string } | undefined;
        if (!issue?.number || !issue.html_url) throw new TrackerError("rejected", "GitHub accepted the request but did not return the new issue.");
        return { externalId: `#${issue.number}`, url: issue.html_url };
    }
}
