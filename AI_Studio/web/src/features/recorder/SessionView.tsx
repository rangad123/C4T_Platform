import { ListTree, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, Callout, EmptyState, ListSkeleton } from "../../components/ui";
import { Tooltip } from "../../components/Tooltip";
import { useFetch } from "../../lib/hooks";
import { Inspector } from "./Inspector";
import { LiveView } from "./LiveView";
import { SaveForm, type Saved } from "./SaveForm";
import { StepList } from "./StepList";
import { STATUS_WORD, agentOf, clock, rememberSession, useSession, type Recording } from "./recorder";
import { DiscardDialog } from "./DiscardDialog";
import { api, ApiError } from "../../api";
import { describeApiError } from "../../lib/labels";


/** One recording session: the status bar, the growing step list, the inspector and, once stopped, the save form. */
export function SessionView({ rid, projectId, onReset }: { rid: string; projectId: string; onReset: (lastUrl?: string) => void }) {
    const { rec, error, loading, apply, reload } = useSession(rid);
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState("");
    const [discard, setDiscard] = useState<null | "discard" | "again">(null);
    const [saved, setSaved] = useState<Saved | null>(null);
    const [canShare, setCanShare] = useState(true);
    const [announce, setAnnounce] = useState("");
    const [now, setNow] = useState(Date.now());

    // Shared elements exist only when the object repository answers; if it does not, "Use as shared element" never shows.
    const objects = useFetch<unknown>(`/projects/${projectId}/objects`);
    const shareHidden = !canShare || (objects.error as { status?: number } | undefined)?.status === 404;

    const live = rec?.status === "starting" || rec?.status === "recording";
    useEffect(() => {
        if (!live) return;
        const t = window.setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [live]);

    // Say "Step N recorded" once per new step, and keep the newest step in view only if the person was already at the bottom.
    const listRef = useRef<HTMLDivElement>(null);
    const stick = useRef(true);
    const seen = useRef<number | null>(null);
    const count = rec?.steps.length ?? 0;
    useEffect(() => {
        if (!rec) return;
        if (seen.current !== null && count > seen.current) {
            setAnnounce(`Step ${count} recorded`);
            const el = listRef.current;
            if (el && stick.current) el.scrollTop = el.scrollHeight;
        }
        seen.current = count;
    }, [rec, count]);

    async function act(fn: () => Promise<Recording>) {
        setBusy(true);
        setActionError("");
        try {
            apply(await fn());
        } catch (e) {
            setActionError(describeApiError(e));
        } finally {
            setBusy(false);
        }
    }

    if (loading) return <ListSkeleton rows={4} />;
    if (!rec) {
        const gone = error instanceof ApiError && error.status === 404;
        return (
            <Callout
                tone="danger"
                title={gone ? "This recording no longer exists" : "We couldn’t open this recording"}
                actions={
                    <>
                        {!gone && (
                            <Button size="sm" onClick={() => void reload()}>
                                Try again
                            </Button>
                        )}
                        <Button size="sm" variant={gone ? "primary" : "secondary"} onClick={() => { rememberSession(projectId, null); onReset(); }}>
                            Start again
                        </Button>
                    </>
                }
            >
                {gone ? "It was discarded, or the platform was restarted. Start a new recording." : (error?.message ?? "Something went wrong. Try again.")}
            </Callout>
        );
    }

    const onAgent = agentOf(rec);
    const end = rec.stoppedAt ? Date.parse(rec.stoppedAt) : now;
    const elapsed = clock(end - Date.parse(rec.startedAt));
    const editable = rec.status === "recording" || rec.status === "stopped";
    const savedView: Saved | null = saved ?? (rec.status === "saved" && rec.savedTestId ? { testId: rec.savedTestId, jobId: null } : null);
    const savedFromReload = !saved && !!savedView;

    return (
        <div className="stack rec-session">
            <section className={`card rec-bar is-${rec.status}`} aria-label="Recording status">
                <div className="rec-bar-main">
                    <span className="rec-state" data-testid="rec-state">
                        <span className="rec-dot" aria-hidden />
                        <span>
                            <b>{STATUS_WORD[rec.status]}</b>
                            {onAgent && (rec.status === "starting" || rec.status === "recording" || rec.status === "stopped") && ` on ${onAgent.name}`}
                        </span>
                    </span>
                    <Tooltip content={`The page the browser is on: ${rec.currentUrl ?? rec.startUrl}`}>
                        <span className="rec-url" data-testid="rec-url" tabIndex={0}>
                            {rec.currentUrl ?? rec.startUrl}
                        </span>
                    </Tooltip>
                    <span className="rec-stats">
                        <span data-testid="rec-count">{count === 1 ? "1 step" : `${count} steps`}</span>
                        <span data-testid="rec-elapsed">{elapsed}</span>
                    </span>
                </div>
                {rec.status !== "saved" && (
                    <div className="rec-bar-acts">
                        {live && (
                            <Button variant="primary" icon={Square} loading={busy} tip="Stops the recording browser. You can still change the steps, then save them as a test." onClick={() => void act(() => api<Recording>(`/recordings/${rid}/stop`, { method: "POST" }))}>
                                Stop recording
                            </Button>
                        )}
                        <Button variant="danger" onClick={() => setDiscard("discard")}>
                            Discard
                        </Button>
                    </div>
                )}
            </section>

            {rec.status === "failed" && (
                <Callout
                    tone="danger"
                    title="The recording stopped"
                    actions={
                        <Button size="sm" variant="primary" onClick={() => { rememberSession(projectId, null); onReset(rec.startUrl); }}>
                            Start again
                        </Button>
                    }
                >
                    {rec.error ?? "The browser window closed unexpectedly."}
                </Callout>
            )}
            {rec.status === "stopped" && rec.error && (onAgent ? <Callout tone="warning" title="The recording ended early">{rec.error}</Callout> : <Callout tone="info">{rec.error}</Callout>)}
            {rec.notes && rec.notes.length > 0 && (
                <Callout tone="neutral" title="Notes from the recorder">
                    {rec.notes.join(" ")}
                </Callout>
            )}
            {rec.status === "starting" && <Callout tone="info">Starting the browser window. {onAgent ? `It opens on ${onAgent.name}, not on this computer.` : "It opens on the computer that runs the platform."}</Callout>}
            {actionError && <Callout tone="danger">{actionError} Try again.</Callout>}

            <div className={`rec-grid${live ? "" : " is-single"}`}>
                <section className="card rec-steps-card" aria-labelledby="rec-steps-title">
                    <div className="card-head wrap">
                        <ListTree size={18} aria-hidden />
                        <h2 className="t-section" id="rec-steps-title">
                            Steps
                        </h2>
                    </div>
                    <p className="sr-only" role="status" aria-live="polite" data-testid="rec-announce">
                        {announce}
                    </p>
                    <div
                        className="rec-scroll"
                        ref={listRef}
                        tabIndex={0}
                        role="region"
                        aria-label="Recorded steps, scrollable"
                        onScroll={(e) => {
                            const el = e.currentTarget;
                            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
                        }}
                    >
                        {rec.steps.length === 0 ? (
                            <EmptyState icon={ListTree} title="No steps yet">
                                Your steps appear here as you click in the browser window.
                            </EmptyState>
                        ) : (
                            <StepList rid={rid} steps={rec.steps} editable={editable} canShare={!shareHidden} onChanged={apply} onShareUnavailable={() => setCanShare(false)} />
                        )}
                    </div>
                </section>
                {live && <Inspector rec={rec} onChanged={apply} />}
            </div>

            {live && <LiveView rid={rid} running={rec.status === "recording"} />}

            {rec.status === "stopped" || rec.status === "saved" ? (
                <SaveForm
                    rid={rid}
                    projectId={projectId}
                    canSave={rec.canSave}
                    saved={savedView}
                    onSaved={(s) => {
                        setSaved(s);
                        rememberSession(projectId, null);
                        void reload();
                    }}
                    onAgain={() => (savedView ? onReset(rec.startUrl) : setDiscard("again"))}
                />
            ) : null}
            {savedFromReload && <p className="hint">This recording was saved earlier.</p>}

            {discard && (
                <DiscardDialog
                    again={discard === "again"}
                    onClose={() => setDiscard(null)}
                    onConfirm={async () => {
                        await api(`/recordings/${rid}`, { method: "DELETE" });
                        rememberSession(projectId, null);
                        onReset(rec.startUrl);
                    }}
                />
            )}
        </div>
    );
}
