import { CircleCheck, Circle } from "lucide-react";
import type { ReactNode } from "react";
import type { Job, TestSummary } from "../../api";
import { LinkButton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { routes } from "../../lib/router";
import type { Agent } from "../agents/agents";
import { RunMenu } from "../runs/RunMenu";
import "./onboarding.css";

interface Step {
    key: string;
    done: boolean;
    title: string;
    text: string;
    /** One action each; none once the step is done. */
    action?: ReactNode;
}

/**
 * What to do after the first tests exist, one action each. Every step ticks itself from what the platform already knows (a run
 * that happened, a schedule that exists, sign-in details that were saved, a runner that connected): nothing is stored for the list,
 * so it can never disagree with the project. A step that does not apply is not shown.
 */
export function NextSteps({
    projectId,
    tests,
    scheduleCount,
    hasSignIn,
    firstNotPassing,
    notPassing,
    explores = true,
}: {
    projectId: string;
    tests: TestSummary[];
    scheduleCount: number | undefined;
    hasSignIn: boolean;
    firstNotPassing: TestSummary | undefined;
    notPassing: number;
    /** False for a code project: it is never explored, so the step that adds sign-in details by exploring again is left out. */
    explores?: boolean;
}) {
    const jobs = useFetch<Job[]>(`/projects/${projectId}/jobs`);
    const agents = useFetch<Agent[]>(`/projects/${projectId}/agents`);
    const model = useFetch<{ authentication?: { required?: boolean } } | null>(`/projects/${projectId}/application-model`);

    // Until the facts are in, show nothing rather than a list that then changes under the person's eyes.
    if (jobs.loading || agents.loading || model.loading || scheduleCount === undefined) return null;

    const ranAgain = (jobs.data ?? []).some((j) => j.mode === "validate" && ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status));
    const needsSignIn = explores && model.data?.authentication?.required === true;
    const steps: Step[] = [];

    if (notPassing > 0 && firstNotPassing) {
        steps.push({
            key: "open",
            done: false,
            title: notPassing === 1 ? "Open the test that is not passing" : `Open a test that is not passing (${notPassing} are)`,
            text: "See what it expected, what happened instead, and fix the test or the application.",
            action: <LinkButton variant="primary" href={routes.test(firstNotPassing.id)}>Open {firstNotPassing.testId}</LinkButton>,
        });
    }
    steps.push({
        key: "run",
        done: ranAgain,
        title: "Run the tests again whenever you like",
        text: ranAgain ? "You have run them again." : "For example after you change your application. Results are kept in Runs.",
        action: <RunMenu projectId={projectId} tests={tests} label="Run all tests" />,
    });
    steps.push({
        key: "schedule",
        done: scheduleCount > 0,
        title: "Set a schedule",
        text: scheduleCount > 0 ? "A schedule is set." : "Run the tests every night or every week without opening the platform.",
        action: <LinkButton href={routes.schedule(projectId)}>Set a schedule</LinkButton>,
    });
    if (needsSignIn) {
        steps.push({
            key: "login",
            done: hasSignIn,
            title: "Add your login",
            text: hasSignIn ? "Sign-in details are saved for this project." : "Your application has a sign-in page. Add a test account so the tests can see what is behind it.",
            action: <LinkButton href={routes.requirements(projectId)} tip="Opens the Requirements tab. Sign-in details are under What the agents need; the next exploration uses them.">Add sign-in details</LinkButton>,
        });
    }
    steps.push({
        key: "runner",
        done: (agents.data ?? []).length > 0,
        title: "Run tests on your own computer",
        text: (agents.data ?? []).length > 0 ? "A runner is connected." : "Connect a runner to run tests inside your network or on a phone. Optional.",
        action: <LinkButton href={routes.runners(projectId)}>Connect a runner</LinkButton>,
    });

    // Everything that applies is done: the list has nothing left to say.
    if (steps.every((s) => s.done)) return null;
    return (
        <section className="stack-sm" aria-labelledby="next-steps" data-testid="next-steps">
            <div className="section-head">
                <h2 className="t-section" id="next-steps">
                    Next steps
                </h2>
                <span className="t-meta">{steps.filter((s) => s.done).length} of {steps.length} done</span>
            </div>
            <ul className="card list divided next-steps">
                {steps.map((s) => (
                    <li key={s.key} className={`next-step${s.done ? " is-done" : ""}`} data-step={s.key} data-done={s.done}>
                        <span className="tick" aria-hidden>
                            {s.done ? <CircleCheck size={20} /> : <Circle size={20} />}
                        </span>
                        <span className="what">
                            <span className="title">
                                {s.title}
                                <span className="sr-only">{s.done ? ", done" : ", not done yet"}</span>
                            </span>
                            <span className="t-secondary">{s.text}</span>
                        </span>
                        {!s.done && s.action && <span className="act">{s.action}</span>}
                    </li>
                ))}
            </ul>
        </section>
    );
}
