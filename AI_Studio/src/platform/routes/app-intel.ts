/**
 * Application intelligence (testing-engine Phase 1, app-intel-store.ts): reading needs access to the project; confirming or rejecting a
 * rule needs permission to write tests in it, and a person (the shared access key is no person, so it cannot confirm anything).
 *
 *   GET /api/projects/:id/intel/models                    → { versions: [{ id, version, note, createdAt, diff }] }
 *   GET /api/projects/:id/intel/models/:version           → the version with its model ("latest" for the newest)
 *   GET /api/projects/:id/intel/rules?status=&explicitness= → { rules }
 *   PUT /api/projects/:id/intel/rules/:ruleId/decision    { status: confirmed | rejected | unverified } → the rule
 */
import { z } from "zod";
import { RULE_STATUSES } from "../../engine/intel/model.js";
import { ownerIdOfActor } from "../agent-store.js";
import { AppIntelStore } from "../app-intel-store.js";
import { actorOf } from "../auth/access.js";
import { currentActor } from "../auth/actor.js";
import { HttpError } from "../http-error.js";
import { parsePlain } from "./project-settings.js";
import type { RouteCtx } from "./types.js";

const Decision = z.object({ status: z.enum(RULE_STATUSES) }).strict();
const RuleFilter = z.object({ status: z.enum(RULE_STATUSES).optional(), explicitness: z.enum(["explicit", "inferred"]).optional() }).strict();
export const ONLY_A_PERSON = "Only a person can confirm or reject a rule. Sign in with your own account.";

export function registerAppIntelRoutes(ctx: RouteCtx): void {
    const { app, p } = ctx;
    const store = new AppIntelStore(p.sql);
    const projectId = (req: { params: unknown }): string => {
        const { id } = req.params as { id: string };
        ctx.project(id);
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

    app.put("/api/projects/:id/intel/rules/:ruleId/decision", async (req) => {
        const pid = projectId(req);
        const { ruleId } = req.params as { ruleId: string };
        const person = ownerIdOfActor(actorOf(req) ?? currentActor());
        if (!person) throw new HttpError(403, ONLY_A_PERSON);
        const rule = await store.decide(pid, ruleId, parsePlain(Decision, req.body).status, person);
        if (!rule) throw new HttpError(404, "Rule not found");
        return rule;
    });
}
