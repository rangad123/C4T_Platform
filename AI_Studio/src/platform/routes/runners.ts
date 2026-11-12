/**
 * One runner per person, set up in Settings and used for every run they start (round 45; docs/features/runner-settings.md). The rows are
 * in agent-store.ts; the download that carries the one-time code is routes/runner-kits.ts (POST /api/me/runner/download).
 *
 *   GET    /api/me/runner                       → { runner: null | RunnerMine, canSeeEveryone }; RunnerMine.can says what it can start now
 *                                                 ({ ok, why? } per kind: the sentence the server's up-front refusal would give)
 *   GET    /api/me/runner/enrollments/:id       → { status: "waiting" | "connected" | "expired" | "used" }   (the code's owner only)
 *   PATCH  /api/me/runner                       { name?, switches?: { codeScripts?, privateTargets?, realPhone? } } → { runner }
 *   POST   /api/me/runner/retire                "Remove this computer": its credential stops working at once → { runner: null }
 *   POST   /api/me/runner/update                "Update now" → { runner }
 *   GET    /api/admin/runners                   every person's runner (platform admins, people who manage runners everywhere)
 *   POST   /api/admin/runners/:id/retire        an admin removes one (a lost laptop)
 *
 * The open server acts as one person (OPEN_OWNER_ID); the shared access key is no person and has no runner.
 */
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { hostDeviceProblem } from "../agent-device.js";
import { recordProblem } from "../agent-record.js";
import { capabilityProblem } from "../agent-routing.js";
import { cannotRunSentence, getAgentServices } from "../agent-services.js";
import { getAdapter, IOS_ADAPTER_ID } from "../../engine/frameworks/index.js";
import { RUNNER_OFFLINE } from "../runner-only.js";
import { OPEN_OWNER_ID, ownerIdOfActor, type AgentRecord, type AgentTokenRecord } from "../agent-store.js";
import { accessControlOf, actorOf } from "../auth/access.js";
import { currentActor, type Actor } from "../auth/actor.js";
import { HttpError } from "../http-error.js";
import { CANNOT_HAVE_RUNNER, checkView, KEY_CANNOT_HAVE_RUNNER, networkSentence, RUNNER_NOT_FOUND, RUNNER_RETIRED, runnerState, seesEveryRunner } from "../runner-health.js";
import { runnerUpdatesFor } from "../runner-update.js";
import { parsePlain } from "./project-settings.js";
import type { RouteCtx } from "./types.js";

const RunnerName = z.string().trim().min(1, "Give the runner a name.").max(60, "A runner's name is at most 60 characters.");

