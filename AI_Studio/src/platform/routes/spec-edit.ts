import { z } from "zod";
import type { BuilderDiagnostic } from "../../engine/builder/index.js";
import { RateLimiter } from "../agent-routing.js";
import { HttpError } from "../http-error.js";
import { SpecEditService } from "../spec-edit-service.js";
import type { RouteCtx } from "./types.js";

/** The visual test builder (Builder AT): read, check, save and start a test's steps. Contract: docs/features/visual-builder.md. */
export function registerSpecEditRoutes(ctx: RouteCtx): void {
    const { app } = ctx;
    const svc = new SpecEditService(ctx);
    // The editor previews while the person types (debounced): at most five a second.
    const previews = new RateLimiter(5, 1000);

    const Body = z.object({ spec: z.unknown(), note: z.string().max(200).optional(), run: z.boolean().optional() });

    app.get("/api/tests/:id/spec", async (req) => svc.describe((req.params as { id: string }).id));

    app.put("/api/tests/:id/spec", async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = Body.parse(req.body);
        try {
            return await svc.save(id, body.spec, body.note, undefined, body.run === false ? { run: false } : undefined);
        } catch (e) {
            const diagnostics = (e as { diagnostics?: BuilderDiagnostic[] }).diagnostics;
            if (e instanceof HttpError && e.status === 422 && diagnostics) return reply.code(422).send({ error: e.message, diagnostics });
            throw e;
        }
    });

    app.post("/api/tests/:id/spec/preview", async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = Body.parse(req.body);
        if (!previews.take(req.ip)) return reply.code(429).header("retry-after", "1").send({ error: "Checking too fast. Wait a moment." });
        return svc.preview(id, body.spec);
    });

    app.get("/api/tests/:id/spec-versions", async (req) => {
        const t = svc.test((req.params as { id: string }).id);
        return svc.versions.list(t.id);
    });
    app.get("/api/tests/:id/spec-versions/:version", async (req) => {
        const { id, version } = req.params as { id: string; version: string };
        const t = svc.test(id);
        const v = /^\d+$/.test(version) ? svc.versions.get(t.id, Number(version)) : undefined;
        if (!v) throw new HttpError(404, "That version does not exist.");
        return v;
    });

    app.post("/api/projects/:id/built-tests", async (req, reply) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const body = z
            .object({
                title: z.string().trim().min(3).max(160),
                kind: z.enum(["web", "api"]),
                startUrl: z.string().trim().max(2000).optional(),
                category: z.string().trim().min(1).max(80).optional(),
            })
            .parse(req.body);
        const r = await svc.createBlank(id, body);
        return reply.code(201).send(r);
    });
}
