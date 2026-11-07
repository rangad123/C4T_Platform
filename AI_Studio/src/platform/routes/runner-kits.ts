import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getAgentServices } from "../agent-services.js";
import type { EnrollmentRecord } from "../agent-store.js";
import { actorOf } from "../auth/access.js";
import { actorLabel, currentActor } from "../auth/actor.js";
import { enrollmentMakerOf } from "./runners.js";
import { runnerUpdatesFor } from "../runner-update.js";
import { RateLimiter } from "../agent-routing.js";
import { CustomScriptStore } from "../custom-script-store.js";
import { HttpError } from "../http-error.js";
import { assertMayAddRunner } from "../runner-health.js";
import { buildInstallerZip, installerFileName, installerInfo, loadInstaller, type KitKind } from "../runner-installer.js";
import { buildKitZip, decideAddress, kitFileName, KitRequest, loadBundle, maxTokensFrom, NODE_MIN_MAJOR, projectSlugOf, runnerLimitMessage } from "../runner-kit.js";
import { buildCompleteZip, completeFileName, completeInfo, loadComplete, MAX_COMPLETE_AT_ONCE, targetOf } from "../runner-kit-complete.js";
import type { RouteCtx } from "./types.js";

/**
 * Runner kit routes: a zip the tester downloads and double-clicks, so a runner needs no checkout of the repository.
 *
 *   GET  /api/projects/:id/runner-kits/info   can a kit be built here, and which address would it connect to
 *   POST /api/projects/:id/runner-kits        { name, platform, kind? } -> the zip with a single-use enrollment code (runner.enroll) for a team
 *                                             runner registered from the project; the runner trades it for its credential at first contact
 *   POST /api/runners/kits                    { runner: "personal" | "team", organizationId?, projectIds?, name, platform, kind?, ... } -> the
 *                                             same zip from the Runners page: this person's own computer, or a team runner (round 39)
 *
 * No download carries a runner credential (round 39). The answer names the code's record (x-runner-enrollment-id, x-runner-enrollment-expires);
 * GET /api/runners/enrollments/:id says when the runner has connected.
 *
 * `kind` is "installer" (the setup program on Windows, the app on a Mac; see runner-installer.ts) or "files" (the plain zip with the start
 * scripts). Without it Windows gets the installer and Mac/Linux the plain files. An installer that was not built on this server falls back
 * to the plain files, and the answer says so in x-runner-kit-kind and x-runner-kit-note.
 *
 * `complete: true` with `arch` ("x64" | "arm64", and `os` "mac" | "linux" for platform "unix") is the complete download: its own Node.js
 * and every package for that system and processor (runner-kit-complete.ts), streamed with its length, x-runner-kit-kind: complete and
 * x-runner-kit-target. Without that build on the server it is a 503 with the build command (no fallback: the person chose it for its size
 * and the panel offers the other ways). The info answer gains `complete.targets` (available, approximate bytes, Node.js version).
 *
 * Both are ordinary API-key routes (the server's hook protects everything outside the agent-protocol routes). The code is stored only as its
 * hash, so the zip holds the only copy and is never cached; once traded, the runner appears on the Runners page and is retired there.
 */
