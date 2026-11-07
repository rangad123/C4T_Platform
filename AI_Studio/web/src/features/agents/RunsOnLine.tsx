import { Cable } from "lucide-react";
import { Badge } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { routes } from "../../lib/router";
import { ranOnSentence, type RanOn, type RunnerChoice } from "./agents";
import { ADD_THIS_COMPUTER_HREF, NO_NEEDS, NO_RUNNER_ONLINE, RUNS_OFF_HERE, sortChoices, useExecutionMode, useRunnerChoices, useRunsHere, whyNotRunner, type RunnerChoices } from "../runs/runs-here";
import "./agents.css";

/**
 * One quiet line saying where this project's tests run ("Runs on this server", "Runs on Maya's laptop (online)"), with a link to change it.
 * With `ranOn` (the answer of a run just finished) it says where that run happened instead. It shows nothing when the platform
 * does not answer, so a server without runner agents looks exactly as before. In runners mode (every run goes to a runner) it says
 * which runner this person's runs would go to, or that none is online, with a way to add this computer.
 */
export function RunsOnLine({ projectId, ranOn }: { projectId: string; ranOn?: RanOn | null }) {
    const mode = useExecutionMode();
    const runner = useFetch<RunnerChoice>(`/projects/${projectId}/runner`);
    const choices = useRunnerChoices(projectId, mode === "runners" && !ranOn, 30_000);
    // Tests switched off on this server: no run starts here or on a runner (the server hands runs out), so the line says that instead.
    const runsHere = useRunsHere();
    const cur = runner.data;
    if (mode === "runners" && !ranOn) {
        if (choices.data) return <RunnersLine projectId={projectId} c={choices.data} />;
        if (!cur) return null;
    }
    if (!cur) return null;
    const off = !ranOn && !runsHere && mode === "local";
    const text = ranOn ? ranOnSentence(ranOn) : off ? RUNS_OFF_HERE.replace(/\.$/, "") : cur.runOn === "agent" || mode === "runners" ? cur.status.replace(/\.$/, "") : "Runs on this server";
    return (
        <p className="ag-runs-on t-secondary" data-testid="runs-on">
            <Cable size={16} aria-hidden />
            <span>{text}.</span>
            {!off && <a href={routes.runners(projectId)}>{cur.runOn === "agent" || mode === "runners" ? "Change" : "Use a runner"}</a>}
        </p>
    );
}

/** Runners mode: where a run started now would go, for this person. */
function RunnersLine({ projectId, c }: { projectId: string; c: RunnerChoices }) {
    const usable = sortChoices(c.runners).filter((r) => !whyNotRunner(r, NO_NEEDS, c.allowPersonal));
    const pinned = c.defaultRunnerId ? usable.find((r) => r.id === c.defaultRunnerId) : undefined;
    const state = (r: { busy: boolean }) => (r.busy ? "busy" : "online");
    const text =
        usable.length === 0
            ? NO_RUNNER_ONLINE.replace(/\.$/, "")
            : pinned
              ? `Runs on ${pinned.name} (${state(pinned)})`
              : usable.length === 1
                ? `Runs on ${usable[0]!.name} (${state(usable[0]!)})`
                : `Runs on a runner that is online (${usable.length} you can use)`;
    return (
        <p className="ag-runs-on t-secondary" data-testid="runs-on">
            <Cable size={16} aria-hidden />
            <span>{text}.</span>
            {usable.length === 0 && c.allowPersonal && <a href={ADD_THIS_COMPUTER_HREF}>Add this computer</a>}
            <a href={routes.runners(projectId)}>{usable.length === 0 ? "See runners" : "Change"}</a>
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
