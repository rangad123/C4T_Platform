export type TrackerKind = "github" | "jira" | "notion";

export interface Integration {
    id: string;
    projectId: string;
    kind: TrackerKind;
    name: string;
    config: { kind: TrackerKind; owner?: string; repo?: string; apiUrl?: string; baseUrl?: string; projectKey?: string; email?: string; issueType?: string; databaseId?: string; titleProperty?: string };
    createdAt: string;
}

export interface IssueLink {
    id: string;
    testId: string;
    integrationId: string | null;
    provider: TrackerKind;
    externalId: string;
    url: string;
    title: string | null;
    createdAt: string;
}

export const TRACKER_LABEL: Record<TrackerKind, string> = { github: "GitHub", jira: "Jira", notion: "Notion" };

/** One line saying where a connection points, without anything secret. */
export function describeConnection(i: Integration): string {
    const c = i.config;
    if (c.kind === "github") return `${c.owner}/${c.repo}${c.apiUrl ? ` · ${new URL(c.apiUrl).host}` : ""}`;
    if (c.kind === "notion") return `database ${(c.databaseId ?? "").slice(0, 8)}${c.apiUrl ? `, at ${new URL(c.apiUrl).host}` : ""}`;
    return `${c.projectKey} · ${c.baseUrl ? new URL(c.baseUrl).host : ""}`;
}
