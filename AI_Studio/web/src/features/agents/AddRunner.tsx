import { Cable, Check, Download, LoaderCircle } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, Callout, ErrorState, Skeleton } from "../../components/ui";
import { downloadBlob } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { routes, useRoute } from "../../lib/router";
import { SeeHow } from "../guide/SeeHow";
import { usePolled, type Agent } from "./agents";
import { checkComputerHelp } from "./check";
import {
    CONNECT_POLL_MS,
    DEFAULT_RUNNER_NAME,
    NAME_MAX,
    TARGET_WORDS,
    completeAvailable,
    downloadErrorText,
    downloadRunnerKit,
    effectiveKind,
    findNewRunner,
    guessPlatform,
    guessTarget,
    installerAvailable,
    refineTarget,
    sizeWords,
    startInstructions,
    targetsFor,
    waitLimitMs,
    type CompleteTarget,
    type KitDownload,
    type KitInfo,
    type KitKind,
    type KitPlatform,
} from "./kit";
import { UnsignedNotice } from "../runners/UnsignedNotice";
import "./add-runner.css";

const STEP_TITLES = ["Choose the computer", "Download and unzip", "Start it"] as const;

/**
 * "Add a runner" as three plain steps: choose the computer, download the kit, start it and watch it connect.
 * The kit holds a secret. This panel never sees inside it: the browser saves the zip as a file and only the id of the new access is kept.
 */
