import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type Job, type ProjectDetail, type ProjectRow, type TestSummary } from "../../api";
import { Tooltip } from "../../components/Tooltip";
import { go } from "../../lib/router";
import { useAuth } from "../auth/auth";
import { appState } from "../phone/phone";
import { includesSecurity, loadSecurityStatus, loadTestingType } from "../security/security";
import { resolveProject, useCurrentProject } from "./current-project";
import { chapterTitle, chaptersOf, counter, nextChapterStart, onPage, pageHref, stepsFor, type ChapterId, type TourHave, type TourStep } from "./tour-steps";

/** The browser's memory of the tour: seen once, so it is offered once. Every access is guarded, because storage can be blocked. */
export const TOUR_KEY = "guide.tour";
/** The step a person stopped at (its id), so the tour can offer to go on from there. Cleared when the tour is finished. */
export const TOUR_AT_KEY = "guide.tour.at";
const read = (key = TOUR_KEY): string | null => {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
};
const write = (v: string | null, key = TOUR_KEY) => {
    try {
        if (v === null) localStorage.removeItem(key);
        else localStorage.setItem(key, v);
    } catch {
        /* storage is blocked: the offer comes back on the next load, but not again in this one (see `offeredThisLoad`) */
    }
};
/** With storage blocked we cannot remember a choice, but we never ask twice in one visit. */
let offeredThisLoad = false;

/**
 * Whether to offer the tour on this visit: only to someone who has not seen it, never with `?notour=1`, and not to an
 * automated browser (a person new to the product is not a script). `?tour=1` asks for it anyway, which is how tests see the offer.
 */
