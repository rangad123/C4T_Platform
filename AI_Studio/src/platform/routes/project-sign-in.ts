/**
 * The project's sign-in: the account its tests sign in with, for any project (tested by code, by the AI agent, or both).
 *
 *   GET /api/projects/:id/sign-in   → { username: string | null, hasPassword: boolean, hasTotp: boolean, site: string | null }
 *   PUT /api/projects/:id/sign-in   { username?, password?, totpSecret?, clear?: ("password" | "totpSecret" | "all")[] } → the same answer
 *
 * Where it is kept: the project's saved inputs (agent-inputs-store.ts, the row "What the agents need" also reads and writes). It is the
 * project's one sign-in: every run on its site reads it for {{credentials.username}}, {{credentials.password}} and {{credentials.totp}}
 * (TEST_USERNAME, TEST_PASSWORD and TEST_TOTP_SECRET in a code test, here and on a runner), because Repo.getApplication puts it on the
 * application a run reads. A path that brings a sign-in of its own (an exploration, an import, a CI run) saves it here with the same
 * write (saveSignIn), so what this page shows is always what runs use. A project that never saved one answers with what its runs use (a
 * sign-in on its application row from before), and the first save starts from it. `site` is the application address: the sign-in is
 * only ever used there (another site starts without it).
 *
 * Secrets are write-only: the answer only says whether one is saved, and nothing here logs them. A secret left out or empty keeps the
 * saved one; an empty user name removes it; `clear` removes before the new values in the same request are applied ("all": the user
 * name, password and authenticator secret; an API token or OAuth2 client saved for the agents stays).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { accessControlOf, actorOf, noteRefusedPermission } from "../auth/access.js";
import { HttpError } from "../http-error.js";
import { SIGN_IN_KEYS, withSignIn } from "../agent-inputs-store.js";
import type { Platform } from "../bootstrap.js";
import type { Credentials, Repo } from "../repo.js";
import { agentInputsStoreOf, savedInputsFor } from "./agent-inputs.js";
import type { RouteCtx } from "./types.js";

export interface ProjectSignIn {
    username: string | null;
    hasPassword: boolean;
    hasTotp: boolean;
    site: string | null;
}

export const NO_ADDRESS_FOR_SIGN_IN = "This project has no application address yet. Add it in Settings → General, then save the sign-in.";

const CLEARS = ["password", "totpSecret", "all"] as const;

/** The project's latest application with its decrypted credentials (what runs use), or undefined when it has no address yet. */
export function latestApplicationOf(repo: Repo, projectId: string) {
    const latest = repo.getLatestApplicationPublic(projectId);
    return latest ? repo.getApplication(String(latest.id)) : undefined;
}

/** The answer: the user name and whether each secret is saved, never a secret. */
export function signInView(credentials: Credentials | undefined, site: string | null): ProjectSignIn {
    return { username: credentials?.username || null, hasPassword: Boolean(credentials?.password), hasTotp: Boolean(credentials?.totpSecret), site };
}

const Body = z
    .object({
        username: z.string({ error: "The user name must be text." }).max(300, "The user name is too long: at most 300 characters.").optional(),
        password: z.string({ error: "The password must be text." }).max(300, "The password is too long: at most 300 characters.").optional(),
        totpSecret: z
            .string({ error: "The authenticator secret must be text." })
            .max(200, "The authenticator secret is too long: at most 200 characters.")
            .regex(/^[A-Za-z2-7\s=-]*$/, "The authenticator secret is the setup key shown when the account was enrolled (letters A-Z and digits 2-7).")
            .optional(),
        clear: z.array(z.enum(CLEARS), { error: 'clear lists what to remove: "password", "totpSecret" or "all".' }).max(CLEARS.length).optional(),
    })
    .strict();

function parseBody(raw: unknown): z.infer<typeof Body> {
    const r = Body.safeParse(raw ?? {});
    if (r.success) return r.data;
    const issue = r.error.issues[0];
    if (issue?.code === "unrecognized_keys") throw new HttpError(400, "Only the user name, password and authenticator secret are saved here (username, password, totpSecret, clear).");
    if (issue?.path[0] === "clear") throw new HttpError(400, 'clear lists what to remove: "password", "totpSecret" or "all".');
    throw new HttpError(400, issue?.message ?? "The sign-in could not be read.");
}

