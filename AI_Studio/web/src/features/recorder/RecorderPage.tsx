import { useState } from "react";
import { projectKind, type ProjectDetail } from "../../api";
import { usePage } from "../../components/Shell";
import { Callout, LinkButton, PageHeader } from "../../components/ui";
import { useDocumentTitle, useFetch } from "../../lib/hooks";
import { go, routes, useRoute } from "../../lib/router";
import { SessionView } from "./SessionView";
import { StartForm } from "./StartForm";
import "./recorder.css";

/**
 * The Record a test page: the start form, or one recording session when the address names it (?session=...). Recording is an AI
 * agent way of testing: a code project (audit Q3) that reaches this address sees a plain message pointing to its test scripts.
 */
export function RecorderPage({ id }: { id: string }) {
    const route = useRoute();
    const rid = route.query.get("session");
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const name = project.data?.name;
    // The address the last session started from, so "Start again" does not make the person type it twice.
    // A first-run link brings the address (?url=...); the form shows it and the person still presses Start.
    const [lastUrl, setLastUrl] = useState<string | undefined>(route.query.get("url") ?? undefined);
    useDocumentTitle(name ? `Record a test · ${name}` : "Record a test");
    usePage({ crumbs: [{ label: "Projects", href: routes.home }, { label: name ?? "…", href: routes.project(id) }, { label: "Test scripts", href: routes.tests(id) }, { label: "Record a test" }], nav: "projects" });

    // Wait for the project before showing anything, so a code project never sees the form flash up.
    if (project.loading) return null;
    if (project.data && projectKind(project.data) === "code") {
        return (
            <>
                <PageHeader title="Record a test" />
                <Callout tone="info" title="Recording is not part of a code project" actions={<LinkButton size="sm" href={routes.tests(id)}>Open test scripts</LinkButton>}>
                    A code project&rsquo;s tests are scripts. Write or import them from Test scripts, New test script.
                </Callout>
            </>
        );
    }
    return (
        <>
            <PageHeader title="Record a test" subtitle="Click through your application and we turn what you do into a test." />
            {rid ? (
                <SessionView
                    rid={rid}
                    key={rid}
                    projectId={id}
                    onReset={(url) => {
                        if (url) setLastUrl(url);
                        go(routes.record(id));
                    }}
                />
            ) : (
                <StartForm projectId={id} initialUrl={lastUrl} onStarted={(r) => go(routes.record(id, r.id))} onResume={(r) => go(routes.record(id, r))} />
            )}
        </>
    );
}