export function offerWanted(): boolean {
    const where = `${location.search}${location.hash}`;
    if (/[?&]notour=1(?=&|#|$)/.test(where)) return false;
    const forced = /[?&]tour=1(?=&|#|$)/.test(where);
    if (!forced && (navigator as Navigator & { webdriver?: boolean }).webdriver) return false;
    return read() === null && !offeredThisLoad;
}

interface TourApi {
    active: boolean;
    /** Start the tour: at the chapter list, or straight at one chapter. */
    start: (chapter?: ChapterId) => void;
}
const Ctx = createContext<TourApi>({ active: false, start: () => undefined });
export const useTour = () => useContext(Ctx);

interface Session {
    steps: TourStep[];
    /** -1 is the chapter list; `steps.length` means the last step was passed and the tour is done. */
    index: number;
    /** Which way the person is moving, so a step that cannot be shown is passed over in that direction. */
    dir: 1 | -1;
    have: TourHave;
    /** Steps passed over because their element was not there; the counter leaves them out. */
    skipped: ReadonlySet<number>;
    /** A line for the chapter list (a chapter asked for that does not apply here). */
    note?: string;
}

/** What the tour needs to know before it starts, read with GET requests only. Anything that cannot be read is treated as missing. */
async function gather(account: boolean): Promise<TourHave> {
    const quiet = <T,>(p: Promise<T>): Promise<T | undefined> => p.catch(() => undefined);
    const have: TourHave = { account };
    const here = location.hash;
    let project = await quiet(resolveProject(here));
    if (!project) project = ((await quiet(api<ProjectRow[]>("/projects"))) ?? [])[0]?.id;
    const status = await quiet(loadSecurityStatus());
    have.module = status?.enabled === true;
    if (!project) return have;
    have.project = project;
    const [tests, detail, jobs, releases, type] = await Promise.all([
        quiet(api<TestSummary[]>(`/projects/${project}/tests`)),
        quiet(api<ProjectDetail>(`/projects/${project}`)),
        quiet(api<Job[]>(`/projects/${project}/jobs`)),
        quiet(api<{ releases?: Array<{ id: string }> }>(`/projects/${project}/releases`)),
        have.module ? quiet(loadTestingType(project)) : Promise.resolve(undefined),
    ]);
    const list = Array.isArray(tests) ? tests : [];
    // A person on a test's page sees that test; otherwise the project's first one.
    const parts = here.replace(/^#/, "").split("?")[0]!.split("/").filter(Boolean);
    const current = parts[0] === "tests" ? list.find((t) => t.id === parts[1]) : undefined;
    have.test = (current ?? list[0])?.id;
    have.failing = list.find((t) => t.validationStatus === "FAILED_VALIDATION")?.id ?? list.find((t) => t.validationStatus === "NEEDS_REVIEW")?.id;
    have.job = (Array.isArray(jobs) ? jobs[0] : undefined)?.jobId;
    have.release = releases?.releases?.[0]?.id;
    have.phone = appState(detail?.mobile) !== "none";
    have.security = Boolean(type?.available && includesSecurity(type.type));
    have.securityOnly = Boolean(type?.available && type.type === "security");
    return have;
}

export function TourProvider({ children }: { children: ReactNode }) {
    const [session, setSession] = useState<Session | null>(null);
    const starting = useRef(false);
    const auth = useAuth();
    const kind = auth.state?.me?.kind;
    const account = Boolean(kind) && kind !== "open";
    // Keeps note of the project the person is in, so a tour started from the Guide or Settings uses that one.
    useCurrentProject();

    const start = useCallback(
        (chapter?: ChapterId) => {
            if (starting.current) return;
            starting.current = true;
            offeredThisLoad = true;
            // A click handler passes its event: only a chapter id counts.
            const wanted = typeof chapter === "string" ? chapter : undefined;
            void (async () => {
                const have = await gather(account);
                const steps = stepsFor(have);
                const first = wanted ? steps.findIndex((s) => s.chapter === wanted) : -1;
                const note = wanted && first < 0 ? `${chapterTitle(wanted)} does not apply to this project, so it is left out.` : undefined;
                setSession({ steps, index: first, dir: 1, have, skipped: new Set(), ...(note ? { note } : {}) });
                starting.current = false;
            })();
        },
        [account],
    );

    const end = useCallback((how: "done" | "skipped" | "later", at?: string) => {
        write(how);
        // Stopping part of the way through is remembered, so the tour can offer to go on; finishing it forgets the place.
        write(how === "done" ? null : (at ?? read(TOUR_AT_KEY)), TOUR_AT_KEY);
        setSession(null);
    }, []);

    const value = useMemo<TourApi>(() => ({ active: session !== null, start }), [session, start]);
    return (
        <Ctx.Provider value={value}>
            {children}
            {session && (session.index < 0 ? <TourIntro session={session} setSession={setSession} end={end} /> : <TourCard session={session} setSession={setSession} end={end} />)}
            {!session && <TourOffer start={start} />}
        </Ctx.Provider>
    );
}

// ── the first-visit offer ───────────────────────────────────────────────────

function TourOffer({ start }: { start: () => void }) {
    const [show, setShow] = useState(false);
    useEffect(() => {
        if (!offerWanted()) return;
        // Wait a moment so the page is there first, and so the offer never fights a page that is still loading.
        const t = window.setTimeout(() => {
            if (offerWanted()) {
                offeredThisLoad = true;
                setShow(true);
            }
        }, 900);
        return () => window.clearTimeout(t);
    }, []);
    if (!show) return null;
    return (
        <section className="tour-offer" role="region" aria-label="Tour offer">
            <p className="tour-offer-text">New here? Take the guided tour, one chapter at a time.</p>
            <div className="tour-actions">
                <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => {
                        setShow(false);
                        write("started");
                        start();
                    }}
                >
                    Start the tour
                </button>
                <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                        setShow(false);
                        write("later");
                    }}
                >
                    Not now
                </button>
            </div>
        </section>
    );
}

type SetSession = (f: (s: Session | null) => Session | null) => void;
type End = (how: "done" | "skipped" | "later", at?: string) => void;

/** The first not-passed-over step from `from` going `dir`, or -1 / `steps.length` past either end. */
function landing(s: Session, from: number, dir: 1 | -1): number {
    let i = from;
    while (i >= 0 && i < s.steps.length && s.skipped.has(i)) i += dir;
    return i;
}

/** Escape ends the tour from anywhere, unless something on the page used it first (an open menu or dialog closes instead). */
function useEscape(onEscape: () => void) {
    useEffect(() => {
        const esc = (e: KeyboardEvent) => {
            if (e.key === "Escape" && !e.defaultPrevented) onEscape();
        };
        document.addEventListener("keydown", esc);
        return () => document.removeEventListener("keydown", esc);
    }, [onEscape]);
}

// ── the chapter list ────────────────────────────────────────────────────────

function TourIntro({ session, setSession, end }: { session: Session; setSession: SetSession; end: End }) {
    const chapters = chaptersOf(session.steps);
    const first = useRef<HTMLButtonElement>(null);
    const savedId = read(TOUR_AT_KEY);
    const savedAt = savedId ? session.steps.findIndex((s) => s.id === savedId) : -1;
    const saved = savedAt >= 0 ? session.steps[savedAt]! : undefined;
    const open = (index: number) => setSession((s) => (s ? { ...s, index, dir: 1 } : s));
    useEffect(() => first.current?.focus(), []);
    useEscape(useCallback(() => end("skipped"), [end]));
    return (
        <section className="tour-card is-plain is-intro" role="region" aria-label="Guided tour">
            <div aria-live="polite" aria-atomic="true">
                <h2 className="tour-title">Take the tour</h2>
                <p className="tour-text">
                    {session.steps.length} {session.steps.length === 1 ? "step" : "steps"} in {chapters.length} {chapters.length === 1 ? "chapter" : "chapters"}. Skip a chapter or stop at any time; this browser remembers where you stopped.
                </p>
                {session.note && <p className="tour-note">{session.note}</p>}
            </div>
            {saved && (
                <div className="tour-resume">
                    <button type="button" className="btn btn-primary btn-sm" ref={first} onClick={() => open(savedAt)}>
                        Continue where you stopped
                    </button>
                    <span className="t-meta">
                        {saved.title}, in {chapterTitle(saved.chapter)}
                    </span>
                </div>
            )}
            <ol className="tour-chapter-list" aria-label="Chapters">
                {chapters.map((c) => (
                    <li key={c.id}>
                        <button type="button" className="btn btn-sm tour-chapter" onClick={() => open(c.first)} aria-describedby={`tour-ch-${c.id}`}>
                            {c.title}
                        </button>
                        <span className="t-meta" id={`tour-ch-${c.id}`}>
                            {c.count} {c.count === 1 ? "step" : "steps"}. {c.about}
                        </span>
                    </li>
                ))}
            </ol>
            <div className="tour-actions">
                <button type="button" className={`btn btn-sm${saved ? "" : " btn-primary"}`} ref={saved ? undefined : first} onClick={() => open(0)}>
                    Start from the beginning
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => end("skipped")}>
                    Not now
                </button>
            </div>
        </section>
    );
}

