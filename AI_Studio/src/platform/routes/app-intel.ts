/**
 * Application intelligence (testing-engine Phase 1, app-intel-store.ts): reading needs access to the project; confirming or rejecting a
 * rule needs permission to write tests in it, and a person (the shared access key is no person, so it cannot confirm anything).
 *
 *   GET /api/projects/:id/intel/models                    → { versions: [{ id, version, note, createdAt, diff }] }
 *   GET /api/projects/:id/intel/models/:version           → the version with its model ("latest" for the newest)
 *   GET /api/projects/:id/intel/rules?status=&explicitness= → { rules }
 *   PUT /api/projects/:id/intel/rules/:ruleId/decision    { status: confirmed | rejected | unverified, fingerprint } → the rule (409 when
 *                                                          the rule's fingerprint is no longer the one decided about; undo needs none)
 *   GET /api/projects/:id/intel/sources                   → { sources, running: { since } | null, last: { at, changed, version, failed, error? } | null }
 *   POST /api/projects/:id/intel/analyse                  → 202 { running: { since } } (409 while one runs); runs in the background
 *   DELETE /api/projects/:id/intel/analyse                → { stopped: true } (404 when none runs)
 *   POST /api/projects/:id/intel/sources/schema?name=     the schema file's bytes (SQL or Prisma, at most 1 MB) → the source, 201
 *   DELETE /api/projects/:id/intel/sources/schema/:sourceId → { removed }
 *   PUT /api/projects/:id/intel/app-version               { label } → the latest version, labelled by a person
 */
import { z } from "zod";
import { RULE_STATUSES } from "../../engine/intel/model.js";
import { MAX_SCHEMA_INPUT } from "../../engine/intel/sources/db-schema.js";
import { aiOwnerOfActor } from "../ai-config.js";
import { analysisState, AppAnalysis, startAnalysis, stopAnalysis } from "../app-analysis.js";
import { ownerIdOfActor } from "../agent-store.js";
import { AppIntelStore } from "../app-intel-store.js";
import { actorOf, assertHoldsHere } from "../auth/access.js";
import { projectSetupOf } from "../project-setup.js";
import { currentActor } from "../auth/actor.js";
import { HttpError } from "../http-error.js";
import { parsePlain } from "./project-settings.js";
import type { RouteCtx } from "./types.js";

const Decision = z.object({ status: z.enum(RULE_STATUSES), fingerprint: z.string().regex(/^[0-9a-f]{64}$/, "A rule's fingerprint is 64 hexadecimal characters.").optional() }).strict();
const RuleFilter = z.object({ status: z.enum(RULE_STATUSES).optional(), explicitness: z.enum(["explicit", "inferred"]).optional() }).strict();
export const ONLY_A_PERSON = "Only a person can confirm or reject a rule. Sign in with your own account.";
export const ONLY_A_PERSON_LABELS = "Only a person can name the application version. Sign in with your own account.";
export const SAY_WHICH_RULE = "Say which version of the rule you decide about: send the fingerprint of the rule as you read it.";
export const AGENT_PROJECTS_ONLY = "Application understanding is part of AI agent projects. Turn on the AI agent testing mode for this project to use it.";
export const RULE_CHANGED = "This rule changed since you read it. Read it again, then confirm or reject it.";
const SchemaName = z.object({ name: z.string().trim().regex(/^[\w][\w .()-]{0,199}$/, "Give the schema file a plain name (letters, digits, spaces, dots, dashes), without folders.") }).strict();
const Label = z.object({ label: z.string().trim().min(1, "Give the version a label.").max(200, "A version label is at most 200 characters.") }).strict();
const utf8 = new TextDecoder("utf-8", { fatal: true });

