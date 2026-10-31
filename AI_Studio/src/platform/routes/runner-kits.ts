import { getAgentServices } from "../agent-services.js";
import { RateLimiter } from "../agent-routing.js";
import { CustomScriptStore } from "../custom-script-store.js";
import { HttpError } from "../http-error.js";
import { buildInstallerZip, installerFileName, installerInfo, loadInstaller, type KitKind } from "../runner-installer.js";
import { buildKitZip, decideAddress, kitFileName, KitRequest, loadBundle, maxTokensFrom, NODE_MIN_MAJOR, projectSlugOf, runnerLimitMessage } from "../runner-kit.js";
import { buildCompleteZip, completeFileName, completeInfo, loadComplete, MAX_COMPLETE_AT_ONCE, targetOf } from "../runner-kit-complete.js";
import type { RouteCtx } from "./types.js";

/**
 * Runner kit routes: a zip the tester downloads and double-clicks, so a runner needs no checkout of the repository.
 *
 *   GET  /api/projects/:id/runner-kits/info   can a kit be built here, and which address would it connect to
 *   POST /api/projects/:id/runner-kits        { name, platform, kind? } -> the zip; makes a NEW project token and puts it inside
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
 * Both are ordinary API-key routes (the server's hook protects everything outside the six agent-protocol routes). The token made here
 * is a normal project token: it appears in GET /api/projects/:id/agent-tokens under the runner's name and is revoked there. The
 * platform stores only its hash, so the zip holds the only copy and is never cached.
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
        const parsed = KitRequest.safeParse(req.body ?? {});
        if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "The runner name or system is not valid.");
        const request = parsed.data;

        if (!limiter.take(id)) throw new HttpError(429, "Too many runner kits were downloaded just now. Wait a minute and try again.");
        const bundle = loadBundle();
        if (!bundle.ok) throw new HttpError(503, bundle.reason);
        const address = addressOf(req);
        if (!address.platformUrl) throw new HttpError(409, address.urlWarning ?? "The platform could not tell which address it is reached at. Set PUBLIC_URL.");
        const max = maxTokensFrom();
        if (svc.store.countActiveTokens(id) >= max) throw new HttpError(409, runnerLimitMessage(max));

        // The complete download (its own Node.js and packages). A missing build is a 503 with the build command; the plain kit stays available.
        if (request.complete) {
            const target = targetOf(request.platform === "windows" ? "windows" : request.os === "linux" ? "linux" : "mac", request.arch!);
            const build = loadComplete(target, bundle);
            if (!build.ok) throw new HttpError(503, build.reason);
            if (completeStreaming >= MAX_COMPLETE_AT_ONCE) throw new HttpError(429, "Several complete runner downloads are running right now. Try again in a minute.");
            // The installer program goes in too when this server has one for that system: the double-click alternative to the start script.
            const installers = target.startsWith("linux") ? undefined : loadInstaller();
            const part = installers ? (target.startsWith("win") ? installers.windows : installers.mac) : undefined;
            const { secret, record } = svc.store.createToken(id, request.name);
            let zip: ReturnType<typeof buildCompleteZip>;
            try {
                zip = buildCompleteZip({ bundle, build, ...(part?.ok ? { installer: part } : {}), runnerName: request.name, projectName: String(project.name), projectSlug: projectSlugOf(String(project.name)), platformUrl: address.platformUrl, token: secret });
            } catch {
                svc.store.revokeToken(id, record.id);
                throw new HttpError(500, "The runner kit could not be built. Try again.");
            }
            new CustomScriptStore(ctx.repo.db).audit(id, null, "runner-kit-downloaded", `Runner kit downloaded for “${request.name}” (${target}, complete); token …${record.hint}`);
            req.log.info({ audit: "runner-kit-downloaded", projectId: id, tokenId: record.id, kind: "complete", target }, "runner kit downloaded");
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
                .header("content-type", "application/zip")
                .header("content-length", String(zip.bytes))
                .header("content-disposition", `attachment; filename="${completeFileName(projectSlugOf(String(project.name)), target)}"`)
                .header("x-runner-token-id", record.id)
                .header("x-runner-kit-kind", "complete")
                .header("x-runner-kit-target", target)
                .header("access-control-expose-headers", "x-runner-token-id, content-disposition, x-runner-kit-kind, x-runner-kit-note, x-runner-kit-target, content-length")
                .header("cache-control", "no-store")
                .send(zip.stream);
        }

        // Installer or plain files? An installer that is not available here becomes the plain files kit, and the answer says so.
        const wanted: KitKind = request.kind ?? (request.platform === "windows" ? "installer" : "files");
        const installers = wanted === "installer" ? loadInstaller() : undefined;
        const part = installers ? (request.platform === "windows" ? installers.windows : installers.mac) : undefined;
        const kind: KitKind = part?.ok ? "installer" : "files";
        const fallbackNote = wanted === "installer" && !part?.ok ? `${part && !part.ok ? part.reason : ""} A plain files kit was made instead.`.trim() : undefined;

        // The token's label is the runner's name, so it can be recognised in the token list and revoked there.
        const { secret, record } = svc.store.createToken(id, request.name);
        let zip: Uint8Array;
        try {
            const common = { bundle, projectName: String(project.name), projectSlug: projectSlugOf(String(project.name)), platformUrl: address.platformUrl, token: secret };
            zip = part?.ok ? buildInstallerZip({ ...common, part, platform: request.platform, runnerName: request.name }) : buildKitZip({ ...common, request });
        } catch {
            // Nothing was handed out, so the token must not stay valid.
            svc.store.revokeToken(id, record.id);
            throw new HttpError(500, "The runner kit could not be built. Try again.");
        }
        // The platform has no general audit log; hand-written-test audit rows are per project and not tied to a test (reusable steps use them the same way).
        new CustomScriptStore(ctx.repo.db).audit(id, null, "runner-kit-downloaded", `Runner kit downloaded for “${request.name}” (${request.platform}, ${kind === "installer" ? "installer" : "plain files"}); token …${record.hint}`);
        // The token itself is never logged: only the id of its record.
        req.log.info({ audit: "runner-kit-downloaded", projectId: id, tokenId: record.id, kind }, "runner kit downloaded");
        const slug = projectSlugOf(String(project.name));
        // Header values are single-line ASCII; the sentence is plain English without quotes or line breaks.
        if (fallbackNote) reply.header("x-runner-kit-note", fallbackNote.replace(/[^ -~]/g, " "));
        return reply
            .header("content-type", "application/zip")
            .header("content-disposition", `attachment; filename="${kind === "installer" ? installerFileName(slug, request.platform) : kitFileName(slug, request.platform)}"`)
            .header("x-runner-token-id", record.id)
            .header("x-runner-kit-kind", kind)
            .header("access-control-expose-headers", "x-runner-token-id, content-disposition, x-runner-kit-kind, x-runner-kit-note")
            .header("cache-control", "no-store")
            .send(Buffer.from(zip));
    });
}
