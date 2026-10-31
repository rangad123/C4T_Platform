/**
 * Run control hooks: which run is going now, and one run read test by test and kept fresh. The shapes and sentences live in run-text.ts.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { api, type Job } from "../../api";
import { useFetch, type Fetched } from "../../lib/hooks";
import { isActive } from "../../lib/labels";
import { useJobStream, type JobStream } from "../../lib/stream";
import type { RunAnswer } from "./run-text";

export * from "./run-text";

// ── following runs ───────────────────────────────────────────────────────────

const EVENT = "aitp:runs-changed";

/** Tell the run strips and menus on this page that a run was started or stopped, so they look again at once. */
export const announceRunsChanged = (): void => void window.dispatchEvent(new Event(EVENT));

/**
 * One shared lookup per project for "which run is going now": every Run control and strip on a page reads the same answer, so a page
 * with three of them asks the platform once. It looks again when a run is started or stopped here, when the tab comes back, and every
 * few seconds while a run goes. Nothing runs while nothing is listening.
 */
interface ActiveStore {
    subscribe(l: () => void): () => void;
    get(): Job | undefined;
    load(): Promise<void>;
}
const activeStores = new Map<string, ActiveStore>();
function activeStoreFor(projectId: string): ActiveStore {
    const known = activeStores.get(projectId);
    if (known) return known;
    let job: Job | undefined;
    const listeners = new Set<() => void>();
    let timer: number | undefined;
    let flying: Promise<void> | undefined;
    const load = (): Promise<void> => {
        flying ??= api<Job[]>(`/projects/${projectId}/jobs`)
            .then((list) => {
                const now = list.find((j) => isActive(j.status));
                // Only a change is announced: the same answer again must not re-draw every page that listens.
                if (now?.jobId !== job?.jobId || now?.status !== job?.status) {
                    job = now;
                    listeners.forEach((l) => l());
                }
                clearTimeout(timer);
                timer = listeners.size && now ? window.setTimeout(() => void load(), 3000) : undefined;
            })
            .catch(() => undefined)
            .finally(() => {
                flying = undefined;
            });
        return flying;
    };
    const again = () => void load();
    const visible = () => !document.hidden && again();
    const store: ActiveStore = {
        get: () => job,
        load,
        subscribe(l) {
            listeners.add(l);
            if (listeners.size === 1) {
                window.addEventListener(EVENT, again);
                document.addEventListener("visibilitychange", visible);
                void load();
            }
            return () => {
                listeners.delete(l);
                if (listeners.size === 0) {
                    clearTimeout(timer);
                    timer = undefined;
                    window.removeEventListener(EVENT, again);
                    document.removeEventListener("visibilitychange", visible);
                    job = undefined;
                }
            };
        },
    };
    activeStores.set(projectId, store);
    return store;
}

/** The project's run that is going now, if any (see activeStoreFor). */
export function useActiveRun(projectId: string): { job: Job | undefined; reload: () => Promise<void> } {
    const store = activeStoreFor(projectId);
    const job = useSyncExternalStore(store.subscribe, store.get);
    return { job, reload: store.load };
}

/**
 * One run, test by test, kept fresh. While the live connection works it asks again whenever the platform says something changed (at
 * most about once a second) and checks every few seconds as a safety net; without it, it polls every couple of seconds, as the other pages do.
 */
export function useRunAnswer(projectId: string, jobId: string | null, following: boolean): Fetched<RunAnswer> & { stream: JobStream } {
    const live = useRef(false);
    const answer = useFetch<RunAnswer>(jobId ? `/projects/${projectId}/runs/${jobId}` : null, (d) => (d === undefined || d.active ? (live.current ? 6000 : 2500) : null));
    const stream = useJobStream(jobId, following || Boolean(answer.data?.active), () => void answer.reload());
    live.current = stream.live;
    const reload = useRef(answer.reload);
    reload.current = answer.reload;
    const marker = `${stream.events.length}/${stream.job?.status ?? ""}/${stream.job?.counters.testsValidated ?? 0}/${stream.job?.counters.testsFailedValidation ?? 0}`;
    useEffect(() => {
        if (marker === "0//0/0") return;
        const t = window.setTimeout(() => void reload.current(), 700);
        return () => clearTimeout(t);
    }, [marker]);
    return { ...answer, stream };
}

