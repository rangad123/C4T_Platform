/**
 * Steps 2 and 3 of "Add this computer" and "Add a team runner" (the Runners page): download the runner, which the server makes with a
 * one-time enrollment code inside, or make a code for a command; then wait for the computer to connect while the code's 30 minutes run.
 * A command's code is kept in the panel's state only; the download is saved by the browser and never read here.
 */
import { Check, ChevronRight, Copy, Download, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ApiError, api, type ProjectRow } from "../../api";
import { Button, Callout } from "../../components/ui";
import { downloadBlob } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { routes, useRoute } from "../../lib/router";
import { usePolled } from "../agents/agents";
import { boldScripts } from "../agents/bold";
import { checkComputerHelp } from "../agents/check";
import { CONNECT_POLL_MS, downloadEnrolledKit, downloadErrorText, startInstructions, TARGET_WORDS, waitLimitMs, type CompleteTarget, type EnrollScope, type KitDownload, type KitInfo, type KitKind, type KitPlatform } from "../agents/kit";
import { useCopy } from "../agents/TokensPanel";
import { UnsignedNotice } from "./UnsignedNotice";
import { CODE_LIFE_MS, codeLife, enrollCommand, findEnrolled, makeEnrollment, type EnrollmentState } from "./enroll";
import type { RunnersAnswer } from "./runners";

/** One code: its record (null from a server that does not name it) and when it expires. */
interface Ticket {
    id: string | null;
    expiresAt: string;
}

/** What this panel made: the runners listed before (so the new one can be told apart), the download and its code, the command's code. */
export interface Made {
    name: string;
    before: Set<string>;
    download: (KitDownload & Ticket) | null;
    command: (Ticket & { code: string }) | null;
}

/** The latest moment any of the panel's codes still works. */
const lastExpiry = (m: Made): string => [m.download?.expiresAt, m.command?.expiresAt].filter((x): x is string => Boolean(x)).sort().at(-1) ?? new Date(0).toISOString();

const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** A team runner's owner (an organisation, or Crowd4Test's shared runners) and the projects it may run from the start. */
export function TeamFields({ owners, owner, projectIds, onOwner, onProjects }: { owners: Array<{ id: string | null; label: string }>; owner: string | null; projectIds: string[]; onOwner: (o: string | null) => void; onProjects: (ids: string[]) => void }) {
    const projects = useFetch<ProjectRow[]>("/projects");
    // An organisation's runner serves that organisation's projects; a shared one any (the server checks again).
    const open = (projects.data ?? []).filter((p) => !p.archived_at && (owner === null || p.organization_id === owner));
    return (
        <div className="stack-sm" data-testid="team-fields">
            {owners.length > 1 && (
                <div className="field">
                    <label htmlFor="ark-owner">Owner</label>
                    <select id="ark-owner" className="input" value={owner ?? ""} onChange={(e) => onOwner(e.target.value || null)}>
                        {owners.map((o) => (
                            <option key={o.id ?? ""} value={o.id ?? ""}>
                                {o.label}
                            </option>
                        ))}
                    </select>
                </div>
            )}
            <fieldset className="ag-choices ark-os">
                <legend className="t-card">Projects it may run</legend>
                {projects.loading ? null : open.length === 0 ? (
                    <p className="t-secondary">No project to give it yet. You can give it projects later, on its page.</p>
                ) : (
                    <div className="stack-sm">
                        {open.map((p) => (
                            <label className="check" key={p.id}>
                                <input type="checkbox" checked={projectIds.includes(p.id)} onChange={(e) => onProjects(e.target.checked ? [...projectIds, p.id] : projectIds.filter((x) => x !== p.id))} />
                                <span>
                                    <span className="title">{p.name}</span>
                                </span>
                            </label>
                        ))}
                    </div>
                )}
                <p className="t-meta">You can change this later on the runner’s page.</p>
            </fieldset>
        </div>
    );
}

/** The code's remaining life, refreshed every 15 seconds while shown. */
function useCodeLife(expiresAt: string) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const t = window.setInterval(() => setNow(Date.now()), 15_000);
        return () => clearInterval(t);
    }, []);
    return codeLife(expiresAt, now);
}

function CodeLife({ expiresAt }: { expiresAt: string }) {
    const life = useCodeLife(expiresAt);
    return (
        <p className={life.expired ? "t-secondary" : "t-meta"} data-testid="code-life" data-expired={life.expired}>
            {life.text}
        </p>
    );
}

/** The code and the command for a developer's checkout, with a copy button. */
function CommandWithCode({ ticket }: { ticket: Ticket & { code: string } }) {
    const origin = typeof location === "undefined" ? "" : location.origin;
    const command = enrollCommand(origin, ticket.code);
    const { copied, copy } = useCopy(command);
    return (
        <div className="stack-sm" data-testid="enroll-command">
            <p className="t-secondary">For a computer with a checkout of AI Studio (after npm install), run this in a terminal in that folder. It connects the computer with the code, keeps the runner’s own credential and starts it.</p>
            <pre className="code ag-command" tabIndex={0} aria-label="Command to add this computer">
                <code>{command}</code>
            </pre>
            <div className="row">
                <Button size="sm" icon={copied ? Check : Copy} onClick={() => void copy()}>
                    {copied ? "Copied" : "Copy command"}
                </Button>
            </div>
            <CodeLife expiresAt={ticket.expiresAt} />
        </div>
    );
}

