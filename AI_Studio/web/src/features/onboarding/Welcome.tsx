import { Compass, FolderInput, Globe, Smartphone, Sparkles, Video } from "lucide-react";
import { useState } from "react";
import { api, uploadApk } from "../../api";
import { Button, Callout, FilePicker, LinkButton } from "../../components/ui";
import { hostOf } from "../../lib/format";
import { describeApiError } from "../../lib/labels";
import { go, routes } from "../../lib/router";
import { normalizeUrl } from "../../lib/url";
import { packageError } from "../phone/phone";
import { applyPendingTestingType } from "../security/security";
import "./onboarding.css";

/** What the first card needs from the page that owns the exploration form (it keeps the options and does the start). */
export interface ExploreCard {
    url: string;
    setUrl: (v: string) => void;
    urlError: string;
    clearUrlError: () => void;
    busy: boolean;
    error: string;
    /** Start exploring with the usual options. */
    onExplore: () => void;
    /** Open the form with every option instead. */
    onOptions: () => void;
    autoFocus?: boolean;
}

async function newProject(name: string): Promise<string> {
    const id = (await api("/projects", { method: "POST", body: { name } })).id as string;
    // "Both" chosen above the ways to start (security module on): the new project also gets the Security assessment section.
    await applyPendingTestingType(id);
    return id;
}

/**
 * The first screen: three ways to get tests, side by side and equal. Each says what it will do before it does anything.
 * "Explore my app" lets the AI look at the application and show a plan first; "Record a test" and "Start from tests I have"
 * make an empty project and open the place where that work happens. None of them needs the others.
 */
