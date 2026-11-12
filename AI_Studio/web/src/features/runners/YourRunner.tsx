import { ChevronRight, Download, Laptop, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api";
import { Badge, Button, Callout, ErrorState, Skeleton } from "../../components/ui";
import { BadgeKey } from "../../components/Tooltip";
import { relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { boldScripts } from "./bold";
import { RunnerCheckDetails, RunnerCheckNote } from "./check";
import { RunnerUpdates } from "./updates";
import { RunnerSwitches } from "./RunnerSwitches";
import { StillBlocked } from "./StillBlocked";
import { offlineSteps, STATUS_WORDS } from "./runners";
import {
    ARCH_WORDS,
    clockTime,
    DownloadError,
    downloadMyRunner,
    guessSystem,
    OS_WORDS,
    refineArch,
    sizeWords,
    saveBlob,
    startSteps,
    systemAvailable,
    useMyRunner,
    type AdminRunnerRow,
    type DownloadInfo,
    type DownloadMade,
    type EnrollmentStatus,
    type RunnerArch,
    type RunnerMine,
    type RunnerOs,
} from "./my-runner";
import "./runners.css";

const POLL_MS = 3000;
const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** The system a runner reported (Node's name for it), as offlineSteps() and OS_WORDS take it. */
const nodeOs = (os: string | null | undefined): RunnerOs | null => {
    const o = (os ?? "").toLowerCase();
    if (o === "win32" || o === "windows") return "windows";
    if (o === "darwin" || o === "mac" || o === "macos") return "mac";
    if (o === "linux") return "linux";
    return null;
};

/**
 * "Your runner" in Settings (`#/settings#runner`; docs/features/runner-settings.md). A runner is the program on your computer that runs
 * your tests: the person sets it up once here and every run they start, and their schedules, then go to it. States: not set up, waiting
 * for the computer, connected, offline, needs an update. People the server lets see every runner (canSeeEveryone) also get Everyone's runners,
 * its own section below, where they may remove one.
 */
export function YourRunnerSection() {
    const me = useMyRunner(5000);
    const [settingUp, setSettingUp] = useState(false);
    const scrolled = useRef(false);
    const runner = me.data?.runner ?? null;
    // `#/settings#runner` (where Run, the guide and old Runners links send people): bring the section into view once it has content.
    useEffect(() => {
        if (scrolled.current || !me.data) return;
        if (/#runner\b/.test(location.hash)) {
            scrolled.current = true;
            document.getElementById("runner")?.scrollIntoView({ block: "start" });
        }
    }, [me.data]);
    const state = !me.data ? null : !runner ? "not-set-up" : runner.status;
    return (
        <>
        <section className="card card-pad stack-sm" id="runner" aria-labelledby="runner-title" data-testid="your-runner" data-tour="your-runner" data-state={state ?? "loading"}>
            <div className="row">
                <Laptop size={18} aria-hidden />
                <h2 className="t-section" id="runner-title">
                    Your runner
                </h2>
                <span className="spacer" />
                {runner ? <Badge tone={STATUS_WORDS[runner.status].tone} tip={STATUS_WORDS[runner.status].tip}>{STATUS_WORDS[runner.status].label}</Badge> : me.data ? <Badge tone="warning">Not set up</Badge> : null}
            </div>
            {runner && !settingUp ? (
                <p className="t-secondary" data-testid="runner-head">
                    <b>{runner.name}</b>, last heard from {runner.lastSeenAt ? relativeTime(runner.lastSeenAt) : "never"}.
                </p>
            ) : (
                <p className="t-secondary">A runner is the program on your computer that runs your tests. Set it up once here: every run you start, and your schedules, then run on it.</p>
            )}
            {me.loading && !me.data ? (
                <Skeleton h={60} />
            ) : me.error && !me.data ? (
                <ErrorState error={friendlyError(me.error.message)} onRetry={me.reload} />
            ) : !runner || settingUp ? (
                <SetUpRunner
                    replacing={runner}
                    onCancel={runner ? () => setSettingUp(false) : undefined}
                    onConnected={async () => {
                        setSettingUp(false);
                        await me.reload();
                    }}
                />
            ) : (
                <RunnerDetails runner={runner} onChanged={me.reload} onSetUpAgain={() => setSettingUp(true)} />
            )}
        </section>
        {/* Only for someone the server lets see every runner (platform admins and the like): a missing field means no, so nothing is polled. */}
        {me.data?.canSeeEveryone === true && <EveryonesRunners mineId={runner?.id ?? null} />}
        </>
    );
}

/** The person's connected runner: its state, the computer, the switches, the check, updates, rename and Remove this computer. */
function RunnerDetails({ runner: r, onChanged, onSetUpAgain }: { runner: RunnerMine; onChanged: () => Promise<void>; onSetUpAgain: () => void }) {
    const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    const [renaming, setRenaming] = useState(false);
    const [name, setName] = useState("");
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const act = async (fn: () => Promise<unknown>, done: string, failed: string) => {
        setBusy(true);
        setNote(null);
        try {
            await fn();
            setNote({ tone: "success", text: done });
            setRenaming(false);
            setConfirming(false);
            await onChanged();
        } catch (e) {
            setNote({ tone: "danger", text: message(e, failed) });
        } finally {
            setBusy(false);
        }
    };
    const os = nodeOs(r.os);
    const u = r.update;
    return (
        <div className="stack-sm" data-testid="runner-details">
            {note && <Callout tone={note.tone}>{note.text}</Callout>}
            {r.status === "offline" && (
                <Callout tone="warning" title="Your runner is offline">
                    <div className="stack-sm" data-testid="runner-offline-help">
                        <p>Nothing has been heard from it {r.lastSeenAt ? `since ${relativeTime(r.lastSeenAt)}` : "yet"}. It runs only while its computer is on, signed in and online. Runs can’t start until it is back online. Schedules wait for it.</p>
                        <ul className="ag-steps">
                            {offlineSteps(os).map((step) => (
                                <li key={step}>{step}</li>
                            ))}
                        </ul>
                    </div>
                </Callout>
            )}
            {r.currentRun && (
                <p className="t-secondary" data-testid="runner-current">
                    Running now: <a href={routes.run(r.currentRun.projectId, r.currentRun.jobId)}>{r.currentRun.title}</a>
                </p>
            )}
            {u && <RunnerUpdates name={r.name} update={u} version={r.version ?? undefined} online={r.status !== "offline"} onChanged={onChanged} />}
            <RunnerCheckNote check={r.check} name={r.name} />
            <details className="disclosure" data-testid="runner-more">
                <summary>
                    <ChevronRight size={16} className="chev" aria-hidden />
                    Details
                </summary>
                <div className="inner stack-sm">
                    <div className="ag-facts" data-testid="runner-facts">
                        {r.hostname && (
                            <span>
                                Computer <b>{r.hostname}</b>
                            </span>
                        )}
                        {os && (
                            <span>
                                System <b>{OS_WORDS[os]}</b>
                            </span>
                        )}
                        {r.arch && (
                            <span>
                                Processor <b>{r.arch}</b>
                            </span>
                        )}
                        <span>
                            Runner version <b>{r.version ?? "Unknown"}</b>
                        </span>
                    </div>
                    {r.network && (
                        <p className="t-secondary" data-testid="runner-network">
                            {r.network}
                        </p>
                    )}
                    {r.check && (
                        <>
                            <p className="t-card">Check this computer</p>
                            <RunnerCheckDetails check={r.check} />
                        </>
                    )}
                </div>
            </details>
            <RunnerSwitches runner={r} onChanged={onChanged} />
            {renaming ? (
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <label className="sr-only" htmlFor="runner-rename">
                        New name for {r.name}
                    </label>
                    <input id="runner-rename" className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 320 }} />
                    <Button size="sm" variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void act(() => api("/me/runner", { method: "PATCH", body: { name: name.trim() } }), `Your runner is now called “${name.trim()}”.`, "The runner was not renamed. Try again.")}>
                        Save name
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>
                        Cancel
                    </Button>
                </div>
            ) : confirming ? (
                <Callout
                    tone="warning"
                    title={`Remove ${r.name}?`}
                    actions={
                        <>
                            <Button size="sm" onClick={() => setConfirming(false)}>
                                Keep it
                            </Button>
                            <Button size="sm" variant="danger" loading={busy} onClick={() => void act(() => api("/me/runner/retire", { method: "POST" }), "This computer was removed. It can no longer connect.", "The computer was not removed. Try again.")}>
                                Remove this computer
                            </Button>
                        </>
                    }
                >
                    It can no longer connect, at once. A run it is working on goes back to the queue. To run tests again, set up your runner here.
                </Callout>
            ) : (
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <Button size="sm" icon={Pencil} onClick={() => (setName(r.name), setRenaming(true))}>
                        Rename
                    </Button>
                    <Button size="sm" icon={RefreshCw} onClick={onSetUpAgain}>
                        Set up a different computer
                    </Button>
                    <Button size="sm" variant="danger" icon={Trash2} onClick={() => setConfirming(true)}>
                        Remove this computer
                    </Button>
                </div>
            )}
        </div>
    );
}

