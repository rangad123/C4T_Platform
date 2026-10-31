import { BookText, Compass, Search } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { usePage } from "../../components/Shell";
import { EmptyState, LinkButton, PageHeader } from "../../components/ui";
import { useDocumentTitle } from "../../lib/hooks";
import { routes, useRoute } from "../../lib/router";
import { glossary, topics, wants } from "./content";
import { searchGuide } from "./search";
import { TopicView, topicById } from "./TopicView";
import { useTour } from "./Tour";
import { CHAPTERS } from "./tour-steps";
import { GROUP_TITLES, type GroupId } from "./types";
import "./guide.css";

const GROUP_ORDER = Object.keys(GROUP_TITLES) as GroupId[];

function SearchBox({ q, onChange, label = "Search all topics" }: { q: string; onChange: (v: string) => void; label?: string }) {
    return (
        <div className="input-wrap guide-search">
            <Search size={16} className="lead" aria-hidden />
            <input className="input" type="search" aria-label={label} placeholder="Search, for example “run tests every night”" value={q} onChange={(e) => onChange(e.target.value)} />
        </div>
    );
}

/** The start of the Guide: what you want to do, then every topic by group, with a search over all of it. */
function GuideHome() {
    useDocumentTitle("Guide");
    usePage({ crumbs: [{ label: "Guide" }], nav: "guide" });
    const [q, setQ] = useState("");
    const tour = useTour();
    const hits = useMemo(() => (q.trim() ? searchGuide(q, topics, glossary, 20) : []), [q]);
    const searching = q.trim() !== "";
    return (
        <>
            <PageHeader
                title="Guide"
                subtitle="Plain explanations of everything in the platform. Start with what you want to do."
                actions={
                    <>
                        <LinkButton href={routes.guideWords} icon={BookText}>
                            Words
                        </LinkButton>
                        <button type="button" className="btn" onClick={() => tour.start()} data-tour="guide-tour">
                            <Compass size={18} aria-hidden /> Take the tour
                        </button>
                    </>
                }
            />
            <div className="stack">
                <SearchBox q={q} onChange={setQ} />
                {searching ? (
                    <section aria-label="Search results" aria-live="polite" className="stack-sm">
                        {hits.length === 0 ? (
                            <div className="card">
                                <EmptyState icon={Search} title="Nothing found" actions={<button type="button" className="btn" onClick={() => setQ("")}>Show what I want to do</button>}>
                                    Nothing in the Guide matches “{q.trim()}”. Try fewer words, or pick a goal from the “I want to…” list.
                                </EmptyState>
                            </div>
                        ) : (
                            <ul className="card list divided guide-hits">
                                {hits.map((h) => (
                                    <li key={`${h.kind}-${h.id}`}>
                                        <a className="list-row" href={h.kind === "topic" ? routes.guideTopic(h.id) : `${routes.guideWords}?word=${encodeURIComponent(h.id)}`}>
                                            <span className="main">
                                                <span className="title">
                                                    {h.title}
                                                    {h.kind === "word" && <span className="t-meta"> (a word)</span>}
                                                </span>
                                                <span className="meta">{h.snippet}</span>
                                            </span>
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                ) : (
                    <>
                        <section aria-labelledby="guide-want" className="stack-sm" data-tour="guide-wants">
                            <h2 id="guide-want" className="t-section">
                                I want to…
                            </h2>
                            <ul className="guide-wants">
                                {wants
                                    .filter((w) => topicById(w.topic))
                                    .map((w) => (
                                        <li key={w.text}>
                                            <a className="guide-want" href={routes.guideTopic(w.topic)}>
                                                {w.text}
                                            </a>
                                        </li>
                                    ))}
                            </ul>
                        </section>
                        <section aria-labelledby="guide-tour-h" className="stack-sm">
                            <h2 id="guide-tour-h" className="t-section">
                                The guided tour
                            </h2>
                            <p className="t-secondary">It opens each place and points at the thing it explains. It never changes anything. Start at any chapter; chapters that do not apply to your project are left out.</p>
                            <ul className="guide-tour-chapters">
                                {CHAPTERS.map((c) => (
                                    <li key={c.id}>
                                        <button type="button" className="btn" onClick={() => tour.start(c.id)} aria-describedby={`guide-ch-${c.id}`}>
                                            {c.title}
                                        </button>
                                        <span className="t-meta" id={`guide-ch-${c.id}`}>
                                            {c.about}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </section>
                        <section aria-labelledby="guide-all" className="stack-sm">
                            <h2 id="guide-all" className="t-section">
                                All topics
                            </h2>
                            <div className="guide-groups">
                                {GROUP_ORDER.map((g) => {
                                    const list = topics.filter((t) => t.group === g);
                                    if (list.length === 0) return null;
                                    return (
                                        <section key={g} className="guide-group" aria-labelledby={`group-${g}`}>
                                            <h3 id={`group-${g}`} className="t-card">
                                                {GROUP_TITLES[g]}
                                            </h3>
                                            <ul className="guide-index">
                                                {list.map((t) => (
                                                    <li key={t.id}>
                                                        <a href={routes.guideTopic(t.id)}>{t.title}</a>
                                                    </li>
                                                ))}
                                            </ul>
                                        </section>
                                    );
                                })}
                            </div>
                        </section>
                    </>
                )}
            </div>
        </>
    );
}

function TopicPage({ id }: { id: string }) {
    const topic = topicById(id);
    useDocumentTitle(topic ? `${topic.title} · Guide` : "Guide");
    usePage({ crumbs: [{ label: "Guide", href: routes.guide }, { label: topic?.title ?? "Topic not found" }], nav: "guide" });
    if (!topic)
        return (
            <>
                <PageHeader title="Guide" />
                <div className="card">
                    <EmptyState icon={Search} title="We can’t find that topic" actions={<LinkButton href={routes.guide} variant="primary">Open the Guide</LinkButton>}>
                        The address may be old. The Guide lists every topic, and you can search it.
                    </EmptyState>
                </div>
            </>
        );
    return (
        <div className="guide-page">
            <TopicView topic={topic} level={1} />
            <p className="guide-back">
                <a href={routes.guide}>All topics</a>
            </p>
        </div>
    );
}

/** Every word the platform uses, in alphabetical order, with a search that also knows the older names. */
function WordsPage() {
    const { query } = useRoute();
    const [q, setQ] = useState("");
    useDocumentTitle("Words · Guide");
    usePage({ crumbs: [{ label: "Guide", href: routes.guide }, { label: "Words" }], nav: "guide" });
    const list = useMemo(() => {
        if (q.trim()) {
            const ids = new Set(searchGuide(q, [], glossary, 50).map((h) => h.id));
            return glossary.filter((g) => ids.has(g.id));
        }
        return [...glossary].sort((a, b) => a.term.localeCompare(b.term, "en", { sensitivity: "base" }));
    }, [q]);
    const focus = query.get("word");
    useEffect(() => {
        if (focus) document.getElementById(`word-${focus}`)?.scrollIntoView?.({ block: "center" });
    }, [focus]);
    return (
        <>
            <PageHeader title="Words" subtitle="A short meaning for every word the platform uses." />
            <div className="stack">
                <SearchBox q={q} onChange={setQ} label="Search the words" />
                {list.length === 0 ? (
                    <div className="card">
                        <EmptyState icon={Search} title="No word like that" actions={<button type="button" className="btn" onClick={() => setQ("")}>Show every word</button>}>
                            Try fewer letters, or an older name such as hand-written or runbook.
                        </EmptyState>
                    </div>
                ) : (
                    <dl className="card card-pad guide-glossary">
                        {list.map((g) => (
                            <Fragment key={g.id}>
                                <dt id={`word-${g.id}`} className={focus === g.id ? "is-focus" : undefined}>
                                    {g.term}
                                </dt>
                                <dd>
                                    {g.meaning}
                                    {g.alsoCalled && g.alsoCalled.length > 0 && <span className="t-meta guide-aka"> Also called: {g.alsoCalled.join(", ")}.</span>}
                                </dd>
                            </Fragment>
                        ))}
                    </dl>
                )}
            </div>
        </>
    );
}

/** `#/guide`, `#/guide/words` and `#/guide/<topic>`. */
export function GuidePage() {
    const { parts } = useRoute();
    const [, second] = parts;
    if (second === "words") return <WordsPage />;
    if (second) return <TopicPage id={decodeURIComponent(second)} key={second} />;
    return <GuideHome />;
}
