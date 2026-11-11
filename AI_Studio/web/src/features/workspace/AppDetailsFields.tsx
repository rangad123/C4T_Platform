import { Globe } from "lucide-react";
import { ApiError, api, uploadApk, uploadIpa, type AppDetails, type Platform } from "../../api";
import { FilePicker } from "../../components/ui";
import { formatBytes } from "../../lib/format";

/**
 * The app a project tests, by its platform (round 37): the address of a web application, an Android app as an .apk or its Google
 * Play link, an iPhone app as an .ipa or its App Store link. Used by Create a project and by Settings → General. The server checks
 * everything again (routes/project-app.ts): links must be the real store's https address, uploads must be real app archives.
 */
export type AppHow = "upload" | "link" | "later";

export interface AppDraft {
    webUrl: string;
    androidHow: AppHow;
    apk: File | null;
    playStoreUrl: string;
    iosHow: AppHow;
    ipa: File | null;
    appStoreUrl: string;
}

export const EMPTY_APP_DRAFT: AppDraft = { webUrl: "", androidHow: "upload", apk: null, playStoreUrl: "", iosHow: "upload", ipa: null, appStoreUrl: "" };

const PLAY_HINT = "For example https://play.google.com/store/apps/details?id=com.example.shop";
const APP_STORE_HINT = "For example https://apps.apple.com/app/id123456789";

