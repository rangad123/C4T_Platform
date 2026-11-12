import { useFetch, useConfig } from "../../lib/hooks";
import { useMyRunner } from "../runners/my-runner";
import type { CodeConfig, ConfigWithCode } from "./code";

/**
 * Can this project run hand-written scripts? Runners mode: when the person's own runner takes code scripts (its switch in Settings).
 * Local mode: when the platform host allows it, or when the project runs on runners and the person's own runner is online and takes them. While the answers
 * are still loading, `known` is false so the page shows no warning yet.
 */
export function useRunPolicy(projectId: string | null): { known: boolean; enabled: boolean; config: CodeConfig | undefined } {
    const cfg = useConfig() as ConfigWithCode | undefined;
    const runnersOnly = cfg?.executionMode === "runners";
    const local = Boolean(cfg) && !runnersOnly;
    const runner = useFetch<{ runOn: "platform" | "agent"; agentId: string | null }>(projectId && local ? `/projects/${projectId}/runner` : null);
    const me = useMyRunner(0, runnersOnly || runner.data?.runOn === "agent");
    const code = cfg?.customScripts;
    if (runnersOnly) {
        const r = me.data?.runner;
        return { known: !me.loading, enabled: Boolean(r && r.switches?.codeScripts !== false), config: code };
    }
    const known = !!cfg && !runner.loading && !me.loading;
    const r = me.data?.runner;
    const viaAgent = runner.data?.runOn === "agent" && !!r && r.status !== "offline" && r.switches?.codeScripts === true;
    return { known, enabled: !!code?.platform || viaAgent, config: code };
}