/**
 * Not set up (or setting up a different computer): choose the system, download, then wait for the computer to connect with the
 * one-time code inside the download. One download per system: the installer on Windows and Mac, the plain files on Linux.
 */
function SetUpRunner({ replacing, onCancel, onConnected }: { replacing: RunnerMine | null; onCancel?: () => void; onConnected: () => Promise<void> }) {
    const info = useFetch<DownloadInfo>("/me/runner/download/info");
    const [os, setOs] = useState<RunnerOs>(() => guessSystem().os);
    const [arch, setArch] = useState<RunnerArch>(() => guessSystem().arch);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [made, setMade] = useState<({ os: RunnerOs } & DownloadMade) | null>(null);
    useEffect(() => {
        let gone = false;
        void refineArch(guessSystem()).then((g) => !gone && setArch((a) => (g.os === os ? g.arch : a)));
        return () => {
            gone = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // A server without the info route (or that refuses it) still offers the download: the download itself says why it cannot be made.
    const avail = systemAvailable(info.data, os, arch);
    const refused = info.data?.mayDownload === false;
    const download = async () => {
        setBusy(true);
        setError("");
        try {
            const out = await downloadMyRunner(os, arch, saveBlob);
            setMade({ os, ...out });
        } catch (e) {
            setError(e instanceof DownloadError || e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };
    if (made) return <WaitForComputer made={made} onConnected={onConnected} onAgain={() => setMade(null)} />;
    return (
        <div className="stack-sm" data-testid="runner-setup">
            {replacing && (
                <Callout tone="info" title="One runner per person">
                    Setting up a different computer removes {replacing.name} as soon as the new one connects.
                </Callout>
            )}
            {info.data?.urlOk === false && info.data.urlWarning && <Callout tone="warning">{info.data.urlWarning}</Callout>}
            <details className="disclosure" data-testid="runner-other-computer">
                <summary>
                    <ChevronRight size={16} className="chev" aria-hidden />
                    For another computer?
                </summary>
                <div className="inner">
                    <fieldset className="ark-os">
                        <legend className="sr-only">The computer the runner is for</legend>
                        <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
                            <div className="field">
                                <label htmlFor="runner-os">System</label>
                                <select id="runner-os" className="input" value={os} onChange={(e) => setOs(e.target.value as RunnerOs)}>
                                    {(Object.keys(OS_WORDS) as RunnerOs[]).map((o) => (
                                        <option key={o} value={o}>
                                            {OS_WORDS[o]}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="field">
                                <label htmlFor="runner-arch">Processor</label>
                                <select id="runner-arch" className="input" value={arch} onChange={(e) => setArch(e.target.value as RunnerArch)}>
                                    {(["x64", "arm64"] as RunnerArch[]).map((a) => (
                                        <option key={a} value={a}>
                                            {ARCH_WORDS[os][a]}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>
                    </fieldset>
                </div>
            </details>
            {refused ? (
                <div data-testid="runner-download-refused">
                    <Callout tone="warning">{info.data?.refusal ?? "You cannot set up a runner here."}</Callout>
                </div>
            ) : !avail.ok ? (
                <Callout tone="warning" title={`No download for ${OS_WORDS[os]} on this processor yet`}>
                    {avail.reason ?? "Ask whoever runs the platform to prepare the runner download."}
                </Callout>
            ) : avail.note ? (
                <p className="t-meta">{avail.note}</p>
            ) : null}
            {error && (
                <div data-testid="runner-download-error">
                    <Callout tone="danger">{error}</Callout>
                </div>
            )}
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                {!refused && (
                    <Button variant="primary" icon={Download} loading={busy} disabled={!avail.ok} onClick={() => void download()}>
                        Download for {OS_WORDS[os]}{avail.bytes ? ` (${sizeWords(avail.bytes)})` : ""}
                    </Button>
                )}
                {onCancel && (
                    <Button variant="ghost" onClick={onCancel}>
                        Cancel
                    </Button>
                )}
            </div>
            <p className="t-meta">The download holds a one-time code that connects the runner to your account. Keep it to yourself.</p>
        </div>
    );
}

/** After the download: what to do on the computer, and the connection noticed as soon as the runner trades its code. */
function WaitForComputer({ made, onConnected, onAgain }: { made: { os: RunnerOs } & DownloadMade; onConnected: () => Promise<void>; onAgain: () => void }) {
    const status = useFetch<EnrollmentStatus>(made.enrollmentId ? `/me/runner/enrollments/${encodeURIComponent(made.enrollmentId)}` : null, (d) => (d && d.status !== "waiting" ? null : POLL_MS));
    const s = status.data?.status;
    const connected = s === "connected" || s === "used";
    useEffect(() => {
        if (connected) void onConnected();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connected]);
    const how = startSteps(made.os, made.kind);
    return (
        <div className="stack-sm" data-testid="runner-waiting">
            <p className="t-secondary">
                Saved <b className="ark-file">{made.fileName}</b>. On the computer you chose:
            </p>
            {made.note && <p className="t-meta" data-testid="runner-kit-note">{made.note}</p>}
            <ol className="ag-steps">
                {how.steps.map((step) => (
                    <li key={step}>{boldScripts(step)}</li>
                ))}
            </ol>
            {how.command && <pre className="raw">{how.command}</pre>}
            {s === "expired" ? (
                <Callout tone="warning" title="The code in that download has expired" actions={<Button size="sm" onClick={onAgain}>Download again</Button>}>
                    A download works once, for a short while. Download the runner again and start it soon after.
                </Callout>
            ) : (
                <p className="ark-wait" role="status" data-testid="runner-wait">
                    Waiting for the computer to connect{made.expiresAt ? `. The code inside the download works once, until ${clockTime(made.expiresAt)}` : ""}.
                </p>
            )}
            <StillBlocked os={made.os} kind={made.kind} />
            <div>
                <Button size="sm" variant="ghost" onClick={onAgain}>
                    Back
                </Button>
            </div>
        </div>
    );
}

/** People who manage runners: every person's runner, with Remove (GET /api/admin/runners, POST /api/admin/runners/:id/retire). */
function EveryonesRunners({ mineId }: { mineId: string | null }) {
    const list = useFetch<{ runners: AdminRunnerRow[] }>("/admin/runners", () => 30_000);
    const [confirm, setConfirm] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    // A server that does not have the list (or refuses it) shows nothing here.
    if (!list.data) return null;
    const rows = list.data.runners;
    const retire = async (r: AdminRunnerRow) => {
        setBusy(true);
        setNote(null);
        try {
            await api(`/admin/runners/${encodeURIComponent(r.id)}/retire`, { method: "POST" });
            setNote({ tone: "success", text: `${r.ownerName ?? "Someone"}’s runner ${r.name} was removed. It can no longer connect.` });
            setConfirm(null);
            await list.reload();
        } catch (e) {
            setNote({ tone: "danger", text: message(e, "The runner was not removed. Try again.") });
        } finally {
            setBusy(false);
        }
    };
    return (
        <section className="card card-pad stack-sm" data-testid="everyones-runners" aria-labelledby="everyones-runners-title">
            <h2 className="t-section" id="everyones-runners-title">
                Everyone’s runners ({rows.length})
            </h2>
            <div className="stack-sm">
                {note && <Callout tone={note.tone}>{note.text}</Callout>}
                {rows.length > 0 && <BadgeKey label="the runner states" entries={(["online", "busy", "offline"] as const).map((k) => ({ word: STATUS_WORDS[k].label, text: STATUS_WORDS[k].tip }))} />}
                {rows.length === 0 ? (
                    <p className="t-secondary">Nobody has set up a runner yet.</p>
                ) : (
                    <ul className="list divided" aria-label="Everyone’s runners">
                        {rows.map((r) => {
                            const w = STATUS_WORDS[r.status] ?? STATUS_WORDS.offline;
                            return (
                                <li key={r.id} className="list-row" data-runner={r.id}>
                                    <span className="main">
                                        <span className="title truncate">
                                            {r.ownerName ?? "Someone"}: {r.name}
                                        </span>
                                        <span className="meta">
                                            {r.lastSeenAt ? `Last seen ${relativeTime(r.lastSeenAt)}` : "Never connected"}
                                            {r.version ? ` · version ${r.version}` : ""}
                                        </span>
                                    </span>
                                    <Badge tone={w.tone} tip={w.tip}>
                                        {w.label}
                                    </Badge>
                                    {r.id !== mineId &&
                                        (confirm === r.id ? (
                                            <>
                                                <Button size="sm" onClick={() => setConfirm(null)}>
                                                    Keep
                                                </Button>
                                                <Button size="sm" variant="danger" loading={busy} onClick={() => void retire(r)} aria-label={`Remove ${r.ownerName ?? "Someone"}’s runner ${r.name}`}>
                                                    Remove
                                                </Button>
                                            </>
                                        ) : (
                                            <Button size="sm" variant="ghost" onClick={() => setConfirm(r.id)} aria-label={`Remove ${r.ownerName ?? "Someone"}’s runner ${r.name}…`}>
                                                Remove
                                            </Button>
                                        ))}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </section>
    );
}

/** The Dashboard's line about the person's runner, with a link to Settings: only while it is not set up or offline (nothing to say otherwise). */
export function YourRunnerCard() {
    const me = useMyRunner(15_000);
    const r = me.data?.runner ?? null;
    // Nothing until the answer is in, so the card never shows and then disappears.
    if (!me.error && (!me.data || (r && r.status !== "offline"))) return null;
    return (
        <section className="card card-pad stack-sm" data-testid="dashboard-runner" aria-labelledby="dashboard-runner-title">
            <div className="row">
                <h2 className="t-section" id="dashboard-runner-title">
                    Your runner
                </h2>
                <span className="spacer" />
                {r && <Badge tone={STATUS_WORDS[r.status].tone}>{STATUS_WORDS[r.status].label}</Badge>}
                <a href={routes.yourRunner}>{r ? "Open Your runner" : "Set up your runner"}</a>
            </div>
            {!me.data ? (
                <ErrorState error={friendlyError(me.error!.message)} onRetry={me.reload} />
            ) : !r ? (
                <p className="t-secondary">A runner is the program on your computer that runs your tests. Set it up once in Settings, and every run you start goes to it.</p>
            ) : (
                <p className="t-secondary">
                    {r.name}: offline{r.lastSeenAt ? ` since ${relativeTime(r.lastSeenAt)}` : ""}. Start it on your computer to run tests.
                </p>
            )}
        </section>
    );
}
