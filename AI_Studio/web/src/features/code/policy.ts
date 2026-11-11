import { useFetch, useConfig } from "../../lib/hooks";
import type { Agent } from "../agents/agents";
import { useMyRunner } from "../runners/my-runner";
import type { CodeConfig, ConfigWithCode } from "./code";

/**
 * Can this project run hand-written scripts? Runners mode: when the person's own runner takes code scripts (its switch in Settings).
 * Local mode: when the platform host allows it, or when the project runs on a runner that reported it accepts them. While the answers
 * are still loading, `known` is false so the page shows no warning yet.
 */
export function useRunPolicy(projectId: string | null): { known: boolean; enabled: boolean; config: CodeConfig | undefined } {
    const cfg = useConfig() as ConfigWithCode | undefined;
    const runnersOnly = cfg?.executionMode === "runners";
    const local = Boolean(cfg) && !runnersOnly;
    const runner = useFetch<{ runOn: "platform" | "agent"; agentId: string | null }>(projectId && local ? `/projects/${projectId}/runner` : null);
    const agents = useFetch<Agent[]>(projectId && local ? `/projects/${projectId}/agents` : null);
    const me = useMyRunner(0, runnersOnly);
    const code = cfg?.customScripts;
    if (runnersOnly) {
        const r = me.data?.runner;
        return { known: !me.loading, enabled: Boolean(r && r.switches?.codeScripts !== false), config: code };
    }
    const known = !!cfg && !runner.loading && !agents.loading;
    const viaAgent =
        runner.data?.runOn === "agent" &&
        !!agents.data?.some((a) => (!runner.data!.agentId || a.id === runner.data!.agentId) && a.online && (a.capabilities as { customScripts?: boolean }).customScripts === true);
    return { known, enabled: !!code?.platform || viaAgent, config: code };
}
