import { Download, Plus, Puzzle, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { api, downloadFrom, type ProjectDetail } from "../../api";
import { useHere } from "../auth/project-access";
import { usePage } from "../../components/Shell";
import { Badge, Button, Callout, EmptyState, ErrorState, ListSkeleton, PageHeader } from "../../components/ui";
import { plural } from "../../lib/format";
import { useDocumentTitle, useFetch } from "../../lib/hooks";
import { describeApiError, friendlyError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { ProjectTabs } from "../../pages/ProjectOverview";
import { ElementDialog } from "./ElementDialog";
import { ExtractPanel } from "./ExtractPanel";
import { appliesToText, groupOf, KIND_TEXT, usedByLine, type ChangeResult, type ElementList, type SharedElement } from "./objects";
import "./objects.css";

/** The project's Objects tab: named, shared elements. Change one here and every test that uses it follows. */
export function ProjectObjects({ id }: { id: string }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const list = useFetch<ElementList>(`/projects/${id}/objects`);
    const [dialog, setDialog] = useState<{ element?: SharedElement } | null>(null);
    const [notice, setNotice] = useState<{ tone: "success" | "info" | "warning"; title: string; text: string } | null>(null);
    const [confirming, setConfirming] = useState<string | null>(null);
    const [error, setError] = useState("");
    const fileRef = useRef<HTMLInputElement>(null);
    // Adding, changing and importing elements needs tests.write here, deleting one tests.delete, the export reports.export.
    const here = useHere(id, project);
    const noWrite = here.why("ai_studio.tests.write");
    const noExport = here.why("ai_studio.reports.export");
    const mayDelete = here.may("ai_studio.tests.delete");

    const name = project.data?.name;
    useDocumentTitle(name ? `Shared elements · ${name}` : "Shared elements");
    usePage({ crumbs: [{ label: "Projects", href: routes.home }, { label: name ?? "…", href: routes.project(id) }, { label: "Shared elements" }], nav: "projects" });

    const elements = list.data?.elements ?? [];
    const groups = [...new Set(elements.map(groupOf))];

    function changed(out: ChangeResult | SharedElement, kind: "added" | "changed") {
        setDialog(null);
        if (kind === "added") setNotice({ tone: "success", title: "Element added", text: "Use it in a test by its name, or let your tests find it with “Find elements to share”." });
        else {
            const c = out as ChangeResult;
            const text = c.revalidation?.status === "started" ? `${appliesToText(c.appliesTo)} Their scripts were updated and they are running again.` : c.revalidation?.status === "waiting" ? `${appliesToText(c.appliesTo)} ${c.revalidation.message ?? ""}` : appliesToText(c.appliesTo);
            setNotice({ tone: c.revalidation?.status === "waiting" ? "warning" : "success", title: "Changes saved", text });
        }
        void list.reload();
    }

    async function remove(e: SharedElement) {
        setError("");
        try {
            await api(`/projects/${id}/objects/${e.id}`, { method: "DELETE" });
            setConfirming(null);
            setNotice({ tone: "info", title: "Element deleted", text: `“${e.name}” was removed.` });
            await list.reload();
        } catch (err) {
            setConfirming(null);
            setError(describeApiError(err));
        }
    }

    async function exportFile() {
        setError("");
        try {
            await downloadFrom(`/projects/${id}/objects/export`, "object-repository.json");
        } catch (err) {
            setError(describeApiError(err));
        }
    }

    async function importFile(file: File | undefined) {
        if (!file) return;
        setError("");
        try {
            if (file.size > 2_000_000) throw new Error("That file is too large to be an element list.");
            const body = JSON.parse(await file.text());
            const out = await api<{ created: number; updated: number; unchanged: number }>(`/projects/${id}/objects/import`, { method: "POST", body: Array.isArray(body) ? { elements: body } : body });
            setNotice({ tone: "success", title: "Elements imported", text: `${plural(out.created, "element")} added, ${out.unchanged} already there.` });
            await list.reload();
        } catch (err) {
            setError(err instanceof SyntaxError ? "That file is not valid JSON. Use a file exported from this page." : describeApiError(err));
        } finally {
            if (fileRef.current) fileRef.current.value = "";
        }
    }

    return (
        <>
            <PageHeader
                title="Shared elements"
                subtitle="Name the buttons and fields your tests use once, and fix them in one place."
                actions={
                    <>
                        <Button icon={Plus} variant="primary" disabled={Boolean(noWrite)} tip={noWrite} onClick={() => setDialog({})}>Add element</Button>
                        <Button icon={Download} onClick={exportFile} disabled={!elements.length || Boolean(noExport)} tip={noExport ?? (elements.length ? "Downloads every shared element as a JSON file another project can import." : "There are no shared elements to export yet.")}>Export</Button>
                        <Button icon={Upload} disabled={Boolean(noWrite)} onClick={() => fileRef.current?.click()} tip={noWrite ?? "Adds the elements from a file exported here. If a name is already used with a different way of finding it, nothing is imported."}>Import</Button>
                        <input ref={fileRef} type="file" accept="application/json,.json" hidden aria-label="Import elements from a file" onChange={(e) => void importFile(e.target.files?.[0])} />
                    </>
                }
            />
            <ProjectTabs id={id} active="scripts" count={project.data?.test_count} />
            <div className="stack">
                {notice && (
                    <Callout tone={notice.tone} title={notice.title}>
                        {notice.text}
                    </Callout>
                )}
                {error && <Callout tone="danger" title="That didn’t work">{error}</Callout>}

                {list.loading && <ListSkeleton rows={3} />}
                {list.error && !list.data && <ErrorState error={friendlyError(list.error.message)} onRetry={list.reload} />}
                {list.data && elements.length === 0 && (
                    <div className="card">
                        <EmptyState icon={Puzzle} title="No shared elements yet" seeHow={{ topic: "shared-elements" }} actions={<Button variant="primary" icon={Plus} disabled={Boolean(noWrite)} tip={noWrite} onClick={() => setDialog({})}>Add element</Button>}>
                            Name the buttons and fields your tests use once, and fix them in one place. When a page changes, you update the element and every test that uses it follows.
                        </EmptyState>
                    </div>
                )}
                {groups.map((g) => (
                    <section key={g} aria-labelledby={`obj-g-${g}`}>
                        <div className="section-head">
                            <h2 className="t-section" id={`obj-g-${g}`}>{g}</h2>
                            <span className="t-meta">{plural(elements.filter((e) => groupOf(e) === g).length, "element")}</span>
                        </div>
                        <ul className="card list divided" data-testid="element-list">
                            {elements.filter((e) => groupOf(e) === g).map((e) => (
                                <li key={e.id} className="obj-row">
                                    <div className="obj-main">
                                        <div className="obj-name">
                                            <span className="title">{e.name}</span>
                                            <Badge tone={e.kind === "web" ? "brand" : "info"}>{KIND_TEXT[e.kind]}</Badge>
                                        </div>
                                        <div className="obj-code">{e.description}</div>
                                        {e.notes && <div className="t-meta">{e.notes}</div>}
                                        <div className="t-meta">
                                            {usedByLine(e.usedBy)}
                                        </div>
                                    </div>
                                    <div className="obj-actions">
                                        {confirming === e.id ? (
                                            <>
                                                <span className="t-meta">{e.usedBy.count || e.usedBy.blocks?.length ? "This element is in use and can’t be deleted." : "Delete this element?"}</span>
                                                {e.usedBy.count === 0 && !e.usedBy.blocks?.length && <Button size="sm" variant="danger" onClick={() => void remove(e)}>Delete element</Button>}
                                                <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>Keep it</Button>
                                            </>
                                        ) : (
                                            <>
                                                <Button size="sm" onClick={() => setDialog({ element: e })} aria-label={`${noWrite ? "View" : "Edit"} ${e.name}`}>{noWrite ? "View" : "Edit"}</Button>
                                                {mayDelete && <Button size="sm" variant="ghost" onClick={() => setConfirming(e.id)} aria-label={`Delete ${e.name}`}>Delete</Button>}
                                            </>
                                        )}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </section>
                ))}

                {!noWrite && <ExtractPanel projectId={id} onApplied={() => void list.reload()} />}
            </div>
            {dialog && (!noWrite || dialog.element) && <ElementDialog key={dialog.element?.id ?? "new"} projectId={id} element={dialog.element} readOnly={Boolean(noWrite)} onClose={() => setDialog(null)} onDone={changed} />}
        </>
    );
}
