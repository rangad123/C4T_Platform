/**
 * The read-only cross-account designation of an application (assessment/cross-account.ts):
 *
 *   GET    /api/v1/security/applications/:appId/cross-account   viewer   { designation | null, ready: { ok, problems[] }, signIns: { A, B }, draft }
 *   PUT    /api/v1/security/applications/:appId/cross-account   editor   Designation -> the same answer (saving settles the draft)
 *
 * `draft` (or null): a designation drafted from a test run's two-account evidence, with the run and findings it came from. It is never
 * used until a person saves it here.
 *   DELETE /api/v1/security/applications/:appId/cross-account   editor   { deleted }
 *
 * Refused when saved (400, with the reason): an application not marked development or staging, an account that is not one of the project's,
 * a resource outside the application's scope, under an excluded path or a sensitive workflow, a sign-out address or a GraphQL mutation. The
 * assessment checks all of it again when it runs. No answer carries a sign-in value or anything an assessment received.
 */
import { HttpError } from "../../platform/http-error.js";
import { DesignationSchema, environmentProblem, refusalOf, type Designation } from "../assessment/cross-account.js";
import { withSensitiveExclusions } from "../assessment/runner.js";
import type { SecurityApplication } from "../contract.js";
import { deleteDesignation, readDesignation, readDesignationDraft, writeDesignation } from "../cross-account-store.js";
import { inScope } from "../scope.js";
import { accountNames, signInLabel, signInStatus } from "../signin.js";
import { SECURITY_API, type SecurityRouteCtx } from "./context.js";

export function registerSecurityCrossAccountRoutes(ctx: SecurityRouteCtx): void {
    const { app } = ctx;
    const db = ctx.p.db;
    const cfg = ctx.p.config;
    const appIdOf = (req: { params: unknown }) => (req.params as Record<string, string>).appId!;

    const view = (a: SecurityApplication, d: Designation | undefined) => {
        if (!d) return { designation: null, ready: { ok: false, problems: ["No cross-account designation is set."] }, signIns: null };
        const status = { A: signInStatus(db, cfg, a.projectId, d.accountA, a), B: signInStatus(db, cfg, a.projectId, d.accountB, a) };
        const problems = [
            ...(environmentProblem(a.environment) ? [environmentProblem(a.environment)!] : []),
            ...(["A", "B"] as const).filter((w) => status[w].state !== "ready" && status[w].state !== "not-checked").map((w) => `Account ${w} (${status[w].label}): ${status[w].message}`),
        ];
        return { designation: d, ready: { ok: problems.length === 0, problems }, signIns: status };
    };

    app.get(`${SECURITY_API}/applications/:appId/cross-account`, async (req) => {
        const a = ctx.application(appIdOf(req), req);
        return { ...view(a, readDesignation(db, a.id)), draft: readDesignationDraft(db, a.id) ?? null };
    });

    app.put(`${SECURITY_API}/applications/:appId/cross-account`, async (req) => {
        const a = ctx.application(appIdOf(req), req);
        const d = ctx.body(DesignationSchema, req.body);
        const env = environmentProblem(a.environment);
        if (env) throw new HttpError(400, `${env} Mark the application as development or staging first; production is never checked this way.`);
        const known = accountNames(db, cfg, a.projectId);
        for (const account of [d.accountA, d.accountB]) if (!known.includes(account)) throw new HttpError(400, `There is no test account named “${account}”. Add it under Test accounts first.`);
        const scoped = withSensitiveExclusions(a);
        for (const r of d.resources) {
            const no = refusalOf(r.path);
            if (no) throw new HttpError(400, `${r.path}: ${no}`);
            const v = inScope(new URL(r.path, a.targetUrl), scoped);
            if (!v.ok) throw new HttpError(400, `${r.path}: ${v.code === "excluded-path" ? "it is under an excluded path or a sensitive workflow, so it is never requested." : v.reason}`);
        }
        writeDesignation(db, a.id, d, ctx.actorName(req));
        const owners = (o: string) => d.resources.filter((r) => r.owner === o).length;
        ctx.audit({
            projectId: a.projectId,
            applicationId: a.id,
            action: "cross-account.changed",
            objectType: "application",
            objectId: a.id,
            summary: `Set the read-only cross-account check of “${a.name}”: account A ${signInLabel(d.accountA)}, account B ${signInLabel(d.accountB)}, ${d.resources.length} resource${d.resources.length === 1 ? "" : "s"} (${owners("B")} of B's, ${owners("A")} of A's, ${owners("shared")} shared, ${owners("public")} public).`,
        });
        return { ...view(a, d), draft: null };
    });

    app.delete(`${SECURITY_API}/applications/:appId/cross-account`, async (req) => {
        const a = ctx.application(appIdOf(req), req);
        const deleted = deleteDesignation(db, a.id);
        if (deleted) ctx.audit({ projectId: a.projectId, applicationId: a.id, action: "cross-account.changed", objectType: "application", objectId: a.id, summary: `Removed the read-only cross-account check of “${a.name}”.` });
        return { deleted };
    });
}
