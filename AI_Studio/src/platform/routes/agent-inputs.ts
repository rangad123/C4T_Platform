/**
 * What a project's testing agents need, kept once on its Requirements tab (round 38) instead of being typed on every exploration:
 *
 *   GET /api/projects/:id/agent-inputs   → { applies, application, signIn, apiAccess, openApiUrl, allowMutatingApiTests, cleanupAfter,
 *                                            requirements: { active }, agents: { ids, names, source }, missing: [{ agent, agentName, input, inputName, text }] }
 *   PUT /api/projects/:id/agent-inputs   { username?, password?, totpSecret?, apiToken?, oauth2?, openApiUrl?, allowMutatingApiTests?,
 *                                          cleanupAfter?, clear?: ["password" | "totpSecret" | "apiToken" | "oauth2"] } → the same answer
 *
 * Storage: the project's own row (agent-inputs-store.ts), written only here, with the site it was saved for; an exploration reads it and
 * never writes it. Saving also makes a new application row with the latest one's address, settings and mobile app plus these inputs,
 * because runs read the latest application: the next run signs in with what was just saved. The cleanup choice is the project's
 * cleanup switch (cleanup-store.ts). Secrets are write-only: the answer says only whether one is saved. In PUT a secret left out or
 * empty keeps the saved one, and `clear` removes it. A custom API header (`apiAuthHeader`, from explorations made before this tab)
 * belongs to the API token: shown as a saved token, replaced by a new token and cleared with it.
 *
 * Exploring (POST /api/projects/:id/test-generation) uses the saved inputs when the request leaves them out, and only on the same site
 * they were saved for, so a sign-in is never sent to another one. Saved credentials go only to that site and the addresses saved with
 * them (the OpenAPI document, the OAuth2 token URL): an exploration that names another API address or OpenAPI document is refused
 * (409) unless it brings its own credentials. It also refuses (409) when the project's chosen agents miss an input they cannot work
 * without (REQUIRED_INPUTS below). The requirements an exploration covers are the project's active requirements, unless the request
 * brings a document: the Requirements tab's own Import keeps documents, so none is stored here a second time.
 */
import { z } from "zod";
import { isAppUri } from "../../engine/desktop/target.js";
import { REQUIREMENTS_MAX_CHARS } from "../../engine/requirements/extract.js";
import { AgentInputsStore, type SavedAgentInputs } from "../agent-inputs-store.js";
import { secretBoxOf } from "../ai-config.js";
import { CleanupStore } from "../cleanup-store.js";
import type { Row } from "../db.js";
import { HttpError } from "../http-error.js";
import { assertAllowedTarget } from "../net-guard.js";
import type { Platform } from "../bootstrap.js";
import { projectSetupOf } from "../project-setup.js";
import type { Credentials } from "../repo.js";
import { RequirementStore } from "../requirement-store.js";
import { agentById, type AgentId } from "../testing-agents.js";
import { testingAgentsOf } from "./testing-agents.js";
import type { RouteCtx } from "./types.js";

/** The inputs an agent can need, by the names the Requirements tab shows. */
export const AGENT_INPUT_WORDS = {
    signIn: "Sign in",
    apiAccess: "API access",
    openApiUrl: "OpenAPI document URL",
    requirements: "Requirements",
} as const;
export type AgentInputId = keyof typeof AGENT_INPUT_WORDS;

