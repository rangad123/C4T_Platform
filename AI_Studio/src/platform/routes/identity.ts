import { z } from "zod";
import { HttpError } from "../http-error.js";
import { IdentityStore, MAX_ROLES, ROLE_NAME, toPublic, type Role } from "../identity-store.js";
import { SecretBox } from "../secrets.js";
import type { RouteCtx } from "./types.js";

const RoleInput = z.object({
    name: z.string().regex(ROLE_NAME, "use lower-case letters, digits, - or _ (start with a letter, at most 24 characters)"),
    username: z.string().min(1).max(300),
    /** Omitted for an existing account = keep the saved password. */
    password: z.string().min(1).max(300).optional(),
    /** Omitted = keep; empty string = remove. */
    apiToken: z.string().max(4000).optional(),
    totpSecret: z
        .union([z.literal(""), z.string().max(200).regex(/^[A-Za-z2-7\s=-]+$/, "must be the base32 setup key (letters A-Z and digits 2-7)")])
        .optional(),
});

/** Named test accounts per project. Passwords and secrets are write-only. */
export function registerIdentityRoutes({ app, p, project }: RouteCtx): void {
    const store = new IdentityStore(p.db, new SecretBox(p.config.dataDir, p.config.SECRET_KEY));

    app.get("/api/projects/:id/roles", async (req) => {
        const id = (req.params as { id: string }).id;
        project(id);
        return { roles: store.get(id).map(toPublic) };
    });

    /** Replace the project's accounts. A password or secret left out keeps what is saved for an account of that name. */
    app.put("/api/projects/:id/roles", async (req) => {
        const id = (req.params as { id: string }).id;
        project(id);
        const body = z.object({ roles: z.array(RoleInput).max(MAX_ROLES, `at most ${MAX_ROLES} test accounts`) }).parse(req.body);
        const names = body.roles.map((r) => r.name);
        if (new Set(names).size !== names.length) throw new HttpError(400, "Each test account needs its own name.");
        const saved = new Map(store.get(id).map((r) => [r.name, r]));
        const next: Role[] = body.roles.map((r) => {
            const old = saved.get(r.name);
            const password = r.password ?? old?.password;
            if (!password) throw new HttpError(400, `The account “${r.name}” needs a password.`);
            const totp = r.totpSecret === undefined ? old?.totpSecret : r.totpSecret.trim() || undefined;
            const apiToken = r.apiToken === undefined ? old?.apiToken : r.apiToken.trim() || undefined;
            return { name: r.name, username: r.username, password, ...(totp ? { totpSecret: totp } : {}), ...(apiToken ? { apiToken } : {}) };
        });
        store.set(id, next);
        return { roles: next.map(toPublic) };
    });
}
