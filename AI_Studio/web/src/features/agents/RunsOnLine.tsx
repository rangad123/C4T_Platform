import { Cable } from "lucide-react";
import { Badge } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { routes } from "../../lib/router";
import { ranOnSentence, type RanOn, type RunnerChoice } from "./agents";
import "./agents.css";

/**
 * One quiet line saying where this project's tests run ("Runs on this server", "Runs on Maya's laptop (online)"), with a link to change it.
 * With `ranOn` (the answer of a run just finished) it says where that run happened instead. It shows nothing when the platform
 * does not answer, so a server without runner agents looks exactly as before.
 */
export function RunsOnLine({ projectId, ranOn }: { projectId: string; ranOn?: RanOn | null }) {
    const runner = useFetch<RunnerChoice>(`/projects/${projectId}/runner`);
    const cur = runner.data;
    if (!cur) return null;
    const text = ranOn ? ranOnSentence(ranOn) : cur.runOn === "agent" ? cur.status.replace(/\.$/, "") : "Runs on this server";
    return (
        <p className="ag-runs-on t-secondary" data-testid="runs-on">
            <Cable size={16} aria-hidden />
            <span>{text}.</span>
            <a href={routes.runners(projectId)}>{cur.runOn === "agent" ? "Change" : "Use a runner"}</a>
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
