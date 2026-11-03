import { useEffect, useRef } from "react";
import { useFetch } from "../../lib/hooks";
import type { AgentSwitch, ProjectAgents, SwitchState } from "./testing-agents";

type Setters = Partial<Record<AgentSwitch, (on: boolean) => void>>;

/**
 * The explore form under a project's saved testing agents: once loaded, each switch starts as the agents set it (on when a chosen
 * agent runs it, off otherwise), and the states come back so the form can lock the switches no chosen agent owns. A project with
 * no saved choice (or not tested by the AI agent) gives undefined, and the form keeps its usual defaults; the server decides again.
 */
export function useAgentSwitches(projectId: string | undefined, set: Setters): Record<AgentSwitch, SwitchState> | undefined {
    const got = useFetch<ProjectAgents>(projectId ? `/projects/${projectId}/testing-agents` : null);
    const d = got.data && got.data.applies && got.data.source === "chosen" ? got.data : undefined;
    const applied = useRef(false);
    useEffect(() => {
        if (!d || applied.current) return;
        applied.current = true;
        for (const [k, fn] of Object.entries(set) as Array<[AgentSwitch, (on: boolean) => void]>) fn(d.switches[k] === "on");
    }, [d]); // eslint-disable-line react-hooks/exhaustive-deps
    return d?.switches;
}
