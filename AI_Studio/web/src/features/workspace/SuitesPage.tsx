import { ChevronRight, Layers, ListOrdered, Plus } from "lucide-react";
import { useState } from "react";
import { api, type ProjectDetail } from "../../api";
import { ProjectPlace } from "../../components/ProjectHub";
import { BadgeKey } from "../../components/Tooltip";
import { Badge, Button, Callout, EmptyState, ErrorState, JobBadge, jobKey, ListSkeleton } from "../../components/ui";
import { plural, relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { describeApiError, friendlyError } from "../../lib/labels";
import { go, routes } from "../../lib/router";
import { SuiteDetail } from "../suites/SuiteDetail";
import { runResult, type Suite, type SuiteList } from "../suites/suites";
import "../suites/suites.css";

/**
 * The Test suites place: suites people build (ordered tests and how they run), and the groups by area the platform makes for you.
 * `suiteId` opens one suite (`#/projects/:id/suites/:suiteId`).
 */
export function SuitesPage({ id, suiteId }: { id: string; suiteId?: string }) {
    return (
        <ProjectPlace id={id} place="suites" title="Test suites" subtitle="Groups of test cases that run together, in an order you choose, and how they run.">
            {suiteId ? <SuiteDetail projectId={id} suiteId={suiteId} /> : <SuiteIndex id={id} />}
        </ProjectPlace>
    );
}

function SuiteIndex({ id }: { id: string }) {
    const list = useFetch<SuiteList>(`/projects/${id}/test-suites`);
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const canWrite = !project.data?.access || project.data.access.permissions.includes("ai_studio.tests.write");
    const [adding, setAdding] = useState(false);
    const data = list.data;
    const full = data ? data.suites.length >= data.limits.suitesPerProject : false;

    return (
        <>
            {data && !data.canRun.ok && (
                <Callout tone="warning" title="Tests do not run on this server">
                    {data.canRun.reason} You can still build suites and their settings here.
                </Callout>
            )}
            <section className="card" aria-labelledby="suites-built">
                <div className="card-head wrap">
                    <ListOrdered size={18} aria-hidden />
                    <h2 className="t-section" id="suites-built">
                        Suites you build
                    </h2>
                    {data && data.suites.some((s) => s.lastRun) && <BadgeKey label="the run badges" entries={jobKey(data.suites.flatMap((s) => (s.lastRun ? [s.lastRun.job] : [])))} />}
                    <span className="spacer" />
                    {canWrite && data && data.suites.length > 0 && !adding && (
                        <Button size="sm" icon={Plus} onClick={() => setAdding(true)} disabled={full} tip={full ? `A project can have up to ${data.limits.suitesPerProject} suites.` : "Name a suite, then add test cases to it."}>
                            New suite
                        </Button>
                    )}
                </div>
                {list.loading ? (
                    <ListSkeleton rows={3} />
                ) : list.error || !data ? (
                    <div className="card-pad">
                        <ErrorState error={friendlyError(list.error?.message)} onRetry={list.reload} />
                    </div>
                ) : (
                    <>
                        {data.suites.length === 0 && !adding ? (
                            <EmptyState icon={ListOrdered} title="No suites yet" actions={canWrite ? <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>New suite</Button> : undefined}>
                                A suite is a list of test cases in the order they run, with how they run: for example a quick smoke suite and a full suite.
                                {!canWrite && " You can look at suites here; building them needs permission to change tests."}
                            </EmptyState>
                        ) : (
                            data.suites.length > 0 && (
                                <ul className="list divided" aria-label="Suites you build">
                                    {data.suites.map((s) => (
                                        <li key={s.id}>
                                            <a className="list-row" href={routes.suite(id, s.id)} data-suite={s.id}>
                                                <span className="main">
                                                    <span className="title">{s.name}</span>
                                                    <span className="meta">
                                                        {plural(s.testCount, "test")}
                                                        {s.settings.environment ? `, against “${s.settings.environment}”` : ""}
                                                        {s.lastRun ? `. Last run ${relativeTime(s.lastRun.createdAt)}: ${runResult(s.lastRun)}` : ". Not run yet"}
                                                    </span>
                                                </span>
                                                <span className="tail">{s.lastRun && <JobBadge job={s.lastRun.job} />}</span>
                                                <ChevronRight size={16} className="chev" aria-hidden />
                                            </a>
                                        </li>
                                    ))}
                                </ul>
                            )
                        )}
                        {adding && (
                            <NewSuiteForm
                                projectId={id}
                                onCancel={() => setAdding(false)}
                                onCreated={(s) => {
                                    setAdding(false);
                                    go(routes.suite(id, s.id));
                                }}
                            />
                        )}
                    </>
                )}
            </section>

            <section className="stack-sm" aria-labelledby="suites-auto">
                <div className="row">
                    <h2 className="t-section" id="suites-auto">
                        Groups by area
                    </h2>
                    <Badge tone="neutral">Made for you</Badge>
                </div>
                <p className="t-secondary">The platform groups tests by the part of the application they check. You cannot change these groups or their order.</p>
                {list.loading ? (
                    <ListSkeleton rows={3} />
                ) : !data ? null : data.automatic.length === 0 ? (
                    <div className="card">
                        <EmptyState icon={Layers} title="No groups yet">
                            Groups appear when the project has test scripts.
                        </EmptyState>
                    </div>
                ) : (
                    <div className="card">
                        <ul className="list divided" aria-label="Groups by area">
                            {data.automatic.map((s) => (
                                <li key={s.id}>
                                    <a className="list-row" href={routes.tests(id)}>
                                        <span className="main">
                                            <span className="title">{s.name}</span>
                                            <span className="meta">
                                                {plural(Number(s.total), "test")}, {Number(s.validated) || 0} passing
                                            </span>
                                        </span>
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </section>
        </>
    );
}

function NewSuiteForm({ projectId, onCancel, onCreated }: { projectId: string; onCancel: () => void; onCreated: (s: Suite) => void }) {
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    async function create() {
        setBusy(true);
        setError("");
        try {
            onCreated(await api<Suite>(`/projects/${projectId}/test-suites`, { method: "POST", body: { name, ...(description.trim() ? { description } : {}) } }));
        } catch (e) {
            setError(describeApiError(e));
            setBusy(false);
        }
    }

    return (
        <form
            className="card-pad stack-sm suite-form"
            aria-label="New suite"
            onSubmit={(e) => {
                e.preventDefault();
                void create();
            }}
        >
            <div className="field">
                <label htmlFor="suite-name">Name</label>
                <input id="suite-name" className="input" value={name} maxLength={80} required autoFocus placeholder="For example: Smoke, Checkout, Full regression" onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
                <label htmlFor="suite-description">What it is for (optional)</label>
                <textarea id="suite-description" className="input" rows={2} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="row">
                <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
                    Create suite
                </Button>
                <Button type="button" variant="ghost" onClick={onCancel}>
                    Cancel
                </Button>
            </div>
        </form>
    );
}
