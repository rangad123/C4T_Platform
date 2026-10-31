import { z } from "zod";
import type { IssueDraft } from "./content.js";

/** Issue trackers. (Sentry is also stored in the integrations table but is never a tracker: see ../sentry/.) */
export const INTEGRATION_KINDS = ["github", "jira", "notion"] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

const slug = /^[A-Za-z0-9_.-]+$/;

/** What a user enters to connect GitHub Issues. `apiUrl` is only for GitHub Enterprise. */
export const GithubSettings = z.object({
    kind: z.literal("github"),
    owner: z.string().min(1).max(100).regex(slug, "Owner can only contain letters, numbers, dashes, dots and underscores"),
    repo: z.string().min(1).max(100).regex(slug, "Repository name can only contain letters, numbers, dashes, dots and underscores"),
    token: z.string().min(1).max(500),
    apiUrl: z.string().url().max(300).optional(),
});

/** What a user enters to connect Jira Cloud. */
export const JiraSettings = z.object({
    kind: z.literal("jira"),
    baseUrl: z.string().url().max(300),
    projectKey: z.string().min(1).max(20).regex(/^[A-Za-z][A-Za-z0-9_]*$/, "Project keys are letters and numbers, like SHOP"),
    email: z.string().email().max(200),
    token: z.string().min(1).max(500),
    issueType: z.string().min(1).max(60).default("Bug"),
});

/**
 * A Notion database id, from the id itself (with or without dashes) or from the address of the database as pasted from the
 * browser (`https://www.notion.so/workspace/Name-<32 hex>?v=<view id>`: the view id after `?v=` is not the database).
 */
export function extractNotionDatabaseId(input: string): string | undefined {
    const text = input.trim();
    let candidate = text;
    if (/^https?:\/\//i.test(text)) {
        try {
            candidate = decodeURIComponent(new URL(text).pathname);
        } catch {
            return undefined;
        }
    }
    // The id is the last 32 hex digits of the path (a title and a dash may come before it), or a dashed UUID.
    const dashed = [...candidate.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)].at(-1)?.[0];
    const plain = [...candidate.matchAll(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi)].at(-1)?.[0];
    const hex = (dashed ?? plain)?.replace(/-/g, "").toLowerCase();
    if (!hex || hex.length !== 32) return undefined;
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const NotionDatabaseId = z
    .string()
    .max(600)
    .transform((v, ctx) => {
        const id = extractNotionDatabaseId(v);
        if (!id) ctx.addIssue({ code: "custom", message: "Paste the link to your Notion database, or its 32-character id" });
        return id ?? "";
    });

/** What a user enters to connect a Notion database. `apiUrl` is only for tests and proxies; the default is Notion's own API. */
export const NotionSettings = z.object({
    kind: z.literal("notion"),
    databaseId: NotionDatabaseId,
    titleProperty: z.string().trim().min(1).max(100).default("Name"),
    token: z.string().min(1).max(500),
    apiUrl: z.string().url().max(300).optional(),
});

export const IntegrationSettings = z.discriminatedUnion("kind", [GithubSettings, JiraSettings, NotionSettings]);
export type IntegrationSettings = z.infer<typeof IntegrationSettings>;

/** Non-secret part, stored as JSON. */
export type IntegrationConfig =
    | { kind: "github"; owner: string; repo: string; apiUrl?: string }
    | { kind: "jira"; baseUrl: string; projectKey: string; email: string; issueType: string }
    | { kind: "notion"; databaseId: string; titleProperty: string; apiUrl?: string };

export interface CreatedIssue {
    externalId: string;
    url: string;
}

export interface IssueProvider {
    /** A real call that proves the address and the token work. Returns a short sentence for the user. */
    verify(): Promise<string>;
    createIssue(draft: IssueDraft): Promise<CreatedIssue>;
}
