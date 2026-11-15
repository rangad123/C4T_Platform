/**
 * The project's sign-in: the account its tests sign in with, for any project (tested by code, by the AI agent, or both).
 *
 *   GET /api/projects/:id/sign-in   → { username: string | null, hasPassword: boolean, hasTotp: boolean, site: string | null }
 *   PUT /api/projects/:id/sign-in   { username?, password?, totpSecret?, clear?: ("password" | "totpSecret" | "all")[] } → the same answer
 *
 * Where it is kept: the project's saved inputs (agent-inputs-store.ts, the row "What the agents need" also reads and writes, written only
 * by people who may change settings), and, because every run reads the latest application row for {{credentials.username}},
 * {{credentials.password}} and {{credentials.totp}} (TEST_USERNAME, TEST_PASSWORD and TEST_TOTP_SECRET in a code test, here and on a
 * runner), saving also makes a new application row on the same address carrying it, with everything else the latest one had. A project
 * that never saved one here or on the Requirements tab answers with what its runs use (a sign-in given with an import, say), and the
 * first save starts from it. `site` is the application address: the sign-in is only ever used there (another site starts without it).
 *
 * Secrets are write-only: the answer only says whether one is saved, and nothing here logs them. A secret left out or empty keeps the
 * saved one; an empty user name removes it; `clear` removes before the new values in the same request are applied ("all": the user
 * name, password and authenticator secret; an API token or OAuth2 client saved for the agents stays).
 */
import { z } from "zod";
import { HttpError } from "../http-error.js";
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

const SIGN_IN_KEYS = ["username", "password", "totpSecret"] as const;
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

const sameSignIn = (a: Credentials, b: Credentials) => SIGN_IN_KEYS.every((k) => a[k] === b[k]);

/** The sign-in as saved (same site only), else what the project's runs use; with the latest application it belongs to. */
function currentSignIn(p: RouteCtx["p"], repo: Repo, projectId: string): { full?: ReturnType<typeof latestApplicationOf>; saved: ReturnType<typeof savedInputsFor>; signIn: Credentials } {
    const full = latestApplicationOf(repo, projectId);
    if (!full) return { saved: {}, signIn: {} };
    const saved = savedInputsFor(p, projectId, full.url);
    const from = saved.site ? (saved.credentials ?? {}) : (full.credentials ?? {});
    const signIn: Credentials = {};
    for (const k of SIGN_IN_KEYS) if (from[k]) signIn[k] = from[k];
    return { full, saved, signIn };
}

export function registerProjectSignInRoutes(ctx: RouteCtx): void {
    const { app, p, repo, project } = ctx;
    const store = agentInputsStoreOf(p);

    app.get("/api/projects/:id/sign-in", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        const { full, signIn } = currentSignIn(p, repo, id);
        return signInView(signIn, full?.url ?? null);
    });

    app.put("/api/projects/:id/sign-in", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        const body = parseBody(req.body);
        const { full, saved, signIn } = currentSignIn(p, repo, id);
        if (!full) throw new HttpError(409, NO_ADDRESS_FOR_SIGN_IN);
        const next = applyChange(signIn, body);
        const withSignIn = (c: Credentials | undefined): Credentials => {
            const out: Credentials = { ...(c ?? {}) };
            for (const k of SIGN_IN_KEYS) {
                if (next[k]) out[k] = next[k];
                else delete out[k];
            }
            return out;
        };
        // The saved inputs: this sign-in beside the agents' other saved inputs (API access, OpenAPI document), which stay as they are.
        store.save(id, { site: full.url, credentials: withSignIn(saved.credentials), openApiUrl: saved.openApiUrl, allowMutatingApiTests: saved.allowMutatingApiTests });
        // What runs read: a new application row on the same address, with everything else the latest one had.
        const runs = withSignIn(full.credentials);
        if (!sameSignIn(full.credentials ?? {}, runs)) repo.createApplication(id, full.url, { ...full.config }, runs);
        return signInView(next, full.url);
    });
}