export function Welcome({ aiConfigured, explore }: { aiConfigured: boolean | undefined; explore: ExploreCard }) {
    const [recordUrl, setRecordUrl] = useState("");
    const [recordError, setRecordError] = useState("");
    const [ownName, setOwnName] = useState("");
    const [busy, setBusy] = useState<"" | "record" | "import" | "hand">("");
    const [problem, setProblem] = useState("");
    // The first card explores a website or API (the address) or an Android app (its package or an .apk).
    const [what, setWhat] = useState<"web" | "android">("web");
    const [pkg, setPkg] = useState("");
    const [apk, setApk] = useState<File | null>(null);
    const [pkgError, setPkgError] = useState("");
    const [phoneBusy, setPhoneBusy] = useState(false);
    const [phoneProblem, setPhoneProblem] = useState("");

    /** Save the app as the project's Mobile app, then go to the place that offers the exploration (Settings, Mobile app, with the start panel open). */
    async function explorePhone() {
        setPhoneProblem("");
        const p = pkg.trim();
        // The AI explores an app by its package name; an .apk is only installed first.
        if (!p) return setPkgError("Enter the app’s package name, for example com.example.shop.");
        const bad = packageError(p);
        if (bad) return setPkgError(bad);
        setPkgError("");
        setPhoneBusy(true);
        try {
            const name = p ? (p.split(".").slice(-2).join(" ") || p) : (apk!.name.replace(/.apk$/i, "") || "Android app");
            const id = await newProject(name);
            if (apk) await uploadApk(id, apk);
            await api(`/projects/${id}/mobile-app`, { method: "PUT", body: { appPackage: p || null, iosBundleId: null } });
            go(`${routes.setup(id, "mobile")}&start=phone`);
        } catch (err) {
            setPhoneProblem(describeApiError(err));
            setPhoneBusy(false);
        }
    }

    async function record(e: React.FormEvent) {
        e.preventDefault();
        setProblem("");
        const n = normalizeUrl(recordUrl);
        if (!n.url) return setRecordError(n.error!);
        setRecordError("");
        setBusy("record");
        try {
            const id = await newProject(hostOf(n.url) || "Untitled project");
            go(`${routes.record(id)}?url=${encodeURIComponent(n.url)}`);
        } catch (err) {
            setProblem(describeApiError(err));
            setBusy("");
        }
    }

    async function own(kind: "import" | "hand") {
        setProblem("");
        setBusy(kind);
        try {
            const id = await newProject(ownName.trim() || "My tests");
            go(kind === "import" ? `${routes.tests(id)}?start=import` : routes.tests(id));
        } catch (err) {
            setProblem(describeApiError(err));
            setBusy("");
        }
    }

    return (
        <div className="welcome-cards" role="group" aria-label="Ways to start">
            <form className="card card-pad stack welcome-card" onSubmit={(e) => (e.preventDefault(), what === "android" ? void explorePhone() : explore.onExplore())} noValidate aria-labelledby="w-explore">
                <span className="icon-tile" aria-hidden>
                    <Compass size={20} />
                </span>
                <div className="stack-sm">
                    <h2 className="t-section" id="w-explore">
                        Explore my app
                    </h2>
                    <p className="t-secondary">The AI looks around your application, then shows you a plan. Nothing is created or run until you say so.</p>
                </div>
                <fieldset className="welcome-kind">
                    <legend className="sr-only">What do you want to test?</legend>
                    {(
                        [
                            ["web", "A website or API", Globe],
                            ["android", "An Android app", Smartphone],
                        ] as const
                    ).map(([key, label, Icon]) => (
                        <label key={key} className="check welcome-kind-opt">
                            <input type="radio" name="w-what" value={key} checked={what === key} onChange={() => setWhat(key)} />
                            <span className="title">
                                <Icon size={16} aria-hidden /> {label}
                            </span>
                        </label>
                    ))}
                </fieldset>
                {what === "android" ? (
                    <>
                        {aiConfigured === false ? (
                            <Callout tone="warning" title="The AI model isn’t set up on this server" actions={<LinkButton href={routes.settings}>Open Settings</LinkButton>}>
                                Exploring a phone app needs it. The other two ways to start work without it.
                            </Callout>
                        ) : (
                            <p className="t-meta" data-testid="ai-note">
                                Uses the AI model: it opens the app on a phone or emulator, taps through it like a careful user and plans tests. Android only.
                            </p>
                        )}
                        <div className="field">
                            <label htmlFor="w-package">App package</label>
                            <p className="hint" id="w-package-hint">
                                The app’s Android id, for example com.example.shop. If you also choose an .apk file below, it is installed on the phone or emulator first.
                            </p>
                            <input
                                id="w-package"
                                className="input"
                                autoComplete="off"
                                spellCheck={false}
                                placeholder="com.example.shop"
                                value={pkg}
                                onChange={(e) => {
                                    setPkg(e.target.value);
                                    setPkgError("");
                                }}
                                aria-describedby="w-package-hint"
                                aria-invalid={!!pkgError}
                            />
                            {pkgError && <div className="error-text">{pkgError}</div>}
                        </div>
                        <div className="field">
                            <label htmlFor="w-apk">App file (optional)</label>
                            <FilePicker id="w-apk" accept=".apk,application/vnd.android.package-archive" file={apk} onChange={setApk} label="Choose .apk" />
                        </div>
                        {phoneProblem && <Callout tone="danger" title="We couldn’t save the app">{phoneProblem}</Callout>}
                        <div className="row">
                            <Button type="submit" variant="primary" icon={Sparkles} loading={phoneBusy}>
                                {phoneBusy ? "Saving…" : "Explore my app"}
                            </Button>
                        </div>
                    </>
                ) : (
                    <>
                    {aiConfigured === false ? (
                        <Callout tone="warning" title="The AI model isn’t set up on this server" actions={<LinkButton href={routes.settings}>Open Settings</LinkButton>}>
                            Exploring a web application needs it. Tests for an API alone don’t, and the other two ways to start work without it.
                        </Callout>
                    ) : (
                        <p className="t-meta" data-testid="ai-note">
                            Uses the AI model: it decides what to test, writes the browser tests and corrects one that fails along the way. Tests for an API alone are created without it.
                        </p>
                    )}
                    <div className="field">
                        <label htmlFor="url">Application URL</label>
                        <p className="hint" id="url-hint">
                            The address of the website you want to test.
                        </p>
                        <div className="input-wrap">
                            <Globe size={18} className="lead" aria-hidden />
                            <input
                                id="url"
                                className="input"
                                type="text"
                                inputMode="url"
                                autoComplete="url"
                                placeholder="https://example.com"
                                value={explore.url}
                                onChange={(e) => {
                                    explore.setUrl(e.target.value);
                                    explore.clearUrlError();
                                }}
                                aria-describedby="url-hint"
                                aria-invalid={!!explore.urlError}
                                autoFocus={explore.autoFocus}
                            />
                        </div>
                        {explore.urlError && <div className="error-text">{explore.urlError}</div>}
                    </div>
                    {explore.error && <Callout tone="danger" title="We couldn’t start the exploration">{explore.error}</Callout>}
                    <div className="row">
                        <Button type="submit" variant="primary" icon={Sparkles} loading={explore.busy}>
                            {explore.busy ? "Starting…" : "Explore my app"}
                        </Button>
                        <Button type="button" variant="ghost" onClick={explore.onOptions} disabled={explore.busy} tip="Shows every option before exploring: kinds of check, sign-in details, API access and a requirements document.">
                            Choose what to test first
                        </Button>
                    </div>
                    </>
                )}
            </form>

            <form className="card card-pad stack welcome-card" onSubmit={record} noValidate aria-labelledby="w-record">
                <span className="icon-tile" aria-hidden>
                    <Video size={20} />
                </span>
                <div className="stack-sm">
                    <h2 className="t-section" id="w-record">
                        Record a test
                    </h2>
                    <p className="t-secondary">Click through your application in a browser window and we turn what you do into the steps of a test. No AI needed.</p>
                </div>
                <div className="field">
                    <label htmlFor="record-url">Address to start from</label>
                    <div className="input-wrap">
                        <Globe size={18} className="lead" aria-hidden />
                        <input
                            id="record-url"
                            className="input"
                            type="text"
                            inputMode="url"
                            autoComplete="off"
                            placeholder="https://example.com"
                            value={recordUrl}
                            onChange={(e) => {
                                setRecordUrl(e.target.value);
                                setRecordError("");
                            }}
                            aria-invalid={!!recordError}
                        />
                    </div>
                    {recordError && <div className="error-text">{recordError}</div>}
                </div>
                <div className="row">
                    <Button type="submit" icon={Video} loading={busy === "record"} disabled={busy !== "" && busy !== "record"} tip="Makes a project named after the address, then opens the recorder on it.">
                        {busy === "record" ? "Opening…" : "Record a test"}
                    </Button>
                </div>
            </form>

            <section className="card card-pad stack welcome-card" aria-labelledby="w-own">
                <span className="icon-tile" aria-hidden>
                    <FolderInput size={20} />
                </span>
                <div className="stack-sm">
                    <h2 className="t-section" id="w-own">
                        Start from tests I have
                    </h2>
                    <p className="t-secondary">Bring tests you already have from a file, Maestro or a Git repository, or write one yourself as text or code. No AI needed.</p>
                </div>
                <div className="field">
                    <label htmlFor="own-name">Project name</label>
                    <input id="own-name" className="input" autoComplete="off" placeholder="My tests" value={ownName} onChange={(e) => setOwnName(e.target.value)} />
                </div>
                <div className="row">
                    <Button type="button" icon={FolderInput} loading={busy === "import"} disabled={busy !== "" && busy !== "import"} onClick={() => void own("import")} tip="Makes the project, then asks where the tests come from: a JSON file, Maestro flows or a Git repository.">
                        {busy === "import" ? "Opening…" : "Import tests"}
                    </Button>
                    <Button type="button" variant="ghost" loading={busy === "hand"} disabled={busy !== "" && busy !== "hand"} onClick={() => void own("hand")} tip="Makes the project and opens its Tests page. New test there lets you build steps, write text or write code.">
                        Write a test by hand
                    </Button>
                </div>
            </section>

            {problem && (
                <div className="welcome-problem">
                    <Callout tone="danger" title="We couldn’t create the project">
                        {problem}
                    </Callout>
                </div>
            )}
        </div>
    );
}