export function registerRunnerKitRoutes(ctx: RouteCtx): void {
    const { app, p } = ctx;
    const svc = getAgentServices(p);
    // A few downloads a minute for a project is plenty for a person; the limit stops a script from filling the token list.
    const perMinute = Math.max(1, Number(process.env.RUNNER_KIT_RATE_PER_MINUTE) || 5);
    const limiter = new RateLimiter(perMinute, 60_000);
    // Complete downloads streaming right now (each is 50 to 70 MB read from disk); see MAX_COMPLETE_AT_ONCE.
    let completeStreaming = 0;

    const addressOf = (req: { protocol: string; headers: { host?: string | undefined } }) => decideAddress({ publicUrl: p.config.PUBLIC_URL, protocol: req.protocol, host: req.headers.host });

    /** The signed-update sequence a fresh download starts from (runner-update.ts), when this server publishes signed updates. */
    const seq = (): { updateSequence?: number } => {
        const n = runnerUpdatesFor(p).downloadSequence();
        return n === undefined ? {} : { updateSequence: n };
    };

    /** What the download panels need to know: is a kit built here, which address it connects to, the installer and complete builds. */
    const kitInfo = (req: FastifyRequest) => {
        const bundle = loadBundle();
        const address = addressOf(req);
        return {
            available: bundle.ok,
            ...(bundle.ok ? { kitVersion: bundle.manifest.kitVersion } : { reason: bundle.reason }),
            platformUrl: address.platformUrl,
            urlOk: address.urlOk,
            ...(address.urlWarning ? { urlWarning: address.urlWarning } : {}),
            nodeMin: NODE_MIN_MAJOR,
            installer: installerInfo(),
            complete: completeInfo(bundle),
        };
    };

    // The Runners page's "Add this computer" and "Add a team runner" (round 39): the same answer, with no project and no per-project limit.
    app.get("/api/runners/kits/info", async (req) => ({ ...kitInfo(req), maxRunners: null, activeRunners: null }));

    app.get("/api/projects/:id/runner-kits/info", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const bundle = loadBundle();
        const address = addressOf(req);
        return {
            available: bundle.ok,
            ...(bundle.ok ? { kitVersion: bundle.manifest.kitVersion } : { reason: bundle.reason }),
            platformUrl: address.platformUrl,
            urlOk: address.urlOk,
            ...(address.urlWarning ? { urlWarning: address.urlWarning } : {}),
            nodeMin: NODE_MIN_MAJOR,
            installer: installerInfo(),
            complete: completeInfo(bundle),
            // One runner per project by default: the UI hides "Add a runner" and says to remove the current one once this many exist.
            maxRunners: maxTokensFrom(),
            activeRunners: svc.store.countActiveTokens(id),
        };
    });

    app.post("/api/projects/:id/runner-kits", async (req, reply) => {
        const { id } = req.params as { id: string };
        const project = ctx.project(id);
        // A team runner registered from the project: the same rule as registering a runner on the Runners page.
        assertMayAddRunner(app, req, svc.store, (project.organization_id as string | null) ?? null);
        const parsed = KitRequest.safeParse(req.body ?? {});
        if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "The runner name or system is not valid.");
        const request = parsed.data;
        if (!limiter.take(id)) throw new HttpError(429, "Too many runner kits were downloaded just now. Wait a minute and try again.");
        const max = maxTokensFrom();
        if (svc.store.countActiveTokens(id) >= max) throw new HttpError(409, runnerLimitMessage(max));
        const prepared = prepare(req, request);
        // The download carries a single-use enrollment code, never a runner credential (round 39): the runner trades it at first contact.
        const actor = actorOf(req) ?? currentActor();
        const enrollment = svc.store.createEnrollment({ kind: "team", organizationId: (project.organization_id as string | null) ?? null, projectId: id, label: request.name, createdBy: actorLabel(actor), createdById: actor.id ?? null });
        return sendKit(req, reply, { ...prepared, request, enrollment, projectName: String(project.name), slug: projectSlugOf(String(project.name)), auditProject: id });
    });

    // A kit from the Runners page (round 39): for this person's own computer, or a team runner of an organisation, with no project needed.
    const RunnerKitBody = z.object({ runner: z.enum(["personal", "team"]), organizationId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable().optional(), projectIds: z.array(z.string().trim().min(1).max(64)).max(50).optional() }).passthrough();
    app.post("/api/runners/kits", async (req, reply) => {
        const outer = RunnerKitBody.safeParse(req.body ?? {});
        if (!outer.success) throw new HttpError(400, "Say whose runner this is: runner is personal or team.");
        const { runner, organizationId, projectIds, ...rest } = outer.data;
        const parsed = KitRequest.safeParse(rest);
        if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "The runner name or system is not valid.");
        const request = parsed.data;
        const actor = actorOf(req) ?? currentActor();
        if (!limiter.take(`runners:${actor.id ?? actor.kind}`)) throw new HttpError(429, "Too many runner kits were downloaded just now. Wait a minute and try again.");
        const make = enrollmentMakerOf(app);
        if (!make) throw new HttpError(503, "Runner downloads are not available on this server.");
        const prepared = prepare(req, request);
        const enrollment = make(req, { kind: runner, label: request.name, ...(organizationId !== undefined ? { organizationId } : {}), ...(projectIds ? { projectIds } : {}) });
        return sendKit(req, reply, { ...prepared, request, enrollment, projectName: runner === "personal" ? "your own runs" : "your team", slug: runner === "personal" ? "my-computer" : "team", auditProject: null });
    });

    /** What every download needs before a code is made: the runner bundle, the address it connects to, and the complete build when asked for. */
    function prepare(req: FastifyRequest, request: KitRequest) {
        const bundle = loadBundle();
        if (!bundle.ok) throw new HttpError(503, bundle.reason);
        const address = addressOf(req);
        if (!address.platformUrl) throw new HttpError(409, address.urlWarning ?? "The platform could not tell which address it is reached at. Set PUBLIC_URL.");
        if (!request.complete) return { bundle, platformUrl: address.platformUrl };
        const target = targetOf(request.platform === "windows" ? "windows" : request.os === "linux" ? "linux" : "mac", request.arch!);
        const build = loadComplete(target, bundle);
        if (!build.ok) throw new HttpError(503, build.reason);
        if (completeStreaming >= MAX_COMPLETE_AT_ONCE) throw new HttpError(429, "Several complete runner downloads are running right now. Try again in a minute.");
        return { bundle, platformUrl: address.platformUrl, complete: { target, build } };
    }

    /** The zip with runner.enroll: streamed for the complete download, else built in memory. A kit that cannot be built uses up its code. */
    function sendKit(
        req: FastifyRequest,
        reply: FastifyReply,
        k: ReturnType<typeof prepare> & { request: KitRequest; enrollment: { code: string; record: EnrollmentRecord }; projectName: string; slug: string; auditProject: string | null },
    ) {
        const { bundle, request, enrollment, slug } = k;
        const expires = new Date(enrollment.record.expiresMs).toISOString();
        const audit = (what: string) => {
            if (k.auditProject) new CustomScriptStore(ctx.repo.db).audit(k.auditProject, null, "runner-kit-downloaded", `Runner kit downloaded for “${request.name}” (${what}); enrollment code …${enrollment.record.hint}`);
            // The code itself is never logged: only the id of its record.
            req.log.info({ audit: "runner-kit-downloaded", projectId: k.auditProject, enrollmentId: enrollment.record.id, kind: what }, "runner kit downloaded");
        };
        const common = { "x-runner-enrollment-id": enrollment.record.id, "x-runner-enrollment-expires": expires, "cache-control": "no-store" };
        const expose = "x-runner-enrollment-id, x-runner-enrollment-expires, content-disposition, x-runner-kit-kind, x-runner-kit-note, x-runner-kit-target, content-length";
        if (k.complete) {
            const { target, build } = k.complete;
            // The installer program goes in too when this server has one for that system: the double-click alternative to the start script.
            const installers = target.startsWith("linux") ? undefined : loadInstaller();
            const part = installers ? (target.startsWith("win") ? installers.windows : installers.mac) : undefined;
            let zip: ReturnType<typeof buildCompleteZip>;
            try {
                zip = buildCompleteZip({ bundle, build, ...(part?.ok ? { installer: part } : {}), runnerName: request.name, projectName: k.projectName, projectSlug: slug, platformUrl: k.platformUrl, enrollCode: enrollment.code, ...seq() });
            } catch {
                svc.store.expireEnrollment(enrollment.record.id);
                throw new HttpError(500, "The runner kit could not be built. Try again.");
            }
            audit(`${target}, complete`);
            completeStreaming++;
            let released = false;
            const release = (): void => {
                if (!released) {
                    released = true;
                    completeStreaming--;
                }
            };
            zip.stream.once("close", release);
            zip.stream.once("end", release);
            zip.stream.once("error", release);
            return reply
                .headers(common)
                .header("content-type", "application/zip")
                .header("content-length", String(zip.bytes))
                .header("content-disposition", `attachment; filename="${completeFileName(slug, target)}"`)
                .header("x-runner-kit-kind", "complete")
                .header("x-runner-kit-target", target)
                .header("access-control-expose-headers", expose)
                .send(zip.stream);
        }
        // Installer or plain files? An installer that is not available here becomes the plain files kit, and the answer says so.
        const wanted: KitKind = request.kind ?? (request.platform === "windows" ? "installer" : "files");
        const installers = wanted === "installer" ? loadInstaller() : undefined;
        const part = installers ? (request.platform === "windows" ? installers.windows : installers.mac) : undefined;
        const kind: KitKind = part?.ok ? "installer" : "files";
        const fallbackNote = wanted === "installer" && !part?.ok ? `${part && !part.ok ? part.reason : ""} A plain files kit was made instead.`.trim() : undefined;
        let zip: Uint8Array;
        try {
            const common2 = { bundle, projectName: k.projectName, projectSlug: slug, platformUrl: k.platformUrl, enrollCode: enrollment.code, ...seq() };
            zip = part?.ok ? buildInstallerZip({ ...common2, part, platform: request.platform, runnerName: request.name }) : buildKitZip({ ...common2, request });
        } catch {
            // Nothing was handed out, so the code must not stay usable.
            svc.store.expireEnrollment(enrollment.record.id);
            throw new HttpError(500, "The runner kit could not be built. Try again.");
        }
        audit(`${request.platform}, ${kind === "installer" ? "installer" : "plain files"}`);
        // Header values are single-line ASCII; the sentence is plain English without quotes or line breaks.
        if (fallbackNote) reply.header("x-runner-kit-note", fallbackNote.replace(/[^ -~]/g, " "));
        return reply
            .headers(common)
            .header("content-type", "application/zip")
            .header("content-disposition", `attachment; filename="${kind === "installer" ? installerFileName(slug, request.platform) : kitFileName(slug, request.platform)}"`)
            .header("x-runner-kit-kind", kind)
            .header("access-control-expose-headers", expose)
            .send(Buffer.from(zip));
    }
}
