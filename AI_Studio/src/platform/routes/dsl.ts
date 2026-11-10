import { z } from "zod";
import { phraseReference } from "../../engine/dsl/index.js";
import { RateLimiter } from "../agent-routing.js";
import { callerCredentials } from "../auth/access.js";
import { DslRefusal, DslService } from "../dsl-service.js";
import type { RouteCtx } from "./types.js";

/**
 * Text tests (Builder BC): a test written as one line per step. Read it (parse, nothing stored), create a test from it, and read or save
 * a stored test as text. Contract: docs/features/text-tests.md. The checks and the storing are the platform's own (see ../dsl-service.ts).
 */
export function registerDslRoutes(ctx: RouteCtx): void {
    const { app } = ctx;
    const svc = new DslService(ctx);
    // The editor reads while the person types (debounced to one request every half second): at most five a second, like the step editor's preview.
    const parses = new RateLimiter(5, 1000);

    // The parser works on text up to 50 KB and says so itself; this only keeps a huge body from being read at all.
    const Text = z.string().max(200_000);

    /** A refusal that carries line diagnostics is sent as `{ error, diagnostics }`, the way the step editor's refusals are. */
    const refuse = <T>(reply: { code(n: number): { send(b: unknown): T } }, e: unknown): T => {
        if (e instanceof DslRefusal) return reply.code(e.status).send({ error: e.message, diagnostics: e.diagnostics });
        throw e;
    };

    app.get("/api/dsl/phrases", async () => phraseReference());

    app.post("/api/dsl/parse", async (req, reply) => {
        const body = z.object({ text: Text }).parse(req.body);
        if (!parses.take(req.ip)) return reply.code(429).header("retry-after", "1").send({ error: "Checking too fast. Wait a moment." });
        const r = svc.parse(body.text);
        return { spec: r.spec, diagnostics: r.diagnostics, truncated: r.truncated, stepLines: r.stepLines };
    });

    // The steps editor shows its unsaved steps as text when the person switches views.
    app.post("/api/dsl/print", async (req, reply) => {
        const body = z.object({ spec: z.unknown().optional() }).parse(req.body);
        if (!parses.take(req.ip)) return reply.code(429).header("retry-after", "1").send({ error: "Checking too fast. Wait a moment." });
        return svc.print(body.spec);
    });

    app.post("/api/projects/:id/dsl-tests", async (req, reply) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const body = z.object({ text: Text }).parse(req.body);
        try {
            const made = await svc.create(id, body.text, callerCredentials(req));
            return reply.code(201).send(made);
        } catch (e) {
            return refuse(reply, e);
        }
    });

    app.get("/api/tests/:id/dsl", async (req) => svc.describe((req.params as { id: string }).id));

    app.put("/api/tests/:id/dsl", async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = z.object({ text: Text, note: z.string().max(200).optional(), run: z.boolean().optional() }).parse(req.body);
        try {
            return await svc.save(id, body.text, body.note, body.run === false ? { run: false } : undefined);
        } catch (e) {
            return refuse(reply, e);
        }
    });
}
