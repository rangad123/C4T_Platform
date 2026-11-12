import type { FastifyReply, FastifyRequest } from "fastify";
import { getAgentServices } from "../agent-services.js";
import { OPEN_OWNER_ID, type EnrollmentRecord } from "../agent-store.js";
import { accessControlOf, actorOf } from "../auth/access.js";
import { actorLabel, currentActor, type Actor } from "../auth/actor.js";
import { runnerUpdatesFor } from "../runner-update.js";
import { RateLimiter } from "../agent-routing.js";
import { HttpError } from "../http-error.js";
import { mayHaveRunner } from "../runner-health.js";
import { buildInstallerExe, buildInstallerZip, installerFileName, loadInstaller, MAC_ZIP_NAME, macAppSigned, peSigned, WINDOWS_EXE_NAME, type InstallerPart, type KitKind, type LoadedInstaller } from "../runner-installer.js";
import { LINUX_SCRIPT_NAME } from "../runner-linux-script.js";
import { buildKitZip, decideAddress, DownloadRequest, kitFileName, loadBundle, type Bundle } from "../runner-kit.js";
import { buildCompleteZip, completeFileName, loadComplete, MAX_COMPLETE_AT_ONCE, targetOf, type CompleteBuild, type CompleteTarget } from "../runner-kit-complete.js";
import type { RouteCtx } from "./types.js";

/**
 * The runner download (round 45: one runner per person, set up once in Settings):
 *
 *   GET  /api/me/runner/download/info   which systems can be downloaded here, and which address the runner would connect to
 *   POST /api/me/runner/download        { os: "windows" | "mac" | "linux", arch: "x64" | "arm64" } -> the zip with this person's one-time code
 *
 * One download per system, nothing to choose: Windows gets the setup program, a Mac the app, Linux the plain files with the start scripts.
 * Each is one thing (rounds 49 and 50): Windows the program with the kit appended, a Mac a zip holding only the app with the kit inside it,
 * Linux one `ai-testing-runner.sh` with the kit at its end. A signed program or app gets the zip with the kit beside it instead.
 * The Mac app and the Linux files also carry their own Node.js and every test tool (the complete build, runner-kit-complete.ts) when this
 * server has built it for that system and processor (the Mac app is then put inside it). Windows never does: its installer finds or
 * downloads Node.js and installs the test tools with npm ci, because a complete node_modules copied into its install folder passes
 * Windows' 260-character path limit. A server without the installer for a system sends the plain files and says so (x-runner-kit-note).
 * The runner is named after the computer (runner.json holds no name).
 *
 * The zip holds a single-use code (runner.enroll), never a credential: the runner trades it once at /api/agent/enroll for this person's one
 * runner credential, which retires every older one of theirs (agent-store.ts). The answer names the code's record (x-runner-enrollment-id,
 * x-runner-enrollment-expires); GET /api/me/runner/enrollments/:id says when the runner has connected. The code is stored only as its
 * hash, so the zip holds the only copy and is never cached.
 *
 * Who may download: a signed-in person who may run tests in at least one project (the runner is theirs), and the open server (no access key,
 * nobody signed up yet), which acts as one person (OPEN_OWNER_ID). The shared access key is nobody's computer and is refused.
 */
export const KEY_CANNOT_DOWNLOAD = "Sign in with your own account to set up your runner.";
export const CANNOT_DOWNLOAD = "Setting up a runner needs permission to run tests in at least one project.";

/** What a system's one download is made of on this server. */
interface Plan {
    kind: KitKind;
    /** The installer for Windows or a Mac, when it is built here. */
    installer?: Extract<InstallerPart, { ok: true }>;
    /** The complete build (own Node.js and test tools) for this system and processor, when it is built here and current. */
    complete?: Extract<CompleteBuild, { ok: true }>;
    /** Why the download is not the installer, for Windows and Mac. */
    note?: string;
    /** What is sent: the Windows program, the zip holding only the Mac app, the Linux script, or a zip with one folder. */
    form: "exe" | "mac-app" | "linux" | "zip";
    fileName: string;
}

function planFor(req: DownloadRequest, bundle: Extract<Bundle, { ok: true }>, installers: LoadedInstaller | undefined, completes: (t: CompleteTarget) => CompleteBuild): Plan {
    // Windows never gets the complete parts: its installer installs the test tools itself (npm ci), because a complete node_modules copied
    // into the install folder runs past Windows' 260-character path limit, so they are not built for Windows, and its fallback is
    // the plain files.
    const build = req.os === "windows" ? undefined : completes(targetOf(req.os, req.arch));
    const complete = build?.ok ? build : undefined;
    const has = complete ? { complete } : {};
    if (req.os === "linux") return { kind: "files", ...has, form: "linux", fileName: LINUX_SCRIPT_NAME };
    const part = installers ? (req.os === "windows" ? installers.windows : installers.mac) : undefined;
    if (part?.ok) {
        // shortcut: a signed program or app gets the zip with the kit beside it (bytes added to it break the signature); when signing starts,
        // let the browser approve a connect code instead of a file inside the download, so every download is the same file.
        if (req.os === "windows") {
            const signed = peSigned(part.files.find((f) => f.name === WINDOWS_EXE_NAME)!.data);
            return { kind: "installer", installer: part, form: signed ? "zip" : "exe", fileName: signed ? installerFileName("windows") : WINDOWS_EXE_NAME };
        }
        if (macAppSigned(part)) return { kind: "installer", installer: part, ...has, form: "zip", fileName: complete ? completeFileName(complete.target) : installerFileName("unix") };
        return { kind: "installer", installer: part, ...has, form: "mac-app", fileName: MAC_ZIP_NAME };
    }
    const note = `${part && !part.ok ? part.reason : ""} The plain files were sent instead.`.trim();
    return { kind: "files", ...has, note, form: "zip", fileName: complete ? completeFileName(complete.target) : kitFileName(req.os === "windows" ? "windows" : "unix") };
}

