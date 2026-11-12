import { Cable } from "lucide-react";
import { Badge } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { ranOnSentence, type RanOn, type RunnerChoice } from "../runners/runners";
import { RUNS_OFF_HERE, useExecutionMode, useRunsHere } from "../runs/runs-here";
import { runnerProblem, useMyRunner, type RunnerMine } from "../runners/my-runner";
import "./agents.css";
import { routes } from "../../lib/router";

/** A run happened on a runner that is not the person's own (a schedule's creator's, or a computer set up before): worth saying. */
function ranElsewhere(ranOn: RanOn, mine: RunnerMine | null | undefined): boolean {
    if (ranOn.kind !== "agent") return false;
    if (!mine) return true;
    const runnerId = (ranOn as { runnerId?: unknown }).runnerId;
    return typeof runnerId === "string" ? runnerId !== mine.id : ranOn.name !== mine.name;
}

/**
 * One quiet line, shown only when something is off about where this project's tests run. Runners mode: every run goes to the
 * person's own runner, so the line appears only while it is not set up or is offline, with a link to Settings. Local mode: only while
 * tests are switched off here or the project sends them to a runner. With `ranOn` (a run just finished): only when that run happened
 * somewhere other than the person's own runner.
 */
export function RunsOnLine({ projectId, ranOn }: { projectId: string; ranOn?: RanOn | null }) {
    const mode = useExecutionMode();
    const runner = useFetch<RunnerChoice>(mode === "local" && !ranOn ? `/projects/${projectId}/runner` : null);
    const me = useMyRunner(30_000, mode === "runners");
    // Tests switched off on this server: no run starts here or on a runner (the server hands runs out), so the line says that instead.
    const runsHere = useRunsHere();
    let text: string | null = null;
    let link = false;
    if (ranOn) {
        if (mode === "runners" && !me.data) return null;
        if (mode === "local" ? ranOn.kind === "agent" : ranElsewhere(ranOn, me.data?.runner)) text = ranOnSentence(ranOn);
    } else if (mode === "runners") {
        const why = me.data ? runnerProblem(me.data) : null;
        if (why) {
            text = why.replace(/\.$/, "");
            link = true;
        }
    } else if (runner.data) {
        text = !runsHere ? RUNS_OFF_HERE.replace(/\.$/, "") : runner.data.runOn === "agent" ? runner.data.status.replace(/\.$/, "") : null;
    }
    if (!text) return null;
    return (
        <p className="ag-runs-on t-secondary" data-testid="runs-on">
            <Cable size={16} aria-hidden />
            <span>{text}.</span>
            {link && <a href={routes.yourRunner}>Open Your runner in Settings</a>}
        </p>
    );
}

/** A small badge for a run list: only for a run that happened on a runner other than the person's own. */
export function RanOnBadge({ ranOn }: { ranOn?: RanOn | null }) {
    const mode = useExecutionMode();
    const me = useMyRunner(0, mode === "runners" && ranOn?.kind === "agent");
    if (!ranOn || ranOn.kind !== "agent") return null;
    if (mode === "runners" && (!me.data || !ranElsewhere(ranOn, me.data.runner))) return null;
    return (
        <Badge tone="info" icon={Cable} title={`This run happened on ${ranOn.name}`}>
            On {ranOn.name}
        </Badge>
    );
}
