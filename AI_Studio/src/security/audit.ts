/**
 * The security audit trail. Every create/change/delete of applications and authorizations, assessments started/cancelled/stopped,
 * validation changes, manual findings, report exports and the testing-type choice are recorded TWICE: in the module's own trail
 * (security_audit, listed by GET /api/v1/security/projects/:id/activity) and in the platform's Activity list (Settings, People), with who.
 *
 * Stable API:
 *   recordSecurityEvent(db, event)    writes both; who = the current actor (the request's person or key; "Platform" for background work)
 *   auditedThisRequest(actor)         true when the request of this actor already recorded an event (the routes' fallback uses it)
 *   SECURITY_ACTIVITY_PREFIX          Activity rows of this module have action "security:<code>" and the plain summary as detail
 *
 * Summaries are one plain sentence and never carry secrets (no cookie values, tokens, passwords, approver emails).
 */
import type { Db } from "../platform/db.js";
import { currentActor, type Actor } from "../platform/auth/actor.js";
import { UserStore } from "../platform/user-store.js";
import { securityStoreFor, type SecurityAuditEvent } from "./store.js";

export const SECURITY_ACTIVITY_PREFIX = "security:";

const audited = new WeakSet<Actor>();
const userStores = new WeakMap<Db, UserStore>();

/** The Activity writer for a database (the platform's UserStore; no secret box is needed to add activity rows). */
function activityOf(db: Db): UserStore {
    let u = userStores.get(db);
    if (!u) userStores.set(db, (u = new UserStore(db)));
    return u;
}

export function recordSecurityEvent(db: Db, e: SecurityAuditEvent): void {
    const actor = currentActor();
    securityStoreFor(db).addAudit(e);
    try {
        activityOf(db).addActivity({
            actorKind: actor.kind,
            actorId: actor.id ?? null,
            actorName: actor.name,
            action: `${SECURITY_ACTIVITY_PREFIX}${e.action}`,
            path: null,
            projectId: e.projectId,
            status: null,
            detail: e.summary,
        });
    } finally {
        audited.add(actor);
    }
}

/** Whether a request (known by its actor object, which is new for every request) already recorded a security event. */
export function auditedThisRequest(actor: Actor | undefined): boolean {
    return actor !== undefined && audited.has(actor);
}