/**
 * The inputs each agent cannot work without (the rest is optional and only makes an agent do more). Decided from what each agent and
 * the engine really need:
 *   api             the API documentation, as an OpenAPI document URL: the contract checks compare every answer with it, and the
 *                   agent tests the API it describes. Without it only the calls seen while exploring are found.
 *   accessibility   nothing: its checks are rules run on the pages the exploration finds (sign-in only reaches more pages).
 *   security        nothing: the header, cookie, file and certificate checks are passive; the access checks use the project's test
 *                   accounts when there are some and are skipped otherwise.
 *   responsive-ui   nothing: pictures of the pages found, and the browsers picked for a run.
 *   ux              nothing: page health checks of the pages found (AI screen review is a choice per run).
 *   performance     nothing: timings of the pages and safe calls found (a load check is a choice per run, never on production).
 *   test-generation nothing beyond the address, which the Explore page itself asks for (a sign-in only reaches more journeys;
 *                   requirements, when there are some, are planned for).
 *   chatbot         not available.
 * Every agent also needs an AI model on the server; that is the server's setting, said on the Explore page, not a project input.
 */
export const REQUIRED_INPUTS: Partial<Record<AgentId, ReadonlyArray<{ input: AgentInputId; text: string }>>> = {
    api: [{ input: "openApiUrl", text: "The API Testing Agent needs the API documentation: the address of the OpenAPI document." }],
};

export interface MissingInput {
    agent: AgentId;
    agentName: string;
    input: AgentInputId;
    inputName: string;
    text: string;
}

/** What is missing for these agents, given what is saved or sent. `targets`: what the exploration covers (the API agent needs its document only when the API is explored). */
export function missingInputs(agents: readonly AgentId[], have: { openApiUrl?: string | null }, targets?: readonly string[]): MissingInput[] {
    const out: MissingInput[] = [];
    for (const agent of agents) {
        for (const r of REQUIRED_INPUTS[agent] ?? []) {
            if (r.input === "openApiUrl" && (have.openApiUrl || (targets && !targets.includes("api")))) continue;
            out.push({ agent, agentName: agentById(agent)!.name, input: r.input, inputName: AGENT_INPUT_WORDS[r.input], text: r.text });
        }
    }
    return out;
}

/** The refusal of an exploration that misses a mandatory input, in the words the Explore page's pop-up uses. */
export const missingInputsMessage = (missing: readonly MissingInput[]): string =>
    `${missing.map((m) => m.text).join(" ")} Add ${missing.length === 1 ? "it" : "them"} on the project's Requirements tab, or remove the agent in Settings → General, then explore again.`;

/** The project's chosen agents (a project with no saved choice, or not tested by the AI agent, has none: nothing is mandatory for it). */
async function chosenAgents(p: Platform, row: Row): Promise<AgentId[] | undefined> {
    if (!projectSetupOf(row).testingModes.includes("agent")) return undefined;
    return testingAgentsOf(p).chosen(String(row.id));
}

/** For test-generation: what the chosen agents miss for this exploration (empty for a project with no saved choice). */
export async function missingForExploration(p: Platform, row: Row, have: { openApiUrl?: string }, targets: readonly string[] | undefined): Promise<MissingInput[]> {
    const chosen = await chosenAgents(p, row);
    return chosen ? missingInputs(chosen, have, targets) : [];
}

/** Whether two application addresses are the same site (saved sign-in details are used only there). */
export function sameSite(a: string, b: string): boolean {
    if (isAppUri(a) || isAppUri(b) || !/^https?:/i.test(a) || !/^https?:/i.test(b)) return a === b;
    try {
        return new URL(a).origin === new URL(b).origin;
    } catch {
        return false;
    }
}

export const agentInputsStoreOf = (p: Pick<Platform, "db" | "config">): AgentInputsStore => new AgentInputsStore(p.db, secretBoxOf(p.config));

type Saved = Omit<SavedAgentInputs, "updatedAt">;

/** The inputs the project saved, when they were saved for the same site as `url` (nothing otherwise). */
export function savedInputsFor(p: Pick<Platform, "db" | "config">, projectId: string, url: string): Partial<Saved> {
    const s = agentInputsStoreOf(p).get(projectId);
    if (!s || !sameSite(s.site, url)) return {};
    const { updatedAt: _at, ...saved } = s;
    return saved;
}