// ── the tour card ───────────────────────────────────────────────────────────

const find = (target: string) => document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
/** A target counts as there when it has a size and is inside the window sideways (the menu of a phone is off to the side). */
const visible = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth;
};
const PHONE = "(max-width: 639px)";

function TourCard({ session, setSession, end }: { session: Session; setSession: SetSession; end: End }) {
    const done = session.index >= session.steps.length;
    const step = session.steps[Math.min(session.index, session.steps.length - 1)]!;
    const { position, total } = counter(session.index, session.steps.length, session.skipped);
    const prev = landing(session, session.index - 1, -1);
    const nextIndex = landing(session, session.index + 1, 1);
    const last = nextIndex >= session.steps.length;
    const chapterNext = nextChapterStart(session.steps, session.index);
    const lastChapter = chapterNext < 0 || landing(session, chapterNext, 1) >= session.steps.length;
    const chapters = chaptersOf(session.steps);
    const card = useRef<HTMLElement>(null);
    const nextBtn = useRef<HTMLButtonElement>(null);
    const [rect, setRect] = useState<DOMRect | null>(null);
    /** The element the card points at right now: the step's target, or its alternative. */
    const [shown, setShown] = useState<string | null>(null);
    /** The step whose element has been found (the card is hidden until then, and a hidden card cannot hold focus). */
    const [found, setFound] = useState(-1);
    const [place, setPlace] = useState<{ top: number; left: number; index: number } | null>(null);
    const phone = typeof matchMedia === "function" && matchMedia(PHONE).matches;

    useEffect(() => {
        if (done) end("done");
    }, [done, end]);

    /** Go `dir` steps on, passing over the steps already known to be missing; `skipThis` marks the current one as missing. */
    const move = useCallback(
        (dir: 1 | -1, skipThis = false) =>
            setSession((s) => {
                if (!s) return s;
                const skipped = skipThis ? new Set([...s.skipped, s.index]) : s.skipped;
                const moved = { ...s, skipped };
                let index = landing(moved, s.index + dir, dir);
                // Nothing left behind: go forward from where we are instead (the first steps were all passed over).
                if (index < 0) index = landing(moved, s.index + 1, 1);
                return { ...moved, index, dir: index < s.index ? -1 : 1 };
            }),
        [setSession],
    );
    const jump = useCallback((index: number) => setSession((s) => (s ? { ...s, index: landing(s, index, 1), dir: 1 } : s)), [setSession]);

    // Take the person to the page the step is about. The tour only opens pages.
    useEffect(() => {
        if (done) return;
        if (!onPage(step.page, location.hash, session.have)) {
            const href = pageHref(step.page, session.have);
            if (href) go(href);
        }
        // Only when the step changes: a person who then goes elsewhere on their own is not pulled back.
    }, [session.index]); // eslint-disable-line react-hooks/exhaustive-deps

    // Find the element, wait for it while the page loads, and pass over the step quietly if it never shows.
    useEffect(() => {
        setRect(null);
        setPlace(null);
        setShown(null);
        if (done || !step.target) return;
        let el: HTMLElement | null = null;
        let tries = 0;
        let hidden = 0;
        const timer = window.setInterval(() => {
            tries++;
            const main = find(step.target!);
            // An alternative is used only once the page had a moment to show the target itself.
            const other = step.alt && tries > 12 ? find(step.alt) : null;
            const pick = main && visible(main) ? main : other && visible(other) ? other : null;
            // Something that exists but cannot be seen will not appear by waiting (the menu of a phone, off to the side). A tab scrolled
            // out of its row is brought into view first.
            if (main && !visible(main) && !(other && visible(other))) {
                if (hidden === 0) main.scrollIntoView?.({ block: "nearest", inline: "nearest" });
                hidden++;
            }
            if (pick) {
                window.clearInterval(timer);
                el = pick;
                el.classList.add("tour-target");
                // Near the top of the window (below the top bar, see `.tour-target` in guide.css), so the card fits below it.
                el.scrollIntoView?.({ block: "start", inline: "nearest" });
                setShown(pick === main ? step.target! : step.alt!);
                setRect(el.getBoundingClientRect());
                setFound(session.index);
            } else if (tries > 30 || hidden > 3) {
                window.clearInterval(timer);
                move(session.dir, true);
            }
        }, 100);
        return () => {
            window.clearInterval(timer);
            el?.classList.remove("tour-target");
            // A step that was passed over before the element showed never got the class, but be sure.
            find(step.target!)?.classList.remove("tour-target");
            if (step.alt) find(step.alt)?.classList.remove("tour-target");
        };
    }, [session.index]); // eslint-disable-line react-hooks/exhaustive-deps

    // Keep the card next to its element while the window changes, the page scrolls, or the page moves the element as it loads.
    useEffect(() => {
        if (!shown) return;
        let last = "";
        const again = () => {
            const el = find(shown);
            if (!el || !visible(el)) return;
            const r = el.getBoundingClientRect();
            const key = `${Math.round(r.top)},${Math.round(r.left)},${Math.round(r.width)},${Math.round(r.height)}`;
            if (key !== last) {
                last = key;
                setRect(r);
            }
        };
        // A section that fills in after its data arrives moves what is below it without any event: look again now and then.
        const watch = window.setInterval(again, 250);
        addEventListener("resize", again);
        addEventListener("scroll", again, true);
        return () => {
            window.clearInterval(watch);
            removeEventListener("resize", again);
            removeEventListener("scroll", again, true);
        };
    }, [shown]);

    // Below the element when it fits, else above it, else at the bottom of the window: never off screen. A phone uses the full width.
    useLayoutEffect(() => {
        if (!rect || !card.current) return;
        const w = card.current.offsetWidth;
        const h = card.current.offsetHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let top = rect.bottom + 12;
        if (top + h > vh - 12) top = rect.top - h - 12;
        if (top < 12) top = Math.max(12, vh - h - 12);
        const left = phone ? 12 : Math.min(Math.max(12, rect.left), Math.max(12, vw - w - 12));
        setPlace({ top, left, index: session.index });
    }, [rect, phone, session.index]);

    // Each step takes the keyboard to its Next button, once, as soon as the card can be seen (a hidden card cannot take focus).
    const focusedFor = useRef(-1);
    useEffect(() => {
        const ready = !step.target || (found === session.index && place?.index === session.index);
        if (ready && focusedFor.current !== session.index) {
            focusedFor.current = session.index;
            nextBtn.current?.focus();
        }
    }, [found, place, session.index, step.target]);

    // Escape ends the tour (and remembers this step); the arrow keys go back and on while the keyboard is in the card or nowhere.
    useEscape(useCallback(() => end("skipped", step.id), [end, step.id]));
    useEffect(() => {
        const keys = (e: KeyboardEvent) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            const at = document.activeElement;
            if (at && at !== document.body && !card.current?.contains(at)) return;
            if (at instanceof HTMLElement && at.closest("details") && at.tagName === "SUMMARY") return;
            e.preventDefault();
            if (e.key === "ArrowRight") last ? end("done") : move(1);
            else if (prev >= 0) move(-1);
        };
        document.addEventListener("keydown", keys);
        return () => document.removeEventListener("keydown", keys);
    }, [last, prev, move, end]);

    if (done) return null;
    // A card that points at something waits (hidden) until that something is found, so a step that gets passed over is never seen.
    const placed = place?.index === session.index;
    const style = step.target ? (rect && placed ? { top: place.top, left: place.left, bottom: "auto" } : { visibility: "hidden" as const }) : undefined;
    return (
        <section ref={card} className={`tour-card${step.target ? "" : " is-plain"}`} role="region" aria-label="Guided tour" style={style}>
            <div aria-live="polite" aria-atomic="true">
                <p className="tour-count">
                    Step {position} of {total} · {chapterTitle(step.chapter)}
                </p>
                <h2 className="tour-title">{step.title}</h2>
                <p className="tour-text">{step.text}</p>
            </div>
            <div className="tour-actions">
                <button type="button" className="btn btn-sm" disabled={prev < 0} onClick={() => move(-1)}>
                    Back
                </button>
                <button type="button" className="btn btn-primary btn-sm" ref={nextBtn} onClick={() => (last ? end("done") : move(1))}>
                    {last ? "Finish" : "Next"}
                </button>
                {!lastChapter && (
                    <Tooltip content="Goes to the first step of the next chapter.">
                        <button type="button" className="btn btn-sm" onClick={() => jump(chapterNext)}>
                            Skip chapter
                        </button>
                    </Tooltip>
                )}
                <Tooltip content="Closes the tour. Take the tour again from Help to go on from this step.">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => end("skipped", step.id)}>
                        End tour
                    </button>
                </Tooltip>
            </div>
            <details className="tour-chapters">
                <summary>Chapters</summary>
                <ol aria-label="Chapters">
                    {chapters.map((c) => (
                        <li key={c.id}>
                            <button type="button" className="btn btn-ghost btn-sm" aria-current={c.id === step.chapter ? "step" : undefined} onClick={() => jump(c.first)}>
                                {c.title}
                            </button>
                        </li>
                    ))}
                </ol>
            </details>
        </section>
    );
}
