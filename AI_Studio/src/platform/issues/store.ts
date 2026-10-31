import { randomUUID } from "node:crypto";
import type { Db, Row } from "../db.js";
import type { SecretBox } from "../secrets.js";
import { GithubProvider } from "./github.js";
import { JiraProvider } from "./jira.js";
import { NotionProvider } from "./notion.js";
import { INTEGRATION_KINDS, type IntegrationConfig, type IntegrationKind, type IntegrationSettings, type IssueProvider } from "./types.js";

const now = () => new Date().toISOString();

/** Only issue trackers. A Sentry connection lives in the same table (see ../sentry/store.ts) but must never show up here. */
const TRACKER_KINDS_SQL = INTEGRATION_KINDS.map((k) => `'${k}'`).join(", ");

/** An integration as the API shows it: never any secret. */
export interface PublicIntegration {
    id: string;
    projectId: string;
    kind: IntegrationKind;
    name: string;
    config: IntegrationConfig;
    createdAt: string;
}

export interface IssueLink {
    id: string;
    testId: string;
    integrationId: string | null;
    provider: IntegrationKind;
    externalId: string;
    url: string;
    title: string | null;
    createdAt: string;
}

const toPublic = (r: Row): PublicIntegration => ({ id: r.id, projectId: r.project_id, kind: r.kind, name: r.name, config: JSON.parse(r.config_json), createdAt: r.created_at });
const toLink = (r: Row): IssueLink => ({ id: r.id, testId: r.test_case_id, integrationId: r.integration_id, provider: r.provider, externalId: r.external_id, url: r.url, title: r.title, createdAt: r.created_at });

/** Splits the secret from the settings; the secret only ever leaves this class inside a provider. */
export function splitSettings(s: IntegrationSettings): { config: IntegrationConfig; token: string } {
    if (s.kind === "github") return { config: { kind: "github", owner: s.owner, repo: s.repo, ...(s.apiUrl ? { apiUrl: s.apiUrl } : {}) }, token: s.token };
    if (s.kind === "notion") return { config: { kind: "notion", databaseId: s.databaseId, titleProperty: s.titleProperty, ...(s.apiUrl ? { apiUrl: s.apiUrl } : {}) }, token: s.token };
    return { config: { kind: "jira", baseUrl: s.baseUrl, projectKey: s.projectKey.toUpperCase(), email: s.email, issueType: s.issueType }, token: s.token };
}

export function providerFor(config: IntegrationConfig, token: string): IssueProvider {
    if (config.kind === "notion") return new NotionProvider(config, token);
    return config.kind === "github" ? new GithubProvider(config, token) : new JiraProvider(config, token);
}

export const defaultName = (c: IntegrationConfig) => (c.kind === "github" ? `GitHub ${c.owner}/${c.repo}` : c.kind === "notion" ? `Notion database ${c.databaseId.slice(0, 8)}` : `Jira ${c.projectKey}`);

export class IntegrationStore {
    constructor(
        private readonly db: Db,
        private readonly secrets: SecretBox,
    ) {}

    create(projectId: string, settings: IntegrationSettings, name?: string): PublicIntegration {
        const { config, token } = splitSettings(settings);
        const id = randomUUID();
        const t = now();
        this.db.run(
            "INSERT INTO integrations (id, project_id, kind, name, config_json, secret_enc, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            id,
            projectId,
            config.kind,
            name?.trim() || defaultName(config),
            JSON.stringify(config),
            this.secrets.encrypt({ token }),
            t,
            t,
        );
        return this.get(id)!;
    }

    get(id: string): PublicIntegration | undefined {
        const r = this.db.get(`SELECT * FROM integrations WHERE id = ? AND kind IN (${TRACKER_KINDS_SQL})`, id);
        return r ? toPublic(r) : undefined;
    }

    list(projectId: string): PublicIntegration[] {
        return this.db.all(`SELECT * FROM integrations WHERE project_id = ? AND kind IN (${TRACKER_KINDS_SQL}) ORDER BY created_at`, projectId).map(toPublic);
    }

    /** Update the name and/or non-secret settings; a new token replaces the stored one. */
    update(id: string, patch: { name?: string; config?: Record<string, unknown>; token?: string }): PublicIntegration | undefined {
        const r = this.db.get(`SELECT * FROM integrations WHERE id = ? AND kind IN (${TRACKER_KINDS_SQL})`, id);
        if (!r) return undefined;
        const config = { ...JSON.parse(r.config_json), ...(patch.config ?? {}), kind: r.kind } as IntegrationConfig;
        this.db.run("UPDATE integrations SET name = ?, config_json = ?, secret_enc = ?, updated_at = ? WHERE id = ?", patch.name?.trim() || r.name, JSON.stringify(config), patch.token ? this.secrets.encrypt({ token: patch.token }) : r.secret_enc, now(), id);
        return this.get(id);
    }

    remove(id: string): boolean {
        return Number(this.db.run(`DELETE FROM integrations WHERE id = ? AND kind IN (${TRACKER_KINDS_SQL})`, id).changes) > 0;
    }

    /** The provider client for a stored integration (decrypts the token for the duration of the call). */
    provider(id: string): IssueProvider | undefined {
        const r = this.db.get(`SELECT * FROM integrations WHERE id = ? AND kind IN (${TRACKER_KINDS_SQL})`, id);
        if (!r) return undefined;
        return providerFor(JSON.parse(r.config_json), this.secrets.decrypt<{ token: string }>(r.secret_enc).token);
    }

    linksForTest(testId: string): IssueLink[] {
        return this.db.all("SELECT * FROM issue_links WHERE test_case_id = ? ORDER BY created_at", testId).map(toLink);
    }

    linkFor(testId: string, integrationId: string): IssueLink | undefined {
        const r = this.db.get("SELECT * FROM issue_links WHERE test_case_id = ? AND integration_id = ?", testId, integrationId);
        return r ? toLink(r) : undefined;
    }

    addLink(a: { testId: string; integrationId: string; provider: IntegrationKind; externalId: string; url: string; title: string }): IssueLink {
        const id = randomUUID();
        this.db.run("INSERT INTO issue_links (id, test_case_id, integration_id, provider, external_id, url, title, created_at) VALUES (?,?,?,?,?,?,?,?)", id, a.testId, a.integrationId, a.provider, a.externalId, a.url, a.title, now());
        return toLink(this.db.get("SELECT * FROM issue_links WHERE id = ?", id)!);
    }
}
