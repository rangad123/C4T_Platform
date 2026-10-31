import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRoute } from "../../lib/router";
import { topics } from "./content";
import { placeOf, type PlaceId } from "./places";

/** What the Help panel is showing: the help for this page, one topic, a word, or search results. */
export type HelpView = { kind: "place" } | { kind: "topic"; id: string } | { kind: "word"; id: string } | { kind: "search"; q: string };

interface HelpApi {
    open: boolean;
    view: HelpView;
    /** The place the person is in now (the page may refine it with `useHelpPlace`). */
    place: PlaceId;
    /** Open the panel. `topic` shows that topic; if it does not exist, `query` is searched instead. */
    show: (opts?: { topic?: string; query?: string }) => void;
    close: () => void;
    toggle: () => void;
    setView: (v: HelpView) => void;
    setOverride: (p: PlaceId | null) => void;
}

const Ctx = createContext<HelpApi | null>(null);

/** Help state for the whole app: whether the panel is open, what it shows and which place the person is in. */
export function HelpProvider({ children }: { children: ReactNode }) {
    const route = useRoute();
    const [open, setOpen] = useState(false);
    const [view, setView] = useState<HelpView>({ kind: "place" });
    const [override, setOverride] = useState<PlaceId | null>(null);
    const opener = useRef<HTMLElement | null>(null);
    const place = override ?? placeOf(route);

    // The panel follows the person: a new page (or section) shows that page's help again.
    const key = `${route.parts.join("/")}?${route.query.toString()}`;
    const lastKey = useRef(key);
    useEffect(() => {
        if (lastKey.current === key) return;
        lastKey.current = key;
        setView({ kind: "place" });
    }, [key]);

    const remember = () => {
        const el = document.activeElement;
        opener.current = el instanceof HTMLElement && el !== document.body && !el.closest(".help-panel") ? el : null;
    };
    const show = useCallback((opts?: { topic?: string; query?: string }) => {
        remember();
        if (opts?.topic && topics.some((t) => t.id === opts.topic)) setView({ kind: "topic", id: opts.topic });
        else if (opts?.query) setView({ kind: "search", q: opts.query });
        else setView({ kind: "place" });
        setOpen(true);
    }, []);
    const close = useCallback(() => {
        setOpen(false);
        // Focus goes back to what opened the panel; if that is gone (a line that vanished once data loaded), to the Help button.
        const back = opener.current?.isConnected ? opener.current : visibleHelpButton();
        opener.current = null;
        window.setTimeout(() => back?.focus(), 0);
    }, []);
    const api = useMemo<HelpApi>(() => ({ open, view, place, show, close, toggle: () => (open ? close() : show()), setView, setOverride }), [open, view, place, show, close]);
    return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/** The first Help button that can be seen (the sidebar one is off screen on a phone). */
function visibleHelpButton(): HTMLElement | null {
    return Array.from(document.querySelectorAll<HTMLElement>("[data-help-button]")).find((b) => b.offsetParent !== null) ?? null;
}

const OFF: HelpApi = { open: false, view: { kind: "place" }, place: "projects", show: () => undefined, close: () => undefined, toggle: () => undefined, setView: () => undefined, setOverride: () => undefined };

/** The help state; outside the provider (a page rendered alone in a test) it does nothing. */
export function useHelp(): HelpApi {
    return useContext(Ctx) ?? OFF;
}

/** A page that is more specific than its address (the first-run welcome, the plan) says so, so Help shows the right text. */
export function useHelpPlace(place: PlaceId): void {
    const { setOverride } = useHelp();
    useEffect(() => {
        setOverride(place);
        return () => setOverride(null);
    }, [place, setOverride]);
}

/** The same as `useHelpPlace`, for a page that is only sometimes that place (rendered when it is). */
export function HelpPlace({ place }: { place: PlaceId }) {
    useHelpPlace(place);
    return null;
}
