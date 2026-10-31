import { useFetch, useConfig } from "../../lib/hooks";
import type { Agent } from "../agents/agents";
import type { CodeConfig, ConfigWithCode } from "./code";

/**
 * Can this project run hand-written scripts? Yes when the platform host allows it, or when the project runs on a runner agent
 * that reported it accepts them. While the answers are still loading, `known` is false so the page shows no warning yet.
 */
export function useRunPolicy(projectId: string | null): { known: boolean; enabled: boolean; config: CodeConfig | undefined } {
    const cfg = useConfig() as ConfigWithCode | undefined;
    const runner = useFetch<{ runOn: "platform" | "agent"; agentId: string | null }>(projectId ? `/projects/${projectId}/runner` : null);
    const agents = useFetch<Agent[]>(projectId ? `/projects/${projectId}/agents` : null);
    const known = !!cfg && !runner.loading && !agents.loading;
    const code = cfg?.customScripts;
    const viaAgent =
        runner.data?.runOn === "agent" &&
        !!agents.data?.some((a) => a.id === runner.data!.agentId && a.online && (a.capabilities as { customScripts?: boolean }).customScripts === true);
    return { known, enabled: !!code?.platform || viaAgent, config: code };
}
