import { ArrowLeft, BookOpen, Compass, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Tooltip } from "../../components/Tooltip";
import { routes, useRoute } from "../../lib/router";
import { glossary, topics } from "./content";
import { useHelp, type HelpView } from "./HelpContext";
import { PLACES, type Target } from "./places";
import { searchGuide } from "./search";
import { TopicView, topicById, wordById } from "./TopicView";
import { useTour } from "./Tour";
import { useCurrentProject } from "./current-project";
import { useMedia } from "./useMedia";
import { whereToHref } from "./where";
import "./guide.css";

/** Wide enough to sit beside the page without covering it, and wide enough to float over it without hiding the page's controls. */
export const DOCK_QUERY = "(min-width: 1200px)";
export const FLOAT_QUERY = "(min-width: 1024px)";

/** A button or link for one `Target`: a topic opens inside the panel, a place or another tab of the test is an ordinary link. */
function TargetButton({ to, label, onView, className = "btn btn-sm" }: { to: Target; label: string; onView: (v: HelpView) => void; className?: string }) {
    const route = useRoute();
    const project = useCurrentProject();
    if ("topic" in to) {
        const known = Boolean(topicById(to.topic));
        return (
            <button type="button" className={className} onClick={() => onView(known ? { kind: "topic", id: to.topic } : { kind: "search", q: to.search ?? label })}>
                {label}
            </button>
        );
    }
    if ("search" in to)
        return (
            <button type="button" className={className} onClick={() => onView({ kind: "search", q: to.search })}>
                {label}
            </button>
        );
    const href = "where" in to ? whereToHref(to.where, project) : route.parts[0] === "tests" && route.parts[1] ? routes.testTab(route.parts[1], to.testTab) : null;
    if (!href)
        return (
            <button type="button" className={className} disabled>
                {label}
            </button>
        );
    return (
        <a className={className} href={href}>
            {label}
        </a>
    );
}

function PlaceView({ onView }: { onView: (v: HelpView) => void }) {
    const { place } = useHelp();
    const help = PLACES[place];
    const words = help.words.map(wordById).filter((w): w is NonNullable<typeof w> => Boolean(w));
    const topic = help.topic ? topicById(help.topic) : undefined;
    return (
        <>
            <section className="help-sec" aria-labelledby="help-what">
                <h3 id="help-what" className="help-sub">
                    What is this page
                </h3>
                <p>
                    <strong>{help.title}.</strong> {help.what}
                </p>
                {topic && (
                    <button type="button" className="btn-link help-more" onClick={() => onView({ kind: "topic", id: topic.id })}>
                        Read more: {topic.title}
                    </button>
                )}
            </section>
            <section className="help-sec" aria-labelledby="help-can">
                <h3 id="help-can" className="help-sub">
                    What you can do here
                </h3>
                <ul className="help-actions">
                    {help.canDo.map((a, i) => (
                        <li key={i}>
                            <span className="help-action-text">{a.text}</span>
                            <TargetButton to={a.to} label={a.button} onView={onView} />
                        </li>
                    ))}
                </ul>
            </section>
            {words.length > 0 && (
                <section className="help-sec">
                    <details className="help-words">
                        <summary>Words on this page ({words.length})</summary>
                        <dl className="guide-words">
                            {words.map((w) => (
                                <div key={w.id}>
                                    <dt>{w.term}</dt>
                                    <dd>{w.meaning}</dd>
                                </div>
                            ))}
                        </dl>
                    </details>
                </section>
            )}
            <section className="help-sec" aria-labelledby="help-next">
                <h3 id="help-next" className="help-sub">
                    What next
                </h3>
                <ul className="help-actions">
                    {help.next.map((n, i) => (
                        <li key={i}>
                            <span className="help-action-text">{n.text}</span>
                            <TargetButton to={n.to} label={n.button} onView={onView} />
                        </li>
                    ))}
                </ul>
            </section>
        </>
    );
}

