import { Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, Callout } from "../../components/ui";
import { api, ApiError } from "../../api";
import { describeApiError } from "../../lib/labels";


interface LiveElement {
    index: number;
    tag: string;
    role?: string;
    name?: string;
    visible: boolean;
    enabled: boolean;
    value?: string;
    secret?: boolean;
}
interface LiveSnapshot {
    url: string;
    title: string;
    text: string;
    elements: LiveElement[];
    image?: string;
    imageType?: string;
}

/** At most one picture a second, only while the panel is open, the session is running and this tab is in front. */
export const LIVE_VIEW_GAP_MS = 1500;

export const updatedWords = (ms: number): string => (ms < 3000 ? "Updated just now" : `Updated ${Math.round(ms / 1000)} seconds ago`);

const elementLine = (e: LiveElement): string => {
    const what = e.role ?? e.tag;
    const flags = [e.visible ? "" : "not shown", e.enabled ? "" : "disabled", e.secret ? "secret field" : ""].filter(Boolean);
    return `${what}${e.name ? ` “${e.name}”` : ""}${e.value ? `, holds “${e.value}”` : ""}${flags.length ? ` (${flags.join(", ")})` : ""}`;
};

/** What the browser shows right now, for a session on this computer or on a runner agent. Closed until asked for, so it costs nothing otherwise. */
export function LiveView({ rid, running }: { rid: string; running: boolean }) {
    const [open, setOpen] = useState(false);
    const [snap, setSnap] = useState<LiveSnapshot | null>(null);
    const [at, setAt] = useState(0);
    const [now, setNow] = useState(Date.now());
    const [problem, setProblem] = useState("");
    const [hidden, setHidden] = useState(typeof document !== "undefined" && document.hidden);
    const alive = useRef(true);

    useEffect(() => {
        const onVisible = () => setHidden(document.hidden);
        document.addEventListener("visibilitychange", onVisible);
        return () => document.removeEventListener("visibilitychange", onVisible);
    }, []);

    const polling = open && running && !hidden;
    useEffect(() => {
        if (!polling) return;
        alive.current = true;
        let timer: number | undefined;
        const tick = async () => {
            let wait = LIVE_VIEW_GAP_MS;
            try {
                const s = await api<LiveSnapshot>(`/recordings/${rid}/snapshot?image=1`);
                if (!alive.current) return;
                setSnap(s);
                setAt(Date.now());
                setProblem("");
            } catch (e) {
                if (!alive.current) return;
                setProblem(describeApiError(e));
                // A refusal (an old agent, a session that ended) will not change by asking again; a lost connection might.
                if (e instanceof ApiError && e.status >= 400 && e.status < 500) return;
                wait = 4000;
            }
            if (alive.current) timer = window.setTimeout(() => void tick(), wait);
        };
        void tick();
        return () => {
            alive.current = false;
            window.clearTimeout(timer);
        };
    }, [polling, rid]);

    useEffect(() => {
        if (!polling) return;
        const t = window.setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [polling]);

    const title = snap ? snap.title || "The page" : "";
    return (
        <section className="card rec-live" aria-labelledby="rec-live-title">
            <div className="card-head wrap">
                <Eye size={18} aria-hidden />
                <h2 className="t-section" id="rec-live-title">
                    Live view
                </h2>
                <Button size="sm" variant="secondary" icon={open ? EyeOff : Eye} aria-expanded={open} aria-controls="rec-live-body" onClick={() => setOpen((o) => !o)}>
                    {open ? "Hide live view" : "Show live view"}
                </Button>
            </div>
            {open && (
                <div className="rec-live-body" id="rec-live-body">
                    {!running && <p className="hint">The session is not running, so there is nothing to show.</p>}
                    {problem && <Callout tone="warning" title="The live view isn’t available">{problem}</Callout>}
                    {hidden && running && <p className="hint">Paused while this tab is in the background.</p>}
                    {snap && (
                        <>
                            <p className="rec-live-meta">
                                <span className="rec-url" data-testid="live-url">{snap.url}</span>
                                <span className="hint" data-testid="live-updated">{updatedWords(now - at)}</span>
                            </p>
                            {snap.image ? (
                                <img className="rec-live-img" data-testid="live-image" src={`data:${snap.imageType ?? "image/png"};base64,${snap.image}`} alt={`${title}, at ${snap.url}`} />
                            ) : (
                                <p className="hint">No picture of the page this time. The list of elements below shows what is on it.</p>
                            )}
                            <details className="rec-live-els">
                                <summary>Elements on the page ({snap.elements.length})</summary>
                                {snap.elements.length === 0 ? (
                                    <p className="hint">Nothing to click or type into was found.</p>
                                ) : (
                                    <ul>
                                        {snap.elements.map((e) => (
                                            <li key={e.index}>{elementLine(e)}</li>
                                        ))}
                                    </ul>
                                )}
                            </details>
                        </>
                    )}
                    {!snap && !problem && running && <p className="hint">Loading the first picture…</p>}
                </div>
            )}
        </section>
    );
}