export function registerAppIntelRoutes(ctx: RouteCtx): void {
    const { app, p } = ctx;
    const store = new AppIntelStore(p.sql);
    const projectId = (req: { params: unknown }): string => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        return id;
    };
    /** The project of a write route: it must be an AI agent project (application understanding is shown and used only there). */
    const agentProject = (req: { params: unknown }): string => {
        const id = projectId(req);
        if (!projectSetupOf(ctx.project(id)).testingModes.includes("agent")) throw new HttpError(409, AGENT_PROJECTS_ONLY);
        return id;
    };

    app.get("/api/projects/:id/intel/models", async (req) => ({ versions: await store.versions(projectId(req)) }));

    app.get("/api/projects/:id/intel/models/:version", async (req) => {
        const pid = projectId(req);
        const { version } = req.params as { version: string };
        const v = version === "latest" ? await store.latest(pid) : /^\d{1,9}$/.test(version) ? await store.version(pid, Number(version)) : undefined;
        if (!v) throw new HttpError(404, "Application model not found");
        return v;
    });

    app.get("/api/projects/:id/intel/rules", async (req) => {
        const pid = projectId(req);
        const filter = parsePlain(RuleFilter, req.query ?? {});
        return { rules: await store.rules(pid, filter) };
    });

    const analysis = new AppAnalysis({ sql: p.sql, store: p.store });

    app.get("/api/projects/:id/intel/sources", async (req) => {
        const pid = projectId(req);
        return { sources: await store.sources(pid), ...analysisState(p.db, pid) };
    });

    app.post("/api/projects/:id/intel/analyse", async (req, reply) => {
        const pid = agentProject(req);
        // The route asks for the AI permission; the analysis also stores what it finds, so writing tests is needed too.
        assertHoldsHere(app, req, pid, "ai_studio.tests.write");
        // The starter's chosen AI key, like any AI work they start (ai-config.ts); the analysis itself runs in the background.
        const actor = actorOf(req) ?? currentActor();
        const started = await startAnalysis(p, pid, aiOwnerOfActor(actor));
        return reply.code(202).send({ running: { since: started.since } });
    });

    app.delete("/api/projects/:id/intel/analyse", async (req) => {
        const pid = projectId(req);
        if (!stopAnalysis(p.db, pid)) throw new HttpError(404, "The application is not being read right now.");
        return { stopped: true };
    });

    app.post("/api/projects/:id/intel/sources/schema", { bodyLimit: MAX_SCHEMA_INPUT * 4 }, async (req, reply) => {
        const pid = agentProject(req);
        const { name } = parsePlain(SchemaName, req.query);
        const body = Buffer.isBuffer(req.body) ? req.body : typeof req.body === "string" ? Buffer.from(req.body, "utf8") : undefined;
        if (!body) throw new HttpError(415, "Send the schema file's bytes with the type application/octet-stream or text/plain.");
        if (body.length > MAX_SCHEMA_INPUT) throw new HttpError(413, "A schema file is at most 1 MB.");
        if (!body.length) throw new HttpError(400, "The schema file is empty.");
        let text: string;
        try {
            text = utf8.decode(body);
        } catch {
            throw new HttpError(400, "The schema file is not UTF-8 text.");
        }
        return reply.code(201).send(await analysis.uploadSchema(pid, name, text));
    });

    app.delete("/api/projects/:id/intel/sources/schema/:sourceId", async (req) => {
        const pid = projectId(req);
        const { sourceId } = req.params as { sourceId: string };
        const s = await store.source(pid, sourceId);
        if (!s || s.kind !== "db_schema") throw new HttpError(404, "There is no schema file with that id in this project.");
        await analysis.deleteSource(pid, s.id);
        return { removed: s.ref };
    });

    app.put("/api/projects/:id/intel/app-version", async (req) => {
        const pid = agentProject(req);
        if (!ownerIdOfActor(actorOf(req) ?? currentActor())) throw new HttpError(403, ONLY_A_PERSON_LABELS);
        const { label } = parsePlain(Label, req.body);
        const v = await store.labelLatest(pid, label);
        if (!v) throw new HttpError(409, "There is nothing to label yet. Read the application first.");
        return { id: v.id, version: v.version, appVersion: v.appVersion };
    });

    app.put("/api/projects/:id/intel/rules/:ruleId/decision", async (req) => {
        const pid = projectId(req);
        const { ruleId } = req.params as { ruleId: string };
        const person = ownerIdOfActor(actorOf(req) ?? currentActor());
        if (!person) throw new HttpError(403, ONLY_A_PERSON);
        const body = parsePlain(Decision, req.body);
        if (body.status !== "unverified" && !body.fingerprint) throw new HttpError(400, SAY_WHICH_RULE);
        const rule = await store.decide(pid, ruleId, body.status, person, body.fingerprint);
        if (!rule) throw new HttpError(404, "Rule not found");
        return rule;
    });
}
