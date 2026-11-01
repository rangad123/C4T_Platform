import { ClipboardList, Download, Pencil, Plus, Trash2, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { api, getKey, type ProjectDetail, type TestSummary } from "../../api";
import { usePage } from "../../components/Shell";
import { Button, Callout, Disclosure, EmptyState, ErrorState, ListSkeleton, Menu, MenuItem, PageHeader } from "../../components/ui";
import { downloadBlob, plural } from "../../lib/format";
import { useDocumentTitle, useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { ProjectTabs } from "../../pages/ProjectOverview";
import { apiMessage, groupByArea, MAX_STEPS, PRIORITIES, PRIORITY_LABEL, type CaseInput, type CaseList, type ImportResult, type ManualCase, type Priority } from "./manual";
import "./manual.css";
import type { RequirementLink } from "../requirements/requirements";

const EMPTY: CaseInput = { title: "", area: "", priority: "medium", requirement: "", steps: [{ action: "", expected: "" }], linkedTestIds: [] };

/** Manual cases of a project: the checks a person does by hand. Add, edit, delete, import and export. */
export function ManualCasesPage({ id }: { id: string }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const list = useFetch<CaseList>(`/projects/${id}/manual-cases`);
    // The requirement records each case covers (Requirements place), shown on its row.
    const reqLinks = useFetch<{ links: RequirementLink[] }>(`/projects/${id}/requirements/links`);
    const coversOf = (caseId: string) => (reqLinks.data?.links ?? []).filter((l) => l.kind === "manual" && l.testId === caseId);
    const [editing, setEditing] = useState<{ id?: string; input: CaseInput } | null>(null);
    const [notice, setNotice] = useState<{ tone: "success" | "danger" | "warning"; text: string; detail?: string[] } | null>(null);
    const [confirming, setConfirming] = useState<string | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const name = project.data?.name;
    useDocumentTitle(name ? `Manual cases, ${name}` : "Manual cases");
    usePage({ crumbs: [{ label: "Projects", href: routes.home }, { label: name ?? "…", href: routes.project(id) }, { label: "Releases", href: routes.releases(id) }, { label: "Manual cases" }], nav: "projects" });

    const cases = list.data?.cases ?? [];

    async function remove(c: ManualCase) {
        try {
            await api(`/projects/${id}/manual-cases/${c.id}`, { method: "DELETE" });
            setNotice({ tone: "success", text: `Deleted “${c.title}”.` });
            setConfirming(null);
            await list.reload();
        } catch (e) {
            setNotice({ tone: "danger", text: apiMessage(e) });
        }
    }

    async function importFile(file: File) {
        setNotice(null);
        try {
            const content = await file.text();
            const format = /\.csv$/i.test(file.name) ? "csv" : /\.json$/i.test(file.name) ? "json" : undefined;
            const r = await api<ImportResult>(`/projects/${id}/manual-cases/import`, { method: "POST", body: { content, ...(format ? { format } : {}) } });
            const detail = r.skipped.map((s) => `Row ${s.row}: ${s.reason}`);
            setNotice({
                tone: r.skipped.length ? "warning" : "success",
                text: `Imported ${plural(r.created, "case")}.${r.duplicates ? ` ${plural(r.duplicates, "case")} already existed and ${r.duplicates === 1 ? "was" : "were"} left out.` : ""}${r.skipped.length ? ` ${plural(r.skipped.length, "row")} could not be imported.` : ""}`,
                detail,
            });
            await list.reload();
        } catch (e) {
            setNotice({ tone: "danger", text: `Nothing was imported. ${apiMessage(e)}` });
        } finally {
            if (fileRef.current) fileRef.current.value = "";
        }
    }

    async function exportAs(format: "csv" | "json") {
        try {
            const res = await fetch(`/api/projects/${id}/manual-cases/export?format=${format}`, { headers: getKey() ? { "x-api-key": getKey() } : {} });
            if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error);
            downloadBlob(await res.blob(), `manual-cases.${format}`);
        } catch (e) {
            setNotice({ tone: "danger", text: `Download failed. ${apiMessage(e)}` });
        }
    }

    return (
        <>
            <PageHeader
                title="Manual cases"
                subtitle={list.data ? `${plural(list.data.total, "case")} of ${list.data.max} allowed. Each release has you mark these by hand.` : "The checks a person does by hand."}
                actions={
                    <>
                        <input ref={fileRef} type="file" accept=".csv,.json,text/csv,application/json" hidden aria-label="Choose a file to import" onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} />
                        <Button icon={Upload} onClick={() => fileRef.current?.click()}>
                            Import
                        </Button>
                        <Menu label="Export" icon={Download}>
                            {(close) => (
                                <>
                                    <MenuItem
                                        hint="Opens in a spreadsheet"
                                        onClick={() => {
                                            close();
                                            void exportAs("csv");
                                        }}
                                    >
                                        Export as CSV
                                    </MenuItem>
                                    <MenuItem
                                        hint="Keeps linked tests"
                                        onClick={() => {
                                            close();
                                            void exportAs("json");
                                        }}
                                    >
                                        Export as JSON
                                    </MenuItem>
                                </>
                            )}
                        </Menu>
                        <Button variant="primary" icon={Plus} onClick={() => setEditing({ input: EMPTY })} disabled={editing !== null}>
                            Add case
                        </Button>
                    </>
                }
            />
            <ProjectTabs id={id} active="tests" count={project.data?.test_count} />

            <div className="stack">
                {notice && (
                    <div className="stack-sm">
                        <Callout tone={notice.tone}>{notice.text}</Callout>
                        {notice.detail && notice.detail.length > 0 && (
                            <ul className="rel-reasons" aria-label="Rows that were not imported">
                                {notice.detail.slice(0, 10).map((d) => (
                                    <li key={d}>{d}</li>
                                ))}
                                {notice.detail.length > 10 && <li className="t-meta">and {notice.detail.length - 10} more</li>}
                            </ul>
                        )}
                    </div>
                )}

                {editing && (
                    <CaseForm
                        key={editing.id ?? "new"}
                        projectId={id}
                        areas={list.data?.areas ?? []}
                        initial={editing.input}
                        caseId={editing.id}
                        onCancel={() => setEditing(null)}
                        onSaved={async (title) => {
                            setEditing(null);
                            setNotice({ tone: "success", text: `Saved “${title}”.` });
                            await list.reload();
                        }}
                    />
                )}

                {list.loading ? (
                    <ListSkeleton rows={3} />
                ) : list.error ? (
                    <ErrorState error={friendlyError(list.error.message)} onRetry={list.reload} />
                ) : cases.length === 0 ? (
                    !editing && (
                        <div className="card">
                            <EmptyState
                                icon={ClipboardList}
                                title="No manual cases yet"
                                actions={
                                    <>
                                        <Button variant="primary" icon={Plus} onClick={() => setEditing({ input: EMPTY })}>
                                            Add case
                                        </Button>
                                        <Button icon={Upload} onClick={() => fileRef.current?.click()}>
                                            Import a file
                                        </Button>
                                    </>
                                }
                            >
                                Some checks need a person: how a page looks, a printout, a device, a question for the finance team. Write them here as steps with the result you expect, and you mark them in every release. A CSV file with the columns title, area, priority and steps imports in one go.
                            </EmptyState>
                        </div>
                    )
                ) : (
                    <div className="stack">
                        {groupByArea(cases.slice().sort((a, b) => a.area.localeCompare(b.area, undefined, { sensitivity: "base" }) || PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority))).map(([area, items]) => (
                            <section key={area} aria-label={`Area ${area}`}>
                                <div className="section-head">
                                    <h2 className="t-section">{area}</h2>
                                    <span className="t-meta">{plural(items.length, "case")}</span>
                                </div>
                                <ul className="card list divided">
                                    {items.map((c) => (
                                        <li key={c.id} className="mc-case">
                                            <div className="mc-case-main">
                                                <span className="title">{c.title}</span>
                                                <span className="t-meta">
                                                    {PRIORITY_LABEL[c.priority]} priority
                                                    <span className="dot-sep" />
                                                    {plural(c.steps.length, "step")}
                                                    {c.requirement && (
                                                        <>
                                                            <span className="dot-sep" />
                                                            {c.requirement}
                                                        </>
                                                    )}
                                                    {coversOf(c.id).length > 0 && (
                                                        <>
                                                            <span className="dot-sep" />
                                                            Covers{" "}
                                                            {coversOf(c.id).map((l, i) => (
                                                                <span key={l.requirementId}>
                                                                    {i > 0 && ", "}
                                                                    <a href={routes.requirement(id, l.requirementId)} title={l.title}>
                                                                        {l.ref}
                                                                    </a>
                                                                </span>
                                                            ))}
                                                        </>
                                                    )}
                                                </span>
                                            </div>
                                            <div className="mc-case-actions">
                                                {confirming === c.id ? (
                                                    <>
                                                        <Button size="sm" variant="danger" onClick={() => void remove(c)}>
                                                            Delete “{c.title}”
                                                        </Button>
                                                        <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                                                            Keep
                                                        </Button>
                                                    </>
                                                ) : (
                                                    <>
                                                        <Button
                                                            size="sm"
                                                            icon={Pencil}
                                                            aria-label={`Edit ${c.title}`}
                                                            onClick={() => setEditing({ id: c.id, input: { title: c.title, area: c.area, priority: c.priority, requirement: c.requirement, steps: c.steps.length ? c.steps : [{ action: "", expected: "" }], linkedTestIds: c.linkedTestIds } })}
                                                        >
                                                            Edit
                                                        </Button>
                                                        <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Delete ${c.title}`} onClick={() => setConfirming(c.id)}>
                                                            Delete
                                                        </Button>
                                                    </>
                                                )}
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        ))}
                    </div>
                )}
            </div>
        </>
    );
}

function CaseForm({ projectId, areas, initial, caseId, onCancel, onSaved }: { projectId: string; areas: string[]; initial: CaseInput; caseId?: string; onCancel: () => void; onSaved: (title: string) => void | Promise<void> }) {
    const [f, setF] = useState<CaseInput>(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const tests = useFetch<TestSummary[]>(`/projects/${projectId}/tests`);

    const set = <K extends keyof CaseInput>(k: K, v: CaseInput[K]) => setF((x) => ({ ...x, [k]: v }));
    const setStep = (i: number, k: "action" | "expected", v: string) => set("steps", f.steps.map((s, j) => (j === i ? { ...s, [k]: v } : s)));

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        if (!f.title.trim()) return setError("Give the case a title, like “Print an invoice”.");
        const steps = f.steps.filter((s) => s.action.trim() || s.expected.trim());
        if (steps.some((s) => !s.action.trim())) return setError("Every step needs an action. Fill it in or remove the step.");
        setBusy(true);
        setError("");
        try {
            const body = { ...f, title: f.title.trim(), area: f.area.trim(), requirement: f.requirement.trim(), steps };
            await api(caseId ? `/projects/${projectId}/manual-cases/${caseId}` : `/projects/${projectId}/manual-cases`, { method: caseId ? "PUT" : "POST", body });
            await onSaved(body.title);
        } catch (err) {
            setError(apiMessage(err));
            setBusy(false);
        }
    }

    return (
        <form className="card card-pad stack-sm" onSubmit={submit} aria-label={caseId ? "Edit manual case" : "New manual case"} noValidate>
            <div className="row">
                <h2 className="t-section">{caseId ? "Edit case" : "New case"}</h2>
                <span className="spacer" />
                <Button type="button" size="sm" variant="ghost" icon={X} onClick={onCancel} aria-label="Close the form">
                    Close
                </Button>
            </div>
            <div className="field">
                <label htmlFor="mc-title">Title</label>
                <input id="mc-title" className="input" value={f.title} maxLength={160} placeholder="Print an invoice" autoFocus onChange={(e) => set("title", e.target.value)} />
            </div>
            <div className="grid-2">
                <div className="field">
                    <label htmlFor="mc-area">Area</label>
                    <input id="mc-area" className="input" list="mc-areas" value={f.area} maxLength={80} placeholder="General" onChange={(e) => set("area", e.target.value)} />
                    <datalist id="mc-areas">
                        {areas.map((a) => (
                            <option key={a} value={a} />
                        ))}
                    </datalist>
                </div>
                <div className="field">
                    <label htmlFor="mc-priority">Priority</label>
                    <select id="mc-priority" className="input" value={f.priority} onChange={(e) => set("priority", e.target.value as Priority)}>
                        {PRIORITIES.map((p) => (
                            <option key={p} value={p}>
                                {PRIORITY_LABEL[p]}
                            </option>
                        ))}
                    </select>
                </div>
            </div>
            <fieldset className="mc-steps">
                <legend className="label">Steps</legend>
                {f.steps.map((s, i) => (
                    <div className="mc-step" key={i}>
                        <div className="field">
                            <label htmlFor={`mc-action-${i}`}>Step {i + 1}, what to do</label>
                            <input id={`mc-action-${i}`} className="input" value={s.action} maxLength={500} onChange={(e) => setStep(i, "action", e.target.value)} />
                        </div>
                        <div className="field">
                            <label htmlFor={`mc-expected-${i}`}>Step {i + 1}, what should happen</label>
                            <input id={`mc-expected-${i}`} className="input" value={s.expected} maxLength={500} onChange={(e) => setStep(i, "expected", e.target.value)} />
                        </div>
                        <Button type="button" size="sm" variant="ghost" icon={Trash2} aria-label={`Remove step ${i + 1}`} onClick={() => set("steps", f.steps.filter((_, j) => j !== i))}>
                            Remove
                        </Button>
                    </div>
                ))}
                <div>
                    <Button type="button" size="sm" icon={Plus} disabled={f.steps.length >= MAX_STEPS} onClick={() => set("steps", [...f.steps, { action: "", expected: "" }])}>
                        Add step
                    </Button>
                    {f.steps.length >= MAX_STEPS && <span className="hint"> A case can have {MAX_STEPS} steps at most.</span>}
                </div>
            </fieldset>
            <div className="field">
                <label htmlFor="mc-req">Requirement (optional)</label>
                <input id="mc-req" className="input" value={f.requirement} maxLength={500} placeholder="Where this check comes from, like REQ-12" onChange={(e) => set("requirement", e.target.value)} />
            </div>
            {(tests.data?.length ?? 0) > 0 && (
                <Disclosure label={`Related automated tests${f.linkedTestIds.length ? ` (${f.linkedTestIds.length} chosen)` : ""}`}>
                    <fieldset className="mc-linked">
                        <legend className="sr-only">Related automated tests</legend>
                        {tests.data!.map((t) => (
                            <label className="check" key={t.id}>
                                <input type="checkbox" checked={f.linkedTestIds.includes(t.id)} onChange={(e) => set("linkedTestIds", e.target.checked ? [...f.linkedTestIds, t.id] : f.linkedTestIds.filter((x) => x !== t.id))} />
                                <span>
                                    <span className="title">{t.title}</span>
                                    <span className="hint">{t.testId}</span>
                                </span>
                            </label>
                        ))}
                    </fieldset>
                </Disclosure>
            )}
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="row">
                <Button type="submit" variant="primary" loading={busy}>
                    {caseId ? "Save changes" : "Add case"}
                </Button>
                <Button type="button" onClick={onCancel} disabled={busy}>
                    Cancel
                </Button>
            </div>
        </form>
    );
}
