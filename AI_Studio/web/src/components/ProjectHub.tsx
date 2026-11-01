import { useEffect, useRef, useState, type ReactNode } from "react";
import { projectShape, type ProjectDetail } from "../api";
import { ProjectTabs, type PlaceKey } from "../pages/ProjectOverview";
import { EmbeddedContext } from "../lib/embedded";
import { useDocumentTitle, useFetch, useProjectChanged } from "../lib/hooks";
import { routes } from "../lib/router";
import { usePage } from "./Shell";
import { Callout, PageHeader } from "./ui";
import { Tooltip } from "./Tooltip";

export interface HubSection {
    key: string;
    label: string;
    /** What the section is for, one line (shown as its tooltip, read by screen readers after the name). */
    hint?: string;
    render: () => ReactNode;
}

/**
 * One of the project's places that holds several sections (Runs, Library, Release, Setup): the place's title and tab bar
 * on top, a labelled row of its sections, and the chosen section below. Each section is a page that used to stand alone;
 * it is shown "embedded", so it drops its own title, tab bar and breadcrumbs and the hub owns them.
 * Only the chosen section is mounted, so a section that polls or fetches costs nothing until it is opened.
 */
export function ProjectHub({ id, place, title, subtitle, sections, current, hrefOf, actions, below }: { id: string; place: PlaceKey; title: string; subtitle: ReactNode; sections: HubSection[]; current: string; hrefOf: (key: string) => string; actions?: ReactNode; below?: ReactNode }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    useProjectChanged(id, project.reload);
    const name = project.data?.name;
    const active = sections.find((s) => s.key === current) ?? sections[0]!;
    useDocumentTitle(name ? `${title} · ${name}` : title);
    usePage({ crumbs: [{ label: "Projects", href: routes.home }, { label: name ?? "…", href: routes.project(id) }, { label: title }], nav: "projects" });
    const nav = useRef<HTMLElement>(null);
    // On a narrow screen the row scrolls sideways: bring the open section into view.
    useEffect(() => {
        nav.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({ inline: "center", block: "nearest" });
    }, [active.key]);
    return (
        <>
            <PageHeader title={title} subtitle={subtitle} actions={actions} />
            <ProjectTabs id={id} active={place} count={project.data?.test_count} modes={project.data ? projectShape(project.data).testingModes : undefined} />
            {project.data?.archived_at && <ArchivedNote id={id} />}
            {below}
            <nav className="subtabs" aria-label={`${title} sections`} ref={nav}>
                {sections.map((s) => (
                    <Tooltip key={s.key} content={s.hint} placement="bottom">
                        <a className="subtab" href={hrefOf(s.key)} aria-current={s.key === active.key ? "page" : undefined} data-tour={`${place}-${s.key}`}>
                            {s.label}
                        </a>
                    </Tooltip>
                ))}
            </nav>
            <EmbeddedContext.Provider value={true}>
                <div className="hub-body" data-section={active.key} key={active.key}>
                    {active.render()}
                </div>
            </EmbeddedContext.Provider>
        </>
    );
}

/** A project place that is one page, not a hub of sections (Requirements, Test suites, Agent runs): its title, the tab bar, the page. */
export function ProjectPlace({ id, place, title, subtitle, actions, children }: { id: string; place: PlaceKey; title: string; subtitle: ReactNode; actions?: ReactNode; children: ReactNode }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    useProjectChanged(id, project.reload);
    const name = project.data?.name;
    useDocumentTitle(name ? `${title} · ${name}` : title);
    usePage({ crumbs: [{ label: "Projects", href: routes.home }, { label: name ?? "…", href: routes.project(id) }, { label: title }], nav: "projects" });
    return (
        <>
            <PageHeader title={title} subtitle={subtitle} actions={actions} />
            <ProjectTabs id={id} active={place} count={project.data?.test_count} modes={project.data ? projectShape(project.data).testingModes : undefined} />
            {project.data?.archived_at && <ArchivedNote id={id} />}
            <div className="stack">{children}</div>
        </>
    );
}

/**
 * A setting that is rarely changed: a titled row with a one-line summary and "Change". The form opens under it.
 * The summary stays visible after it opens, so the current value is never hidden.
 */
export function CollapsedSetting({ title, summary, children, defaultOpen, testId, extra, tour }: { title: string; summary: ReactNode; children: ReactNode; defaultOpen?: boolean; testId?: string; /** Another button beside Change (for example the one thing this setting is for). */ extra?: ReactNode; /** The guided tour points at this setting by this name. */ tour?: string }) {
    const [open, setOpen] = useState(defaultOpen ?? false);
    return (
        <section className="card" data-testid={testId} data-tour={tour}>
            <div className="setting-row">
                <div className="setting-text">
                    <h2 className="t-card">{title}</h2>
                    <p className="t-secondary">{summary}</p>
                </div>
                {extra}
                <button type="button" className="btn" aria-expanded={open} aria-label={`${open ? "Done with" : "Change"} ${title.toLowerCase()}`} onClick={() => setOpen(!open)}>
                    {open ? "Done" : "Change"}
                </button>
            </div>
            {open && <div className="setting-body">{children}</div>}
        </section>
    );
}


/** Shown on every place of an archived project (round 34): it is read-only until a Project Admin restores it. */
export function ArchivedNote({ id }: { id: string }) {
    return (
        <div style={{ marginBottom: 16 }} data-testid="archived-note">
            <Callout tone="info" title="This project is archived">
                It is read-only and starts no runs. A Project Admin can restore it in <a href={routes.projectSettings(id, "general")}>Settings → General</a>.
            </Callout>
        </div>
    );
}