function SearchView({ q, onView }: { q: string; onView: (v: HelpView) => void }) {
    const hits = useMemo(() => searchGuide(q, topics, glossary, 10), [q]);
    return (
        <section className="help-sec" aria-labelledby="help-results">
            <h3 id="help-results" className="help-sub">
                {hits.length === 0 ? "Nothing found" : `${hits.length} ${hits.length === 1 ? "result" : "results"}`}
            </h3>
            {hits.length === 0 ? (
                <>
                    <p>Nothing in the Guide matches “{q}”. Try fewer words, or a different way of saying it.</p>
                    <p>
                        Or start from what you want to do: <a href={routes.guide}>open the “I want to…” list</a>.
                    </p>
                </>
            ) : (
                <ul className="help-results">
                    {hits.map((h) => (
                        <li key={`${h.kind}-${h.id}`}>
                            <button type="button" onClick={() => onView({ kind: h.kind === "topic" ? "topic" : "word", id: h.id })}>
                                <span className="help-result-title">
                                    {h.title}
                                    {h.kind === "word" && <span className="help-result-kind"> (a word)</span>}
                                </span>
                                <span className="help-result-snippet">{h.snippet}</span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

/**
 * The Help panel. Docked beside the page on a wide screen, floating over its right edge on a middle one, and a full-height sheet
 * (a modal dialog: the page behind it is switched off) on a phone. It reads the place the person is in, so it follows them from
 * page to page. It never starts anything or changes anything: its buttons open topics and pages.
 */
export function HelpPanel() {
    const help = useHelp();
    const tour = useTour();
    const wide = useMedia(FLOAT_QUERY);
    const root = useRef<HTMLDivElement>(null);
    const title = useRef<HTMLHeadingElement>(null);
    const [q, setQ] = useState("");
    const view = help.view;
    const modal = !wide;

    // A topic opened from a "See how" line has no search text; a search view keeps what was typed.
    useEffect(() => {
        if (view.kind === "search") setQ((cur) => (cur.trim() === view.q ? cur : view.q));
        else if (view.kind === "place") setQ("");
    }, [view]);

    // On opening, focus goes to the panel's title so a screen reader reads where it is and the keyboard starts inside it.
    useEffect(() => {
        if (help.open) title.current?.focus();
    }, [help.open]);

    // A sheet is modal: the page behind it cannot be reached by keyboard, pointer or screen reader.
    useEffect(() => {
        if (!help.open || !modal) return;
        const shell = document.querySelector<HTMLElement>(".shell");
        shell?.setAttribute("inert", "");
        return () => shell?.removeAttribute("inert");
    }, [help.open, modal]);

    // Escape closes the panel when the keyboard is in it (and always for the sheet), without stealing Escape from a menu or dialog on the page.
    useEffect(() => {
        if (!help.open) return;
        const esc = (e: KeyboardEvent) => {
            if (e.key !== "Escape" || e.defaultPrevented) return;
            if (modal || root.current?.contains(document.activeElement)) help.close();
        };
        document.addEventListener("keydown", esc);
        return () => document.removeEventListener("keydown", esc);
    }, [help.open, modal, help.close]);

    if (!help.open) return null;

    const setView = (v: HelpView) => {
        help.setView(v);
        // Show the top of the new content, and keep the keyboard in the panel (the button that was pressed is gone).
        requestAnimationFrame(() => {
            const scroll = root.current?.querySelector<HTMLElement>(".help-scroll");
            scroll?.scrollTo?.({ top: 0 });
            if (root.current?.contains(document.activeElement) === false || document.activeElement === document.body) scroll?.focus({ preventScroll: true });
        });
    };
    const onTab = (e: React.KeyboardEvent) => {
        if (!modal || e.key !== "Tab") return;
        const items = Array.from(root.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input, select, summary, [tabindex]:not([tabindex='-1'])") ?? []).filter((el) => el.offsetParent !== null);
        const first = items[0];
        const lastItem = items[items.length - 1];
        if (!first || !lastItem) return;
        if (e.shiftKey && (document.activeElement === first || document.activeElement === title.current)) (e.preventDefault(), lastItem.focus());
        else if (!e.shiftKey && document.activeElement === lastItem) (e.preventDefault(), first.focus());
    };

    const word = view.kind === "word" ? wordById(view.id) : undefined;
    const topic = view.kind === "topic" ? topicById(view.id) : undefined;
    const body = (
        <div className="help-scroll" tabIndex={-1}>
            {view.kind !== "place" && (
                <button type="button" className="btn-link help-back" onClick={() => (setQ(""), setView({ kind: "place" }))}>
                    <ArrowLeft size={16} aria-hidden /> Help for this page
                </button>
            )}
            {view.kind === "place" && <PlaceView onView={setView} />}
            {view.kind === "search" && <SearchView q={view.q} onView={setView} />}
            {topic && <TopicView topic={topic} level={3} onTopic={(id) => setView({ kind: "topic", id })} />}
            {word && (
                <section className="help-sec">
                    <h3 className="t-section">{word.term}</h3>
                    <p>{word.meaning}</p>
                    {word.alsoCalled && word.alsoCalled.length > 0 && <p className="t-meta">Also called: {word.alsoCalled.join(", ")}</p>}
                    <a href={routes.guideWords}>See all words</a>
                </section>
            )}
            <div className="help-foot">
                <a className="btn btn-sm" href={routes.guide}>
                    <BookOpen size={16} aria-hidden /> Open the full guide
                </a>
                <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                        help.close();
                        tour.start();
                    }}
                >
                    <Compass size={16} aria-hidden /> Take the tour
                </button>
            </div>
        </div>
    );

    const props = modal
        ? ({ role: "dialog", "aria-modal": true, "aria-labelledby": "help-title" } as const)
        : ({ role: "complementary", "aria-label": "Help" } as const);
    return (
        <>
            {modal && <div className="help-scrim" onClick={help.close} aria-hidden />}
            <div id="help-panel" ref={root} className={`help-panel${modal ? " is-sheet" : ""}`} {...props} onKeyDown={onTab}>
                <div className="help-head">
                    <h2 id="help-title" className="t-section" tabIndex={-1} ref={title}>
                        Help
                    </h2>
                    <Tooltip content="Close help" placement="left">
                        <button type="button" className="btn btn-ghost btn-icon" aria-label="Close help" onClick={help.close}>
                            <X size={18} aria-hidden />
                        </button>
                    </Tooltip>
                </div>
                <form
                    className="help-search"
                    role="search"
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (q.trim()) setView({ kind: "search", q: q.trim() });
                    }}
                >
                    <div className="input-wrap">
                        <Search size={16} className="lead" aria-hidden />
                        <input
                            className="input"
                            type="search"
                            aria-label="Search the guide"
                            placeholder="Search, for example “run tests every night”"
                            value={q}
                            onChange={(e) => {
                                setQ(e.target.value);
                                if (e.target.value.trim()) help.setView({ kind: "search", q: e.target.value.trim() });
                                else help.setView({ kind: "place" });
                            }}
                        />
                    </div>
                </form>
                {body}
            </div>
        </>
    );
}
