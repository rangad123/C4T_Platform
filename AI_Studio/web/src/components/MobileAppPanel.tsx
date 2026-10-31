import { Smartphone } from "lucide-react";
import { useState } from "react";
import { api, uploadApk, type MobileApp, type PlatformConfig } from "../api";
import { describeApiError } from "../lib/labels";
import { Button, Callout, Disclosure, FilePicker } from "./ui";
import { StartStateFields, type StartStateValue } from "../features/phonestate/StartState";

/**
 * Which Android app mobile tests run against: one already on the emulator (its package name) and/or an APK
 * to install first. Shown only on request, because most projects are web or API projects.
 */
export function MobileAppPanel({ projectId, current, mobile, onSaved, onClose }: { projectId: string; current: MobileApp | null; mobile: PlatformConfig["mobile"] | undefined; onSaved: () => void; onClose?: () => void }) {
    const [pkg, setPkg] = useState(current?.appPackage ?? "");
    const [bundle, setBundle] = useState(current?.iosBundleId ?? "");
    const [apk, setApk] = useState<File | null>(null);
    const [start, setStart] = useState<StartStateValue>({ cleanStart: current?.cleanStart === true, grantPermissions: current?.grantPermissions ?? [] });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState(false);

    async function save() {
        setBusy(true);
        setError("");
        setSaved(false);
        try {
            if (apk) await uploadApk(projectId, apk);
            // An empty package keeps whatever the APK defines; the server needs one of the two.
            // The start options are sent only when they changed, so a save that does not touch them sends what it always sent.
            const startChanged = start.cleanStart !== (current?.cleanStart === true) || start.grantPermissions.join(",") !== (current?.grantPermissions ?? []).join(",");
            const startBody = startChanged ? { cleanStart: start.cleanStart || null, grantPermissions: start.grantPermissions.length ? start.grantPermissions : null } : {};
            await api(`/projects/${projectId}/mobile-app`, { method: "PUT", body: { appPackage: pkg.trim() || null, iosBundleId: bundle.trim() || null, ...startBody } });
            setApk(null);
            setSaved(true);
            onSaved();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="card card-pad stack-sm" aria-label="Mobile app">
            <div className="row">
                <Smartphone size={18} aria-hidden />
                <h2 className="t-section">Mobile app</h2>
                <span className="spacer" />
                {onClose && <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>}
            </div>
            <p className="t-secondary">Mobile tests run on an Android emulator. Tell us which app they should test. Once it is saved, choose Explore with AI and the AI taps through the app and plans the tests for you.</p>
            {mobile && !mobile.available && <Callout tone="warning" title="This computer can’t run mobile tests yet">Install one with “npx @taqwright/taqwright install --with-avd” on the computer that runs the platform. You can still save the app and import mobile tests now; they’ll run once an emulator is available.</Callout>}
            {current?.apk && <p className="t-meta">Uploaded app: {current.apk}</p>}
            {current?.appActivity && (
                <p className="t-meta" data-testid="app-activity">
                    Opens with <span className="mono">{current.appActivity}</span>, as the phone said on the last run. Each run checks it again on its own phone.
                </p>
            )}
            <div className="field">
                <label htmlFor="app-package">App package</label>
                <input id="app-package" className="input" value={pkg} placeholder="com.android.settings" autoComplete="off" onChange={(e) => { setPkg(e.target.value); setSaved(false); }} />
                <p className="t-meta">The app’s Android id, for an app that is already on the emulator (for example the built-in Settings app).</p>
            </div>
            <div className="field">
                <label htmlFor="app-apk">App file (optional)</label>
                <FilePicker id="app-apk" accept=".apk,.aab,application/vnd.android.package-archive" file={apk} onChange={setApk} label="Choose .apk or .aab" />
                <p className="t-meta">An .apk to install on the emulator before testing. An .aab (app bundle) works when the platform’s computer has Java and bundletool.</p>
            </div>
            <Disclosure label="How each test starts">
                <StartStateFields projectId={projectId} hasPackage={Boolean(pkg.trim())} value={start} onChange={(v) => { setStart(v); setSaved(false); }} />
            </Disclosure>
            <div className="field">
                <label htmlFor="app-ios-bundle">iOS app id (optional)</label>
                <input id="app-ios-bundle" className="input" value={bundle} placeholder="com.apple.Preferences" autoComplete="off" onChange={(e) => { setBundle(e.target.value); setSaved(false); }} />
                <p className="t-meta">For iOS tests: the id of an app already installed on the simulator. iOS tests run on a runner on a Mac with Xcode. The AI explores Android apps only; for an iPhone app, import tests.</p>
            </div>
            {error && <Callout tone="danger">{error}</Callout>}
            {saved && <Callout tone="success">Saved. Mobile tests will use this app.</Callout>}
            <div className="row">
                <Button variant="primary" loading={busy} disabled={busy || (!pkg.trim() && !bundle.trim() && !apk && !current?.apk)} onClick={save}>
                    Save
                </Button>
            </div>
        </section>
    );
}
