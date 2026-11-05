import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { projectKind, type ProjectDetail } from "../api";
import { usePage } from "../components/Shell";
import { Badge, Callout, EmptyState, ErrorState, ListSkeleton, Metric, PageHeader } from "../components/ui";
import { useDocumentTitle, useFetch } from "../lib/hooks";
import { friendlyError } from "../lib/labels";
import { help } from "../lib/help";
import { Tooltip } from "../components/Tooltip";
import { routes } from "../lib/router";
import { ProjectTabs } from "./ProjectOverview";

type Status = "covered" | "attention" | "gap";
interface Control {
    id: string;
    title: string;
    description: string;
    status: Status;
    tests: { total: number; validated: number; needsReview: number; failed: number };
    testRefs: Array<{ id: string; testId: string; title: string; validationStatus: string }>;
}
interface Report {
    disclaimer: string;
    testCount: number;
    frameworks: Array<{ framework: string; summary: { total: number; covered: number; attention: number; gap: number }; controls: Control[] }>;
}

const STATUS: Record<Status, { label: string; tone: "success" | "warning" | "neutral"; tip: string }> = {
    covered: { label: "Covered", tone: "success", tip: help("metric", "complianceCovered") },
    attention: { label: "Needs attention", tone: "warning", tip: help("metric", "complianceAttention") },
    // engine/compliance/map.ts: a control whose tests have not run yet is a gap too.
    gap: { label: "No tests yet", tone: "neutral", tip: "Controls no test covers yet, or whose tests have not run yet." },
};
const FRAMEWORK_NAME: Record<string, string> = { "NIST-800-53": "NIST 800-53", HIPAA: "HIPAA Security Rule", "ISO-27001": "ISO 27001" };

export function ProjectCompliance({ id }: { id: string }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const report = useFetch<Report>(`/projects/${id}/compliance`);
    const [active, setActive] = useState<string>();
    const name = project.data?.name;
    useDocumentTitle(name ? `Compliance · ${name}` : "Compliance");
    usePage({ crumbs: [{ label: "Projects", href: routes.home }, { label: name ?? "…", href: routes.project(id) }, { label: "Compliance" }], nav: "projects" });

    const fw = report.data?.frameworks.find((f) => f.framework === (active ?? report.data?.frameworks[0]?.framework));

    return (
        <>
            <PageHeader title="Compliance" subtitle="Which security-control topics your tests touch." />
            <ProjectTabs id={id} active="runs" count={project.data?.test_count} />
            <div className="stack">
                <Callout tone="info">{report.data?.disclaimer ?? "Indicative mapping of test coverage to control topics. It is not a compliance assessment or certification."}</Callout>
                {report.loading ? (
                    <ListSkeleton rows={5} />
                ) : report.error ? (
                    <ErrorState error={friendlyError(report.error.message)} onRetry={report.reload} />
                ) : !report.data || report.data.testCount === 0 ? (
                    <div className="card">
                        <EmptyState
                            icon={ShieldCheck}
                            title="No tests to map yet"
                            actions={
                                !project.data ? undefined : projectKind(project.data) === "code" ? (
                                    <a className="btn btn-primary" href={routes.tests(id)}>
                                        Open Test scripts
                                    </a>
                                ) : (
                                    <a className="btn btn-primary" href={routes.newProject({ project: id })}>
                                        Start exploring
                                    </a>
                                )
                            }
                        >
                            Once this project has tests, they’re matched to NIST, HIPAA and ISO 27001 controls here.
                        </EmptyState>
                    </div>
                ) : (
                    <>
                        <div className="chips" aria-label="Framework">
                            {report.data.frameworks.map((f) => (
                                <Tooltip key={f.framework} content={`${f.summary.covered} of ${f.summary.total} controls covered`}>
                                    <button className="chip" aria-pressed={f.framework === fw?.framework} onClick={() => setActive(f.framework)}>
                                        {FRAMEWORK_NAME[f.framework] ?? f.framework}
                                        <span className="n">{f.summary.covered}/{f.summary.total}</span>
                                    </button>
                                </Tooltip>
                            ))}
                        </div>
                        {fw && (
                            <div className="card divided" style={{ overflow: "hidden" }}>
                                <div className="metrics">
                                    <Metric value={fw.summary.covered} label="Covered" tip={STATUS.covered.tip} tone="ok" />
                                    <Metric value={fw.summary.attention} label="Need attention" tip={STATUS.attention.tip} tone={fw.summary.attention ? "warn" : undefined} />
                                    <Metric value={fw.summary.gap} label="No tests yet" tip={STATUS.gap.tip} />
                                </div>
                                <ul className="list divided">
                                    {fw.controls.map((c) => (
                                        <li key={c.id} className="section stack-sm" data-control={c.id}>
                                            <div className="row">
                                                <strong>{c.title}</strong>
                                                <span className="t-meta">{c.id}</span>
                                                <span className="spacer" />
                                                <Badge tone={STATUS[c.status].tone} tip={STATUS[c.status].tip}>{STATUS[c.status].label}</Badge>
                                            </div>
                                            <p className="t-secondary">{c.description}</p>
                                            {c.testRefs.length > 0 && (
                                                <p className="t-meta">
                                                    {c.tests.total} {c.tests.total === 1 ? "test" : "tests"}:{" "}
                                                    {c.testRefs.slice(0, 5).map((t, i) => (
                                                        <span key={t.id}>
                                                            {i > 0 && ", "}
                                                            <a href={routes.test(t.id)}>{t.title}</a>
                                                        </span>
                                                    ))}
                                                    {c.testRefs.length > 5 && ` and ${c.testRefs.length - 5} more`}
                                                </p>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </>
                )}
            </div>
        </>
    );
}
