/**
 * One findings list (testing-engine Phase 5 S2, owner's H2): the project's candidate findings with their lifecycle, and its security
 * findings read only (findings/adapters.ts). Reading needs access to the project; a person's verdict needs tests.write (auth/roles.ts).
 * Every finding is looked up within the project in the path: another project's id answers 404.
 *
 *   GET  /api/projects/:id/findings?state=&severity=&group=   → { findings: [Item] }, newest first, then the security findings. `state`
 *                                                              and `severity`: one value or a comma list; `group`: a group id.
 *   GET  /api/projects/:id/findings/:fid                     → { finding: Item, attempts, history }
 *   POST /api/projects/:id/findings/:fid/transition          { action: confirm | not_a_bug | split | reopen, reason? } → { finding: Item }
 *                                                            { action: check_fix } → { finding, fixCheck: { jobId } }: the fix is checked
 *                                                            by a verification job (findings/regression-service.ts); Fixed only if it passes.
 *
 * Item = the FindingView plus { severity, findingClass, groupId, readOnly }. A security finding is readOnly: it changes in the
 * Security module (its own states), never here, and is left out when the module is off. A refused move answers 409 with the lifecycle's
 * sentence.
 */
import { z } from "zod";
import { actorLabel, currentActor } from "../auth/actor.js";
import { FINDING_STATES, type FindingState } from "../../engine/findings/lifecycle.js";
import type { FindingView } from "../../engine/findings/view.js";
import { securitySettings } from "../../security/settings.js";
import { securityStoreFor } from "../../security/store.js";
import { CandidateFindingStore, type CandidateFindingRecord } from "../candidate-finding-store.js";
import { fromCandidate, fromSecurity, type TestOf } from "../findings/adapters.js";
import { claimFix } from "../findings/regression-service.js";
import { HttpError } from "../http-error.js";
import { getScheduleServices } from "../schedule-services.js";
import type { RouteCtx } from "./types.js";

const SEVERITY_WORDS = ["critical", "high", "medium", "low", "info"] as const;

const words = <T extends string>(allowed: readonly T[], what: string) =>
    z
        .string()
        .max(500)
        .optional()
        .transform((v, ctx) => {
            if (!v) return undefined;
            const parts = [...new Set(v.split(",").map((s) => s.trim()).filter(Boolean))];
            const bad = parts.find((p) => !(allowed as readonly string[]).includes(p));
            if (bad) {
                ctx.addIssue({ code: "custom", message: `Unknown ${what} "${bad.slice(0, 40)}". Use one of: ${allowed.join(", ")}.` });
                return z.NEVER;
            }
            return parts as T[];
        });

const ListQuery = z.object({ state: words(FINDING_STATES, "state"), severity: words(SEVERITY_WORDS, "severity"), group: z.string().max(100).optional() }).passthrough();
const TransitionBody = z.object({ action: z.enum(["confirm", "not_a_bug", "split", "reopen", "check_fix"]), reason: z.string().max(2000).optional().nullable() }).strict();

/** Where a person's reopen sends a finding: a closed verdict back to Candidate, anything else to verification again. */
const reopenTo = (from: FindingState): FindingState => (from === "not_a_bug" || from === "duplicate" ? "candidate" : "verification_pending");

type Item = FindingView & { severity: string | null; findingClass: string | null; groupId: string | null; readOnly: boolean };