export function registerRunnerKitRoutes(ctx: RouteCtx): void {
    const { app, p } = ctx;
    const svc = getAgentServices(p);
    const control = accessControlOf(app);
    // A few downloads a minute is plenty for a person; the limit stops a script from filling the code table.
    const perMinute = Math.max(1, Number(process.env.RUNNER_KIT_RATE_PER_MINUTE) || 5);
    const limiter = new RateLimiter(perMinute, 60_000);
    // Downloads with their own Node.js streaming right now (each is 50 to 70 MB read from disk); see MAX_COMPLETE_AT_ONCE.
    let completeStreaming = 0;

    const addressOf = (req: { protocol: string; headers: { host?: string | undefined } }) => decideAddress({ publicUrl: p.config.PUBLIC_URL, protocol: req.protocol, host: req.headers.host });

    /** The signed-update sequence a fresh download starts from (runner-update.ts), when this server publishes signed updates. */
    const seq = (): { updateSequence?: number } => {
        const n = runnerUpdatesFor(p).downloadSequence();
        return n === undefined ? {} : { updateSequence: n };
    };

    /** Whose runner a download makes: the signed-in person, or the open server's one person. The access key and the rest are refused. */
    const ownerOf = (actor: Actor): string => {
        if (actor.kind === "open") return actor.id ?? OPEN_OWNER_ID;
        if (actor.kind === "key") throw new HttpError(403, KEY_CANNOT_DOWNLOAD);
        if (actor.kind !== "user" || !actor.id) throw new HttpError(403, KEY_CANNOT_DOWNLOAD);
        if (!mayHaveRunner(control.projects, actor)) throw new HttpError(403, CANNOT_DOWNLOAD);
        return actor.id;
    };

    app.get("/api/me/runner/download/info", async (req) => {
        const actor = actorOf(req) ?? currentActor();
        const bundle = loadBundle();
        const address = addressOf(req);
        const installers = bundle.ok ? loadInstaller() : undefined;
        // Only what Settings reads (web/src/features/runners/my-runner.ts DownloadInfo).
        const systems = (["windows", "mac", "linux"] as const).flatMap((os) =>
            (["x64", "arm64"] as const).map((arch) => {
                if (!bundle.ok) return { os, arch, available: false, reason: bundle.reason };
                const plan = planFor({ os, arch }, bundle, installers, (t) => loadComplete(t, bundle));
                return {
                    os,
                    arch,
                    available: address.urlOk,
                    fileName: plan.fileName,
                    // The size of a download that carries its own Node.js and test tools.
                    ...(plan.complete ? { bytes: plan.complete.manifest.packBytes + plan.complete.manifest.files.length * 120 + 2 * 1024 * 1024 } : {}),
                    ...(plan.note ? { note: plan.note } : {}),
                    ...(!address.urlOk && address.urlWarning ? { reason: address.urlWarning } : {}),
                };
            }),
        );
        let mayDownload = true;
        let refusal: string | undefined;
        try {
            ownerOf(actor);
        } catch (e) {
            mayDownload = false;
            refusal = e instanceof HttpError ? e.message : CANNOT_DOWNLOAD;
        }
        return {
            available: bundle.ok,
            ...(bundle.ok ? {} : { reason: bundle.reason }),
            urlOk: address.urlOk,
            ...(address.urlWarning ? { urlWarning: address.urlWarning } : {}),
            mayDownload,
            ...(refusal ? { refusal } : {}),
            systems,
        };
    });

    app.post("/api/me/runner/download", async (req, reply) => {
        const actor = actorOf(req) ?? currentActor();
        const ownerId = ownerOf(actor);
        const parsed = DownloadRequest.safeParse(req.body ?? {});
        if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Choose the system (windows, mac or linux) and the processor (x64 or arm64).");
        const request = parsed.data;
        if (!limiter.take(`me:${ownerId}`)) throw new HttpError(429, "Too many runner downloads were made just now. Wait a minute and try again.");
        const bundle = loadBundle();
        if (!bundle.ok) throw new HttpError(503, bundle.reason);
        const address = addressOf(req);
        if (!address.platformUrl) throw new HttpError(409, address.urlWarning ?? "The platform could not tell which address it is reached at. Set PUBLIC_URL.");
        const plan = planFor(request, bundle, loadInstaller(), (t) => loadComplete(t, bundle));
        if (plan.complete && completeStreaming >= MAX_COMPLETE_AT_ONCE) throw new HttpError(429, "Several runner downloads are being sent right now. Try again in a minute.");
        // The download carries a single-use code, never a runner credential: the runner trades it at first contact.
        const enrollment = svc.store.createPersonalEnrollment({ ownerId, createdBy: actorLabel(actor) });
        control.users.addActivity({ actorKind: actor.kind, actorId: actor.id ?? null, actorName: actor.name, action: "runner-download", detail: `The runner was downloaded for ${request.os} ${request.arch}.`, projectId: null });
        return send(req, reply, { request, plan, bundle, platformUrl: address.platformUrl, enrollment });
    });

    /** The zip with runner.enroll: streamed when it carries its own Node.js, else built in memory. A zip that cannot be built uses up its code. */
    function send(
        req: FastifyRequest,
        reply: FastifyReply,
        k: { request: DownloadRequest; plan: Plan; bundle: Extract<Bundle, { ok: true }>; platformUrl: string; enrollment: { code: string; record: EnrollmentRecord } },
    ) {
        const { request, plan, bundle, enrollment } = k;
        const platform = request.os === "windows" ? "windows" : "unix";
        const common = {
            "x-runner-enrollment-id": enrollment.record.id,
            "x-runner-enrollment-expires": new Date(enrollment.record.expiresMs).toISOString(),
            "x-runner-kit-kind": plan.kind,
            "cache-control": "no-store",
            "access-control-expose-headers": "x-runner-enrollment-id, x-runner-enrollment-expires, content-disposition, x-runner-kit-kind, x-runner-kit-note, x-runner-kit-target, content-length",
        };
        const logged = (what: string) => req.log.info({ audit: "runner-downloaded", enrollmentId: enrollment.record.id, kind: what }, "runner downloaded");
        const failed = (): never => {
            // Nothing was handed out, so the code must not stay usable.
            svc.store.expireEnrollment(enrollment.record.id);
            throw new HttpError(500, "The runner download could not be built. Try again.");
        };
        // Header values are single-line ASCII; the sentence is plain English without quotes or line breaks.
        if (plan.note) reply.header("x-runner-kit-note", plan.note.replace(/[^ -~]/g, " "));
        if (plan.complete || plan.form === "mac-app" || plan.form === "linux") {
            const target = plan.complete?.target;
            if (plan.form === "zip" && plan.installer && request.os === "mac") req.log.info({ enrollmentId: enrollment.record.id }, "the Mac app is signed: sending the zip with the kit beside it");
            let zip: ReturnType<typeof buildCompleteZip> | undefined;
            try {
                const layout = plan.form === "mac-app" ? "mac-app" : plan.form === "linux" ? "linux" : "folder";
                zip = buildCompleteZip({ bundle, ...(plan.complete ? { build: plan.complete } : {}), ...(plan.installer ? { installer: plan.installer } : {}), layout, platformUrl: k.platformUrl, enrollCode: enrollment.code, ...seq() });
            } catch {
                failed();
            }
            const stream = zip!.stream;
            logged(`${request.os} ${request.arch}, ${plan.kind}, ${plan.form}${target ? ", own Node.js" : ""}`);
            if (plan.complete) {
                completeStreaming++;
                let released = false;
                const release = (): void => {
                    if (!released) {
                        released = true;
                        completeStreaming--;
                    }
                };
                stream.once("close", release);
                stream.once("end", release);
                stream.once("error", release);
            }
            return reply
                .headers(common)
                .header("content-type", plan.form === "linux" ? "application/x-sh" : "application/zip")
                .header("content-length", String(zip!.bytes))
                .header("content-disposition", `attachment; filename="${plan.fileName}"`)
                .headers(target ? { "x-runner-kit-target": target } : {})
                .send(stream);
        }
        let zip: Uint8Array | undefined;
        try {
            const base = { bundle, platformUrl: k.platformUrl, enrollCode: enrollment.code, ...seq() };
            // Windows (round 49): the setup program itself with the kit appended; a signed program gets the zip (runner-installer.ts).
            if (plan.installer && platform === "windows" && plan.form === "zip") req.log.info({ enrollmentId: enrollment.record.id }, "the Windows installer is signed: sending the zip");
            if (plan.installer && request.os === "mac") req.log.info({ enrollmentId: enrollment.record.id }, "the Mac app is signed: sending the zip with the kit beside it");
            zip = plan.form === "exe" ? buildInstallerExe({ ...base, part: plan.installer!, platform }) : plan.installer ? buildInstallerZip({ ...base, part: plan.installer, platform }) : buildKitZip({ ...base, request: { platform } });
            if (!zip) throw new Error("the program could not be stamped");
        } catch {
            failed();
        }
        logged(`${request.os} ${request.arch}, ${plan.kind}, ${plan.form}`);
        return reply
            .headers(common)
            .header("content-type", plan.form === "exe" ? "application/vnd.microsoft.portable-executable" : "application/zip")
            .header("content-disposition", `attachment; filename="${plan.fileName}"`)
            .send(Buffer.from(zip!));
    }
}
