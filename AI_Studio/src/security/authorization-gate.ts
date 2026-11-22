/**
 * The "authorization" value of a job's risky-checks gate (Phase 4 Q4: controlled concurrency C8 and writes as another identity C3e):
 * the project holds a current client authorization (authorization.ts, judged now by SecurityStore.currentAuthorization) for a security
 * application whose target is the job's application (the same origin). Read from the project's records only; a job's options or a
 * request body never set it.
 */
import type { Db } from "../platform/db.js";
import { securityStoreFor } from "./store.js";

const originOf = (url: string): string | undefined => {
    try {
        return new URL(url).origin;
    } catch {
        return undefined;
    }
};

export function hasCurrentAuthorization(db: Db, projectId: string, appUrl: string, now = Date.now()): boolean {
    const origin = originOf(appUrl);
    if (!origin) return false;
    const store = securityStoreFor(db);
    return store.listApplications(projectId).some((a) => originOf(a.targetUrl) === origin && store.currentAuthorization(a, now) !== undefined);
}
