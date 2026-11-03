/**
 * The app a project tests (round 37; project-app.ts):
 *
 *   GET  /api/projects/:id/app-details            → { webUrl, android: { apk, appPackage, playStoreUrl }, ios: { ipa, bundleId, appStoreUrl } }
 *   PUT  /api/projects/:id/app-details            { webUrl?, playStoreUrl?, appStoreUrl?, clearIpa? } → the same answer
 *   POST /api/projects/:id/app-details/ipa?filename=   the .ipa as the raw body → the same answer
 *
 * The .apk keeps its own upload (POST /api/projects/:id/mobile-app/apk). A Google Play link also sets the Android package when none
 * is set yet, since the link names it. Uploaded apps are stored and never opened or run on the server.
 */
import { z } from "zod";
import { isAppUri } from "../../engine/desktop/target.js";
import type { MobileTarget } from "../../engine/mobile/target.js";
import type { Platform } from "../bootstrap.js";
import type { Row } from "../db.js";
import { HttpError } from "../http-error.js";
import { assertAllowedTarget } from "../net-guard.js";
import { appStoreLink, ipaKey, looksLikeIpa, MAX_IPA_BYTES, NOT_AN_IPA, playStoreLink, ProjectAppStore, shownFileName } from "../project-app.js";
import type { Repo } from "../repo.js";
import type { FastifyInstance } from "fastify";
import { parsePlain } from "./project-settings.js";

export interface ProjectAppDeps {
    app: FastifyInstance;
    p: Platform;
    repo: Repo;
    project(id: string): Row;
    assertNoActiveJob(projectId: string): Promise<void>;
    latestMobile(projectId: string): MobileTarget | undefined;
    /** Saves the Mobile app setting as a new application row (server.ts). */
    saveMobile(projectId: string, next: Partial<MobileTarget>): Promise<unknown>;
    /** Makes `url` the project's application address (a new application row; sign-in details kept on the same site). */
    setWebAddress(projectId: string, url: string): Promise<void>;
}

export const WEB_URL_PROBLEM = "Enter the application's address, starting with http:// or https://.";

/** A web address as the form sends it: http(s) only, checked against the platform's address rules before anything is saved. */
export async function checkedWebUrl(raw: string): Promise<string> {
    let u: URL;
    try {
        u = new URL(raw.trim());
    } catch {
        throw new HttpError(400, WEB_URL_PROBLEM);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(400, WEB_URL_PROBLEM);
    if (u.username || u.password) throw new HttpError(400, "The address must not contain a user name or password. Put sign-in details in the project's test accounts instead.");
    await assertAllowedTarget(u.href);
    return u.href;
}

/** The app details of a create or update request, checked: each is undefined (leave), null (clear) or the normal form. */
export const AppDetailsBody = z.object({
    webUrl: z.string().max(2000).optional(),
    playStoreUrl: z.string().max(500).nullable().optional(),
    appStoreUrl: z.string().max(500).nullable().optional(),
});
export type AppDetailsInput = z.infer<typeof AppDetailsBody>;

export async function checkedAppDetails(body: AppDetailsInput): Promise<{ webUrl?: string; play?: { url: string; appPackage: string } | null; appStore?: string | null }> {
    const out: { webUrl?: string; play?: { url: string; appPackage: string } | null; appStore?: string | null } = {};
    if (body.webUrl !== undefined && body.webUrl.trim()) out.webUrl = await checkedWebUrl(body.webUrl);
    if (body.playStoreUrl !== undefined) {
        if (body.playStoreUrl === null || !body.playStoreUrl.trim()) out.play = null;
        else {
            const r = playStoreLink(body.playStoreUrl);
            if ("error" in r) throw new HttpError(400, r.error);
            out.play = r;
        }
    }
    if (body.appStoreUrl !== undefined) {
        if (body.appStoreUrl === null || !body.appStoreUrl.trim()) out.appStore = null;
        else {
            const r = appStoreLink(body.appStoreUrl);
            if ("error" in r) throw new HttpError(400, r.error);
            out.appStore = r.url;
        }
    }
    return out;
}

export function registerProjectAppRoutes(d: ProjectAppDeps) {
    const { app, p, repo, project } = d;
    const store = new ProjectAppStore(p.db);

    const answer = (projectId: string) => {
        const row = store.get(projectId);
        const m = d.latestMobile(projectId);
        const url = repo.getLatestApplicationPublic(projectId)?.url as string | undefined;
        return {
            webUrl: url && !isAppUri(url) && /^https?:/i.test(url) ? url : null,
            android: { apk: m?.apkPath ? (m.apkPath.split(/[\\/]/).pop() ?? "app.apk") : null, appPackage: m?.appPackage ?? null, playStoreUrl: row.playStoreUrl },
            ios: { ipa: row.iosApp, bundleId: m?.iosBundleId ?? null, appStoreUrl: row.appStoreUrl },
        };
    };

    /** Saves checked details (create and update share this). */
    const apply = async (projectId: string, c: Awaited<ReturnType<typeof checkedAppDetails>>) => {
        if (c.webUrl) await d.setWebAddress(projectId, c.webUrl);
        if (c.play !== undefined || c.appStore !== undefined) store.set(projectId, { ...(c.play !== undefined ? { playStoreUrl: c.play?.url ?? null } : {}), ...(c.appStore !== undefined ? { appStoreUrl: c.appStore } : {}) });
        // The link names the Android package: use it when the project has none yet (a package already set is never replaced).
        if (c.play) {
            const m = d.latestMobile(projectId);
            if (!m?.appPackage) await d.saveMobile(projectId, { ...(m ?? {}), appPackage: c.play.appPackage });
        }
    };

    app.get("/api/projects/:id/app-details", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        return answer(id);
    });

    app.put("/api/projects/:id/app-details", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        const body = parsePlain(AppDetailsBody.extend({ clearIpa: z.boolean().optional() }).strict(), req.body);
        const checked = await checkedAppDetails(body);
        await apply(id, checked);
        if (body.clearIpa) {
            await p.store.delete(ipaKey(id)).catch(() => false);
            store.set(id, { iosApp: null });
        }
        return answer(id);
    });

    app.post("/api/projects/:id/app-details/ipa", { bodyLimit: MAX_IPA_BYTES }, async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        await d.assertNoActiveJob(id);
        const { filename } = z.object({ filename: z.string().max(200).default("app.ipa") }).parse(req.query);
        if (!/\.ipa$/i.test(filename)) throw new HttpError(400, "The file name must end in .ipa");
        const data = req.body as Buffer;
        if (!Buffer.isBuffer(data) || !looksLikeIpa(data)) throw new HttpError(400, NOT_AN_IPA);
        await p.store.put(ipaKey(id), data, { contentType: "application/octet-stream" });
        store.set(id, { iosApp: { name: shownFileName(filename, "app.ipa"), bytes: data.length } });
        return answer(id);
    });

    return { apply };
}