export function AddRunner({ projectId, agents, onClose, onChanged }: { projectId: string; agents: Agent[]; onClose: () => void; onChanged: () => void }) {
    const info = useFetch<KitInfo>(`/projects/${projectId}/runner-kits/info`);
    const [step, setStep] = useState<1 | 2 | 3>(1);
    const [platform, setPlatform] = useState<KitPlatform>(() => guessPlatform());
    // What the person picked; null means "the recommended one for this computer". An installer this server does not have is never used.
    const [chosenKind, setChosenKind] = useState<KitKind | null>(null);
    // System and processor for the complete download: guessed from the browser until the person picks one.
    const [target, setTarget] = useState<CompleteTarget>(() => guessTarget());
    const [targetPicked, setTargetPicked] = useState(false);
    useEffect(() => {
        let live = true;
        void refineTarget(guessTarget()).then((t) => {
            if (live && !targetPicked) setTarget((cur) => ((cur.startsWith("win") === t.startsWith("win")) ? t : cur));
        });
        return () => {
            live = false;
        };
        // Asked once, when the panel opens.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const kind = effectiveKind(info.data, platform, chosenKind, target);
    const [name, setName] = useState(DEFAULT_RUNNER_NAME);
    const [made, setMade] = useState<{ download: KitDownload; name: string; onlineBefore: Set<string> } | null>(null);
    const panel = useRef<HTMLElement>(null);
    const heading = useRef<HTMLHeadingElement>(null);

    // Keyboard and screen-reader users land on the step they are on, not at the top of the page.
    useEffect(() => {
        heading.current?.focus();
    }, [step]);
    useEffect(() => {
        panel.current?.scrollIntoView?.({ block: "nearest" });
    }, []);

    const titleId = useId();
    return (
        <section
            ref={panel}
            className="card ark"
            aria-labelledby={titleId}
            data-testid="add-runner"
            onKeyDown={(e) => {
                // Escape leaves the panel unless a dialog above it is the thing being closed.
                if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector("dialog[open]")) onClose();
            }}
        >
            <div className="card-head wrap">
                <Cable size={18} aria-hidden />
                <h2 className="t-section" id={titleId}>Add a runner</h2>
                <span className="spacer" />
                <Button size="sm" variant="ghost" onClick={onClose}>
                    Close
                </Button>
            </div>
            <div className="ark-body">
                <p className="ark-progress" data-testid="add-runner-step">
                    <span>Step {step} of 3</span>
                    <span className="ark-dots" aria-hidden>
                        {[1, 2, 3].map((n) => (
                            <i key={n} className={n <= step ? "on" : ""} />
                        ))}
                    </span>
                </p>
                <h3 className="t-card ark-step-title" tabIndex={-1} ref={heading}>
                    {STEP_TITLES[step - 1]}
                </h3>

                {step === 1 && (
                    <ChooseStep
                        projectId={projectId}
                        info={info}
                        platform={platform}
                        kind={kind}
                        name={name}
                        target={target}
                        targetPicked={targetPicked}
                        onPlatform={(p) => {
                            setPlatform(p);
                            setChosenKind(null);
                            // Keep the guessed processor when it fits the new system; otherwise the first one of that system.
                            if (target.startsWith("win") !== (p === "windows")) {
                                const g = guessTarget();
                                setTarget(g.startsWith("win") === (p === "windows") ? g : targetsFor(p)[0]!);
                                setTargetPicked(false);
                            }
                        }}
                        onTarget={(t) => {
                            setTarget(t);
                            setTargetPicked(true);
                        }}
                        onKind={setChosenKind}
                        onName={setName}
                        onNext={() => setStep(2)}
                    />
                )}
                {step === 2 && info.data && (
                    <DownloadStep
                        projectId={projectId}
                        platform={platform}
                        kind={kind}
                        target={target}
                        size={sizeWords(info.data.complete?.targets?.[target]?.bytes)}
                        name={name.trim()}
                        agents={agents}
                        made={made}
                        onMade={(download, onlineBefore) => {
                            setMade({ download, name: name.trim(), onlineBefore });
                            onChanged();
                        }}
                        onBack={() => setStep(1)}
                        onNext={() => setStep(3)}
                    />
                )}
                {step === 3 && info.data && made && (
                    <StartStep projectId={projectId} platform={platform} info={info.data} made={made} onBack={() => setStep(2)} onDone={() => { onChanged(); onClose(); }} />
                )}
            </div>
        </section>
    );
}

// ── Step 1 ──────────────────────────────────────────────────────────────────

function ChooseStep({
    projectId,
    info,
    platform,
    kind,
    name,
    target,
    targetPicked,
    onPlatform,
    onTarget,
    onKind,
    onName,
    onNext,
}: {
    projectId: string;
    info: ReturnType<typeof useFetch<KitInfo>>;
    platform: KitPlatform;
    kind: KitKind;
    name: string;
    target: CompleteTarget;
    targetPicked: boolean;
    onPlatform: (p: KitPlatform) => void;
    onTarget: (t: CompleteTarget) => void;
    onKind: (k: KitKind) => void;
    onName: (n: string) => void;
    onNext: () => void;
}) {
    const nameOk = name.trim().length >= 1 && name.trim().length <= NAME_MAX;
    const [touched, setTouched] = useState(false);
    const k = info.data;
    // The complete download is offered only by a server that has built at least one; it is recommended when it exists for this system.
    const anyComplete = Boolean(k?.complete && Object.values(k.complete.targets ?? {}).some((t) => t?.available));
    const completeHere = Boolean(k && targetsFor(platform).some((t) => completeAvailable(k, t)));
    const targetOk = completeAvailable(k, target);
    const canContinue = Boolean(k?.available) && (kind !== "complete" || targetOk);
    const sizeOf = (t: CompleteTarget) => sizeWords(k?.complete?.targets?.[t]?.bytes);
    const showKinds = Boolean(k && (k.installer || anyComplete));

    return (
        <form
            className="ark-step"
            aria-label="Choose the computer"
            onSubmit={(e) => {
                e.preventDefault();
                setTouched(true);
                if (nameOk && canContinue) onNext();
            }}
        >
            <p className="t-secondary">
                A runner is a small program on a computer where your app can be reached. It connects out to this platform, so nobody opens a door into your network.
            </p>

            {info.loading ? (
                <div className="stack-sm" aria-busy="true">
                    <Skeleton h={64} />
                    <Skeleton h={40} />
                </div>
            ) : info.error || !k ? (
                <ErrorState error={friendlyError(info.error?.message)} onRetry={info.reload} />
            ) : (
                <>
                    {!k.available && (
                        <div className="stack-sm" data-testid="kit-unavailable">
                            <Callout tone="warning" title="This server cannot make a runner download yet">
                                {k.reason || "The runner download has not been prepared on this server."} Ask whoever runs the platform to prepare it, then try again.
                            </Callout>
                            <SeeHow topic="runners" />
                        </div>
                    )}
                    {k.available && !k.urlOk && (
                        <Callout tone="warning" title="The runner may not be able to find this platform">
                            {k.urlWarning || "This platform’s address may not work from another computer."}
                            {k.platformUrl ? ` The runner will try ${k.platformUrl}.` : ""} If that is wrong, ask whoever runs the platform to set its public address before you download.
                        </Callout>
                    )}
                    {k.available && k.urlOk && k.urlWarning && <Callout tone="info">{k.urlWarning}</Callout>}

                    <fieldset className="ag-choices ark-os">
                        <legend className="t-card">Which computer will run your tests?</legend>
                        <div className="ark-os-grid">
                            <label className="check ark-os-pick">
                                <input type="radio" name="ark-os" value="windows" checked={platform === "windows"} onChange={() => onPlatform("windows")} />
                                <span>
                                    <span className="title">Windows</span>
                                    <span className="hint">A Windows 10 or 11 computer.</span>
                                </span>
                            </label>
                            <label className="check ark-os-pick">
                                <input type="radio" name="ark-os" value="unix" checked={platform === "unix"} onChange={() => onPlatform("unix")} />
                                <span>
                                    <span className="title">Mac or Linux</span>
                                    <span className="hint">A Mac, or a Linux computer or server.</span>
                                </span>
                            </label>
                        </div>
                    </fieldset>

                    {showKinds && (
                        <fieldset className="ag-choices ark-os" data-testid="kit-kind">
                            <legend className="t-card">How do you want to set it up?</legend>
                            <div className={anyComplete ? "ark-os-grid three" : "ark-os-grid"}>
                                {anyComplete && (
                                    <label className="check ark-os-pick">
                                        <input type="radio" name="ark-kind" value="complete" checked={kind === "complete"} disabled={!completeHere} onChange={() => onKind("complete")} />
                                        <span>
                                            <span className="title">
                                                Complete download (recommended)
                                                {completeHere && targetOk && sizeOf(target) ? <span className="ark-size">, {sizeOf(target)}</span> : null}
                                            </span>
                                            <span className="hint">
                                                {completeHere
                                                    ? "Everything in one download, with its own Node.js and test tools. Nothing else to install."
                                                    : "This server has not prepared the complete download for this computer yet. Ask whoever runs the platform, or choose another way."}
                                            </span>
                                        </span>
                                    </label>
                                )}
                                <label className="check ark-os-pick">
                                    <input type="radio" name="ark-kind" value="installer" checked={kind === "installer"} disabled={!installerAvailable(k, platform)} onChange={() => onKind("installer")} />
                                    <span>
                                        <span className="title">{completeHere ? "Installer" : "Installer (recommended)"}</span>
                                        <span className="hint">
                                            {installerAvailable(k, platform)
                                                ? "Checks what the computer already has and only downloads what is missing."
                                                : "This server has not prepared an installer for this computer yet. Ask whoever runs the platform, or use plain files."}
                                        </span>
                                    </span>
                                </label>
                                <label className="check ark-os-pick">
                                    <input type="radio" name="ark-kind" value="files" checked={kind === "files"} onChange={() => onKind("files")} />
                                    <span>
                                        <span className="title">Plain files (advanced)</span>
                                        <span className="hint">A start script you run yourself, in a terminal.</span>
                                    </span>
                                </label>
                            </div>
                            {platform === "unix" && installerAvailable(k, platform) && <p className="t-meta">The installer is for a Mac. On Linux, choose {completeHere ? "the complete download or plain files" : "plain files"}.</p>}
                        </fieldset>
                    )}

                    {kind === "complete" && anyComplete && (
                        <div className="field" data-testid="kit-target">
                            <label htmlFor="ark-target">System and processor</label>
                            <select id="ark-target" className="input" value={target} aria-describedby="ark-target-hint" onChange={(e) => onTarget(e.target.value as CompleteTarget)}>
                                {targetsFor(platform).map((t) => (
                                    <option key={t} value={t} disabled={!completeAvailable(k, t)}>
                                        {sentence(TARGET_WORDS[t])}
                                        {completeAvailable(k, t) ? (sizeOf(t) ? `, ${sizeOf(t)}` : "") : " (not prepared on this server)"}
                                    </option>
                                ))}
                            </select>
                            <span className="hint" id="ark-target-hint" data-testid="kit-target-hint">
                                {!targetOk
                                    ? `This server has not prepared the complete download for ${TARGET_WORDS[target]}. Choose another processor, the installer or plain files, or ask whoever runs the platform.`
                                    : targetPicked
                                      ? `The download for ${TARGET_WORDS[target]}. It only works on that kind of computer.`
                                      : `We guessed ${TARGET_WORDS[target]}. Change it if that is wrong.`}
                            </span>
                        </div>
                    )}

                    <div className="field">
                        <label htmlFor="ark-name">Name</label>
                        <input
                            id="ark-name"
                            className="input"
                            value={name}
                            maxLength={NAME_MAX}
                            autoComplete="off"
                            aria-invalid={touched && !nameOk}
                            aria-describedby="ark-name-hint"
                            onChange={(e) => onName(e.target.value)}
                        />
                        <span className="hint" id="ark-name-hint">{touched && !nameOk ? `Give it a name of 1 to ${NAME_MAX} characters.` : "How this computer is listed here, for example “Maya’s laptop”."}</span>
                    </div>

                    <p className="t-meta">
                        Phone testing and visible browser windows need a runner on a computer you can see; see <a href={routes.setup(projectId, "mobile")}>Settings, Mobile app</a>.
                    </p>
                    <div className="row">
                        <Button type="submit" variant="primary" disabled={!canContinue}>
                            Continue
                        </Button>
                    </div>
                </>
            )}
        </form>
    );
}

/** "a Mac with an Apple chip" -> "A Mac with an Apple chip", for the start of an option. */
const sentence = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// ── Step 2 ──────────────────────────────────────────────────────────────────

function DownloadStep({
    projectId,
    platform,
    kind,
    target,
    size,
    name,
    agents,
    made,
    onMade,
    onBack,
    onNext,
}: {
    projectId: string;
    platform: KitPlatform;
    kind: KitKind;
    target: CompleteTarget;
    size: string;
    name: string;
    agents: Agent[];
    made: { download: KitDownload; name: string } | null;
    onMade: (d: KitDownload, onlineBefore: Set<string>) => void;
    onBack: () => void;
    onNext: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<{ text: string; limit: boolean } | null>(null);

    async function download() {
        setBusy(true);
        setError(null);
        // Remember who was already online, so the next step can tell the new runner from the others.
        const onlineBefore = new Set(agents.filter((a) => a.online).map((a) => a.id));
        try {
            const out = await downloadRunnerKit(projectId, name, platform, downloadBlob, kind, target);
            onMade(out, onlineBefore);
        } catch (e) {
            setError(downloadErrorText(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="ark-step">
            <Callout tone="warning" title="Keep this file private">
                This file contains a secret that lets a computer run tests for this project. Don’t share it. Delete it after the runner connects.
            </Callout>

            {made ? (
                <div className="stack-sm" role="status" data-testid="kit-downloaded">
                    <p className="ark-ok">
                        <Check size={18} aria-hidden />
                        <span>
                            Downloaded <b className="ark-file">{made.download.fileName}</b>.
                        </span>
                    </p>
                    <p>
                        Access created: <b>{made.name}</b> (remove it any time under Access for runners).
                    </p>
                    {made.download.fellBack && (
                        <Callout tone="info" title="You got plain files, not the installer">
                            The installer is not ready on this server yet, so this download holds a start script instead. Ask whoever runs the platform to build the installer if you want it next time.
                        </Callout>
                    )}
                    <p>
                        Unzip it on the computer where your app can be reached. Unzip means {platform === "windows" ? "right-click, then Extract all" : "double-click the file on a Mac, or run unzip on Linux"}.
                    </p>
                </div>
            ) : (
                <p className="t-secondary">
                    {kind === "complete" ? (
                        <>
                            We make a complete download for <b>{name}</b> on {TARGET_WORDS[target]}{size ? `, ${size}` : ""}. It holds its own Node.js and test tools, so nothing else is installed.
                        </>
                    ) : (
                        <>
                            We make a download for <b>{name}</b> on {platform === "windows" ? "Windows" : "Mac or Linux"}{kind === "installer" ? ", with the installer" : ""}.
                        </>
                    )}{" "}
                    It also creates the access the runner uses to connect, so you will not see or copy a token.
                </p>
            )}

            {/* The downloads are unsigned: what SmartScreen and Gatekeeper show, before and after the download. */}
            <UnsignedNotice platform={platform} />

            {error && (
                <Callout
                    tone="danger"
                    title={error.limit ? "This project has all the runner access it can have" : "The download did not work"}
                    actions={
                        <>
                            <Button size="sm" onClick={() => void download()}>
                                Try again
                            </Button>
                            {error.limit && (
                                <Button size="sm" onClick={() => document.getElementById("ark-access")?.scrollIntoView({ block: "center" })}>
                                    Go to Access for runners
                                </Button>
                            )}
                        </>
                    }
                >
                    {error.text}
                    {error.limit && !/Settings|Setup/.test(error.text) ? " Remove access you no longer use under Access for runners, then try again." : ""}
                </Callout>
            )}

            <div className="row">
                <Button variant="ghost" onClick={onBack}>
                    Back
                </Button>
                {!made ? (
                    <Button variant="primary" icon={busy ? LoaderCircle : Download} loading={busy} onClick={() => void download()}>
                        Download runner
                    </Button>
                ) : (
                    <>
                        <Button variant="primary" onClick={onNext}>
                            Continue
                        </Button>
                        <Button variant="ghost" loading={busy} onClick={() => void download()}>
                            Download again
                        </Button>
                    </>
                )}
            </div>
            {made && <p className="t-meta">Downloading again makes new access. The first one stays until you remove it.</p>}
        </div>
    );
}

// ── Step 3 ──────────────────────────────────────────────────────────────────

/** The file to open is the thing to find in the folder, so it is set in bold; a word in `backticks` is something to type, set in a code face. */
function boldScripts(text: string, boldFiles = true) {
    return text.split(/(start-runner\.(?:command|cmd|sh)|check-computer\.(?:command|cmd)|AITestingRunnerSetup\.exe|“AI Testing Runner”|`[^`]+`)/).map((part, i) => {
        if (i % 2 === 0) return part;
        if (part.startsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
        return boldFiles ? <b key={i}>{part}</b> : part;
    });
}

function StartStep({
    projectId,
    platform,
    info,
    made,
    onBack,
    onDone,
}: {
    projectId: string;
    platform: KitPlatform;
    info: KitInfo;
    made: { download: KitDownload; name: string; onlineBefore: Set<string> };
    onBack: () => void;
    onDone: () => void;
}) {
    const query = useRoute().query;
    const limit = useMemo(() => waitLimitMs(query), [query]);
    // Polls only while this step is on screen, and pauses while the tab is hidden.
    const polled = usePolled<Agent[]>(`/projects/${projectId}/agents`, CONNECT_POLL_MS);
    const [connected, setConnected] = useState<Agent | null>(null);
    const [slow, setSlow] = useState(false);

    useEffect(() => {
        if (connected || !polled.data) return;
        const found = findNewRunner(polled.data, { tokenId: made.download.tokenId, name: made.name, onlineBefore: made.onlineBefore });
        if (found) setConnected(found);
    }, [polled.data, connected, made]);

    useEffect(() => {
        if (connected) return;
        const t = window.setTimeout(() => setSlow(true), limit);
        return () => clearTimeout(t);
    }, [connected, limit]);

    const kind = made.download.kind;
    const installer = kind === "installer";
    const complete = kind === "complete";
    // A complete download for Windows or a Mac also holds the installer when the server has one: the double-click alternative.
    const how = startInstructions(platform, kind, info.nodeMin, { installerInside: platform === "windows" ? Boolean(info.installer?.windows) : false });
    const start = installer ? (platform === "windows" ? "AITestingRunnerSetup.exe" : "AI Testing Runner") : platform === "windows" ? "start-runner.cmd" : "start-runner.sh";
    const address = info.platformUrl || "this platform’s address";
    return (
        <div className="ark-step">
            <ol className="ag-steps ark-how">
                {how.steps.map((s) => (
                    <li key={s}>{boldScripts(s)}</li>
                ))}
            </ol>
            {how.command && (
                <pre className="code ag-command" tabIndex={0} aria-label="Command to start the runner">
                    <code data-testid="kit-command">{how.command}</code>
                </pre>
            )}
            {how.note && <p className="t-secondary">{boldScripts(how.note)}</p>}
            {!installer && !complete && (
                <p className="t-secondary">
                    If you are asked to install Node.js, say yes. Node.js is the free program the runner is built on, and it needs version {info.nodeMin} or newer.
                </p>
            )}
            <p className="t-secondary" data-testid="kit-node-help">
                {boldScripts(how.nodeHelp, false)}
            </p>
            <p className="t-secondary" data-testid="kit-check-help">
                {boldScripts(checkComputerHelp(platform, kind))}
            </p>

            {connected ? (
                <div className="ark-connected" role="status" data-testid="kit-status" data-state="connected">
                    <Callout tone="success" title={`Connected: ${connected.name} is online`}>
                        {installer
                            ? "You can delete the downloaded file and the unzipped folder now: the installer keeps its own copy. The runner keeps working in the background. Choose where tests run with “Where this project’s tests run” below."
                            : "You can delete the downloaded file now. Choose where tests run with “Where this project’s tests run” below."}
                    </Callout>
                </div>
            ) : (
                <div role="status" aria-live="polite" data-testid="kit-status" data-state={slow ? "slow" : "waiting"}>
                    <p className="ark-wait">
                        <LoaderCircle size={18} className="spin" aria-hidden />
                        <span>{slow ? "Still waiting for your runner to connect." : "Waiting for your runner to connect…"}</span>
                    </p>
                </div>
            )}

            {!connected && slow && (
                <div className="ark-reasons" data-testid="kit-slow">
                    <p className="t-card">Still waiting. Common reasons:</p>
                    <ul>
                        {!info.urlOk && <li>The platform’s address{info.platformUrl ? ` (${info.platformUrl})` : ""} may not work from that computer. Ask whoever runs the platform to set its public address, then download a new runner.</li>}
                        {installer ? (
                            <>
                                <li>
                                    The setup window shows what went wrong, and is in the notification area next to the clock if it was hidden. Open {start} again and choose Install and start.
                                </li>
                                <li>The installer could not download something. Check that this computer is online; the window lists which step failed.</li>
                            </>
                        ) : complete ? (
                            <>
                                <li>The window was closed. Open {start} again and leave the window open.</li>
                                <li>The window says that Node.js does not start. The download is for another processor: go back, choose the other one, and download again.</li>
                            </>
                        ) : (
                            <>
                                <li>The window was closed. Open {start} again and leave the window open.</li>
                                <li>
                                    The runner cannot find Node.js. If you have it, open {platform === "windows" ? "Command Prompt" : "Terminal"}, run <code>node --version</code> there, and start {start} from that same window. If you do not, install Node.js {info.nodeMin} or newer from nodejs.org, then run {start} again.
                                </li>
                            </>
                        )}
                        <li>A firewall blocks outbound connections. The runner only calls out to {address}; ask your network admin to allow it.</li>
                        <li>The address needs https. Some networks only allow secure addresses, so a plain http address never connects.</li>
                    </ul>
                </div>
            )}

            <div className="row">
                <Button variant="ghost" onClick={onBack}>
                    Back
                </Button>
                {connected && (
                    <Button variant="primary" onClick={onDone}>
                        Done
                    </Button>
                )}
            </div>
        </div>
    );
}