const originOf = (u: string | undefined): string | undefined => {
    if (!u || !/^https?:/i.test(u)) return undefined;
    try {
        return new URL(u).origin;
    } catch {
        return undefined;
    }
};

/** Where saved credentials may be sent: the site they were saved for and the addresses saved with them (OpenAPI document, OAuth2 token URL). */
export function savedCredentialOrigins(s: Pick<Partial<Saved>, "site" | "openApiUrl" | "credentials">): Set<string> {
    return new Set([s.site, s.openApiUrl, s.credentials?.oauth2?.tokenUrl].map(originOf).filter((o): o is string => Boolean(o)));
}

const hostOf = (u: string): string => {
    try {
        return new URL(u).host;
    } catch {
        return u;
    }
};

/** The refusal of an exploration that would send the saved credentials to an address nobody saved them for. */
export const savedCredentialsElsewhere = (site: string, what: string, address: string): string =>
    `The saved sign-in and API access are only sent to ${hostOf(site)} and the addresses saved with them, and this exploration's ${what} is on ${hostOf(address)}. Leave the ${what} out, or send the credentials to use there with the request.`;

/**
 * What an exploration takes from the saved inputs (same site only). Saved credentials are used only when every address of the request
 * that would receive them (the API address the API tests are sent to, the OpenAPI document) is on the saved site or an address saved
 * with them; otherwise the exploration is refused (409): running it without the sign-in would quietly explore less, and its
 * application row (which later runs read) would lose the sign-in. Credentials in the request are the caller's own: nothing is checked
 * against them (an OAuth2 token URL can only come with them).
 */
export function savedInputsForExploration(p: Pick<Platform, "db" | "config">, projectId: string, url: string, request: { credentials?: unknown; apiBaseUrl?: string; openApiUrl?: string }): Partial<Saved> {
    const saved = savedInputsFor(p, projectId, url);
    if (!saved.credentials || request.credentials) return saved;
    const allowed = savedCredentialOrigins(saved);
    for (const [what, address] of [["API address", request.apiBaseUrl], ["OpenAPI document URL", request.openApiUrl]] as const) {
        if (address && !allowed.has(originOf(address) ?? "")) throw new HttpError(409, savedCredentialsElsewhere(saved.site!, what, address));
    }
    return saved;
}

/** The project's active requirements as a document's text (one per line, its reference first), or undefined when it has none. */
export async function projectRequirementsDocument(p: Platform, projectId: string): Promise<{ name: string; text: string } | undefined> {
    const active = (await new RequirementStore(p.db.sql).list(projectId)).filter((r) => r.status === "active");
    if (!active.length) return undefined;
    const one = (s: string) => s.replace(/\s+/g, " ").trim();
    const lines = active.map((r) => {
        const parts = [one(r.title), one(r.description), r.acceptanceCriteria.trim() ? `Acceptance criteria: ${one(r.acceptanceCriteria)}` : ""].filter(Boolean);
        return `${r.ref}: ${parts.join(" ")}`;
    });
    return { name: "The project's requirements", text: `Requirements\n\n${lines.join("\n")}`.slice(0, REQUIREMENTS_MAX_CHARS) };
}

const SECRETS = ["password", "totpSecret", "apiToken", "oauth2"] as const;
const Totp = z.string().max(200).regex(/^[A-Za-z2-7\s=-]*$/, "The authenticator secret is the setup key shown when the account was enrolled (letters A-Z and digits 2-7).");
const Body = z
    .object({
        /** Not a secret: shown back. Empty removes it. */
        username: z.string().max(300).optional(),
        /** Secrets: left out or empty keeps the saved one; `clear` removes it. */
        password: z.string().max(300).optional(),
        totpSecret: Totp.optional(),
        apiToken: z.string().max(4000).optional(),
        oauth2: z
            .object({
                tokenUrl: z.string().max(2000),
                clientId: z.string().max(500),
                clientSecret: z.string().max(4000).optional(),
                scope: z.string().max(1000).optional(),
            })
            .optional(),
        /** Empty removes it. */
        openApiUrl: z.string().max(2000).optional(),
        allowMutatingApiTests: z.boolean().optional(),
        cleanupAfter: z.boolean().optional(),
        clear: z.array(z.enum(SECRETS)).max(SECRETS.length).optional(),
    })
    .strict();