/** What is missing or wrong before sending, in plain words; null when the draft can be sent. `required` (Create) asks for an app, or for "Add it later". */
export function appDraftProblem(platform: Platform | null, d: AppDraft, opts: { required: boolean }): string | null {
    if (platform === "web") {
        const t = d.webUrl.trim();
        if (!t) return opts.required ? "Enter the application’s address." : null;
        if (!/^https?:\/\/[^\s/]+/i.test(t)) return "The application’s address starts with http:// or https://.";
    }
    if (platform === "android") {
        if (d.androidHow === "upload" && !d.apk && opts.required) return "Choose the app’s .apk file, give its Google Play link, or choose Add it later.";
        if (d.androidHow === "upload" && d.apk && !/\.apk$/i.test(d.apk.name)) return "An Android app file ends in .apk.";
        if (d.androidHow === "link" && !/^https:\/\/play\.google\.com\//i.test(d.playStoreUrl.trim())) return `Give the app’s Google Play link. ${PLAY_HINT}.`;
    }
    if (platform === "ios") {
        if (d.iosHow === "upload" && !d.ipa && opts.required) return "Choose the app’s .ipa file, give its App Store link, or choose Add it later.";
        if (d.iosHow === "upload" && d.ipa && !/\.ipa$/i.test(d.ipa.name)) return "An iPhone app file ends in .ipa.";
        if (d.iosHow === "link" && !/^https:\/\/apps\.apple\.com\//i.test(d.appStoreUrl.trim())) return `Give the app’s App Store link. ${APP_STORE_HINT}.`;
    }
    return null;
}

/** The part of the draft sent as JSON (create body or PUT /app-details). Uploads are sent after, by `uploadAppFiles`. */
export function appDraftBody(platform: Platform | null, d: AppDraft): { webUrl?: string; playStoreUrl?: string; appStoreUrl?: string } {
    if (platform === "web" && d.webUrl.trim()) return { webUrl: d.webUrl.trim() };
    if (platform === "android" && d.androidHow === "link" && d.playStoreUrl.trim()) return { playStoreUrl: d.playStoreUrl.trim() };
    if (platform === "ios" && d.iosHow === "link" && d.appStoreUrl.trim()) return { appStoreUrl: d.appStoreUrl.trim() };
    return {};
}

/** Sends the chosen app file, if any. Throws an ApiError with the server's reason when it is refused. */
export async function uploadAppFiles(projectId: string, platform: Platform | null, d: AppDraft): Promise<void> {
    if (platform === "android" && d.androidHow === "upload" && d.apk) await uploadApk(projectId, d.apk);
    if (platform === "ios" && d.iosHow === "upload" && d.ipa) await uploadIpa(projectId, d.ipa);
}

/** Saves the draft on an existing project (Settings → General). */
export async function saveAppDraft(projectId: string, platform: Platform | null, d: AppDraft): Promise<void> {
    const body = appDraftBody(platform, d);
    if (Object.keys(body).length) await api(`/projects/${projectId}/app-details`, { method: "PUT", body });
    await uploadAppFiles(projectId, platform, d);
}

export const appErrorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

function HowChoice({ name, value, onChange, disabled, kinds }: { name: string; value: AppHow; onChange: (v: AppHow) => void; disabled?: boolean; kinds: { upload: string; link: string; later?: string } }) {
    const options: Array<[AppHow, string]> = [
        ["upload", kinds.upload],
        ["link", kinds.link],
        ...(kinds.later ? ([["later", kinds.later]] as Array<[AppHow, string]>) : []),
    ];
    return (
        <div className="row" role="radiogroup" aria-label={name} style={{ gap: 16, flexWrap: "wrap" }}>
            {options.map(([k, label]) => (
                <label key={k} className="check">
                    <input type="radio" name={name} value={k} disabled={disabled} checked={value === k} onChange={() => onChange(k)} />
                    <span>{label}</span>
                </label>
            ))}
        </div>
    );
}

/**
 * The fields for one platform. `current` (Settings) shows what is saved; `offerLater` (Create) adds "Add it later".
 */
export function AppDetailsFields({ platform, draft, onChange, current, disabled, offerLater }: { platform: Platform | null; draft: AppDraft; onChange: (d: AppDraft) => void; current?: AppDetails | null; disabled?: boolean; offerLater?: boolean }) {
    const set = (patch: Partial<AppDraft>) => onChange({ ...draft, ...patch });
    if (!platform) return null;
    if (platform === "web") {
        return (
            <div className="field" data-testid="app-web">
                <label htmlFor="app-web-url">Application URL</label>
                <p className="hint" id="app-web-url-hint">
                    The address of the website or web application to test, such as a staging copy.
                </p>
                <div className="input-wrap">
                    <Globe size={18} className="lead" aria-hidden />
                    <input id="app-web-url" className="input" type="text" inputMode="url" autoComplete="off" placeholder={current?.webUrl ?? "https://example.com"} disabled={disabled} value={draft.webUrl} onChange={(e) => set({ webUrl: e.target.value })} aria-describedby="app-web-url-hint" />
                </div>
                {current && <p className="t-meta">{current.webUrl ? `Now: ${current.webUrl}` : "No address is saved yet."}</p>}
            </div>
        );
    }
    if (platform === "android") {
        const a = current?.android;
        return (
            <fieldset className="choice-group stack-sm" data-testid="app-android">
                <legend className="t-card">Android app</legend>
                {a && (
                    <p className="t-meta">
                        {a.apk || a.playStoreUrl || a.appPackage ? ["Now:", a.apk && `the uploaded ${a.apk}`, a.playStoreUrl && `Google Play ${a.playStoreUrl}`, a.appPackage && `package ${a.appPackage}`].filter(Boolean).join(" ") : "No app is saved yet."}
                    </p>
                )}
                <HowChoice name="Android app" value={draft.androidHow} disabled={disabled} onChange={(v) => set({ androidHow: v })} kinds={{ upload: "Upload an .apk", link: "Google Play link", later: offerLater ? "Add it later" : undefined }} />
                {draft.androidHow === "upload" && (
                    <div className="field">
                        <FilePicker id="app-apk" accept=".apk,application/vnd.android.package-archive" file={draft.apk} onChange={(f) => set({ apk: f })} label="Choose .apk" />
                        <p className="t-meta">At most 512 MB. It is stored for the phones and runners that test it, and never opened on the server.</p>
                    </div>
                )}
                {draft.androidHow === "link" && (
                    <div className="field">
                        <label htmlFor="app-play-url">Link to the app on Google Play</label>
                        <input id="app-play-url" className="input" type="text" inputMode="url" autoComplete="off" placeholder="https://play.google.com/store/apps/details?id=…" disabled={disabled} value={draft.playStoreUrl} onChange={(e) => set({ playStoreUrl: e.target.value })} />
                        <p className="t-meta">{PLAY_HINT}. The app’s package is taken from the link.</p>
                    </div>
                )}
            </fieldset>
        );
    }
    const i = current?.ios;
    return (
        <fieldset className="choice-group stack-sm" data-testid="app-ios">
            <legend className="t-card">iPhone app</legend>
            {i && (
                <p className="t-meta">
                    {i.ipa || i.appStoreUrl || i.bundleId ? ["Now:", i.ipa && `the uploaded ${i.ipa.name} (${formatBytes(i.ipa.bytes)})`, i.appStoreUrl && `App Store ${i.appStoreUrl}`, i.bundleId && `bundle id ${i.bundleId}`].filter(Boolean).join(" ") : "No app is saved yet."}
                </p>
            )}
            <HowChoice name="iPhone app" value={draft.iosHow} disabled={disabled} onChange={(v) => set({ iosHow: v })} kinds={{ upload: "Upload an .ipa", link: "App Store link", later: offerLater ? "Add it later" : undefined }} />
            {draft.iosHow === "upload" && (
                <div className="field">
                    <FilePicker id="app-ipa" accept=".ipa" file={draft.ipa} onChange={(f) => set({ ipa: f })} label="Choose .ipa" />
                    <p className="t-meta">At most 512 MB. It is stored for the Mac runners that test it, and never opened on the server.</p>
                </div>
            )}
            {draft.iosHow === "link" && (
                <div className="field">
                    <label htmlFor="app-store-url">Link to the app on the App Store</label>
                    <input id="app-store-url" className="input" type="text" inputMode="url" autoComplete="off" placeholder="https://apps.apple.com/app/id…" disabled={disabled} value={draft.appStoreUrl} onChange={(e) => set({ appStoreUrl: e.target.value })} />
                    <p className="t-meta">{APP_STORE_HINT}.</p>
                </div>
            )}
        </fieldset>
    );
}
