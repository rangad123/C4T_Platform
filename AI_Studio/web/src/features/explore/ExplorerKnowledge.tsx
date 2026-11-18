import { ChevronRight, History, ImageOff, TriangleAlert } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { artifactUrl } from "../../api";
import { Callout, Metric } from "../../components/ui";
import { plural } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { reusedWord, siteTree, type Knowledge, type SiteNode } from "./knowledge";
import "./explore-tree.css";
import "./knowledge.css";

const TABS = ["map", "reused"] as const;
/** A reason as a sentence of its own: a capital first letter and a full stop. */
const sentence = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? "" : "."}`;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = { map: "Site map", reused: "Reused and why" };

/** A page's small picture; one whose file expired (or failed to load) says so instead. */
function Thumb({ id, path }: { id?: string; path: string }) {
    const [broken, setBroken] = useState(false);
    if (!id || broken) {
        return (
            <span className="xk-thumb is-none" aria-hidden>
                <ImageOff size={16} />
            </span>
        );
    }
    return <img className="xk-thumb" src={artifactUrl(id)} alt={`Picture of ${path}`} loading="lazy" width={160} height={100} onError={() => setBroken(true)} data-testid="xk-thumb" />;
}

function SitePage({ node, projectId }: { node: SiteNode; projectId: string }) {
    const [open, setOpen] = useState(true);
    const listId = useId();
    const p = node.page;
    return (
        <li className="xk-node" data-testid={`xk-page:${node.path}`}>
            <div className="xk-row">
                <Thumb id={p?.thumbnail} path={node.path} />
                <div className="xk-what">
                    <span className="xk-path">{node.path}</span>
                    {p ? (
                        <>
                            {p.title && <span className="xk-title">{p.title}</span>}
                            {p.reusedFrom && (
                                <span className="xt-badge is-info" data-testid="xk-reused">
                                    <History size={12} aria-hidden />
                                    {reusedWord(p.reusedFrom)}
                                </span>
                            )}
                            {p.tests.length ? (
                                <span className="xk-tests">
                                    Tested by{" "}
                                    {p.tests.map((t, i) => (
                                        <span key={t.id}>
                                            {i > 0 && ", "}
                                            <a href={routes.test(t.id)}>
                                                {t.testKey} {t.title}
                                            </a>
                                        </span>
                                    ))}
                                </span>
                            ) : (
                                <span className="t-meta">No test made in this exploration starts on this page.</span>
                            )}
                        </>
                    ) : (
                        <span className="t-meta">No page at this address itself; the pages under it were found.</span>
                    )}
                </div>
            </div>
            {node.children.length > 0 && (
                <>
                    <button type="button" className="xt-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
                        <ChevronRight size={14} className="chev" aria-hidden />
                        {open ? "Hide" : "Show"} {plural(node.children.length, "page")} under {node.path}
                    </button>
                    <ul id={listId} className="xk-list" hidden={!open}>
                        {node.children.map((c) => (
                            <SitePage key={c.path} node={c} projectId={projectId} />
                        ))}
                    </ul>
                </>
            )}
        </li>
    );
}

function SiteMap({ k, projectId }: { k: Knowledge; projectId: string }) {
    const tree = siteTree(k.siteMap.pages);
    if (!tree.length) return <p className="t-secondary">No pages were found yet.</p>;
    return (
        <div className="stack-sm">
            <p className="t-secondary" data-testid="xk-map-counts">
                {plural(k.siteMap.pages.length, "page")} found
                {k.thumbnails.count ? `, ${plural(k.thumbnails.count, "picture")} kept` : k.thumbnails.keep ? "" : ". Page pictures are switched off in Settings → General"}.
            </p>
            <ul className="xk-list xk-top" aria-label="Pages found">
                {tree.map((n) => (
                    <SitePage key={n.path} node={n} projectId={projectId} />
                ))}
            </ul>
        </div>
    );
}

function Reused({ k }: { k: Knowledge }) {
    const r = k.reused;
    const s = k.cacheSavings;
    const lines: string[] = [];
    if (r.pagesFromMemory) lines.push(`Started from ${plural(r.pagesFromMemory.pages, "page")} the last exploration knew, so deep pages were reached without walking the menus again${r.pagesFromMemory.gone ? `; ${plural(r.pagesFromMemory.gone, "known page is", "known pages are")} gone now and ${r.pagesFromMemory.gone === 1 ? "was" : "were"} left out` : ""}.`);
    if (r.signIn) lines.push(`Went straight to the sign-in page${r.signIn.path ? ` ${r.signIn.path}` : ""}${r.signIn.since ? ` known since ${r.signIn.since.slice(0, 10)}` : ""}; the form was still filled and the sign-in checked.`);
    if (r.understanding?.pages) lines.push(`${plural(r.understanding.pages, "unchanged page was", "unchanged pages were")} not sent to the AI again${r.understanding.of ? ` (of ${r.understanding.of})` : ""}.`);
    if (r.requirements?.total) lines.push(`${r.requirements.inAreas} of ${plural(r.requirements.total, "requirement")} reached the planning of the pages they are about; ${r.requirements.catchAll} were planned in a pass of their own.`);
    if (r.expired) lines.push(`${plural(r.expired, "page was", "pages were")} tried again because the earlier results were more than 30 days old or reused 5 times in a row.`);
    if (r.changed) lines.push(`${plural(r.changed, "page had", "pages had")} changed since the last exploration and ${r.changed === 1 ? "was" : "were"} tried again.`);
    if (r.reprobed) lines.push(`${plural(r.reprobed, "page was", "pages were")} tried again after reuse was switched off.`);
    const nothing = !r.pages.length && !lines.length && !k.reuseOff.length;
    return (
        <div className="stack-sm">
            {k.reuseOff.map((o, i) => (
                <Callout key={i} tone="warning" title="Reuse was switched off">
                    {sentence(o.reason)} Every page was tried again from then on.
                </Callout>
            ))}
            {nothing && <p className="t-secondary">Nothing was reused: every page was explored and tried in this run.</p>}
            {r.pages.length > 0 && (
                <div className="stack-sm">
                    <h3 className="t-card">Pages not tried again ({r.total || r.pages.length})</h3>
                    <p className="t-secondary">
                        These pages had not changed, so their menus, conditional fields and validation messages were taken from the exploration named. Tests, checks and validations are never taken from an earlier exploration. {plural(r.spotChecked, "page was", "pages were")} tried anyway as a spot check and matched.
                    </p>
                    <ul className="xk-reused" data-testid="xk-reused-list">
                        {r.pages.map((p) => (
                            <li key={p.path}>
                                <span className="xk-path">{p.path}</span>{" "}
                                <span className="xt-badge is-info">
                                    <History size={12} aria-hidden />
                                    {reusedWord(p.since)}
                                </span>
                            </li>
                        ))}
                    </ul>
                    {r.total > r.pages.length && <p className="t-meta">and {r.total - r.pages.length} more.</p>}
                </div>
            )}
            {lines.length > 0 && (
                <ul className="xk-lines" data-testid="xk-reuse-lines">
                    {lines.map((l) => (
                        <li key={l}>{l}</li>
                    ))}
                </ul>
            )}
            {s && (
                <div className="stack-sm" data-testid="xk-savings">
                    <h3 className="t-card">AI use and cache savings</h3>
                    <div className="metrics">
                        <Metric value={s.aiCalls} label="AI calls made" />
                        <Metric value={`${s.cacheReadPercent}%`} label="Input read from the prompt cache" tip="The share of the AI input the provider read from its prompt cache instead of processing again." />
                        <Metric value={s.cacheReadTokens.toLocaleString("en-US")} label="Cache read tokens" />
                        <Metric value={s.cacheWriteTokens.toLocaleString("en-US")} label="Cache write tokens" />
                        <Metric value={s.aiCallsSaved} label="AI calls saved" tip="Answers reused from the response cache, so no AI call was made for them." />
                        <Metric value={((s.savedInputTokens ?? 0) + (s.savedOutputTokens ?? 0)).toLocaleString("en-US")} label="Tokens saved" tip="The input and output tokens the answers reused from the response cache would have used." />
                    </div>
                </div>
            )}
        </div>
    );
}

/**
 * "What the explorer knows" for one exploration: its site map (the pages found, with their covered pictures and the tests that start on
 * each) and what it reused from the last exploration and why, with the AI cache figures for people who may see AI usage. One tab shows
 * at a time. Read while the exploration runs, every few seconds.
 */
export function ExplorerKnowledge({ projectId, jobId, active }: { projectId: string; jobId: string; active: boolean }) {
    const k = useFetch<Knowledge>(`/projects/${projectId}/jobs/${jobId}/knowledge`, () => (active ? 5000 : null));
    const [tab, setTab] = useState<Tab>("map");
    const buttons = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
    const base = useId();
    if (k.error) {
        return (
            <section className="card card-pad stack-sm" aria-labelledby={`${base}-h`} data-testid="explorer-knowledge">
                <h2 className="t-section" id={`${base}-h`}>
                    What the explorer knows
                </h2>
                <Callout tone="danger">{describeApiError(k.error)}</Callout>
            </section>
        );
    }
    const d = k.data;
    if (!d || (!d.siteMap.pages.length && !d.reuseOff.length && !d.reused.pages.length)) return null;
    const onKeys = (e: KeyboardEvent) => {
        const i = TABS.indexOf(tab);
        const next = e.key === "ArrowRight" ? TABS[(i + 1) % TABS.length] : e.key === "ArrowLeft" ? TABS[(i + TABS.length - 1) % TABS.length] : undefined;
        if (!next) return;
        e.preventDefault();
        setTab(next);
        buttons.current[next]?.focus();
    };
    const reusedCount = d.reused.total || d.reused.pages.length;
    return (
        <section className="card card-pad stack-sm" aria-labelledby={`${base}-h`} data-testid="explorer-knowledge">
            <h2 className="t-section" id={`${base}-h`}>
                What the explorer knows
            </h2>
            <p className="t-secondary" data-testid="xk-summary">
                {plural(d.siteMap.pages.length, "page")} found
                {reusedCount ? `, ${plural(reusedCount, "page")} reused from the last exploration` : ""}
                {d.reuseOff.length ? "; reuse was switched off" : ""}.
            </p>
            <div className="xk-tabs" role="tablist" aria-label="What the explorer knows" onKeyDown={onKeys}>
                {TABS.map((t) => (
                    <button
                        key={t}
                        ref={(el) => {
                            buttons.current[t] = el;
                        }}
                        type="button"
                        role="tab"
                        id={`${base}-tab-${t}`}
                        className="xk-tab"
                        aria-selected={tab === t}
                        aria-controls={`${base}-panel-${t}`}
                        tabIndex={tab === t ? 0 : -1}
                        onClick={() => setTab(t)}
                        data-testid={`xk-tab-${t}`}
                    >
                        {TAB_LABEL[t]}
                        {t === "reused" && d.reuseOff.length > 0 && <TriangleAlert size={14} aria-label="with a warning" />}
                    </button>
                ))}
            </div>
            <div role="tabpanel" id={`${base}-panel-${tab}`} aria-labelledby={`${base}-tab-${tab}`} data-testid={`xk-panel-${tab}`}>
                {tab === "map" ? <SiteMap k={d} projectId={projectId} /> : <Reused k={d} />}
            </div>
        </section>
    );
}