/** The credentials after this change: only the sign-in part changes; everything else saved with it stays. */
function applyChange(before: Credentials, body: z.infer<typeof Body>): Credentials {
    const next: Credentials = { ...before };
    const clear = new Set(body.clear ?? []);
    if (clear.has("all")) for (const k of SIGN_IN_KEYS) delete next[k];
    if (clear.has("password")) delete next.password;
    if (clear.has("totpSecret")) delete next.totpSecret;
    if (body.username !== undefined) {
        const u = body.username.trim();
        if (u) next.username = u;
        else delete next.username;
    }
    // A password is kept exactly as typed (spaces may be part of it); only an empty or blank one means "keep".
    if (body.password?.trim()) next.password = body.password;
    if (body.totpSecret?.trim()) next.totpSecret = body.totpSecret.trim();
    return next;
}

/** The sign-in runs use (the saved one on its site, Repo.getApplication), with the latest application it belongs to. */
function currentSignIn(repo: Repo, projectId: string): { full?: ReturnType<typeof latestApplicationOf>; signIn: Credentials } {
    const full = latestApplicationOf(repo, projectId);
    return { full, signIn: withSignIn({}, full?.credentials) ?? {} };
}

/**
 * Makes `signIn` (its user name, password and authenticator secret, exactly: a field it lacks is removed) the project's saved sign-in for
 * `site`, beside the agents' other saved inputs for that site, which stay as they are. The one write of the sign-in: PUT /sign-in and
 * every path that brings one (an exploration, an import, a CI run) use it.
 */
export function saveSignIn(p: Pick<Platform, "db" | "config">, projectId: string, site: string, signIn: Credentials): void {
    const saved = savedInputsFor(p, projectId, site);
    agentInputsStoreOf(p).save(projectId, { site, credentials: withSignIn(saved.credentials, signIn), openApiUrl: saved.openApiUrl, allowMutatingApiTests: saved.allowMutatingApiTests });
}

export const SIGN_IN_NEEDS_SETTINGS = "Only someone who can change project settings can save the sign-in. Ask them to enter it in Project settings → Sign-in, or start without one.";

/**
 * A request that brings a sign-in saves it (Settings wins), and saving the sign-in needs ai_studio.project.settings, as PUT /sign-in does:
 * anyone else is refused (403) before anything is saved, queued or used. Call it right after reading the request.
 */
export function assertMaySaveSignIn(app: FastifyInstance, req: FastifyRequest, projectId: string, credentials: Credentials | undefined): void {
    if (!credentials || !SIGN_IN_KEYS.some((k) => credentials[k])) return;
    const actor = actorOf(req);
    if (!actor || accessControlOf(app).projects.permissionsIn(actor, projectId)?.has("ai_studio.project.settings")) return;
    noteRefusedPermission(req, "ai_studio.project.settings");
    throw new HttpError(403, SIGN_IN_NEEDS_SETTINGS);
}

/** When `credentials` brought with a request carry a sign-in, it becomes the project's saved sign-in for `site` (Settings wins). */
export function adoptSignIn(p: Pick<Platform, "db" | "config">, projectId: string, site: string, credentials: Credentials | undefined): void {
    if (credentials && SIGN_IN_KEYS.some((k) => credentials[k])) saveSignIn(p, projectId, site, credentials);
}

export function registerProjectSignInRoutes(ctx: RouteCtx): void {
    const { app, p, repo, project } = ctx;

    app.get("/api/projects/:id/sign-in", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        const { full, signIn } = currentSignIn(repo, id);
        return signInView(signIn, full?.url ?? null);
    });

    app.put("/api/projects/:id/sign-in", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        const body = parseBody(req.body);
        const { full, signIn } = currentSignIn(repo, id);
        if (!full) throw new HttpError(409, NO_ADDRESS_FOR_SIGN_IN);
        const next = applyChange(signIn, body);
        saveSignIn(p, id, full.url, next);
        return signInView(next, full.url);
    });
}