export const NO_APPLICATION_YET = "This project has no application address yet. Add it in Settings → General, then save what the agents need.";
export const NOT_AN_AGENT_PROJECT = "These inputs are for the testing agents, and this project is not tested by the AI agent.";

async function httpUrl(raw: string, what: string): Promise<string> {
    let u: URL;
    try {
        u = new URL(raw.trim());
    } catch {
        throw new HttpError(400, `Enter the ${what} as a full address, starting with http:// or https://.`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(400, `Enter the ${what} as a full address, starting with http:// or https://.`);
    // As the application's own address (project-app.ts): a user name or password in an address would be kept and shown in plain text.
    if (u.username || u.password) throw new HttpError(400, `Enter the ${what} without a user name or password: sign-in details go in their own fields.`);
    await assertAllowedTarget(u.href);
    return u.href;
}

export function registerAgentInputRoutes(ctx: RouteCtx): void {
    const { app, p, repo, project } = ctx;
    const cleanup = new CleanupStore(repo.db);
    const store = agentInputsStoreOf(p);

    const view = async (id: string) => {
        const row = project(id);
        const applies = projectSetupOf(row).testingModes.includes("agent");
        const latest = repo.getLatestApplicationPublic(id);
        // What exploring the project's address uses: saved for another site, nothing applies here.
        const saved = latest ? savedInputsFor(p, id, String(latest.url)) : {};
        const c = saved.credentials ?? {};
        const openApiUrl = saved.openApiUrl ?? null;
        const agents = applies ? await testingAgentsOf(p, repo).of(row) : undefined;
        const active = (await new RequirementStore(p.db.sql).list(id)).filter((r) => r.status === "active").length;
        return {
            applies,
            application: latest ? { url: latest.url } : null,
            signIn: { username: c.username || null, hasPassword: Boolean(c.password), hasTotpSecret: Boolean(c.totpSecret) },
            apiAccess: { hasToken: Boolean(c.apiToken || c.apiAuthHeader), oauth2: c.oauth2 ? { tokenUrl: c.oauth2.tokenUrl, clientId: c.oauth2.clientId, scope: c.oauth2.scope ?? null, hasClientSecret: Boolean(c.oauth2.clientSecret) } : null },
            openApiUrl,
            allowMutatingApiTests: saved.allowMutatingApiTests === true,
            cleanupAfter: cleanup.getEnabled(id) ?? true,
            requirements: { active },
            agents: agents ? { ids: agents.agents, names: agents.agents.map((a) => agentById(a)?.name ?? a), source: agents.source } : null,
            // Only a saved choice makes an input mandatory (a project with none explores as before and is never refused).
            missing: agents?.source === "chosen" ? missingInputs(agents.agents, { openApiUrl }) : [],
        };
    };

    app.get("/api/projects/:id/agent-inputs", async (req) => view((req.params as { id: string }).id));

    app.put("/api/projects/:id/agent-inputs", async (req) => {
        const { id } = req.params as { id: string };
        const row = project(id);
        if (!projectSetupOf(row).testingModes.includes("agent")) throw new HttpError(409, NOT_AN_AGENT_PROJECT);
        const body = parseBody(req.body);
        const latest = repo.getLatestApplicationPublic(id);
        if (!latest) throw new HttpError(409, NO_APPLICATION_YET);
        const full = repo.getApplication(String(latest.id))!;
        const clear = new Set(body.clear ?? []);
        // What is saved for this address (saved for another site: nothing is kept, so it is never sent here).
        const before = savedInputsFor(p, id, full.url);
        const old = before.credentials ?? {};
        const keep = (k: "password" | "totpSecret" | "apiToken", given: string | undefined) => (clear.has(k) ? undefined : given?.trim() ? (k === "password" ? given : given.trim()) : old[k]);
        // The custom API header goes with the token: kept while the token is, replaced by a new token, cleared with it.
        const apiAuthHeader = clear.has("apiToken") || body.apiToken?.trim() ? undefined : old.apiAuthHeader;

        let oauth2 = clear.has("oauth2") ? undefined : old.oauth2;
        if (body.oauth2 && !clear.has("oauth2")) {
            const o = body.oauth2;
            if (!o.tokenUrl.trim() && !o.clientId.trim()) oauth2 = undefined;
            else {
                if (!o.clientId.trim()) throw new HttpError(400, "Enter the OAuth2 client ID.");
                const tokenUrl = await httpUrl(o.tokenUrl, "OAuth2 token URL");
                // The saved secret is only ever sent to the site it was saved for: a token address elsewhere needs the secret typed again.
                const sameTokenSite = old.oauth2?.tokenUrl ? new URL(old.oauth2.tokenUrl).origin === new URL(tokenUrl).origin : false;
                const clientSecret = o.clientSecret?.trim() ? o.clientSecret : sameTokenSite ? old.oauth2?.clientSecret : undefined;
                if (!clientSecret) throw new HttpError(400, old.oauth2?.clientSecret ? "The token URL is on another site now: enter the OAuth2 client secret again." : "Enter the OAuth2 client secret.");
                oauth2 = { ...(old.oauth2 ?? {}), tokenUrl, clientId: o.clientId.trim(), clientSecret, scope: o.scope?.trim() || undefined };
            }
        }
        const username = body.username !== undefined ? body.username.trim() || undefined : old.username;
        const credentials: Credentials = Object.fromEntries(
            Object.entries({ username, password: keep("password", body.password), totpSecret: keep("totpSecret", body.totpSecret), apiToken: keep("apiToken", body.apiToken), apiAuthHeader, oauth2 }).filter(([, v]) => v !== undefined),
        ) as Credentials;
        const openApiUrl = body.openApiUrl === undefined ? before.openApiUrl : body.openApiUrl.trim() ? await httpUrl(body.openApiUrl, "OpenAPI document URL") : undefined;
        const allowMutatingApiTests = body.allowMutatingApiTests ?? before.allowMutatingApiTests;
        // The project's saved inputs: only this route writes them.
        store.save(id, { site: full.url, credentials, openApiUrl, allowMutatingApiTests });

        // Runs read the latest application: a new row on the same address keeps everything else the latest one had (settings, mobile
        // app) and carries these inputs, so the next run uses them too.
        const config: Record<string, unknown> = { ...full.config };
        if (openApiUrl) config.openApiUrl = openApiUrl;
        else delete config.openApiUrl;
        if (allowMutatingApiTests !== undefined) config.allowMutatingApiTests = allowMutatingApiTests;
        // An API address an exploration left on that row is kept beside the saved credentials only where they may go, so runs never send
        // them anywhere else (without it, API tests use the application's own address).
        const apiBase = typeof config.apiBaseUrl === "string" ? config.apiBaseUrl : undefined;
        if (apiBase && Object.keys(credentials).length && !savedCredentialOrigins({ site: full.url, openApiUrl, credentials }).has(originOf(apiBase) ?? "")) delete config.apiBaseUrl;
        repo.createApplication(id, full.url, config, credentials);
        if (body.cleanupAfter !== undefined) cleanup.setEnabled(id, body.cleanupAfter);
        return view(id);
    });
}

function parseBody(raw: unknown): z.infer<typeof Body> {
    const r = Body.safeParse(raw ?? {});
    if (!r.success) throw new HttpError(400, r.error.issues[0]?.message ?? "Those inputs could not be read.");
    return r.data;
}
