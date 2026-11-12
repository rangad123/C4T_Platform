import { useConfig, useFetch } from "../../lib/hooks";
import type { Tone } from "../../lib/labels";

/** Shapes the AI configuration routes answer with (src/platform/routes/ai-config.ts). No answer ever carries a key. */
export type AiMode = "managed" | "own";
export type ConfigStatus = "untested" | "working" | "failed";
export interface AiProviderChoice {
    id: string;
    name: string;
    defaultModel: string;
    needsAddress: boolean;
}
export interface AiConfiguration {
    id: string;
    label: string;
    provider: string;
    providerName: string;
    model: string;
    fastModel: string | null;
    baseUrl: string | null;
    keyEnding: string;
    ownerKind: "platform" | "organization" | "project";
    ownerName: string;
    status: ConfigStatus;
    statusNote: string | null;
    lastValidatedAt: string | null;
    usedBy: number;
}
export interface ManagedOption {
    id: string;
    label: string;
    model: string;
    providerName: string;
}
/** Everyone gets the first three; the rest appears with "see usage" or "manage keys". */
export interface ProjectAi {
    available: boolean;
    ready: boolean;
    runsHere: boolean;
    canManage?: boolean;
    mode?: AiMode;
    billingOwner?: "crowd4test" | "organization";
    organizationName?: string | null;
    serverHasKey?: boolean;
    budget?: { monthlyTokens: number | null; jobTokens: number | null; usedTokens: number; warnPercent: number };
    usageByOwner?: Array<{ owner: string; calls: number; totalTokens: number; cost: number | null }>;
    currency?: string;
    configurationId?: string | null;
    configuration?: AiConfiguration | null;
    problem?: string | null;
    ownOptions?: AiConfiguration[];
    managedOptions?: ManagedOption[];
    providers?: AiProviderChoice[];
}
export interface AiConfigurationsAnswer {
    configurations: AiConfiguration[];
    organizations: Array<{ id: string; name: string | null }>;
    canAddPlatform: boolean;
    providers: AiProviderChoice[];
    server: { hasKey: boolean; runsHere: boolean };
}
export interface KeyTestAnswer {
    ok: boolean;
    message: string;
    latencyMs: number;
    configuration: AiConfiguration;
}

export const STATUS_WORDS: Record<ConfigStatus, { label: string; tone: Tone; tip: string }> = {
    untested: { label: "Not tested yet", tone: "neutral", tip: "Nobody has tested this key since it was saved." },
    working: { label: "Working", tone: "success", tip: "The last test or use of this key worked." },
    failed: { label: "Not working", tone: "danger", tip: "The last test or use of this key failed." },
};

export const OWNER_WORDS: Record<string, string> = { crowd4test: "Crowd4Test", organization: "Your organisation" };

export const SERVER_HAS_NO_KEY = "This server has no AI key of its own and no working Crowd4Test configuration, so Crowd4Test’s managed AI cannot answer here. Add a Crowd4Test configuration and test it. A project on its own key is not affected.";
export const NOTHING_RUNS_HERE = "AI work does not run on this server: nothing here picks up a job, so an exploration would wait in the queue and never start. You can still save and test a key.";

/**
 * Whether this project can use AI: its own configuration or the server's key. Pages ask this, not whether the server has a key, because
 * a project on its own key works without one. Until the answer is in, the server's word stands.
 */
export function useProjectAiReady(projectId: string): boolean {
    const ai = useFetch<ProjectAi>(`/projects/${projectId}/ai`);
    const config = useConfig();
    return ai.data ? ai.data.ready : config?.llm.configured === true;
}
