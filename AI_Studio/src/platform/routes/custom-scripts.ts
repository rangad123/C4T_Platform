import { z } from "zod";
import { isHelperName } from "../../engine/custom/helpers.js";
import { MAX_SCRIPT_BYTES } from "../../engine/custom/guard.js";
import { RateLimiter } from "../agent-routing.js";
import { CustomScripts, GuardRefusal } from "../custom-scripts.js";
import { HttpError } from "../http-error.js";
import type { RouteCtx } from "./types.js";

/** Custom (hand-written) scripts, take-over, versions, helpers (Builder AQ). The contract is .scratch/briefs/CODE-API-SHAPES.md. */
export function registerCustomScriptRoutes(ctx: RouteCtx): void {
    const { app, repo } = ctx;
    const svc = new CustomScripts({ p: ctx.p, repo, applicationFor: ctx.applicationFor, startValidationJob: ctx.startValidationJob });
    const store = svc.store;
    // The editor checks while the person types: at most five checks a second.
    const checks = new RateLimiter(5, 1000);

    const test = (id: string) => {
        const t = repo.getTest(id);
        if (!t) throw new HttpError(404, "Test not found");
        return t;
    };
    const helperName = (raw: string): string => {
        if (!isHelperName(raw)) throw new HttpError(400, "Helper names use lower-case letters, digits and hyphens (for example login-steps).");
        return raw;
    };
    /** A refusal by the guard is a 422 that carries the diagnostics (shapes file: `{ error, diagnostics }`). */
    const refuse = (reply: { code(n: number): { send(b: unknown): unknown } }, e: unknown) => {
        if (e instanceof GuardRefusal) return reply.code(422).send({ error: e.message, diagnostics: e.diagnostics });
        throw e;
    };
    const Content = z.object({ content: z.string().max(MAX_SCRIPT_BYTES), note: z.string().max(200).optional() });
    const Confirm = z.object({ confirm: z.literal(true) });

    // ── take over / restore ──
    app.get("/api/tests/:id/take-over", async (req) => {
        const t = test((req.params as { id: string }).id);
        return svc.takeOverInfo(t.id);
    });
    app.post("/api/tests/:id/take-over", async (req) => {
        const t = test((req.params as { id: string }).id);
        Confirm.parse(req.body);
        await svc.takeOver(t.id);
        return ctx.testDetail(t.id);
    });
    app.post("/api/tests/:id/restore-generated", async (req) => {
        const t = test((req.params as { id: string }).id);
        Confirm.parse(req.body);
        const out = await svc.restoreGenerated(t.id);
        return { ...ctx.testDetail(t.id), jobId: out.jobId, ...(out.note ? { note: out.note } : {}) };
    });

    // ── the script ──
    app.put("/api/tests/:id/script", async (req, reply) => {
        const t = test((req.params as { id: string }).id);
        const body = Content.parse(req.body);
        try {
            const r = await svc.saveScript(t.id, body.content, { note: body.note ?? null });
            return { version: r.version, diagnostics: r.diagnostics, jobId: r.jobId, ...(r.note ? { note: r.note } : {}) };
        } catch (e) {
            return refuse(reply, e);
        }
    });
    app.post("/api/tests/:id/script/check", async (req, reply) => {
        const t = test((req.params as { id: string }).id);
        const body = z.object({ content: z.string().max(MAX_SCRIPT_BYTES) }).parse(req.body);
        if (!checks.take(req.ip)) return reply.code(429).header("retry-after", "1").send({ error: "Checking too fast. Wait a moment." });
        return { diagnostics: svc.check(t.projectId, body.content, "test").diagnostics };
    });

    // ── versions ──
    app.get("/api/tests/:id/script-versions", async (req) => {
        const t = test((req.params as { id: string }).id);
        return store.listVersions(t.id);
    });
    app.get("/api/tests/:id/script-versions/:version", async (req) => {
        const { id, version } = req.params as { id: string; version: string };
        const t = test(id);
        const v = store.getVersion(t.id, Number(version));
        if (!/^\d+$/.test(version) || !v) throw new HttpError(404, "That version does not exist.");
        return { version: v.version, content: v.content };
    });
    app.post("/api/tests/:id/script-versions/:version/restore", async (req, reply) => {
        const { id, version } = req.params as { id: string; version: string };
        const t = test(id);
        if (!/^\d+$/.test(version)) throw new HttpError(404, "That version does not exist.");
        try {
            const r = await svc.restoreVersion(t.id, Number(version));
            return { version: r.version, diagnostics: r.diagnostics, jobId: r.jobId, ...(r.note ? { note: r.note } : {}) };
        } catch (e) {
            return refuse(reply, e);
        }
    });

    // ── write from scratch ──
    app.post("/api/projects/:id/custom-tests", async (req, reply) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const body = z.object({ title: z.string().trim().min(3).max(160), kind: z.enum(["web", "api"]), content: z.string().max(MAX_SCRIPT_BYTES), category: z.string().trim().min(1).max(80).optional() }).parse(req.body);
        try {
            const r = await svc.createTest({ projectId: id, title: body.title, kind: body.kind, content: body.content, ...(body.category ? { category: body.category } : {}) });
            return reply.code(201).send({ testId: r.testId, version: r.version, diagnostics: r.diagnostics, jobId: r.jobId, ...(r.note ? { note: r.note } : {}) });
        } catch (e) {
            return refuse(reply, e);
        }
    });

    // ── helpers ──
    app.get("/api/projects/:id/helpers", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        return store.listHelpers(id);
    });
    app.get("/api/projects/:id/helpers/:name", async (req) => {
        const { id, name } = req.params as { id: string; name: string };
        ctx.project(id);
        const h = store.getHelper(id, helperName(name));
        if (!h) throw new HttpError(404, "Helper not found");
        return { name: h.name, content: h.content, updatedAt: h.updatedAt, usedBy: store.usersOfHelper(id, h.name).length };
    });
    app.put("/api/projects/:id/helpers/:name", async (req, reply) => {
        const { id, name } = req.params as { id: string; name: string };
        ctx.project(id);
        const body = z.object({ content: z.string().max(100_000) }).parse(req.body);
        try {
            const r = await svc.putHelper(id, helperName(name), body.content);
            return { diagnostics: r.diagnostics, revalidating: r.revalidating };
        } catch (e) {
            return refuse(reply, e);
        }
    });
    app.delete("/api/projects/:id/helpers/:name", async (req, reply) => {
        const { id, name } = req.params as { id: string; name: string };
        ctx.project(id);
        svc.deleteHelper(id, helperName(name));
        return reply.code(204).send();
    });
}