export function EnrollDownloadStep({
    scope,
    info,
    platform,
    kind,
    target,
    name,
    made,
    onMade,
    onBack,
    onNext,
}: {
    scope: EnrollScope;
    info: KitInfo | undefined;
    platform: KitPlatform;
    kind: KitKind;
    target: CompleteTarget;
    name: string;
    made: Made | null;
    onMade: (m: Made) => void;
    onBack: () => void;
    onNext: () => void;
}) {
    const [busy, setBusy] = useState<"" | "download" | "code">("");
    const [error, setError] = useState<{ title: string; text: string } | null>(null);
    // The command (and so the code) is on the page only once the person opens "Use a command instead".
    const [commandOpen, setCommandOpen] = useState(false);
    const canDownload = Boolean(info?.available);

    /** The runners listed before anything was made, so the new one can be told apart (kept for the panel's life). */
    async function base(): Promise<Made> {
        if (made) return made;
        const listed = await api<RunnersAnswer>("/runners").catch(() => null);
        return { name, before: new Set((listed?.runners ?? []).map((r) => r.id)), download: null, command: null };
    }

    async function download() {
        setBusy("download");
        setError(null);
        try {
            const m = await base();
            // The server makes the code and puts it in the zip; the answer says when it expires.
            const d = await downloadEnrolledKit(scope, name, platform, downloadBlob, kind, target);
            onMade({ ...m, download: { ...d, id: d.enrollmentId ?? null, expiresAt: d.expiresAt ?? new Date(Date.now() + CODE_LIFE_MS).toISOString() } });
        } catch (e) {
            setError({ title: "The download did not work", text: downloadErrorText(e).text });
        } finally {
            setBusy("");
        }
    }

    async function showCommand() {
        setBusy("code");
        setError(null);
        try {
            const m = await base();
            if (m.command && !codeLife(m.command.expiresAt).expired) return;
            const out = await makeEnrollment(scope, name);
            onMade({ ...m, command: { id: out.id ?? null, code: out.code, expiresAt: out.expiresAt } });
        } catch (e) {
            setError({ title: "No code was made", text: message(e, "The code was not made. Try again.") });
        } finally {
            setBusy("");
        }
    }

    return (
        <div className="ark-step">
            <Callout tone="info" title="The download holds a one-time code">
                The code connects one computer, once, within 30 minutes. After that it no longer works, and the runner keeps its own credential on that computer. You never see or copy a password.
            </Callout>

            {made?.download ? (
                <div className="stack-sm" role="status" data-testid="kit-downloaded">
                    <p className="ark-ok">
                        <Check size={18} aria-hidden />
                        <span>
                            Downloaded <b className="ark-file">{made.download.fileName}</b>.
                        </span>
                    </p>
                    <CodeLife expiresAt={made.download.expiresAt} />
                    {made.download.fellBack && (
                        <Callout tone="info" title="You got plain files, not the installer">
                            The installer is not ready on this server yet, so this download holds a start script instead.
                        </Callout>
                    )}
                    <p>Unzip it on the computer you are adding. Unzip means {platform === "windows" ? "right-click, then Extract all" : "double-click the file on a Mac, or run unzip on Linux"}.</p>
                </div>
            ) : canDownload ? (
                <p className="t-secondary">
                    {kind === "complete" ? (
                        <>
                            We make a complete download for <b>{name}</b> on {TARGET_WORDS[target]}. It holds its own Node.js and test tools, so nothing else is installed.
                        </>
                    ) : (
                        <>
                            We make a download for <b>{name}</b> on {platform === "windows" ? "Windows" : "Mac or Linux"}
                            {kind === "installer" ? ", with the installer" : ""}.
                        </>
                    )}
                </p>
            ) : (
                <p className="t-secondary">This server cannot make a download. Use the command below on a computer with the runner’s files.</p>
            )}

            {canDownload && <UnsignedNotice platform={platform} />}

            {error && (
                <Callout tone="danger" title={error.title} actions={<Button size="sm" onClick={() => void (canDownload ? download() : showCommand())}>Try again</Button>}>
                    {error.text}
                </Callout>
            )}

            {canDownload ? (
                <details className="disclosure" open={commandOpen} onToggle={(e) => setCommandOpen((e.currentTarget as HTMLDetailsElement).open)}>
                    <summary>
                        <ChevronRight size={16} className="chev" aria-hidden />
                        Use a command instead
                    </summary>
                    <div className="inner">
                        {!commandOpen ? null : made?.command ? (
                            <CommandWithCode ticket={made.command} />
                        ) : (
                            <Button size="sm" loading={busy === "code"} disabled={busy !== ""} onClick={() => void showCommand()}>
                                Show the command
                            </Button>
                        )}
                    </div>
                </details>
            ) : made?.command ? (
                <CommandWithCode ticket={made.command} />
            ) : (
                <div className="row">
                    <Button variant="primary" loading={busy === "code"} disabled={busy !== ""} onClick={() => void showCommand()}>
                        Show the command
                    </Button>
                </div>
            )}

            <div className="row">
                <Button variant="ghost" onClick={onBack}>
                    Back
                </Button>
                {canDownload && !made?.download && (
                    <Button variant="primary" icon={busy === "download" ? LoaderCircle : Download} loading={busy === "download"} disabled={busy !== ""} onClick={() => void download()}>
                        Download runner
                    </Button>
                )}
                {made && (
                    <Button variant="primary" onClick={onNext}>
                        Continue
                    </Button>
                )}
                {made?.download && (
                    <Button variant="ghost" loading={busy === "download"} disabled={busy !== ""} onClick={() => void download()}>
                        Download again
                    </Button>
                )}
            </div>
        </div>
    );
}

