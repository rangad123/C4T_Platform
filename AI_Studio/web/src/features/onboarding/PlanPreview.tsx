import { RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ApiError, api, type Job } from "../../api";
import { Button, Callout, Disclosure, ErrorState, LinkButton, Skeleton } from "../../components/ui";
import { plural } from "../../lib/format";
import { describeApiError, friendlyError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { announceRunsChanged } from "../runs/runs";
import { useFetch } from "../../lib/hooks";
import { countOf, createBody, createSentence, explored, foundSentence, ideaPriority, ideasOf, initialChoice, isOn, normalizePlan, phoneOnlyPlan, planLines, planTotal, type PlanAnswer, type PlanChoice, type PlanFamily, type PlanIdea, type ReadyPlan } from "./onboarding";
import { LeftAlone } from "../phone/PhoneProgress";
import { exploreAgainHref } from "../phone/phone";
import { coverageSentence } from "../phonedevice/phonedevice";
import "./onboarding.css";

/**
 * What an exploration found and what it would create, before anything is created. The person can leave kinds of test or
 * single test ideas out, create the tests, or throw the plan away. Nothing here runs a test: it only reads the plan the
 * platform kept (GET /api/projects/:id/plans/:jobId) and confirms it (POST .../create).
 */
export function PlanPreview({ projectId, job, onChanged }: { projectId: string; job: Job; onChanged: () => void }) {
    const answer = useFetch<PlanAnswer>(`/projects/${projectId}/plans/${job.jobId}`);
    const [choice, setChoice] = useState<PlanChoice | null>(null);
    const [busy, setBusy] = useState<"" | "create" | "discard">("");
    const [problem, setProblem] = useState("");
    const [discarded, setDiscarded] = useState(false);

    const shown = useMemo(() => (answer.data ? normalizePlan(answer.data) : undefined), [answer.data]);
    const plan = shown && shown.ready ? shown : undefined;
    const exploreAgain = exploreAgainHref(job, projectId);
    useEffect(() => {
        if (plan && !choice) setChoice(initialChoice(plan));
    }, [plan, choice]);

    if (discarded) {
        return (
            <section className="card card-pad">
                <Callout tone="neutral" title="The plan was discarded" actions={<LinkButton variant="primary" icon={RefreshCw} href={exploreAgain}>Explore again</LinkButton>}>
                    Nothing was created. Explore again whenever you like.
                </Callout>
            </section>
        );
    }
    if (answer.loading) {
        return (
            <section className="card card-pad stack" aria-label="Plan" aria-busy="true">
                <Skeleton w={260} h={22} />
                <Skeleton h={16} />
                <Skeleton h={16} w="70%" />
                <Skeleton h={40} w={180} />
            </section>
        );
    }
    if (answer.error) {
        const failure = answer.error;
        const status = failure instanceof ApiError ? failure.status : 0;
        if (status === 410 || status === 409) {
            return (
                <section className="card card-pad">
                    <Callout
                        tone="neutral"
                        title={status === 410 ? "This plan is no longer available" : "There is no plan to show"}
                        actions={<LinkButton variant="primary" icon={RefreshCw} href={exploreAgain}>Explore again</LinkButton>}
                    >
                        {failure.message} Nothing was created.
                    </Callout>
                </section>
            );
        }
        return <ErrorState error={friendlyError(answer.error.message)} onRetry={answer.reload} />;
    }
    if (!plan || !choice) return null;

    const lines = planLines(plan, choice);
    const total = planTotal(plan, choice);
    const left = new Set(choice.left);

    const setFamily = (f: PlanFamily, on: boolean) => {
        const ids = ideasOf(plan, f).map((i) => i.id);
        if (f.id === "journeys" || ids.length > 0) setChoice({ ...choice, left: on ? choice.left.filter((x) => !ids.includes(x)) : [...new Set([...choice.left, ...ids])] });
        else setChoice({ ...choice, switches: { ...choice.switches, [f.option]: on } });
    };
    const setIdea = (id: string, on: boolean) => setChoice({ ...choice, left: on ? choice.left.filter((x) => x !== id) : [...choice.left, id] });

    async function create() {
        if (!plan || !choice) return;
        setBusy("create");
        setProblem("");
        try {
            await api(`/projects/${projectId}/plans/${plan.jobId}/create`, { method: "POST", body: createBody(plan, choice) });
            announceRunsChanged();
            onChanged();
        } catch (e) {
            setProblem(describeApiError(e));
            setBusy("");
        }
    }
    async function discard() {
        setBusy("discard");
        setProblem("");
        try {
            await api(`/projects/${projectId}/plans/${job.jobId}`, { method: "DELETE" });
            setDiscarded(true);
        } catch (e) {
            setProblem(describeApiError(e));
        } finally {
            setBusy("");
        }
    }

    const onPhone = phoneOnlyPlan(plan);
    const nothingFound = onPhone ? (plan.found.screens ?? 0) === 0 : plan.found.pages === 0 && plan.found.apiEndpoints === 0;
    const loginPage = onPhone ? plan.signInNeeded === true && !plan.signInDetails : plan.pages.some((p) => p.type === "login") && !plan.signInDetails;

    return (
        <section className="card card-pad stack plan" aria-labelledby="plan-title" data-testid="plan-preview">
            <div className="stack-sm">
                <h2 className="t-section" id="plan-title">
                    Here is what we will do
                </h2>
                <p data-testid="plan-found">{foundSentence(plan.found, plan.targets)}</p>
                {onPhone && plan.phone?.coverage && (
                    <p className="t-secondary" data-testid="plan-coverage">
                        {coverageSentence({ screens: plan.phone.coverage.screens, activities: plan.phone.coverage.activitiesSeen?.length ?? 0, activitiesListed: plan.phone.coverage.activitiesListed, stoppedBecause: plan.phone.coverage.stoppedBecause })}
                    </p>
                )}
                <p className="plan-create" data-testid="plan-sentence">
                    {createSentence(lines, onPhone ? "phone test" : "test")}
                </p>
                <p className="t-secondary">Nothing has been created or run yet. Change what is included, then create the tests when you are ready.</p>
            </div>

            {plan.about && (
                <p className="t-secondary" data-testid="plan-about">
                    The AI describes it as {plan.about.purpose ? `“${plan.about.purpose.replace(/\.$/, "")}”` : "an application"}
                    {plan.about.siteType !== "unknown" ? ` (type: ${plan.about.siteType}).` : "."}
                </p>
            )}

            {lines.length > 0 && (
                <ul className="plan-lines" aria-label="Tests to create">
                    {lines.map((l) => (
                        <li key={l.id}>
                            <span>{l.label}</span>
                            <span className="num">{l.count}</span>
                        </li>
                    ))}
                </ul>
            )}

            {plan.warnings.map((w) => {
                // The notes of a phone exploration are already plain sentences: they are shown as they are.
                if (onPhone) return <Callout key={w} tone="warning" title="Worth knowing">{w}</Callout>;
                const f = friendlyError(w.replace(/^Web analysis\/planning failed: /, ""));
                return (
                    <Callout key={w} tone="warning" title={f.title} actions={f.fix ? <LinkButton href={f.fix.href}>{f.fix.label}</LinkButton> : undefined}>
                        {f.body}
                    </Callout>
                );
            })}
            {nothingFound && (
                <Callout tone="warning" title="Nothing to test was found">
                    {onPhone ? "We could not find screens in the app. Check that it starts on the phone or emulator, then explore again." : "We could not find pages or API endpoints at this address. Check the address and that the application is running, then explore again."}
                </Callout>
            )}
            {loginPage && (
                <p className="t-meta" data-testid="plan-login-hint">
                    {onPhone ? "The app asks for a sign-in. Screens behind it are not part of this plan. Add a test account under Advanced options when you explore again." : "We found a sign-in page. Pages behind it are not part of this plan. You can add sign-in details when you explore again."}
                </p>
            )}
            {problem && (
                <Callout tone="danger" title="That did not work">
                    {problem}
                </Callout>
            )}

            <div className="row plan-actions">
                <Button variant="primary" size="lg" icon={Sparkles} loading={busy === "create"} disabled={total === 0 || busy !== ""} onClick={() => void create()} tip={total === 0 ? "Nothing is included. Tick at least one kind of test under Edit the plan." : "Creates the tests left in the plan and runs each one. The application is not explored again."}>
                    {busy === "create" ? "Starting…" : "Create the tests"}
                </Button>
                <Button variant="ghost" loading={busy === "discard"} disabled={busy !== ""} onClick={() => void discard()} tip="Forgets this plan. Nothing was created and your existing tests stay. Explore again for a new plan.">
                    Discard the plan
                </Button>
            </div>

            <Disclosure label="Edit the plan">
                <div className="stack plan-edit">
                    <fieldset className="stack-sm plan-fieldset">
                        <legend className="t-card">Kinds of test</legend>
                        {plan.families.map((f) => (
                            <FamilyRow key={f.id} plan={plan} family={f} count={countOf(plan, f, choice)} on={isOn(plan, f, choice)} onChange={(on) => setFamily(f, on)}>
                                {ideasOf(plan, f).length > 0 && (
                                    <ul className="plan-ideas" aria-label={f.id === "journeys" ? "Test ideas" : `Test ideas: ${f.label}`}>
                                        {ideasOf(plan, f).map((i) => (
                                            <li key={i.id}>
                                                <label className="check">
                                                    <input type="checkbox" checked={!left.has(i.id)} onChange={(e) => setIdea(i.id, e.target.checked)} />
                                                    <span>
                                                        <span className="title">{i.title}</span>
                                                        <span className="hint">{ideaHint(i)}</span>
                                                        {i.path && i.path.length > 0 && <span className="hint" data-testid="idea-path">Path: {i.path.join(" → ")}</span>}
                                                    </span>
                                                </label>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </FamilyRow>
                        ))}
                    </fieldset>
                    <p className="t-meta">
                        {onPhone ? "Phone tests are tried on the device, so a few may not work out. Add a test account when you explore again if the app needs a login." : "Journeys are tried in a real browser, so a few may not work out; the other numbers are exact. Add test accounts, sign-in details or data-changing tests when you explore again."}
                    </p>
                </div>
            </Disclosure>

            {plan.screens && plan.screens.length > 0 && (
                <Disclosure label={`What we found (${plural(plan.found.screens ?? plan.screens.length, "screen")})`}>
                    <ul className="plan-screens" aria-label="Screens found" data-testid="plan-screens">
                        {plan.screens.map((sc) => (
                            <li key={sc.name + (sc.path?.join("/") ?? "")}>
                                {sc.thumbnail && <img className="plan-thumb" src={sc.thumbnail} alt={`The ${sc.name} screen`} width={54} height={96} />}
                                <span>
                                    <span className="title">{sc.name}</span>
                                    {sc.path && sc.path.length > 1 && <span className="t-meta"> Reached by {sc.path.join(" → ")}</span>}
                                </span>
                            </li>
                        ))}
                    </ul>
                    {plan.found.screens !== undefined && plan.found.screens > plan.screens.length && <p className="t-meta">Showing the first {plan.screens.length}.</p>}
                </Disclosure>
            )}

            {onPhone && plan.couldNotWrite && plan.couldNotWrite.length > 0 && (
                <Disclosure label={`Ideas left out (${plan.couldNotWrite.length})`}>
                    <p className="t-meta">The AI thought of these but could not write them as tests it could repeat, so they are not in the plan.</p>
                    <ul className="bullets" data-testid="plan-dropped">
                        {plan.couldNotWrite.map((d) => (
                            <li key={d.title}>
                                {d.title}: {d.reason.replace(/\.$/, "")}.
                            </li>
                        ))}
                    </ul>
                </Disclosure>
            )}

            {onPhone && <LeftAlone jobId={job.jobId} known={plan.skipped} />}

            {/* Phone reliability: how each test starts, and the permission answers the tests repeat (only when there is something to say). */}
            {onPhone && (plan.phone?.startState || plan.phone?.permissionAnswers?.length) ? (
                <div className="stack-sm" data-testid="plan-start-state">
                    {plan.phone?.startState && <p className="t-secondary">{plan.phone.startState}</p>}
                    {plan.phone?.permissionAnswers?.length ? <p className="t-secondary">Each test starts with: {plan.phone.permissionAnswers.map((a) => a.step).join(", ")}. The answer is given only if the phone asks.</p> : null}
                </div>
            ) : null}

            {plan.pages.length > 0 && (
                <Disclosure label={`What we found (${plural(plan.found.pages, "page")})`}>
                    <ul className="plan-pages" aria-label="Pages found">
                        {plan.pages.map((p) => (
                            <li key={p.path}>
                                <code>{p.path}</code>
                                <span className="t-meta">{p.title || p.type}</span>
                            </li>
                        ))}
                    </ul>
                    {plan.found.pages > plan.pages.length && <p className="t-meta">Showing the first {plan.pages.length}.</p>}
                </Disclosure>
            )}
        </section>
    );
}

function FamilyRow({ plan, family: f, count, on, onChange, children }: { plan: ReadyPlan; family: PlanFamily; count: number; on: boolean; onChange: (on: boolean) => void; children?: React.ReactNode }) {
    const here = explored(plan, f.needs);
    const note = !here ? (f.needs === "web" ? "The web side was not explored in this plan." : f.needs === "mobile" ? "The phone app was not explored in this plan." : "The API side was not explored in this plan.") : f.note;
    return (
        <div className="plan-family">
            <label className="check">
                <input type="checkbox" checked={here && on} disabled={!here} onChange={(e) => onChange(e.target.checked)} />
                <span>
                    <span className="title">{f.label}</span>
                    <span className="hint">
                        {here ? `${f.id === "journeys" ? "About " : ""}${plural(count, "test")}. ` : ""}
                        {f.about}
                        {note ? ` ${note}` : ""}
                    </span>
                </span>
            </label>
            {children}
        </div>
    );
}

/** One line under a test idea: what it checks (a phone plan) or the journey it belongs to, and how important it is. */
const ideaHint = (i: PlanIdea): string => [(i.goal ?? i.journey)?.replace(/[.]+$/, ""), ideaPriority(i.priority)].filter(Boolean).join(", ");
