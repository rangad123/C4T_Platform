import { toAdf, type IssueDraft } from "./content.js";
import { trackerRequest, TrackerError } from "./http.js";
import type { CreatedIssue, IntegrationConfig, IssueProvider } from "./types.js";

type Cfg = Extract<IntegrationConfig, { kind: "jira" }>;

/** Jira Cloud (REST API v3: descriptions are Atlassian Document Format). */
export class JiraProvider implements IssueProvider {
    constructor(
        private readonly cfg: Cfg,
        private readonly token: string,
    ) {}

    private get base(): string {
        return this.cfg.baseUrl.replace(/\/+$/, "");
    }
    private call(method: "GET" | "POST", path: string, body?: unknown) {
        const basic = Buffer.from(`${this.cfg.email}:${this.token}`).toString("base64");
        return trackerRequest({ method, url: `${this.base}${path}`, authorization: `Basic ${basic}`, body, service: "Jira" });
    }

    async verify(): Promise<string> {
        // /myself proves the email + token pair; the project lookup proves the key exists and is visible.
        const me = (await this.call("GET", "/rest/api/3/myself")).json as { displayName?: string } | undefined;
        const project = (await this.call("GET", `/rest/api/3/project/${encodeURIComponent(this.cfg.projectKey)}`)).json as { name?: string } | undefined;
        return `Connected to Jira project ${project?.name ?? this.cfg.projectKey}${me?.displayName ? ` as ${me.displayName}` : ""}.`;
    }

    async createIssue(draft: IssueDraft): Promise<CreatedIssue> {
        const { json } = await this.call("POST", "/rest/api/3/issue", {
            fields: {
                project: { key: this.cfg.projectKey },
                summary: draft.title.slice(0, 250),
                issuetype: { name: this.cfg.issueType },
                description: toAdf(draft.blocks),
                // Jira labels cannot contain spaces.
                labels: draft.labels.map((l) => l.replace(/\s+/g, "-")),
            },
        });
        const issue = json as { key?: string } | undefined;
        if (!issue?.key) throw new TrackerError("rejected", "Jira accepted the request but did not return the new issue.");
        return { externalId: issue.key, url: `${this.base}/browse/${issue.key}` };
    }
}
