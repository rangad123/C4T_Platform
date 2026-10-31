/**
 * Test files and test data reset routes (see docs/features/frames-uploads-popups.md).
 *
 *   GET    /api/projects/:id/test-files                 the project's test files (names, sizes, types) and the caps
 *   POST   /api/projects/:id/test-files?name=photo.png  add or replace a file (the raw bytes as application/octet-stream)
 *   DELETE /api/projects/:id/test-files/:name           remove a file (refused while a test's upload step uses it)
 *   GET    /api/projects/:id/test-data-reset            the reset requests (per environment; '' = the project's own address), header names only
 *   PUT    /api/projects/:id/test-data-reset            save one: { environment, enabled, method, url, expectedStatus, headers: [{ name, value? }] }
 *   DELETE /api/projects/:id/test-data-reset?environment=  remove one
 *   POST   /api/projects/:id/test-data-reset/try        send it once now, to see that it works: { environment }
 */
import { z } from "zod";
import { uploadFilesOf } from "../../engine/web/pages.js";
import { blockView } from "../block-store.js";
import { environmentStore } from "../environment-run.js";
import { HttpError } from "../http-error.js";
import { SecretBox } from "../secrets.js";
import { RESET_LIMITS, RESET_METHODS, ResetHookStore, resetTarget, sendResetRequest, TEST_FILE_LIMITS, TEST_FILE_TYPES, TestFileStore } from "../test-data-reset-store.js";
import type { RouteCtx } from "./types.js";

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/** Headers the platform sets itself, or that would change where or how the request goes. */
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "upgrade", "te", "trailer", "keep-alive", "proxy-authorization", "expect"]);

const HookBody = z.object({
    environment: z.string().max(80).default(""),
    enabled: z.boolean(),
    method: z.enum(RESET_METHODS),
    url: z.string().trim().min(1, "Enter the address of the reset request.").max(RESET_LIMITS.url),
    expectedStatus: z.number().int().min(100).max(599).default(200),
    headers: z
        .array(
            z.object({
                name: z.string().regex(HEADER_NAME, "A header name uses letters, numbers and dashes."),
                // A value is written once and never shown again; omit it to keep the saved one.
                value: z.string().max(RESET_LIMITS.headerValue).regex(/^[^\r\n\0]*$/, "A header value is one line.").optional(),
            }),
        )
        .max(RESET_LIMITS.headers)
        .default([]),
});

export function registerWebPageRoutes(ctx: RouteCtx): void {
    const { app, repo, p } = ctx;
    const files = () => new TestFileStore(repo.db, p.store);
    const hooks = () => new ResetHookStore(repo.db, new SecretBox(p.config.dataDir, p.config.SECRET_KEY));

    /** Which tests' upload steps name each file (after reusable steps are put in place). */
    const usage = (projectId: string): Map<string, string[]> => {
        const view = blockView(repo.db, projectId);
        const out = new Map<string, string[]>();
        for (const t of repo.listTests(projectId)) {
            if (!JSON.stringify(t.spec).includes('"upload"') && !JSON.stringify(t.spec).includes('"useBlock"')) continue;
            let names: string[] = [];
            try {
                names = uploadFilesOf(view(t.spec));
            } catch {
                names = uploadFilesOf(t.spec);
            }
            for (const n of names) out.set(n, [...(out.get(n) ?? []), t.testKey]);
        }
        return out;
    };

    app.get("/api/projects/:id/test-files", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const used = usage(id);
        const list = files().list(id);
        const known = new Set(list.map((f) => f.name));
        return {
            files: list.map((f) => ({ name: f.name, size: f.size, contentType: f.contentType, createdAt: f.createdAt, usedBy: used.get(f.name) ?? [] })),
            // Names steps use that the library does not have: those steps would fail, so the page says so.
            missing: [...used.entries()].filter(([n]) => !known.has(n)).map(([name, usedBy]) => ({ name, usedBy })),
            limits: { ...TEST_FILE_LIMITS, types: Object.keys(TEST_FILE_TYPES) },
        };
    });

    app.post("/api/projects/:id/test-files", { bodyLimit: TEST_FILE_LIMITS.fileBytes + 1024 }, async (req, reply) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const { name } = z.object({ name: z.string().min(1).max(200) }).parse(req.query);
        if (!Buffer.isBuffer(req.body)) throw new HttpError(415, "Send the file's bytes with the type application/octet-stream.");
        const file = await files().put(id, name, req.body);
        return reply.code(201).send({ name: file.name, size: file.size, contentType: file.contentType, createdAt: file.createdAt });
    });

    app.delete("/api/projects/:id/test-files/:name", async (req) => {
        const { id, name } = req.params as { id: string; name: string };
        ctx.project(id);
        const users = usage(id).get(name);
        if (users?.length) throw new HttpError(409, `This file is used by ${users.length === 1 ? "the test" : "the tests"} ${users.slice(0, 5).join(", ")}${users.length > 5 ? "…" : ""}. Change those steps first.`);
        if (!(await files().remove(id, name))) throw new HttpError(404, "There is no test file with that name.");
        return { removed: name };
    });

    /** The address the hook's request is resolved against: the environment's, or the project's own. */
    const baseFor = (projectId: string, environment: string): string => {
        if (environment) {
            const env = environmentStore(repo, p.config).get(projectId, environment);
            if (!env) throw new HttpError(404, `There is no environment called “${environment}”.`);
            if (env.production) throw new HttpError(400, `“${environment}” is a production environment: its data is never reset by the platform.`);
            return env.baseUrl;
        }
        const appRow = repo.getLatestApplicationPublic(projectId);
        if (!appRow?.url) throw new HttpError(409, "Set the application's address first: the reset request goes to the application.");
        return String(appRow.url);
    };

    app.get("/api/projects/:id/test-data-reset", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        return { hooks: hooks().list(id), methods: RESET_METHODS, limits: RESET_LIMITS };
    });

    app.put("/api/projects/:id/test-data-reset", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const body = HookBody.parse(req.body);
        const names = body.headers.map((h) => h.name.toLowerCase());
        if (new Set(names).size !== names.length) throw new HttpError(400, "A header is listed twice.");
        const bad = names.find((n) => FORBIDDEN_HEADERS.has(n));
        if (bad) throw new HttpError(400, `The header ${bad} is set by the platform and cannot be given here.`);
        // The address must stay on the application's own site (or an allowed one): the saved header values go with it.
        resetTarget(body.url, baseFor(id, body.environment));
        return hooks().save(id, body.environment, { enabled: body.enabled, method: body.method, url: body.url, expectedStatus: body.expectedStatus, headers: body.headers });
    });

    app.delete("/api/projects/:id/test-data-reset", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const { environment } = z.object({ environment: z.string().max(80).default("") }).parse(req.query);
        if (!hooks().remove(id, environment)) throw new HttpError(404, "There is no reset request to remove.");
        return { removed: true };
    });

    app.post("/api/projects/:id/test-data-reset/try", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const { environment } = z.object({ environment: z.string().max(80).default("") }).parse(req.body ?? {});
        // Not while a run is going: a reset in the middle of it would change the data its tests are using.
        await ctx.assertNoActiveJob(id);
        const store = hooks();
        const hook = store.secret(id, environment);
        if (!hook) throw new HttpError(404, "There is no reset request to try. Save one first.");
        const outcome = await sendResetRequest(hook, baseFor(id, environment));
        store.recordOutcome(id, environment, outcome.ok, outcome.message);
        return outcome;
    });
}
