/**
 * Reusable steps ("blocks") routes: named groups of steps per project that tests use with one step (see docs/features/step-blocks.md).
 *
 * The rules live in block-service.ts; this file only reads requests and shapes answers. Every route is behind the platform's API key.
 */
import { z } from "zod";
import { MAX_BLOCKS } from "../../engine/blocks/index.js";
import { builderCatalog } from "../../engine/builder/index.js";
import { BlockNameTakenError, type StoredBlock } from "../block-store.js";
import { BlockService } from "../block-service.js";
import { HttpError } from "../http-error.js";
import type { RouteCtx } from "./types.js";

const UpdateBody = z
    .object({
        name: z.string().max(200).optional(),
        description: z.string().max(2000).nullable().optional(),
        kind: z.enum(["web", "api", "any"]).optional(),
        params: z.array(z.unknown()).max(50).optional(),
        steps: z.array(z.unknown()).max(200).optional(),
        /** Optimistic check: refuse when someone changed the block since this version. */
        expectedVersion: z.number().int().positive().optional(),
    })
    .strict();

const ExtractBody = z.object({
    testId: z.string().min(1).max(64),
    from: z.number().int().min(0).max(1000),
    to: z.number().int().min(0).max(1000),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    params: z
        .array(
            z.object({
                name: z.string().min(1).max(60),
                description: z.string().max(200).optional(),
                default: z.string().max(500).optional(),
                /** The text in the chosen steps that this parameter stands for. */
                replace: z.string().max(500).optional(),
            }),
        )
        .max(10)
        .optional(),
});

export function registerBlockRoutes(ctx: RouteCtx): void {
    const { app, project } = ctx;
    const svc = new BlockService(ctx);

    const taken = (e: unknown): never => {
        if (e instanceof BlockNameTakenError) throw new HttpError(409, e.message);
        throw e;
    };
    const publicBlock = (b: StoredBlock, usage: ReturnType<BlockService["usage"]> extends Map<string, infer U> ? U | undefined : never, all = false) => ({
        id: b.id,
        name: b.name,
        description: b.description,
        kind: b.kind,
        params: b.params,
        stepCount: b.steps.length,
        ...(all ? { steps: b.steps } : {}),
        version: b.version,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
        usedBy: {
            count: usage?.tests.length ?? 0,
            blocks: usage?.blocks ?? [],
            tests: (usage?.tests ?? []).slice(0, all ? 200 : 3).map((u) => ({ id: u.id, testId: u.testKey, title: u.title })),
        },
    });
    /** `{ notes }` when the checks could not be complete (see BlockService.notes); nothing otherwise. */
    const noted = async (projectId: string, saved: string): Promise<{ notes?: string[] }> => {
        const notes = await svc.notes(projectId, saved);
        return notes.length ? { notes } : {};
    };
    const named = (projectId: string, raw: string): StoredBlock => {
        const b = svc.store.get(projectId, raw);
        if (!b) throw new HttpError(404, "Reusable steps not found");
        return b;
    };

    app.get("/api/projects/:id/blocks", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        const q = z.object({ q: z.string().max(100).optional(), kind: z.enum(["web", "api", "any"]).optional() }).parse(req.query);
        const all = svc.store.list(id);
        const usage = svc.usage(id, all);
        let list = all;
        if (q.kind) list = list.filter((b) => b.kind === q.kind || b.kind === "any");
        if (q.q) {
            const needle = q.q.toLowerCase();
            list = list.filter((b) => b.name.toLowerCase().includes(needle) || (b.description ?? "").toLowerCase().includes(needle));
        }
        return { total: all.length, limit: MAX_BLOCKS, blocks: list.map((b) => publicBlock(b, usage.get(b.name))), catalog: builderCatalog(), placeholders: svc.placeholders(id) };
    });

    app.post("/api/projects/:id/blocks", async (req, reply) => {
        const { id } = req.params as { id: string };
        project(id);
        try {
            const b = await svc.create(id, req.body);
            return reply.code(201).send({ ...publicBlock(b, undefined, true), ...(await noted(id, b.name)) });
        } catch (e) {
            return taken(e);
        }
    });

    // Registered before the routes with a name in the path, so "from-steps" is never read as a name.
    app.post("/api/projects/:id/blocks/from-steps", async (req, reply) => {
        const { id } = req.params as { id: string };
        project(id);
        const body = ExtractBody.parse(req.body);
        try {
            const r = await svc.extract(id, body);
            return reply.code(201).send({ block: publicBlock(r.block, undefined, true), testId: r.testId, steps: r.steps, ...(await noted(id, r.block.name)) });
        } catch (e) {
            return taken(e);
        }
    });

    app.get("/api/projects/:id/blocks/:name", async (req) => {
        const { id, name } = req.params as { id: string; name: string };
        project(id);
        const b = named(id, name);
        return publicBlock(b, svc.usage(id).get(b.name), true);
    });

    app.get("/api/projects/:id/blocks/:name/usage", async (req) => {
        const { id, name } = req.params as { id: string; name: string };
        project(id);
        const b = named(id, name);
        const u = svc.usage(id).get(b.name);
        const status = new Map(ctx.repo.listTests(id).map((t) => [t.id, t.validationStatus]));
        return {
            name: b.name,
            tests: (u?.tests ?? []).map((t) => ({ id: t.id, testId: t.testKey, title: t.title, steps: t.steps, validationStatus: status.get(t.id) ?? null })),
            blocks: u?.blocks ?? [],
        };
    });

    app.put("/api/projects/:id/blocks/:name", async (req) => {
        const { id, name } = req.params as { id: string; name: string };
        project(id);
        const { expectedVersion, ...rest } = UpdateBody.parse(req.body);
        const cleaned = { ...rest, ...(rest.description === null ? { description: undefined } : {}) };
        try {
            const r = await svc.update(id, name, cleaned, { expectedVersion });
            return { ...publicBlock(r.block, svc.usage(id).get(r.block.name), true), ...r.outcome, ...(await noted(id, r.block.name)) };
        } catch (e) {
            return taken(e);
        }
    });

    app.delete("/api/projects/:id/blocks/:name", async (req, reply) => {
        const { id, name } = req.params as { id: string; name: string };
        project(id);
        svc.delete(id, name);
        return reply.code(204).send();
    });
}
