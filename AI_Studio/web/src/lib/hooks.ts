import { useCallback, useEffect, useRef, useState } from "react";
import { api, type PlatformConfig } from "../api.js";
import { useEmbedded } from "./embedded.js";

export interface Fetched<T> {
    data: T | undefined;
    error: Error | undefined;
    /** True only for the very first load of `path` (not for background refreshes). */
    loading: boolean;
    reload: () => Promise<void>;
}

/**
 * Fetch `path` (null = skip). With `pollMs`, fetch again after the returned delay; return null to stop
 * (e.g. once a job has finished). A failed background refresh keeps the data already on screen.
 */
export function useFetch<T>(path: string | null, pollMs?: (data: T | undefined) => number | null): Fetched<T> {
    const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: path !== null });
    const pollRef = useRef(pollMs);
    pollRef.current = pollMs;
    const runRef = useRef<() => Promise<void>>();

    useEffect(() => {
        if (path === null) {
            setState({ loading: false });
            return;
        }
        setState({ loading: true });
        let cancelled = false;
        let timer: number | undefined;

        const schedule = (d: T | undefined) => {
            const delay = pollRef.current?.(d);
            if (delay !== null && delay !== undefined) timer = window.setTimeout(() => void run(), delay);
        };
        const run = async () => {
            clearTimeout(timer);
            try {
                const d = await api<T>(path);
                if (cancelled) return;
                setState({ data: d, loading: false });
                schedule(d);
            } catch (e) {
                if (cancelled) return;
                setState((s) => (s.data !== undefined ? s : { error: e as Error, loading: false }));
                schedule(undefined);
            }
        };
        runRef.current = run;
        void run();
        return () => {
            cancelled = true;
            clearTimeout(timer);
            runRef.current = undefined;
        };
    }, [path]);

    const reload = useCallback(async () => {
        await runRef.current?.();
    }, []);
    return { data: state.data, error: state.error, loading: state.loading, reload };
}

/**
 * Run `onFinish` once when `active` flips from true to false (e.g. an analysis completes).
 * Polling stops the moment a job is no longer active, so data fetched just before that moment can be
 * stale; callers use this to refresh once more with the final state.
 */
export function useOnFinish(active: boolean, onFinish: () => void): void {
    const was = useRef(active);
    const cb = useRef(onFinish);
    cb.current = onFinish;
    useEffect(() => {
        if (was.current && !active) cb.current();
        was.current = active;
    }, [active]);
}

let configPromise: Promise<PlatformConfig> | undefined;
/** Server capabilities (AI configured, frameworks...). Fetched once per page load. */
export function useConfig(): PlatformConfig | undefined {
    const [cfg, setCfg] = useState<PlatformConfig>();
    useEffect(() => {
        configPromise ??= api<PlatformConfig>("/config");
        configPromise.then(setCfg).catch(() => {
            configPromise = undefined;
        });
    }, []);
    return cfg;
}

export function useDocumentTitle(title: string): void {
    const embedded = useEmbedded();
    useEffect(() => {
        // A section inside a hub leaves the title to the hub.
        if (embedded) return;
        document.title = title ? `${title} · AI Studio` : "AI Studio · Crowd4Test";
    }, [title, embedded]);
}

/**
 * A project's details changed on this page (for example its testing modes in Settings → General): every part showing that project
 * asks again, so the tab bar and headers follow at once instead of on the next page load.
 */
const PROJECT_CHANGED = "aitp:project-changed";
export function announceProjectChanged(id: string): void {
    window.dispatchEvent(new CustomEvent(PROJECT_CHANGED, { detail: id }));
}
export function useProjectChanged(id: string, reload: () => unknown): void {
    const ref = useRef(reload);
    ref.current = reload;
    useEffect(() => {
        const on = (e: Event) => {
            if ((e as CustomEvent<string>).detail === id) void ref.current();
        };
        window.addEventListener(PROJECT_CHANGED, on);
        return () => window.removeEventListener(PROJECT_CHANGED, on);
    }, [id]);
}

/**
 * Fetch `path` every few seconds while the page is visible. Polling stops when the tab is hidden and
 * picks up again, with an immediate refresh, when it is shown.
 */
export function usePolled<T>(path: string | null, everyMs = 5000): Fetched<T> {
    const f = useFetch<T>(path, () => (document.hidden ? null : everyMs));
    const { reload } = f;
    useEffect(() => {
        const on = () => {
            if (!document.hidden) void reload();
        };
        document.addEventListener("visibilitychange", on);
        return () => document.removeEventListener("visibilitychange", on);
    }, [reload]);
    return f;
}
