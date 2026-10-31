import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api";
import { isPhoneUrl, packageOfUrl } from "../phone/phone";
import { ANNOUNCE_GAP_MS, EXPLORER_POLL_MS, keep, keptFor, type FrameAnswer, type Shown } from "./explorer-text";

/** The Explorer view's polling and timing hooks. The words and shapes are in explorer-text.ts. */

// ── polling ───────────────────────────────────────────────────────────────────

export type PanelState = "waiting" | "showing" | "nothing" | "elsewhere" | "stopping" | "unavailable" | "error";

export interface Watching {
    shown: Shown | null;
    state: PanelState;
    /** The platform's own words when it has no picture. */
    reason: string;
    /** Why the last request failed, in words. */
    problem: string;
}

/** True while this tab is in front. */
export function useTabVisible(): boolean {
    const [hidden, setHidden] = useState(typeof document !== "undefined" && document.hidden);
    useEffect(() => {
        const on = () => setHidden(document.hidden);
        document.addEventListener("visibilitychange", on);
        return () => document.removeEventListener("visibilitychange", on);
    }, []);
    return !hidden;
}

/**
 * Reads the platform's picture of a job while `on` (the panel is open, the job is running, the tab is in front). Stops by itself otherwise, backs off
 * when something goes wrong and never asks about a job that no longer exists.
 */
export function useExplorerFrames(projectId: string, jobId: string, on: boolean, pages: () => number): Watching {
    const [w, setW] = useState<Watching>(() => {
        const k = keptFor(jobId);
        return { shown: k?.shown ?? null, state: k ? "showing" : "waiting", reason: "", problem: "" };
    });
    const since = useRef<string | undefined>(undefined);
    const pagesRef = useRef(pages);
    pagesRef.current = pages;

    useEffect(() => {
        if (!on) return;
        let alive = true;
        let timer: number | undefined;
        let failures = 0;
        const tick = async () => {
            let wait = EXPLORER_POLL_MS;
            try {
                const q = since.current ? `?since=${encodeURIComponent(since.current)}` : "";
                const a = await api<FrameAnswer>(`/projects/${projectId}/jobs/${jobId}/frame${q}`);
                if (!alive) return;
                failures = 0;
                if (a.available) {
                    setW((cur) => {
                        const takenAt = Date.now() - (a.ageMs ?? 0);
                        let shown = cur.shown;
                        if (a.unchanged && shown) shown = { ...shown, takenAt };
                        else if (a.imageBase64) shown = { src: `data:image/jpeg;base64,${a.imageBase64}`, url: a.url ?? "", title: a.title ?? "", note: a.note ?? "", phase: a.phase ?? "", pagesSeen: a.screensSeen ?? a.pagesSeen ?? 0, at: a.at ?? "", takenAt, ...(a.kind === "phone" || isPhoneUrl(a.url) ? { kind: "phone" as const, app: a.app ?? packageOfUrl(a.url) } : {}) };
                        if (shown) keep(jobId, shown, Math.max(pagesRef.current(), shown.pagesSeen));
                        return { shown, state: "showing", reason: "", problem: "" };
                    });
                    since.current = a.at;
                } else {
                    const why = a.why ?? "nothing";
                    setW((cur) => ({ shown: cur.shown, state: why === "waiting" ? "waiting" : why === "elsewhere" ? "elsewhere" : why === "stopping" ? "stopping" : why === "unavailable" ? "unavailable" : "nothing", reason: a.reason ?? "", problem: "" }));
                }
            } catch (e) {
                if (!alive) return;
                const status = e instanceof ApiError ? e.status : 0;
                // Too many reads: slow down. Anything else in the 400s will not change by asking again.
                if (status === 429) {
                    wait = 3000;
                    // The platform answered, so an earlier failure is over; nothing new to say.
                    failures = 0;
                    setW((cur) => (cur.state === "error" ? { ...cur, state: cur.shown ? "showing" : "waiting", problem: "" } : cur));
                } else if (status >= 400 && status < 500) {
                    // "Not found" with no job named means the route itself is missing: a platform that was started before this feature existed.
                    const routeMissing = status === 404 && e instanceof ApiError && /^not found$/i.test(String(e.message).trim());
                    setW((cur) => ({
                        ...cur,
                        state: "error",
                        problem: routeMissing
                            ? "This platform has not been restarted since it was updated, so it cannot show pictures yet. Ask whoever runs it to restart it."
                            : "The platform no longer has this job, so there is no picture to show.",
                    }));
                    return;
                } else {
                    failures++;
                    wait = Math.min(12_000, 3000 * failures);
                    setW((cur) => ({ ...cur, state: "error", problem: "The picture could not be loaded. Trying again…" }));
                }
            }
            if (alive) timer = window.setTimeout(() => void tick(), wait);
        };
        void tick();
        return () => {
            alive = false;
            window.clearTimeout(timer);
        };
    }, [on, projectId, jobId]);

    return w;
}

/** A value that changes at most once per `gap` ms (the latest one wins): what a screen reader is told, so it is not talked over. */
export function useThrottled(value: string, gap: number = ANNOUNCE_GAP_MS): string {
    const [out, setOut] = useState(value);
    const last = useRef(0);
    useEffect(() => {
        if (value === out) return;
        const wait = gap - (Date.now() - last.current);
        if (wait <= 0) {
            last.current = Date.now();
            setOut(value);
            return;
        }
        const t = window.setTimeout(() => {
            last.current = Date.now();
            setOut(value);
        }, wait);
        return () => window.clearTimeout(t);
    }, [value, out, gap]);
    return out;
}

/** Re-renders every second while `on` (for "Updated 4 seconds ago"). */
export function useNow(on: boolean): number {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!on) return;
        const t = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(t);
    }, [on]);
    return now;
}
