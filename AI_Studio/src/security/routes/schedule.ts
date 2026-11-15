/**
 * Scheduled passive assessments (../schedules.ts):
 *
 *   GET /api/v1/security/applications/:appId/schedule   viewer   → { schedule: null | { cadence, enabled, nextRunAt, maker, last…, words } }
 *   PUT /api/v1/security/applications/:appId/schedule   editor   { cadence: {type:"daily",time} | {type:"weekly",weekday,time} | null }
 *                                                                 null switches it off. The person setting it becomes its maker.
 *
 * A schedule only ever starts a passive assessment. Switching one on needs a current authorization (the same rule as starting one by hand).
 */
import { z } from "zod";
import { OPEN_OWNER_ID, ownerIdOfActor } from "../../platform/agent-store.js";
import { HttpError } from "../../platform/http-error.js";
import { describeSecurityCadence, KEY_CANNOT_SCHEDULE, SecurityCadenceSchema, SecurityScheduleStore, type SecuritySchedule } from "../schedules.js";
import { SECURITY_API, type SecurityRouteCtx } from "./context.js";

const PutBody = z.object({ cadence: SecurityCadenceSchema.nullable() }).strict();

const view = (s: SecuritySchedule | undefined) =>
    s
        ? {
              cadence: s.cadence,
              enabled: s.enabled,
              words: s.enabled ? describeSecurityCadence(s.cadence) : "Off",
              nextRunAt: s.nextRunAt,
              maker: s.makerName,
              lastRunAt: s.lastRunAt,
              lastOutcome: s.lastOutcome,
              lastNote: s.lastNote,
              lastAssessmentId: s.lastAssessmentId,
          }
        : null;

export function registerSecurityScheduleRoutes(ctx: SecurityRouteCtx): void {
    const { app, store, p } = ctx;
    const schedules = new SecurityScheduleStore(p.db);
    const params = (req: { params: unknown }) => req.params as Record<string, string>;

    app.get(`${SECURITY_API}/applications/:appId/schedule`, async (req) => {
        const a = ctx.application(params(req).appId!, req);
        return { schedule: view(schedules.get(a.id)) };
    });

    app.put(`${SECURITY_API}/applications/:appId/schedule`, async (req) => {
        const a = ctx.application(params(req).appId!, req);
        const body = ctx.body(PutBody, req.body);
        const actor = ctx.actor(req);
        const makerId = ownerIdOfActor(actor);
        if (!makerId) throw new HttpError(403, KEY_CANNOT_SCHEDULE);
        const before = schedules.get(a.id);
        if (body.cadence) {
            const auth = store.authorizationState(a);
            if (auth.state !== "current") throw new HttpError(409, auth.message);
        }
        const s = schedules.set(a, body.cadence, { id: makerId, name: makerId === OPEN_OWNER_ID ? actor.name : ctx.actorName(req) }, before);
        ctx.audit({
            projectId: a.projectId,
            applicationId: a.id,
            action: "schedule.changed",
            objectType: "application",
            objectId: a.id,
            summary: body.cadence ? `Scheduled a passive assessment of “${a.name}”: ${describeSecurityCadence(body.cadence)}.` : `Switched off the scheduled assessment of “${a.name}”.`,
        });
        return { schedule: view(s) };
    });
}
