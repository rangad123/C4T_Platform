import { useCallback } from "react";
import { usePage } from "../../components/Shell";
import { Badge, Button, Callout, EmptyState, LinkButton, PageHeader } from "../../components/ui";
import { useDocumentTitle, useFetch } from "../../lib/hooks";
import { go, routes, useRoute } from "../../lib/router";
import { Code2 } from "lucide-react";
import { capi, starterTemplate, type Diagnostic, type SaveResult } from "./code";
import { Workbench } from "./Workbench";
import { useRunPolicy } from "./policy";
import "./code.css";

/** The editor of an existing test is the Code tab of the test workbench (features/workbench/CodeTab.tsx). */

/** `#/projects/:id/write-code`: the editor with a starter script; saving creates the test. */
export function NewCodePage({ id }: { id: string }) {
    const { query } = useRoute();
    const project = useFetch<{ name: string }>(`/projects/${id}`);
    const policy = useRunPolicy(id);
    const title = (query.get("title") ?? "").trim();
    const kind = query.get("kind") === "api" ? "api" : "web";
    const category = query.get("category") ?? "";
    useDocumentTitle("Write code");
    usePage({ crumbs: [{ label: "Projects", href: routes.home }, { label: project.data?.name ?? "…", href: routes.project(id) }, { label: "Test cases", href: routes.tests(id) }, { label: "Write code" }], nav: "projects" });

    const save = useCallback(
        async (content: string): Promise<SaveResult> => {
            const res = await capi<{ testId: string; version: number; diagnostics: Diagnostic[]; jobId: string | null; note?: string }>(`/projects/${id}/custom-tests`, {
                method: "POST",
                body: { title, kind, content, ...(category ? { category } : {}) },
            });
            // The test exists now: continue on its own editor page, which shows the run.
            go(routes.code(res.testId, { saved: true, job: res.jobId, note: res.note, version: res.version }));
            return res;
        },
        [id, title, kind, category],
    );

    if (title.length < 3) {
        return (
            <div className="card">
                <EmptyState icon={Code2} title="Name the test first" actions={<LinkButton variant="primary" href={routes.tests(id)}>Back to the tests</LinkButton>}>
                    Choose Write code on the Tests page and give the test a title.
                </EmptyState>
            </div>
        );
    }
    return (
        <>
            <PageHeader title="Write a test in code" subtitle={<><span>{title}</span><Badge tone="neutral">{kind === "api" ? "API test" : "Web test"}</Badge></>} actions={<Button onClick={() => go(routes.tests(id))}>Cancel</Button>} />
            <Workbench
                initial={starterTemplate(kind)}
                baselineKey="new"
                saveLabel="Create the test"
                savingLabel="Creating…"
                onSave={save}
                guard={policy.config?.guard}
                maxBytes={policy.config?.maxBytes}
            >
                {policy.known && !policy.enabled && (
                    <Callout tone="warning" title="Code tests cannot run yet">
                        You can create the test now. It stays “Not run yet” until a runner started with --allow-custom-scripts is chosen under Runners, or ALLOW_CUSTOM_SCRIPTS=true is set on the server.
                    </Callout>
                )}
            </Workbench>
        </>
    );
}
