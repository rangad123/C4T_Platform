import { ChevronRight, ClipboardList, Download, ExternalLink, PenLine, Plus, Search, Sparkles, Trash2, Upload, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { api, getKey, projectKind, type ProjectDetail, type TestSummary } from "../../api";
import { ProjectPlace } from "../../components/ProjectHub";
import { BadgeKey } from "../../components/Tooltip";
import { Badge, Button, Callout, Disclosure, EmptyState, ErrorState, ListSkeleton, Menu, MenuItem, StatusBadge, statusKey } from "../../components/ui";
import { downloadBlob, plural } from "../../lib/format";
import { announceProjectChanged, useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { go, routes, type CasesSection } from "../../lib/router";
import { useCan } from "../auth/permissions";
import type { RequirementLink, RequirementList } from "../requirements/requirements";
import { apiMessage, AUTOMATION_HINT, AUTOMATION_WORDS, MAX_STEPS, PRIORITIES, PRIORITY_LABEL, type Automation, type CaseInput, type CaseList, type ImportResult, type ManualCase, type Priority } from "./manual";
import "./manual.css";
import { GenerateScriptsCard } from "../authoring/GenerateScriptsCard";

const EMPTY: CaseInput = { title: "", area: "", priority: "medium", requirement: "", steps: [{ action: "", expected: "" }], linkedTestIds: [], automation: "manual", requirementId: null };
const FILTERS: CasesSection[] = ["all", "automated", "manual"];
const FILTER_WORDS: Record<CasesSection, string> = { all: "All", automated: "Automated", manual: "Manual" };

const inputOf = (c: ManualCase): CaseInput => ({ title: c.title, area: c.area, priority: c.priority, requirement: c.requirement, steps: c.steps.length ? c.steps : [{ action: "", expected: "" }], linkedTestIds: c.linkedTestIds, automation: c.automation, requirementId: c.requirementId });

/**
 * The Test cases place: the project's written test cases, one list. A test case is what a tester reads and follows (title, steps
 * with what should happen, a priority, the requirement it comes from) and says whether it can be automated. The runnable tests are
 * test scripts, on Test scripts; a case links its script. `filter` is the type shown (`?section=`), `open` one case (`?case=`).
 */
export function TestCaseList({ id, filter, open }: { id: string; filter: CasesSection; open: string | null }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const list = useFetch<CaseList>(`/projects/${id}/manual-cases`);
    const reqs = useFetch<RequirementList>(`/projects/${id}/requirements`);
    const reqLinks = useFetch<{ links: RequirementLink[] }>(`/projects/${id}/requirements/links`);
    const tests = useFetch<TestSummary[]>(`/projects/${id}/tests`);
    const can = useCan();
    const kind = project.data ? projectKind(project.data) : null;
    // An AI agent project has no Test cases tab; an old link still shows its cases, to read.
    const canWrite = can("ai_studio.tests.write") && kind !== "agent";
    const canDelete = can("ai_studio.tests.delete") && kind !== "agent";
    // Having the AI write cases also needs the AI's permission (the server asks for both).
    const canGenerate = canWrite && can("ai_studio.tests.generate");
    const [adding, setAdding] = useState(false);
    const [notice, setNotice] = useState<{ tone: "success" | "danger" | "warning"; text: string; detail?: string[] } | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [q, setQ] = useState("");
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const fileRef = useRef<HTMLInputElement>(null);

    const cases = list.data?.cases ?? [];
    const reqById = useMemo(() => new Map((reqs.data?.requirements ?? []).map((r) => [r.id, r])), [reqs.data]);
    const testById = useMemo(() => new Map((tests.data ?? []).map((t) => [t.id, t])), [tests.data]);
    const counts = { all: cases.length, automated: cases.filter((c) => c.automation === "automated").length, manual: cases.filter((c) => c.automation === "manual").length };
    const needle = q.trim().toLowerCase();
    const requirementRefs = (c: ManualCase): Array<{ id: string; ref: string; title: string }> => {
        const own = c.requirementId ? reqById.get(c.requirementId) : undefined;
        if (own) return [{ id: own.id, ref: own.ref, title: own.title }];
        // Cases linked to requirements before they had one of their own (from the requirement's page).
        return (reqLinks.data?.links ?? []).filter((l) => l.kind === "manual" && l.testId === c.id).map((l) => ({ id: l.requirementId, ref: l.ref, title: l.title }));
    };
    const shown = cases.filter((c) => (filter === "all" || c.automation === filter) && (!needle || `${c.ref}\n${c.title}\n${c.area}\n${c.requirement}\n${requirementRefs(c).map((r) => r.ref).join(" ")}`.toLowerCase().includes(needle)));
    const opened = open ? cases.find((c) => c.id === open) : undefined;
    const allShownChosen = shown.length > 0 && shown.every((c) => selected.has(c.id));
    const scriptOf = (c: ManualCase) => c.linkedTestIds.map((t) => testById.get(t)).find(Boolean);

    const close = () => go(routes.cases(id, filter));
    const reload = async () => {
        await Promise.all([list.reload(), reqLinks.reload(), reqs.reload()]);
    };
    /** After cases were added, imported or deleted: the Test cases tab's count follows at once. */
    const reloadCounted = async () => {
        announceProjectChanged(id);
        await reload();
    };

    async function remove(c: ManualCase) {
        try {
            await api(`/projects/${id}/manual-cases/${c.id}`, { method: "DELETE" });
            setNotice({ tone: "success", text: `Deleted ${c.ref} “${c.title}”.` });
            setConfirming(false);
            setSelected((s) => new Set([...s].filter((x) => x !== c.id)));
            close();
            await reloadCounted();
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
                text: `Imported ${plural(r.created, "test case")}.${r.duplicates ? ` ${plural(r.duplicates, "test case")} already existed and ${r.duplicates === 1 ? "was" : "were"} left out.` : ""}${r.skipped.length ? ` ${plural(r.skipped.length, "row")} could not be imported.` : ""}`,
                detail,
            });
            await reloadCounted();
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
            downloadBlob(await res.blob(), `test-cases.${format}`);
        } catch (e) {
            setNotice({ tone: "danger", text: `Download failed. ${apiMessage(e)}` });
        }
    }

    const toggle = (cid: string, on: boolean) => setSelected((s) => (on ? new Set([...s, cid]) : new Set([...s].filter((x) => x !== cid))));

    return (
        <ProjectPlace
            id={id}
            place="tests"
            title="Test cases"
            subtitle="The written checks of this project: what to do and what should happen, from the requirements. Each says whether it can be automated."
            actions={
                canWrite ? (
                    <>
                        <input ref={fileRef} type="file" accept=".csv,.json,text/csv,application/json" hidden aria-label="Choose a file to import" onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} />
                        <Button icon={Upload} onClick={() => fileRef.current?.click()} tip="A CSV file with the columns title, area, priority and steps, or a JSON file this page exported.">
                            Import
                        </Button>
                        <Menu label="Add test case (manual)" icon={Plus} variant="primary">
                            {(closeMenu) => (
                                <>
                                    <MenuItem
                                        icon={PenLine}
                                        description="Write its title, steps and what should happen"
                                        onClick={() => {
                                            closeMenu();
                                            setAdding(true);
                                            if (open) close();
                                        }}
                                    >
                                        Write one by hand
                                    </MenuItem>
                                    {canGenerate && (
                                        <MenuItem icon={Sparkles} description="Choose requirements and let the AI write their test cases" href={`${routes.requirements(id)}?generate=1`} download={false}>
                                            Generate from requirements
                                        </MenuItem>
                                    )}
                                </>
                            )}
                        </Menu>
                    </>
                ) : undefined
            }
        >
            {kind === "agent" && (
                <Callout tone="info">
                    Test cases are for code-based projects. In an AI agent project the agents decide what to check, so these are shown to read only. The tests the agents made are in{" "}
                    <a href={routes.tests(id)} data-testid="agent-project-tests">
                        this project’s tests
                    </a>
                    .
                </Callout>
            )}
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

            {adding && canWrite && (
                <CaseForm
                    key="new"
                    projectId={id}
                    areas={list.data?.areas ?? []}
                    requirements={reqs.data?.requirements ?? []}
                    tests={tests.data ?? []}
                    initial={EMPTY}
                    onCancel={() => setAdding(false)}
                    onSaved={async (saved) => {
                        setAdding(false);
                        setNotice({ tone: "success", text: `Added ${saved.ref} “${saved.title}”.` });
                        await reloadCounted();
                    }}
                />
            )}

            {open && !list.loading && !opened && list.data && (
                <Callout tone="warning" title="This test case is not here">
                    It may have been deleted. <a href={routes.cases(id, filter)}>Show every test case</a>
                </Callout>
            )}
            {opened && (
                <section className="card card-pad stack-sm" aria-label={`Test case ${opened.ref}`} data-testid="case-open">
                    <div className="row" style={{ flexWrap: "wrap" }}>
                        <h2 className="t-section">
                            <span className="mono tc-ref">{opened.ref}</span> {opened.title}
                        </h2>
                        <span className="spacer" />
                        <Button size="sm" variant="ghost" icon={X} onClick={close} aria-label="Close the test case">
                            Close
                        </Button>
                    </div>
                    <p className="t-meta">
                        {AUTOMATION_WORDS[opened.automation]}
                        <span className="dot-sep" />
                        {PRIORITY_LABEL[opened.priority]} priority
                        <span className="dot-sep" />
                        {opened.automation === "manual" ? (
                            "Done by hand, so it has no test script"
                        ) : scriptOf(opened) ? (
                            <>
                                Its test script: <a href={routes.test(scriptOf(opened)!.id)}>{scriptOf(opened)!.testId} {scriptOf(opened)!.title}</a>
                            </>
                        ) : (
                            "No test script yet"
                        )}
                    </p>
                    {canWrite ? (
                        <CaseForm
                            key={opened.id}
                            projectId={id}
                            areas={list.data?.areas ?? []}
                            requirements={reqs.data?.requirements ?? []}
                            tests={tests.data ?? []}
                            initial={inputOf(opened)}
                            caseId={opened.id}
                            embedded
                            onCancel={close}
                            onSaved={async (saved) => {
                                setNotice({ tone: "success", text: `Saved ${saved.ref} “${saved.title}”.` });
                                close();
                                await reload();
                            }}
                            extra={
                                canDelete &&
                                (confirming ? (
                                    <>
                                        <Button type="button" variant="danger" onClick={() => void remove(opened)}>
                                            Delete {opened.ref}
                                        </Button>
                                        <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
                                            Keep
                                        </Button>
                                    </>
                                ) : (
                                    <Button type="button" variant="ghost" icon={Trash2} onClick={() => setConfirming(true)}>
                                        Delete
                                    </Button>
                                ))
                            }
                        />
                    ) : (
                        <CaseView c={opened} />
                    )}
                </section>
            )}

            <div className="stack-sm">
                <div className="chips" role="group" aria-label="Filter by type">
                    {FILTERS.map((f) => (
                        <button key={f} className="chip" aria-pressed={filter === f} onClick={() => go(routes.cases(id, f))} title={f === "all" ? undefined : AUTOMATION_HINT[f as Automation]} data-tour={`tests-${f}`}>
                            {FILTER_WORDS[f]} <span className="n">{counts[f]}</span>
                        </button>
                    ))}
                </div>
                <div className="section-head tc-head">
                    <h2 className="t-section">
                        Test cases ({filter === "all" && !needle ? counts.all : `${shown.length} of ${counts.all}`})
                    </h2>
                    {shown.length > 0 && (
                        <BadgeKey
                            label="the badges in this list"
                            entries={[
                                { word: AUTOMATION_WORDS.automated, text: AUTOMATION_HINT.automated },
                                { word: AUTOMATION_WORDS.manual, text: AUTOMATION_HINT.manual },
                                { word: "No script yet", text: "No test script is linked to this case yet. Generate one with the AI, or link one when you open the case." },
                                ...statusKey(shown.map((c) => scriptOf(c)?.validationStatus)),
                            ]}
                        />
                    )}
                    <span className="spacer" />
                    <div className="input-wrap" style={{ flex: "0 1 280px" }}>
                        <Search size={16} className="lead" aria-hidden />
                        <input className="input" type="search" placeholder="Search test cases" aria-label="Search test cases" value={q} onChange={(e) => setQ(e.target.value)} />
                    </div>
                    {cases.length > 0 && can("ai_studio.reports.export") && (
                        <Menu label="Export" icon={Download}>
                            {(closeMenu) => (
                                <>
                                    <MenuItem hint="Opens in a spreadsheet" onClick={() => (closeMenu(), void exportAs("csv"))}>
                                        Export as CSV
                                    </MenuItem>
                                    <MenuItem hint="Keeps the type and linked scripts" onClick={() => (closeMenu(), void exportAs("json"))}>
                                        Export as JSON
                                    </MenuItem>
                                </>
                            )}
                        </Menu>
                    )}
                </div>
            </div>

            {list.loading ? (
                <ListSkeleton rows={4} />
            ) : list.error ? (
                <ErrorState error={friendlyError(list.error.message)} onRetry={list.reload} />
            ) : cases.length === 0 ? (
                !adding && (
                    <div className="card">
                        <EmptyState
                            icon={ClipboardList}
                            title="No test cases yet"
                            actions={
                                canWrite ? (
                                    <>
                                        <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
                                            Add test case (manual)
                                        </Button>
                                        {canGenerate && (
                                            <Button icon={Sparkles} onClick={() => go(`${routes.requirements(id)}?generate=1`)}>
                                                Generate from requirements
                                            </Button>
                                        )}
                                    </>
                                ) : undefined
                            }
                        >
                            {kind === "agent"
                                ? "This AI agent project has no written test cases: the agents decide what to check when they explore."
                                : canWrite
                                  ? "A test case is a written check: the steps a tester follows and what should happen at each one. Write them by hand, import a file, or let the AI write them from your requirements. Each one says whether it can be automated."
                                  : "A test case is a written check: the steps a tester follows and what should happen at each one. People who may write tests in this project add them here."}
                        </EmptyState>
                    </div>
                )
            ) : shown.length === 0 ? (
                <div className="card">
                    <EmptyState icon={Search} title="Nothing matches">
                        No test case matches this search and this type.
                    </EmptyState>
                </div>
            ) : (
                <div className="tc-table-wrap" role="region" aria-label="Test cases list" tabIndex={0}>
                    <table className="tc-table">
                        <thead>
                            <tr>
                                <th scope="col" className="tc-check">
                                    <input type="checkbox" aria-label="Choose every test case shown" checked={allShownChosen} onChange={(e) => setSelected(e.target.checked ? new Set([...selected, ...shown.map((c) => c.id)]) : new Set([...selected].filter((x) => !shown.some((c) => c.id === x))))} />
                                </th>
                                <th scope="col">ID</th>
                                <th scope="col">Test case</th>
                                <th scope="col">Requirement</th>
                                <th scope="col">Type</th>
                                <th scope="col">Status</th>
                                <th scope="col">
                                    <span className="sr-only">Open</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {shown.map((c) => {
                                const refs = requirementRefs(c);
                                const script = scriptOf(c);
                                return (
                                    <tr key={c.id} aria-current={c.id === open ? "true" : undefined}>
                                        <td className="tc-check">
                                            <input type="checkbox" aria-label={`Choose ${c.ref}`} checked={selected.has(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} />
                                        </td>
                                        <td className="mono tc-ref">{c.ref}</td>
                                        <td className="tc-title">
                                            <a href={routes.testCase(id, c.id)}>{c.title}</a>
                                            <span className="t-meta">
                                                {PRIORITY_LABEL[c.priority]} priority · {plural(c.steps.length, "step")}
                                            </span>
                                        </td>
                                        <td>
                                            {refs.length > 0 ? (
                                                <span className="tc-reqs">
                                                    {refs.map((r) => (
                                                        <a key={r.id} className="tc-req mono" href={routes.requirement(id, r.id)} title={r.title}>
                                                            {r.ref}
                                                        </a>
                                                    ))}
                                                </span>
                                            ) : c.requirement ? (
                                                <span className="t-secondary">{c.requirement}</span>
                                            ) : (
                                                <span className="t-meta">None</span>
                                            )}
                                        </td>
                                        <td>
                                            <Badge tone={c.automation === "automated" ? "brand" : "neutral"} tip={AUTOMATION_HINT[c.automation]}>
                                                {AUTOMATION_WORDS[c.automation]}
                                            </Badge>
                                        </td>
                                        <td>
                                            {c.automation === "manual" ? (
                                                <span className="t-meta">By hand</span>
                                            ) : script ? (
                                                <a href={routes.test(script.id)} className="tc-script" aria-label={`Test script ${script.testId}: ${script.title}`}>
                                                    <StatusBadge status={script.validationStatus} />
                                                </a>
                                            ) : (
                                                <Badge tone="neutral">No script yet</Badge>
                                            )}
                                        </td>
                                        <td className="tc-chev">
                                            <a href={routes.testCase(id, c.id)} aria-label={`Open ${c.ref}`}>
                                                <ChevronRight size={18} aria-hidden />
                                            </a>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
            {selected.size > 0 && (
                <div className="row" data-testid="cases-chosen">
                    <span className="t-meta">{plural(selected.size, "test case")} chosen</span>
                    <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                        Clear the choice
                    </Button>
                </div>
            )}
            {kind !== "agent" && cases.length > 0 && <GenerateScriptsCard projectId={id} caseIds={[...selected]} onDone={() => void Promise.all([reload(), tests.reload()])} />}
        </ProjectPlace>
    );
}

/** One case, to read (people who may not change it). */
function CaseView({ c }: { c: ManualCase }) {
    return (
        <div className="stack-sm">
            {c.steps.length === 0 ? (
                <p className="t-secondary">No steps written.</p>
            ) : (
                <ol className="tc-steps-view">
                    {c.steps.map((s, i) => (
                        <li key={i}>
                            {s.action}
                            {s.expected && <span className="t-secondary"> → {s.expected}</span>}
                        </li>
                    ))}
                </ol>
            )}
            {c.requirement && <p className="t-meta">Source: {c.requirement}</p>}
        </div>
    );
}

function CaseForm({
    projectId,
    areas,
    requirements,
    tests,
    initial,
    caseId,
    embedded,
    extra,
    onCancel,
    onSaved,
}: {
    projectId: string;
    areas: string[];
    requirements: RequirementList["requirements"];
    tests: TestSummary[];
    initial: CaseInput;
    caseId?: string;
    /** Inside the opened case, which has its own heading and Close. */
    embedded?: boolean;
    extra?: React.ReactNode;
    onCancel: () => void;
    onSaved: (c: ManualCase) => void | Promise<void>;
}) {
    const [f, setF] = useState<CaseInput>(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const set = <K extends keyof CaseInput>(k: K, v: CaseInput[K]) => setF((x) => ({ ...x, [k]: v }));
    const setStep = (i: number, k: "action" | "expected", v: string) => set("steps", f.steps.map((s, j) => (j === i ? { ...s, [k]: v } : s)));

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        if (!f.title.trim()) return setError("Give the test case a title, like “Verify sign in with a valid password”.");
        const steps = f.steps.filter((s) => s.action.trim() || s.expected.trim());
        if (steps.some((s) => !s.action.trim())) return setError("Every step needs an action. Fill it in or remove the step.");
        setBusy(true);
        setError("");
        try {
            const body = { ...f, title: f.title.trim(), area: f.area.trim(), requirement: f.requirement.trim(), steps };
            const saved = await api<ManualCase>(caseId ? `/projects/${projectId}/manual-cases/${caseId}` : `/projects/${projectId}/manual-cases`, { method: caseId ? "PUT" : "POST", body });
            await onSaved(saved);
        } catch (err) {
            setError(apiMessage(err));
            setBusy(false);
        }
    }

    return (
        <form className={embedded ? "stack-sm" : "card card-pad stack-sm"} onSubmit={submit} aria-label={caseId ? "Edit test case" : "New test case"} noValidate>
            {!embedded && (
                <div className="row">
                    <h2 className="t-section">New test case</h2>
                    <span className="spacer" />
                    <Button type="button" size="sm" variant="ghost" icon={X} onClick={onCancel} aria-label="Close the form">
                        Close
                    </Button>
                </div>
            )}
            <div className="field">
                <label htmlFor="mc-title">Title</label>
                <input id="mc-title" className="input" value={f.title} maxLength={160} placeholder="Verify sign in with a valid password" autoFocus={!embedded} onChange={(e) => set("title", e.target.value)} />
            </div>
            <div className="grid-2">
                <fieldset className="tc-type">
                    <legend className="label">Type</legend>
                    {(["automated", "manual"] as const).map((a) => (
                        <label key={a} className="tc-type-opt">
                            <input type="radio" name="mc-automation" value={a} checked={f.automation === a} onChange={() => set("automation", a)} />
                            <span>
                                <span className="title">{AUTOMATION_WORDS[a]}</span>
                                <span className="hint">{AUTOMATION_HINT[a]}</span>
                            </span>
                        </label>
                    ))}
                </fieldset>
                <div className="stack-sm">
                    <div className="field">
                        <label htmlFor="mc-requirement">Requirement</label>
                        <select id="mc-requirement" className="input" value={f.requirementId ?? ""} onChange={(e) => set("requirementId", e.target.value || null)}>
                            <option value="">None</option>
                            {requirements.map((r) => (
                                <option key={r.id} value={r.id}>
                                    {r.ref} {r.title.length > 70 ? `${r.title.slice(0, 69)}…` : r.title}
                                </option>
                            ))}
                        </select>
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
                    {f.steps.length >= MAX_STEPS && <span className="hint"> A test case can have {MAX_STEPS} steps at most.</span>}
                </div>
            </fieldset>
            <Disclosure label="More: area, source, linked test scripts" defaultOpen={Boolean(initial.requirement) && !initial.requirementId}>
                <div className="stack-sm">
                    <div className="grid-2">
                        <div className="field">
                            <label htmlFor="mc-area">Area</label>
                            <input id="mc-area" className="input" list="mc-areas" value={f.area} maxLength={80} placeholder="General" onChange={(e) => set("area", e.target.value)} />
                            <datalist id="mc-areas">
                                {areas.map((a) => (
                                    <option key={a} value={a} />
                                ))}
                            </datalist>
                            <span className="hint">A release groups its checks by area.</span>
                        </div>
                        <div className="field">
                            <label htmlFor="mc-req">Source (optional)</label>
                            <input id="mc-req" className="input" value={f.requirement} maxLength={500} placeholder="Where this check comes from, if not a requirement above" onChange={(e) => set("requirement", e.target.value)} />
                        </div>
                    </div>
                    {tests.length > 0 && (
                        <fieldset className="mc-linked">
                            <legend className="label">Linked test scripts{f.linkedTestIds.length ? ` (${f.linkedTestIds.length} chosen)` : ""}</legend>
                            {tests.map((t) => (
                                <label className="check" key={t.id}>
                                    <input type="checkbox" checked={f.linkedTestIds.includes(t.id)} onChange={(e) => set("linkedTestIds", e.target.checked ? [...f.linkedTestIds, t.id] : f.linkedTestIds.filter((x) => x !== t.id))} />
                                    <span>
                                        <span className="title">{t.title}</span>
                                        <span className="hint">{t.testId}</span>
                                    </span>
                                    <a href={routes.test(t.id)} aria-label={`Open ${t.testId}`} onClick={(e) => e.stopPropagation()}>
                                        <ExternalLink size={14} aria-hidden />
                                    </a>
                                </label>
                            ))}
                        </fieldset>
                    )}
                </div>
            </Disclosure>
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="row" style={{ flexWrap: "wrap" }}>
                <Button type="submit" variant="primary" loading={busy}>
                    {caseId ? "Save changes" : "Add test case"}
                </Button>
                <Button type="button" onClick={onCancel} disabled={busy}>
                    Cancel
                </Button>
                {extra && <span className="spacer" />}
                {extra}
            </div>
        </form>
    );
}

