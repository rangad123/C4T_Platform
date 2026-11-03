import { Accessibility, Braces, Gauge, ListChecks, MessagesSquare, MonitorSmartphone, MousePointerClick, ShieldCheck, type LucideIcon } from "lucide-react";
import { PLATFORM_WORDS, type Platform } from "../../api";
import "./testing-agents.css";

/**
 * Testing agents as the server describes them (GET /api/testing-agents, platform/testing-agents.ts). Each agent is a name over checks
 * AI Studio already has; the avatar is a lucide icon on a token colour (no pictures, no emoji).
 */
export type AgentId = "api" | "accessibility" | "security" | "chatbot" | "responsive-ui" | "ux" | "performance" | "test-generation";
export type AgentSwitch =
    | "functionalTests"
    | "inputChecks"
    | "apiTests"
    | "contractChecks"
    | "accessibility"
    | "securityChecks"
    | "accessChecks"
    | "visual"
    | "variants"
    | "healthChecks"
    | "visionChecks"
    | "performanceChecks"
    | "loadChecks";
export type SwitchState = "on" | "allowed" | "off";

export interface AgentProjectRef {
    id: string;
    name: string;
    /** "matched": the project has no saved choice; the agent matches its latest exploration settings. */
    source: "chosen" | "matched";
}

export interface TestingAgent {
    id: AgentId;
    name: string;
    summary: string;
    description: string;
    checks: string[];
    platforms: Platform[];
    needs: string[];
    available: boolean;
    unavailableReason?: string;
}

export interface AgentWhere {
    canRun: { ok: boolean; reason?: string };
    ai: { configured: boolean };
}
export interface AgentList extends AgentWhere {
    agents: Array<TestingAgent & { projects: AgentProjectRef[] }>;
}
export interface AgentDetail extends AgentWhere {
    agent: TestingAgent;
    projects: AgentProjectRef[];
}
export interface ProjectAgents {
    applies: boolean;
    agents: AgentId[];
    source: "chosen" | "matched";
    chosenBy: string | null;
    chosenAt: string | null;
    switches: Record<AgentSwitch, SwitchState>;
    platforms: Platform[];
}

const ICONS: Record<AgentId, LucideIcon> = {
    api: Braces,
    accessibility: Accessibility,
    security: ShieldCheck,
    chatbot: MessagesSquare,
    "responsive-ui": MonitorSmartphone,
    ux: MousePointerClick,
    performance: Gauge,
    "test-generation": ListChecks,
};

export function AgentAvatar({ id, available = true, size = "md" }: { id: AgentId; available?: boolean; size?: "sm" | "md" | "lg" }) {
    const Icon = ICONS[id] ?? ListChecks;
    return (
        <span className={`ta-avatar ta-${size}${available ? "" : " is-off"}`} aria-hidden>
            <Icon size={size === "lg" ? 28 : size === "sm" ? 16 : 20} />
        </span>
    );
}

/** Whether an agent can be chosen for a project of these platforms. */
export const fitsPlatforms = (a: TestingAgent, platforms: readonly Platform[]) => a.available && a.platforms.some((p) => platforms.includes(p));

/** The agents a new project starts with: what an exploration ran before agents existed, for the platform. */
export function defaultAgents(all: readonly TestingAgent[], platforms: readonly Platform[]): AgentId[] {
    const wanted: AgentId[] = ["api", "accessibility", "security", "ux", "test-generation"];
    const fit = all.filter((a) => wanted.includes(a.id) && fitsPlatforms(a, platforms)).map((a) => a.id);
    return fit.length ? fit : ["test-generation"];
}

/**
 * The agent picker: one checkbox per agent, with its avatar and summary. An agent that is not available, or that does not work on
 * the project's platform, is shown and disabled with the reason.
 */
export function AgentPicker({ agents, platforms, value, onChange, disabled, legend = "Testing agents" }: { agents: readonly TestingAgent[]; platforms: readonly Platform[]; value: readonly AgentId[]; onChange: (v: AgentId[]) => void; disabled?: boolean; legend?: string }) {
    const toggle = (id: AgentId) => onChange(agents.filter((a) => (a.id === id ? !value.includes(id) : value.includes(a.id))).map((a) => a.id));
    return (
        <fieldset className="choice-group stack-sm" data-testid="agent-picker">
            <legend className="t-card">{legend}</legend>
            <p className="t-meta">Choose at least one. Each agent decides which checks run when the AI explores the application.</p>
            <div className="ta-pick">
                {agents.map((a) => {
                    const fits = fitsPlatforms(a, platforms);
                    const why = !a.available ? (a.unavailableReason ?? "Not available yet.") : !fits ? `Works on ${a.platforms.map((p) => PLATFORM_WORDS[p]).join(" and ")} only.` : null;
                    return (
                        <label key={a.id} className={`check ta-check${why ? " is-off" : ""}`}>
                            <input type="checkbox" checked={fits && value.includes(a.id)} disabled={disabled || !fits} onChange={() => toggle(a.id)} aria-describedby={`agent-pick-${a.id}`} />
                            <AgentAvatar id={a.id} available={!why} size="sm" />
                            <span className="choice-text">
                                <span className="title">{a.name}</span>
                                <span className="t-meta" id={`agent-pick-${a.id}`}>
                                    {why ?? a.summary}
                                </span>
                            </span>
                        </label>
                    );
                })}
            </div>
        </fieldset>
    );
}