export function registerRunnerRoutes(ctx: RouteCtx): void {
    const { app, p } = ctx;
    const control = accessControlOf(app);
    const svc = getAgentServices(p);
    const updates = runnerUpdatesFor(p);
    const who = (req: FastifyRequest): Actor => actorOf(req) ?? currentActor();
    const note = (actor: Actor, action: string, detail: string) => control.users.addActivity({ actorKind: actor.kind, actorId: actor.id ?? null, actorName: actor.name, action, detail, projectId: null });

    /**
     * The caller as the owner of a runner, or a plain refusal (the shared key is no person). Changing or removing one's own runner needs only
     * owning it: a person who lost the right to run tests can still remove their computer (setting one up is the download's check).
     */
    const ownerOf = (req: FastifyRequest): string => {
        const actor = who(req);
        if (actor.kind === "key") throw new HttpError(403, KEY_CANNOT_HAVE_RUNNER);
        const id = ownerIdOfActor(actor);
        if (!id) throw new HttpError(403, CANNOT_HAVE_RUNNER);
        return id;
    };

    const projectName = (id: string): string => p.db.get<{ name: string }>("SELECT name FROM projects WHERE id = ?", id)?.name ?? "A project";

    type Can = { ok: boolean; why?: string };
    const can = (why: string | undefined): Can => (why ? { ok: false, why } : { ok: true });

    /** What the runner can start now, in the words of the server's refusals (assertJobAllowed, chooseRecorder, chooseDeviceHost). */
    const canOf = (t: AgentTokenRecord, latest: AgentRecord | undefined, online: boolean) => {
        const kinds = ["web", "phone", "ios", "windows", "record", "recordHeaded", "phoneSession"] as const;
        if (!latest || !online) return Object.fromEntries(kinds.map((k) => [k, can(RUNNER_OFFLINE)])) as Record<(typeof kinds)[number], Can>;
        const tests = (id: string) => {
            const adapter = getAdapter(id);
            const why = capabilityProblem(adapter, latest.capabilities);
            return can(why && cannotRunSentence(adapter, latest.name, why));
        };
        return {
            web: tests("playwright"),
            phone: tests("taqwright"),
            ios: tests(IOS_ADAPTER_ID),
            windows: tests("windows-uia"),
            record: can(recordProblem(latest, false)),
            recordHeaded: can(recordProblem(latest, true)),
            phoneSession: can(hostDeviceProblem({ ...latest, personal: true, allowRealPhone: t.allowRealPhone })),
        };
    };

    /** GET /api/me/runner's runner, from the credential and the computer that last connected with it. */
    const mine = (t: AgentTokenRecord) => {
        const latest = svc.store.agentsOfToken(t.id)[0];
        const now = svc.clock();
        const status = runnerState(svc.store, latest, now);
        const running = latest ? svc.store.runningTaskOf(latest.id) : undefined;
        const check = checkView(latest);
        const network = networkSentence(latest);
        return {
            id: t.id,
            kind: "personal" as const,
            name: t.label ?? latest?.name ?? "Your computer",
            status,
            lastSeenAt: latest ? new Date(latest.lastSeenMs).toISOString() : null,
            os: latest?.os ?? null,
            arch: latest?.arch ?? null,
            ...(latest ? { hostname: latest.name, version: latest.version } : {}),
            // Runner updates: only for a runner started from a download (a checkout-based runner has none).
            ...(latest && (latest.capabilities.kitVersion || latest.capabilities.update) ? { update: updates.publicView(latest) } : {}),
            ...(check ? { check } : {}),
            ...(network ? { network } : {}),
            switches: { codeScripts: t.allowCodeScripts, privateTargets: t.allowPrivateTargets, realPhone: t.allowRealPhone },
            can: canOf(t, latest, status !== "offline"),
            ...(running ? { currentRun: { jobId: running.jobId, projectId: running.projectId, title: projectName(running.projectId) } } : {}),
        };
    };

    app.get("/api/me/runner", async (req) => {
        const actor = who(req);
        const id = ownerIdOfActor(actor);
        // Whether the admins' list (GET /api/admin/runners) answers this caller: the same rule as that route, so the page shows it exactly then.
        const canSeeEveryone = seesEveryRunner(control.projects, actor);
        if (!id) return { runner: null, canSeeEveryone };
        const r = svc.store.runnerOf(id);
        return { runner: r ? mine(r.token) : null, canSeeEveryone };
    });

    app.get("/api/me/runner/enrollments/:enrollmentId", async (req) => {
        const { enrollmentId } = req.params as { enrollmentId: string };
        const owner = ownerIdOfActor(who(req));
        const e = svc.store.getEnrollment(enrollmentId);
        // The person it was made for only; anyone else gets the same answer as for an unknown id.
        if (!e || !owner || e.kind !== "personal" || e.ownerId !== owner) throw new HttpError(404, "Enrollment code not found");
        if (e.usedMs === null) return { status: svc.clock() >= e.expiresMs ? "expired" : "waiting" };
        const t = e.tokenId ? svc.store.getToken(e.tokenId) : undefined;
        // Connected: the computer traded the code and its credential still works. Used: that credential was removed since.
        return { status: t && !t.revokedAt ? "connected" : "used" };
    });

    /** The caller's live runner, or 404 (none set up). */
    const liveMine = (req: FastifyRequest): { owner: string; token: AgentTokenRecord } => {
        const owner = ownerOf(req);
        const r = svc.store.runnerOf(owner);
        if (!r) throw new HttpError(404, "You have no runner set up. Set it up in Settings.");
        return { owner, token: r.token };
    };

    app.patch("/api/me/runner", async (req) => {
        const { token } = liveMine(req);
        const actor = who(req);
        const body = parsePlain(
            z.object({ name: RunnerName.optional(), switches: z.object({ codeScripts: z.boolean().optional(), privateTargets: z.boolean().optional(), realPhone: z.boolean().optional() }).strict().optional() }).strict(),
            req.body ?? {},
        );
        const sw = body.switches ?? {};
        if (body.name !== undefined && !svc.store.renameToken(token.id, body.name)) throw new HttpError(409, RUNNER_RETIRED);
        if (!svc.store.setTokenSwitches(token.id, { ...(sw.codeScripts !== undefined ? { allowCodeScripts: sw.codeScripts } : {}), ...(sw.privateTargets !== undefined ? { allowPrivateTargets: sw.privateTargets } : {}), ...(sw.realPhone !== undefined ? { allowRealPhone: sw.realPhone } : {}) })) throw new HttpError(409, RUNNER_RETIRED);
        if (body.name !== undefined) note(actor, "runner-renamed", `Their runner was renamed to “${body.name}”.`);
        const said = [sw.codeScripts !== undefined ? `code scripts ${sw.codeScripts ? "allowed" : "not allowed"}` : "", sw.privateTargets !== undefined ? `private addresses ${sw.privateTargets ? "allowed" : "not allowed"}` : "", sw.realPhone !== undefined ? `a connected phone ${sw.realPhone ? "may be used" : "is not used"}` : ""].filter(Boolean);
        if (said.length) note(actor, "runner-switches-changed", `Their runner: ${said.join(", ")}.`);
        return { runner: mine(svc.store.getToken(token.id)!) };
    });

    app.post("/api/me/runner/retire", async (req) => {
        const { owner, token } = liveMine(req);
        // "Remove this computer": every credential of the person stops working at once (a person has one runner).
        svc.store.retireOtherPersonal(owner, null);
        note(who(req), "runner-retired", `Their runner “${token.label ?? `…${token.hint}`}” was removed.`);
        return { runner: null };
    });

    app.post("/api/me/runner/update", async (req) => {
        const { token } = liveMine(req);
        const a = svc.store.agentsOfToken(token.id)[0];
        if (!a) throw new HttpError(409, "Your runner has not connected yet, so there is nothing to update.");
        const view = updates.publicView(a);
        if (!view.latest) throw new HttpError(409, "The runner files have not been built on this server, so there is nothing to update to.");
        if (!view.can) throw new HttpError(409, `“${a.name}” cannot update itself: it was started from a repository checkout or from a download made before runner updates existed. Download the runner again from Settings.`);
        if (!view.outOfDate) throw new HttpError(409, `“${a.name}” is already on version ${view.latest}.`);
        if (!view.published) throw new HttpError(409, `${view.unpublished ?? "This server offers no signed runner update."} To update “${a.name}”, download the runner again from Settings.`);
        updates.request(a.id);
        return { runner: mine(token) };
    });

    // ── admins: everyone's runners ──────────────────────────────────────────
    const refuseUnlessAdmin = (req: FastifyRequest): Actor => {
        const actor = who(req);
        if (!seesEveryRunner(control.projects, actor)) throw new HttpError(403, "Only platform admins can see everyone's runners.");
        return actor;
    };
    const personName = (id: string | null): string => {
        if (id === OPEN_OWNER_ID) return "Open access";
        const u = id ? p.db.get<{ name: string | null; email: string | null }>("SELECT name, email FROM users WHERE id = ?", id) : undefined;
        return u?.name || u?.email || "A person";
    };

    app.get("/api/admin/runners", async (req) => {
        refuseUnlessAdmin(req);
        const now = svc.clock();
        return {
            runners: svc.store.allPersonalTokens().map((t) => {
                const latest = svc.store.agentsOfToken(t.id)[0];
                return {
                    id: t.id,
                    name: t.label ?? latest?.name ?? "Unnamed runner",
                    owner: { id: t.ownerId, name: personName(t.ownerId) },
                    ownerName: personName(t.ownerId),
                    status: latest ? runnerState(svc.store, latest, now) : ("not-connected" as const),
                    lastSeenAt: latest ? new Date(latest.lastSeenMs).toISOString() : null,
                    version: latest?.version ?? null,
                    os: latest?.os ?? null,
                };
            }),
        };
    });

    app.post("/api/admin/runners/:runnerId/retire", async (req) => {
        const actor = refuseUnlessAdmin(req);
        const { runnerId } = req.params as { runnerId: string };
        const t = svc.store.getToken(runnerId);
        if (!t || t.kind !== "personal") throw new HttpError(404, RUNNER_NOT_FOUND);
        if (!svc.store.retireToken(t.id)) throw new HttpError(409, RUNNER_RETIRED);
        note(actor, "runner-retired", `${personName(t.ownerId)}'s runner “${t.label ?? `…${t.hint}`}” was removed by an admin.`);
        return { ok: true };
    });
}
