import { useEffect, useState } from "react";
import { api, type ProjectRow } from "../../api";
import { LinkButton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { routes, useRoute } from "../../lib/router";
import type { WhereTo } from "./types";
import { needsProject, whereToHref } from "./where";

/** The last project the person had open, so a place that needs a project still has one after they visit a page without one. */
let lastProject: string | undefined;

/** Which project a test belongs to, asked once per test for the whole visit (the panel's buttons all want to know). */
const projectOfTest = new Map<string, Promise<string | undefined>>();
function askProjectOfTest(testId: string): Promise<string | undefined> {
    let p = projectOfTest.get(testId);
    if (!p) {
        p = api<{ projectId?: string }>(`/tests/${testId}`).then((t) => t.projectId, () => undefined);
        projectOfTest.set(testId, p);
    }
    return p;
}

/** The project of an address (`#/projects/:id/...` or `#/tests/:id/...`), else the last one the person had open. */
export async function resolveProject(hash: string): Promise<string | undefined> {
    const parts = hash.replace(/^#/, "").split("?")[0]!.split("/").filter(Boolean);
    const found = parts[0] === "projects" ? parts[1] : parts[0] === "tests" && parts[1] ? await askProjectOfTest(parts[1]) : undefined;
    if (found) lastProject = found;
    return found ?? lastProject;
}

/**
 * The project the person is working in: the one in the address, the one a test belongs to, or the last one they had open.
 * Undefined when there is none yet (the projects list, settings, the Guide before any project was opened).
 */
export function useCurrentProject(): string | undefined {
    const { parts } = useRoute();
    const fromRoute = parts[0] === "projects" ? parts[1] : undefined;
    const testId = parts[0] === "tests" ? parts[1] : undefined;
    const [fromTest, setFromTest] = useState<{ test: string; project: string | undefined } | undefined>();
    useEffect(() => {
        if (!testId || fromRoute) return;
        let live = true;
        void askProjectOfTest(testId).then((project) => live && setFromTest({ test: testId, project }));
        return () => {
            live = false;
        };
    }, [testId, fromRoute]);
    const found = fromRoute ?? (testId && fromTest?.test === testId ? fromTest.project : undefined);
    if (found) lastProject = found;
    return found ?? lastProject;
}

/**
 * The "Open it in the app" button. A place inside a project uses the current project. With none current, one project is used
 * as it is; several are offered in a list first; none says so and points at starting one. Only ever a link: it opens a place.
 */
export function OpenInApp({ label, to, size = "md" }: { label: string; to: WhereTo; size?: "sm" | "md" }) {
    const current = useCurrentProject();
    const needs = needsProject(to);
    const list = useFetch<ProjectRow[]>(needs && !current ? "/projects" : null);
    const [picked, setPicked] = useState("");
    if (!needs || current) {
        const href = whereToHref(to, current);
        return href ? (
            <LinkButton href={href} variant="primary" size={size}>
                {label}
            </LinkButton>
        ) : null;
    }
    if (list.loading) return <span className="t-meta">Looking for your projects…</span>;
    const projects = list.data ?? [];
    if (projects.length === 0)
        return (
            <p className="t-secondary">
                This part of the app is inside a project, and you have none yet. <a href={routes.newProject()}>Start a project</a> first.
            </p>
        );
    const chosen = projects.length === 1 ? projects[0]!.id : picked;
    const href = chosen ? whereToHref(to, chosen) : null;
    return (
        <div className="guide-pick">
            {projects.length > 1 && (
                <div className="field">
                    <label htmlFor="guide-project">Choose a project to open it in</label>
                    <select id="guide-project" className="input" value={picked} onChange={(e) => setPicked(e.target.value)}>
                        <option value="">Choose a project</option>
                        {projects.map((p) => (
                            <option key={p.id} value={p.id}>
                                {p.name}
                            </option>
                        ))}
                    </select>
                </div>
            )}
            {href ? (
                <LinkButton href={href} variant="primary" size={size}>
                    {label}
                </LinkButton>
            ) : (
                <button type="button" className="btn btn-primary" disabled>
                    {label}
                </button>
            )}
        </div>
    );
}
