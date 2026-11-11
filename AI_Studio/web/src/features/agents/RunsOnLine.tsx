import { Cable } from "lucide-react";
import { Badge } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { ranOnSentence, type RanOn, type RunnerChoice } from "./agents";
import { RUNS_OFF_HERE, useExecutionMode, useRunsHere } from "../runs/runs-here";
import { runnerProblem, runsOnSentence, useMyRunner } from "../runners/my-runner";
import "./agents.css";
import { routes } from "../../lib/router";

/**
 * One quiet line saying where this project's tests run. With `ranOn` (the answer of a run just finished) it says where that run happened
 * instead. Runners mode: every run goes to the person's own runner, so the line names it, or says what is missing, with a link to
 * Settings. Local mode: where the project runs its tests ("Runs on this server").
 */
export function RunsOnLine({ projectId, ranOn }: { projectId: string; ranOn?: RanOn | null }) {
    const mode = useExecutionMode();
    const runner = useFetch<RunnerChoice>(mode === "local" && !ranOn ? `/projects/${projectId}/runner` : null);
    const me = useMyRunner(30_000, mode === "runners" && !ranOn);
    // Tests switched off on this server: no run starts here or on a runner (the server hands runs out), so the line says that instead.
    const runsHere = useRunsHere();
    let text: string | null;
    let link: string | null = null;
    if (ranOn) text = ranOnSentence(ranOn);
    else if (mode === "runners") {
        if (!me.data) return null;
        const why = runnerProblem(me.data);
        text = why ? why.replace(/\.$/, "") : runsOnSentence(me.data.runner!);
        link = why ? "Open Your runner in Settings" : "Your runner";
    } else {
        const cur = runner.data;
        if (!cur) return null;
        text = !runsHere ? RUNS_OFF_HERE.replace(/\.$/, "") : cur.runOn === "agent" ? cur.status.replace(/\.$/, "") : "Runs on this server";
    }
    return (
        <p className="ag-runs-on t-secondary" data-testid="runs-on">
            <Cable size={16} aria-hidden />
            <span>{text}.</span>
            {link && <a href={routes.allRunners}>{link}</a>}
        </p>
    );
}

/** A small badge for a run list: only for runs that happened on an agent. */
export function RanOnBadge({ ranOn }: { ranOn?: RanOn | null }) {
    if (!ranOn || ranOn.kind !== "agent") return null;
    return (
        <Badge tone="info" icon={Cable} title={`This run happened on ${ranOn.name}`}>
            On {ranOn.name}
        </Badge>
    );
}
