import path from "node:path";
import { z } from "zod";
import type { Platform } from "../bootstrap.js";
import type { GitOptions } from "../git-checkout.js";
import { GitImportService, type GitImportPorts } from "../git-import-service.js";
import { buildGitImportPorts } from "../git-import-wiring.js";
import type { RouteCtx } from "./types.js";

/** Test-only seam: swap the git program, allow local sources, shorten limits, or replace the stores. Never reachable from HTTP. */
export interface GitImportSeam extends Partial<Omit<GitOptions, "scratchRoot">> {
    scratchRoot?: string;
    ports?: GitImportPorts;
}
const seams = new WeakMap<Platform, GitImportSeam>();
const services = new WeakMap<Platform, GitImportService>();

export function setGitImportSeam(p: Platform, seam: GitImportSeam): void {
    seams.set(p, seam);
    services.delete(p);
}

/** The service for a platform, built on first use so a test can set its seam first. */
export function gitImportService(ctx: RouteCtx): GitImportService {
    let svc = services.get(ctx.p);
    if (!svc) {
        const seam = seams.get(ctx.p) ?? {};
        const { ports, scratchRoot, ...rest } = seam;
        svc = new GitImportService({ scratchRoot: scratchRoot ?? path.join(ctx.p.config.scratchDir, "git-import"), ...rest }, ports ?? buildGitImportPorts(ctx));
        services.set(ctx.p, svc);
    }
    return svc;
}

const Body = z.object({
    url: z.string().max(500),
    ref: z.string().max(200).optional(),
    path: z.string().max(300).optional(),
    // Write-only: used for this download and then forgotten.
    token: z.string().max(500).optional(),
    dryRun: z.boolean().optional(),
});
const TokenBody = z.object({ token: z.string().max(500).optional() }).default({});

/** Import Playwright test files from a Git repository (Builder AR). */
export function registerGitImportRoutes(ctx: RouteCtx): void {
    const { app, project } = ctx;

    app.post("/api/projects/:id/git-imports", async (req, reply) => {
        const { id } = req.params as { id: string };
        project(id);
        const body = Body.parse(req.body);
        const svc = gitImportService(ctx);
        if (body.dryRun) return reply.code(200).send(await svc.dryRun(id, body));
        return reply.code(201).send(await svc.import(id, body));
    });

    app.get("/api/projects/:id/git-imports", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        return gitImportService(ctx).list(id).map((r) => ({ id: r.id, host: r.host, path: r.path, ref: r.ref, commit: r.commit, importedAt: r.importedAt, tests: r.tests }));
    });

    app.post("/api/projects/:id/git-imports/:gid/check", async (req) => {
        const { id, gid } = req.params as { id: string; gid: string };
        project(id);
        const { token } = TokenBody.parse(req.body ?? {});
        return gitImportService(ctx).check(id, gid, token);
    });

    app.post("/api/projects/:id/git-imports/:gid/refresh", async (req, reply) => {
        const { id, gid } = req.params as { id: string; gid: string };
        project(id);
        const { token } = TokenBody.parse(req.body ?? {});
        return reply.code(201).send(await gitImportService(ctx).refresh(id, gid, token));
    });

    app.delete("/api/projects/:id/git-imports/:gid", async (req, reply) => {
        const { id, gid } = req.params as { id: string; gid: string };
        project(id);
        gitImportService(ctx).remove(id, gid);
        return reply.code(204).send();
    });
}
