import { useState } from "react";
import type { ProjectDetail } from "../../api";
import { usePage } from "../../components/Shell";
import { PageHeader } from "../../components/ui";
import { useDocumentTitle, useFetch } from "../../lib/hooks";
import { go, routes, useRoute } from "../../lib/router";
import { SessionView } from "./SessionView";
import { StartForm } from "./StartForm";
import "./recorder.css";

/** The Record a test page: the start form, or one recording session when the address names it (?session=...). */
export function RecorderPage({ id }: { id: string }) {
    const route = useRoute();
    const rid = route.query.get("session");
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const name = project.data?.name;
    // The address the last session started from, so "Start again" does not make the person type it twice.
    // A first-run link brings the address (?url=...); the form shows it and the person still presses Start.
    const [lastUrl, setLastUrl] = useState<string | undefined>(route.query.get("url") ?? undefined);
    useDocumentTitle(name ? `Record a test · ${name}` : "Record a test");
    usePage({ crumbs: [{ label: "Projects", href: routes.home }, { label: name ?? "…", href: routes.project(id) }, { label: "Test cases", href: routes.tests(id) }, { label: "Record a test" }], nav: "projects" });

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
