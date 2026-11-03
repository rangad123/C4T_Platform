/**
 * The app a project tests, by platform (round 37, migration slot 47):
 *
 *   - Web: the application address. It is the project's latest application row, as before (nothing new is stored for it).
 *   - Android: an uploaded .apk (the Mobile app setting, `apkPath`, as before) or a Google Play link.
 *   - iOS: an uploaded .ipa or an App Store link.
 *
 * The store links and the uploaded .ipa are new and live in `project_app_details`. An uploaded app is only stored: the server never
 * opens, installs or runs it (a runner on a Mac, or a phone, does that). Links are checked to be the real store's https address and
 * are stored in one normal form, so nothing else (another host, credentials, a port, a script) can be saved as a "store link".
 */
import type { Db } from "./db.js";

export const PROJECT_APP_MIGRATION = `
-- One row per project that has a store link or an uploaded iPhone app. The web address and the Android .apk stay where they were.
CREATE TABLE project_app_details (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    play_store_url TEXT,
    app_store_url TEXT,
    ios_app_name TEXT,
    ios_app_bytes INTEGER,
    ios_app_uploaded_at TEXT,
    updated_at TEXT NOT NULL
);
`;

/** The largest .ipa accepted (the same as an .apk). */
export const MAX_IPA_BYTES = 512 * 1024 * 1024;
/** Where an uploaded .ipa is kept in the object store (one per project; a new upload replaces it). */
export const ipaKey = (projectId: string) => `${projectId}/_apps/app.ipa`;

export const PLAY_LINK_PROBLEM = "A Google Play link looks like https://play.google.com/store/apps/details?id=com.example.app.";
export const APP_STORE_LINK_PROBLEM = "An App Store link looks like https://apps.apple.com/app/id123456789 (the country and the app's name may be in it too).";
export const NOT_AN_IPA = "That doesn't look like an iPhone app (.ipa) file.";

const ANDROID_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** The URL as typed, when it is plain https with no credentials or port; otherwise null. */
function httpsUrl(raw: string): URL | null {
    const text = raw.trim();
    if (!text || text.length > 500) return null;
    let u: URL;
    try {
        u = new URL(text);
    } catch {
        return null;
    }
    if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
    return u;
}

/** A Google Play link, stored as `https://play.google.com/store/apps/details?id=<package>`, with the package it names. */
export function playStoreLink(raw: string): { url: string; appPackage: string } | { error: string } {
    const u = httpsUrl(raw);
    if (!u || u.hostname.toLowerCase() !== "play.google.com" || u.pathname.replace(/\/+$/, "") !== "/store/apps/details") return { error: PLAY_LINK_PROBLEM };
    const id = u.searchParams.get("id") ?? "";
    if (id.length > 200 || !ANDROID_PACKAGE.test(id)) return { error: PLAY_LINK_PROBLEM };
    return { url: `https://play.google.com/store/apps/details?id=${id}`, appPackage: id };
}

/** An App Store link, stored as `https://apps.apple.com[/<country>]/app/id<number>`, with the App Store id. */
export function appStoreLink(raw: string): { url: string; appStoreId: string } | { error: string } {
    const u = httpsUrl(raw);
    if (!u || u.hostname.toLowerCase() !== "apps.apple.com") return { error: APP_STORE_LINK_PROBLEM };
    const m = /^\/(?:([a-z]{2})\/)?app\/(?:([a-z0-9%._~-]{1,200})\/)?id(\d{3,15})\/?$/i.exec(u.pathname);
    if (!m) return { error: APP_STORE_LINK_PROBLEM };
    // The app's name in the link is left out: the country and the id open the same page, and nothing typed is kept.
    const [, country, , appStoreId] = m;
    return { url: `https://apps.apple.com${country ? `/${country.toLowerCase()}` : ""}/app/id${appStoreId}`, appStoreId: appStoreId! };
}

/**
 * Is this an iPhone app archive? An .ipa is a zip whose entries sit under `Payload/<Name>.app/`, with the app's Info.plist. The
 * names are read from the zip's local headers as bytes; nothing is unpacked or run.
 */
export function looksLikeIpa(data: Buffer): boolean {
    if (data.length < 100 || data.readUInt32LE(0) !== 0x04034b50) return false;
    const text = data.subarray(0, Math.min(data.length, 64 * 1024 * 1024)).toString("latin1");
    return /Payload\/[^/\0]{1,200}\.app\//.test(text) && text.includes("Info.plist");
}

/** A file name safe to show: its last part, printable, at most 120 characters. */
export function shownFileName(name: string, fallback: string): string {
    const base = name.split(/[\\/]/).pop() ?? "";
    const clean = base.replace(/[^\w .()+-]/g, "").trim().slice(0, 120);
    return clean || fallback;
}

export interface AppDetailsRow {
    playStoreUrl: string | null;
    appStoreUrl: string | null;
    iosApp: { name: string; bytes: number; uploadedAt: string } | null;
}

const EMPTY: AppDetailsRow = { playStoreUrl: null, appStoreUrl: null, iosApp: null };

export class ProjectAppStore {
    constructor(private readonly db: Db) {}

    get(projectId: string): AppDetailsRow {
        const r = this.db.get<{ play_store_url: string | null; app_store_url: string | null; ios_app_name: string | null; ios_app_bytes: number | null; ios_app_uploaded_at: string | null }>(
            "SELECT play_store_url, app_store_url, ios_app_name, ios_app_bytes, ios_app_uploaded_at FROM project_app_details WHERE project_id = ?",
            projectId,
        );
        if (!r) return { ...EMPTY };
        return {
            playStoreUrl: r.play_store_url ?? null,
            appStoreUrl: r.app_store_url ?? null,
            iosApp: r.ios_app_name ? { name: r.ios_app_name, bytes: Number(r.ios_app_bytes ?? 0), uploadedAt: r.ios_app_uploaded_at ?? "" } : null,
        };
    }

    /** Changes what is given (null clears it) and leaves the rest. */
    set(projectId: string, patch: { playStoreUrl?: string | null; appStoreUrl?: string | null; iosApp?: { name: string; bytes: number } | null }): AppDetailsRow {
        const cur = this.get(projectId);
        const t = new Date().toISOString();
        const next = {
            play: patch.playStoreUrl === undefined ? cur.playStoreUrl : patch.playStoreUrl,
            store: patch.appStoreUrl === undefined ? cur.appStoreUrl : patch.appStoreUrl,
            ios: patch.iosApp === undefined ? cur.iosApp : patch.iosApp ? { ...patch.iosApp, uploadedAt: t } : null,
        };
        this.db.tx(() => {
            this.db.run("DELETE FROM project_app_details WHERE project_id = ?", projectId);
            this.db.run(
            "INSERT INTO project_app_details (project_id, play_store_url, app_store_url, ios_app_name, ios_app_bytes, ios_app_uploaded_at, updated_at) VALUES (?,?,?,?,?,?,?)",
            projectId,
            next.play,
            next.store,
            next.ios?.name ?? null,
            next.ios?.bytes ?? null,
            next.ios?.uploadedAt ?? null,
            t,
            );
        });
        return this.get(projectId);
    }
}