export function EnrollStartStep({ mode, platform, info, made, onBack, onRenew, onDone }: { mode: "personal" | "team"; platform: KitPlatform; info: KitInfo | undefined; made: Made; onBack: () => void; onRenew: () => void; onDone: () => void }) {
    const query = useRoute().query;
    const limit = useMemo(() => waitLimitMs(query), [query]);
    // Polls only while this step is on screen, and pauses while the tab is hidden.
    // The download's code (or else the command's) says when it was used; the list catches the other one, and a server without the record.
    const ticket = made.download?.id ? made.download : made.command?.id ? made.command : null;
    const state = usePolled<EnrollmentState>(ticket ? `/runners/enrollments/${ticket.id}` : null, CONNECT_POLL_MS);
    const polled = usePolled<RunnersAnswer>("/runners", CONNECT_POLL_MS);
    const [connected, setConnected] = useState<{ id: string; name: string } | null>(null);
    const [slow, setSlow] = useState(false);
    const life = useCodeLife(lastExpiry(made));

    useEffect(() => {
        if (connected) return;
        const r = state.data?.status === "used" ? state.data.runner : undefined;
        if (r && (r.status === "online" || r.status === "busy")) return setConnected({ id: r.id, name: r.name });
        if (!polled.data) return;
        const found = findEnrolled(polled.data.runners, { before: made.before, name: made.name });
        if (found) setConnected({ id: found.id, name: found.name });
    }, [state.data, polled.data, connected, made]);
    useEffect(() => {
        if (connected) return;
        const t = window.setTimeout(() => setSlow(true), limit);
        return () => clearTimeout(t);
    }, [connected, limit]);

    const kind = made.download?.kind;
    const how = kind ? startInstructions(platform, kind, info?.nodeMin ?? 24, { installerInside: platform === "windows" ? Boolean(info?.installer?.windows) : false }) : null;
    const address = info?.platformUrl || "this platform’s address";
    return (
        <div className="ark-step">
            {how ? (
                <>
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
                    <p className="t-secondary" data-testid="kit-check-help">
                        {boldScripts(checkComputerHelp(platform, kind!))}
                    </p>
                </>
            ) : made.command ? (
                <CommandWithCode ticket={made.command} />
            ) : null}

            {connected ? (
                <div className="ark-connected" role="status" data-testid="kit-status" data-state="connected">
                    <Callout tone="success" title={`Connected: ${connected.name} is online`} actions={<a href={routes.runner(connected.id)}>Open its page</a>}>
                        {mode === "personal"
                            ? "It runs the tests you start in projects that allow people’s own computers. You can delete the downloaded file now."
                            : "It runs the tests of the projects it was given; give it more on its page. You can delete the downloaded file now."}
                    </Callout>
                </div>
            ) : life.expired || (state.data?.status === "expired" && !made.command) ? (
                <div role="status" data-testid="kit-status" data-state="expired">
                    <Callout tone="warning" title="This code has expired" actions={<Button size="sm" onClick={onRenew}>Make a new code</Button>}>
                        The computer did not connect within 30 minutes. Make a new code and download again; the old download can’t connect any more.
                    </Callout>
                </div>
            ) : (
                <div role="status" aria-live="polite" data-testid="kit-status" data-state={slow ? "slow" : "waiting"}>
                    <p className="ark-wait">
                        <LoaderCircle size={18} className="spin" aria-hidden />
                        <span>{slow ? "Still waiting for the computer to connect." : "Waiting for the computer to connect…"}</span>
                    </p>
                    <CodeLife expiresAt={lastExpiry(made)} />
                </div>
            )}

            {!connected && slow && !life.expired && (
                <div className="ark-reasons" data-testid="kit-slow">
                    <p className="t-card">Still waiting. Common reasons:</p>
                    <ul>
                        {info && !info.urlOk && <li>The platform’s address{info.platformUrl ? ` (${info.platformUrl})` : ""} may not work from that computer. Ask whoever runs the platform to set its public address.</li>}
                        <li>The runner was not started, or its window was closed. Start it again as the steps above say.</li>
                        <li>The code was already used by another start. Make a new code and download again.</li>
                        <li>A firewall blocks outbound connections. The runner only calls out to {address}; ask your network admin to allow it.</li>
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
