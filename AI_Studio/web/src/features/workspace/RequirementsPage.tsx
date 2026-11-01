import { useMemo, useState } from "react";
import { ChevronRight, FileText, ListChecks, Plus, Search, Upload } from "lucide-react";
import type { Job } from "../../api";
import { ProjectPlace } from "../../components/ProjectHub";
import { Badge, Button, Callout, EmptyState, ErrorState, LinkButton, ListSkeleton } from "../../components/ui";
import { Tooltip } from "../../components/Tooltip";
import { useCan } from "../auth/permissions";
import { plural, relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { go, routes } from "../../lib/router";
import { ImportPanel } from "../requirements/ImportPanel";
import { RequirementDetail } from "../requirements/RequirementDetail";
import { RequirementForm } from "../requirements/RequirementForm";
import { COVERAGE_HINT, COVERAGE_TONE, COVERAGE_WORDS, COVERAGES, PRIORITY_WORDS, STATUS_WORDS, STATUSES, type Coverage, type RequirementList, type RequirementStatus } from "../requirements/requirements";
import "../requirements/requirements.css";

/**
 * The Requirements place: each requirement as a record, with which test cases cover it and how they did at their latest result.
 * `rid` opens one requirement.
 */
export function RequirementsPage({ id, rid }: { id: string; rid?: string }) {
    if (rid) return <RequirementDetail id={id} rid={rid} key={rid} />;
    return <RequirementList id={id} />;
}

function RequirementList({ id }: { id: string }) {
    const list = useFetch<RequirementList>(`/projects/${id}/requirements`);
    const jobs = useFetch<Job[]>(`/projects/${id}/jobs`);
    const can = useCan();
    const canWrite = can("ai_studio.tests.write");
    const [open, setOpen] = useState<"add" | "import" | null>(null);
    const [notice, setNotice] = useState<{ tone: "success" | "warning"; text: string } | null>(null);
    const [q, setQ] = useState("");
    const [coverage, setCoverage] = useState<Coverage | "all">("all");
    const [status, setStatus] = useState<RequirementStatus | "all">("all");

    const all = list.data?.requirements ?? [];
    const counts = useMemo(() => Object.fromEntries(COVERAGES.map((c) => [c, all.filter((r) => r.coverage === c).length])) as Record<Coverage, number>, [all]);
    const needle = q.trim().toLowerCase();
    const shown = all.filter(
        (r) =>
            (coverage === "all" || r.coverage === coverage) &&
            (status === "all" || r.status === status) &&
            (!needle || `${r.ref}\n${r.title}\n${r.description}\n${r.acceptanceCriteria}`.toLowerCase().includes(needle)),
    );
    const s = list.data?.summary;
    const latestDoc = (jobs.data ?? []).find((j) => (j.counters.requirementsTotal ?? 0) > 0);

    return (
        <ProjectPlace
            id={id}
            place="requirements"
            title="Requirements"
            subtitle="What the application must do, and which test cases check it."
            actions={
                canWrite ? (
                    <>
                        <Button icon={Upload} onClick={() => setOpen(open === "import" ? null : "import")} aria-expanded={open === "import"}>
                            Import
                        </Button>
                        <Button variant="primary" icon={Plus} onClick={() => setOpen(open === "add" ? null : "add")} aria-expanded={open === "add"}>
                            Add requirement
                        </Button>
                    </>
                ) : undefined
            }
        >
            {notice && <Callout tone={notice.tone}>{notice.text}</Callout>}
            {open === "add" && (
                <RequirementForm
                    projectId={id}
                    onCancel={() => setOpen(null)}
                    onSaved={(r) => {
                        setOpen(null);
                        go(routes.requirement(id, r.id));
                    }}
                />
            )}
            {open === "import" && (
                <ImportPanel
                    projectId={id}
                    onCancel={() => setOpen(null)}
                    onImported={async (text) => {
                        setOpen(null);
                        setNotice({ tone: "success", text });
                        await list.reload();
                    }}
                />
            )}

            <h2 className="t-section">Your requirements</h2>
            {list.loading ? (
                <ListSkeleton rows={4} />
            ) : list.error ? (
                <ErrorState error={friendlyError(list.error.message)} onRetry={list.reload} />
            ) : all.length === 0 ? (
                open === null && (
                    <div className="card">
                        <EmptyState
                            icon={ListChecks}
                            title="No requirements yet"
                            actions={
                                canWrite ? (
                                    <>
                                        <Button variant="primary" icon={Plus} onClick={() => setOpen("add")}>
                                            Add requirement
                                        </Button>
                                        <Button icon={Upload} onClick={() => setOpen("import")}>
                                            Import from a document
                                        </Button>
                                    </>
                                ) : undefined
                            }
                        >
                            Write down what the application must do, one requirement at a time, or import them from a requirements document. Then link the test cases that check each one, and see which requirements nothing checks yet.
                        </EmptyState>
                    </div>
                )
            ) : (
                <>
                    {s && (
                        <p className="t-secondary" data-testid="requirements-summary">
                            {plural(s.total, "requirement")}: {s.passing} passing, {s.failing} failing, {s.covered} covered without a full result, {s.notCovered} not covered.
                            {s.retired > 0 && ` ${plural(s.retired, "retired requirement")} ${s.retired === 1 ? "is" : "are"} left out.`}
                        </p>
                    )}
                    <div className="stack-sm">
                        <div className="row" style={{ flexWrap: "wrap" }}>
                            <div className="input-wrap" style={{ flex: "1 1 240px", maxWidth: 360 }}>
                                <Search size={16} className="lead" aria-hidden />
                                <input className="input" type="search" placeholder="Search requirements" aria-label="Search requirements" value={q} onChange={(e) => setQ(e.target.value)} />
                            </div>
                            <select className="input" style={{ width: "auto" }} aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value as RequirementStatus | "all")}>
                                <option value="all">Any status</option>
                                {STATUSES.map((st) => (
                                    <option key={st} value={st}>
                                        {STATUS_WORDS[st]}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="chips" role="group" aria-label="Filter by coverage">
                            <button className="chip" aria-pressed={coverage === "all"} onClick={() => setCoverage("all")}>
                                All <span className="n">{all.length}</span>
                            </button>
                            {COVERAGES.map((c) => (
                                <Tooltip key={c} content={COVERAGE_HINT[c]}>
                                    <button className="chip" aria-pressed={coverage === c} onClick={() => setCoverage(c)}>
                                        {COVERAGE_WORDS[c]} <span className="n">{counts[c]}</span>
                                    </button>
                                </Tooltip>
                            ))}
                        </div>
                    </div>
                    {shown.length === 0 ? (
                        <div className="card">
                            <EmptyState icon={Search} title="Nothing matches">
                                No requirement matches this search and these filters.
                            </EmptyState>
                        </div>
                    ) : (
                        <ul className="card list divided" aria-label="Requirements">
                            {shown.map((r) => (
                                <li key={r.id}>
                                    <a className="list-row" href={routes.requirement(id, r.id)}>
                                        <span className="main">
                                            <span className="title">
                                                <span className="req-ref mono">{r.ref}</span> {r.title}
                                            </span>
                                            <span className="meta">
                                                {PRIORITY_WORDS[r.priority]} priority
                                                <span className="dot-sep" />
                                                {STATUS_WORDS[r.status]}
                                                <span className="dot-sep" />
                                                {r.tests.linked === 0 ? "No test cases" : `${plural(r.tests.linked, "test case")}: ${r.tests.passed} passed, ${r.tests.failed} failed`}
                                            </span>
                                        </span>
                                        <span className="tail">
                                            <Badge tone={COVERAGE_TONE[r.coverage]} tip={COVERAGE_HINT[r.coverage]}>
                                                {COVERAGE_WORDS[r.coverage]}
                                            </Badge>
                                        </span>
                                        <ChevronRight size={18} className="chev" aria-hidden />
                                    </a>
                                </li>
                            ))}
                        </ul>
                    )}
                </>
            )}

            <section className="card card-pad stack-sm" data-testid="requirements-generate">
                <h2 className="t-section">Tests from a requirements document</h2>
                <p className="t-secondary">
                    Add a requirements document when you explore (Advanced options) and the AI plans tests from it. A test it writes is linked to each requirement here whose reference it names, so import the same document first to see them linked.
                    {latestDoc && (
                        <>
                            {" "}
                            The latest exploration with a document ({relativeTime(latestDoc.createdAt)}) found {latestDoc.counters.requirementsTotal} requirements in it; its plan covers {latestDoc.counters.requirementsCovered ?? 0} of them. <a href={routes.run(id, latestDoc.jobId)}>Open that exploration</a>
                        </>
                    )}
                </p>
                {can("ai_studio.tests.generate") && (
                    <div>
                        <LinkButton icon={FileText} href={routes.newProject({ project: id })}>
                            Explore with a document
                        </LinkButton>
                    </div>
                )}
            </section>
        </ProjectPlace>
    );
}
