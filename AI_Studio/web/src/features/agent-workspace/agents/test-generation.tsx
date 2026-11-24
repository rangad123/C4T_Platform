import { useState } from "react";
import { CalendarClock, Sparkles } from "lucide-react";
import { downloadFrom, type Job, type ProjectDetail } from "../../../api";
import { JobProgress } from "../../../components/JobProgress";
import { Callout, ErrorState, LinkButton, ListSkeleton } from "../../../components/ui";
import { isActive } from "../../../lib/labels";
import { useFetch, useOnFinish } from "../../../lib/hooks";
import { routes } from "../../../lib/router";
import { useCan } from "../../auth/permissions";
import { CaseOutcome } from "../../outcome/CaseOutcome";
import type { CaseOutcome as Outcome } from "../../outcome/outcome";
import type { AgentInputs } from "../../requirements/AgentInputs";
import { CaseRunDetail } from "../../runs/CaseRunDetail";
import { CaseRuns } from "../../runs/CaseRuns";
import { runNumbers } from "../../runs/case-runs";
import type { AgentView } from "../registry";

const ID = "test-generation";

/** This agent's newest run (its own, not another agent's), polled while it goes. */
function useNewestRun(projectId: string) {
    return useFetch<Job[]>(`/projects/${projectId}/workspace/${ID}/runs`, (d) => (isActive(d?.[0]?.status) ? 2000 : null));
}

/** The tree and its test cases, with the workbook download (founder 2026-11-19; what the project's Dashboard showed before the Workspace). */
function Outcome({ projectId }: { projectId: string }) {
    const can = useCan();
    const project = useFetch<ProjectDetail>(`/projects/${projectId}`);
    const runs = useNewestRun(projectId);
    const job = runs.data?.[0];
    const active = isActive(job?.status);
    const outcome = useFetch<Outcome>(`/projects/${projectId}/workspace/${ID}/outcome`, () => (active ? 3000 : null));
    useOnFinish(active, () => void outcome.reload());
    const [downloadError, setDownloadError] = useState<string | null>(null);
    const download = async () => {
        setDownloadError(null);
        try {
            await downloadFrom(`/projects/${projectId}/outcome/workbook`, `${project.data?.name ?? "Project"} test cases.xlsx`);
        } catch (e) {
            setDownloadError((e as Error).message);
        }
    };
    if (!outcome.data && !outcome.error) return <ListSkeleton rows={4} />;
    return (
        <div className="stack" data-testid="case-agent-dashboard">
            {job && active && <JobProgress job={job} onChanged={() => void runs.reload()} />}
            {downloadError && (
                <Callout tone="danger" title="The test cases could not be downloaded">
                    {downloadError}
                </Callout>
            )}
            {!outcome.data ? (
                <ErrorState error={{ title: "The test cases could not be loaded", body: outcome.error?.message ?? "" }} onRetry={() => void outcome.reload()} />
            ) : (
                <CaseOutcome
                    outcome={outcome.data}
                    downloadHref={can("ai_studio.reports.export") ? `/api/projects/${projectId}/outcome/workbook` : null}
                    onDownload={() => void download()}
                    emptyActions={
                        <LinkButton href={routes.newProject({ project: projectId, agent: ID })} variant="primary" icon={Sparkles}>
                            Start exploring
                        </LinkButton>
                    }
                />
            )}
        </div>
    );
}

/** Its runs, each adding to the one tree, and where its schedules are. */
function Runs({ projectId }: { projectId: string }) {
    return (
        <div className="stack">
            <CaseRuns id={projectId} jobsPath={`/projects/${projectId}/workspace/${ID}/runs`} />
            <p className="t-meta" data-testid="case-runs-schedules">
                <CalendarClock size={14} aria-hidden style={{ verticalAlign: "-2px", marginRight: 6 }} />
                To explore again on a timetable, so the tree keeps growing, open <a href={routes.agentSchedules(projectId, ID)}>Schedules</a>.
            </p>
        </div>
    );
}

/** One run: what it added to the tree (CaseRunDetail), numbered as in the list. */
function Run({ projectId, jobId }: { projectId: string; jobId: string }) {
    const outcome = useFetch<Outcome>(`/projects/${projectId}/workspace/${ID}/outcome`);
    if (outcome.loading) return <ListSkeleton rows={5} />;
    return <CaseRunDetail id={projectId} jobId={jobId} number={runNumbers(outcome.data).get(jobId)} />;
}

/** Its two inputs, the address and the requirements, and the sign-in its journeys may need: where each is kept. */
function Setup({ projectId }: { projectId: string }) {
    const inputs = useFetch<AgentInputs>(`/projects/${projectId}/agent-inputs`);
    if (inputs.loading) return <ListSkeleton rows={3} />;
    const d = inputs.data;
    if (!d) return <ErrorState error={{ title: "What this agent uses could not be loaded", body: inputs.error?.message ?? "" }} onRetry={() => void inputs.reload()} />;
    return (
        <section className="card card-pad stack-sm" data-testid="agent-setup">
            <p className="t-secondary">It explores the application’s address, or writes its test cases from the requirements when there is no address. Nothing is run.</p>
            <dl className="ws-inputs">
                <dt>Application address</dt>
                <dd>{d.application?.url || "None yet"} · <a href={routes.projectSettings(projectId, "general")}>Settings → General</a></dd>
                <dt>Requirements</dt>
                <dd>{d.requirements.active === 1 ? "1 active requirement" : `${d.requirements.active} active requirements`} · <a href={routes.requirements(projectId)}>Requirements</a></dd>
                <dt>Sign in</dt>
                <dd>{d.signIn.username ? `As ${d.signIn.username}` : "None: it explores signed out"} · <a href={routes.projectSettings(projectId, "signin")}>Settings → Sign-in</a></dd>
            </dl>
        </section>
    );
}

export const view: AgentView = { Outcome, Runs, Run, Setup };