export function registerFindingRoutes(ctx: RouteCtx): void {
    const { app, p, repo } = ctx;
    const store = new CandidateFindingStore(p.sql);
    const security = securityStoreFor(p.db);
    // SECURITY_ASSESSMENT=off hides the module's findings here too.
    const securityOn = securitySettings(p.config).enabled;

    const testOf = (r: CandidateFindingRecord): TestOf | undefined => {
        const t = r.testId ? repo.getTest(r.testId) : undefined;
        return t && t.projectId === r.projectId && !t.unreadable ? { id: t.id, title: t.title, spec: t.spec, meta: t.generationMeta } : undefined;
    };
    const candidateItem = (r: CandidateFindingRecord): Item => ({ ...fromCandidate(r, testOf(r)), severity: r.severity, findingClass: r.findingClass, groupId: r.groupId, readOnly: false });
    const securityItem = (f: Parameters<typeof fromSecurity>[0]): Item => ({ ...fromSecurity(f), severity: f.severity, findingClass: null, groupId: null, readOnly: true });
    const securityOf = (projectId: string, fid: string) => {
        const f = securityOn ? security.getFinding(fid) : undefined;
        return f && f.projectId === projectId ? f : undefined;
    };

    // The channels that chose these notices hear about a person's confirm and reopen (alerts.ts notifyEvent masks the texts); a delivery
    // never holds up or fails the answer.
    const notice = (projectId: string, event: "finding_confirmed" | "finding_reopened", f: Item, from: FindingState) => {
        const { alerts } = getScheduleServices(p);
        const proj = ctx.project(projectId);
        const summary = event === "finding_confirmed" ? `${actorLabel()} confirmed the finding “${f.title}”.` : `${actorLabel()} reopened the finding “${f.title}” (it was ${from.replace(/_/g, " ")}).`;
        void alerts.notifyEvent(alerts.subject({ id: projectId, name: String(proj.name), url: null }), { event, summary, items: [{ title: f.title, reason: f.observed }] }).catch((err) => console.error("[alerts] finding notice failed:", err));
    };

    app.get("/api/projects/:id/findings", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const q = ListQuery.safeParse(req.query ?? {});
        if (!q.success) throw new HttpError(400, q.error.issues[0]!.message);
        const { state, severity, group } = q.data;
        const keep = (i: Item) => (!state || state.includes(i.state)) && (!severity || (i.severity !== null && (severity as string[]).includes(i.severity))) && (!group || i.groupId === group);
        const own = (await store.list(id)).map(candidateItem);
        // Security findings have no group; a group filter is about candidate findings only.
        const sec = group || !securityOn ? [] : security.listFindings({ projectId: id }).map(securityItem);
        return { findings: [...own, ...sec].filter(keep) };
    });

    app.get("/api/projects/:id/findings/:fid", async (req) => {
        const { id, fid } = req.params as { id: string; fid: string };
        ctx.project(id);
        const r = await store.get(id, fid);
        if (r) {
            const finding = candidateItem(r);
            return { finding, attempts: finding.attempts, history: await store.history(id, fid) };
        }
        const s = securityOf(id, fid);
        if (!s) throw new HttpError(404, "Finding not found");
        return { finding: securityItem(s), attempts: [], history: security.findingHistory(fid) };
    });

    app.post("/api/projects/:id/findings/:fid/transition", async (req) => {
        const { id, fid } = req.params as { id: string; fid: string };
        ctx.project(id);
        const b = TransitionBody.safeParse(req.body ?? {});
        if (!b.success) throw new HttpError(400, b.error.issues[0]!.message);
        const r = await store.get(id, fid);
        if (!r) {
            if (securityOf(id, fid)) throw new HttpError(409, "A security finding changes in the Security module, not here.");
            throw new HttpError(404, "Finding not found");
        }
        const actor = { id: currentActor().id ?? null, label: actorLabel() };
        const move = async (to: FindingState) => {
            try {
                return (await store.transition(id, fid, { to, by: "person", actor, reason: b.data.reason ?? null }))!;
            } catch (e) {
                throw new HttpError(409, (e as Error).message);
            }
        };
        const { action } = b.data;
        if (action === "check_fix") {
            // A person says a fix is in: the engine checks it on the application (regression-service.ts); only a passing check makes it Fixed.
            let claimed: Awaited<ReturnType<typeof claimFix>>;
            try {
                claimed = await claimFix(p, id, { findingIds: [fid], by: "person", source: actor.label, actor });
            } catch (e) {
                throw e instanceof HttpError ? e : new HttpError(409, (e as Error).message);
            }
            if (!claimed.jobId) throw new HttpError(409, claimed.refused[0]?.why ?? "The fix cannot be checked.");
            return { finding: candidateItem((await store.get(id, fid))!), fixCheck: { jobId: claimed.jobId } };
        }
        if (action === "split") {
            const mates = r.groupId ? (await store.groups(id)).find((g) => g.id === r.groupId)?.findingIds ?? [] : [];
            if (mates.length < 2) throw new HttpError(409, "This finding is not grouped with others, so there is nothing to split.");
            // A duplicate leaves its group as a candidate of its own; the move goes first, so a refused one changes nothing.
            if (r.state === "duplicate") await move("candidate");
            await store.group(id, [fid], { splitFrom: r.groupId, by: actor.label });
            return { finding: candidateItem((await store.get(id, fid))!) };
        }
        const to: FindingState = action === "confirm" ? "confirmed" : action === "not_a_bug" ? "not_a_bug" : reopenTo(r.state);
        const finding = candidateItem(await move(to));
        if (action !== "not_a_bug") notice(id, action === "confirm" ? "finding_confirmed" : "finding_reopened", finding, r.state);
        return { finding };
    });
}
