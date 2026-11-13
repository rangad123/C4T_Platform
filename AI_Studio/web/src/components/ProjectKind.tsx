import { Apple, Bot, Code2, Globe, Smartphone, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { PLATFORM_WORDS, projectKind, projectShape, type Platform, type ProjectDetail, type ProjectKind } from "../api";
import { useFetch } from "../lib/hooks";
import { AgentAvatar, type AgentId, type AgentList, type ProjectAgents } from "../features/testing-agents/testing-agents";
import { Skeleton } from "./ui";
import { Tooltip } from "./Tooltip";
import "./project-kind.css";

/**
 * How a project's kind looks wherever it is shown (the projects list, the project's header): a tile with the kind's icon, its word (the legend), and the platform's icon and word. The list row and the project's header show the kind once, as
 * the labelled tile beside the name, and the same tags after it (ProjectTags), which do not repeat the kind.
 */
export const KIND_ICON: Record<"agent" | "code", LucideIcon> = { agent: Bot, code: Code2 };
export const KIND_WORDS: Record<"agent" | "code", string> = { agent: "Agent", code: "Code" };
export const KIND_HELP: Record<"agent" | "code", string> = {
    agent: "Tested by AI agents: they explore the application, plan tests and check it.",
    code: "Tested by test scripts: written, imported or generated, then run.",
};
export const MIXED_TIP = "Made before a project had one testing mode, so it has both. Choose one in Settings → General.";
export const PLATFORM_ICONS: Record<Platform, LucideIcon> = { web: Globe, android: Smartphone, ios: Apple };

/**
 * The kind's tile. A mixed project shows the agent's. `labelled`: the tile is the only sign of the kind there (the list row and the
 * project's header), so it has a name for screen readers ("Code project") and the kind's explanation on hover.
 */
export function KindTile({ kind, size = "md", labelled = false }: { kind: ProjectKind; size?: "sm" | "md" | "lg"; labelled?: boolean }) {
    const k = kind === "code" ? "code" : "agent";
    const Icon = KIND_ICON[k];
    const icon = <Icon size={size === "lg" ? 26 : size === "sm" ? 14 : 18} aria-hidden />;
    if (!labelled)
        return (
            <span className={`pk-tile pk-${k} pk-${size}`} data-kind={kind} aria-hidden>
                {icon}
            </span>
        );
    const tile = (
        <span className={`pk-tile pk-${k} pk-${size}`} data-kind={kind} data-testid="kind-tile" role="img" aria-label={kind === "mixed" ? "Agent and code project" : `${KIND_WORDS[k]} project`}>
            {icon}
        </span>
    );
    return <Tooltip content={kind === "mixed" ? MIXED_TIP : KIND_HELP[k]}>{tile}</Tooltip>;
}

/** A platform's icon and word; the word can be dropped on a narrow row (`wordClass`). */
export function PlatformMark({ platform, wordClass }: { platform: Platform; wordClass?: string }) {
    const Icon = PLATFORM_ICONS[platform];
    return (
        <span className="pk-platform" data-platform={platform}>
            <Icon size={16} aria-hidden />
            <span className={wordClass}>{PLATFORM_WORDS[platform]}</span>
        </span>
    );
}

/** At most this many agent tiles on a projects-list row; the rest are "+N" with their names in a tip. */
export const ROW_AGENT_TILES = 3;
/** "API Testing Agent" -> "API", for the tags and the legend. */
export const shortAgentName = (name: string) => name.replace(/ Testing Agent$| Agent$/, "");

export interface TagAgent {
    id: AgentId;
    name: string;
}

/**
 * A project's tags, the same in the projects list and the project's header: every platform and the testing agents (not for a code project). Every tag is one height. On a list row (`row`) the agents are icon
 * tiles, at most ROW_AGENT_TILES, then "+N" naming the rest; in the header every agent is shown with its name.
 */
export function ProjectTags({ kind, platforms, agents, row = false }: { kind: ProjectKind; platforms: Platform[]; agents?: TagAgent[]; row?: boolean }) {
    const list = kind === "code" ? [] : (agents ?? []);
    const shown = row ? list.slice(0, ROW_AGENT_TILES) : list;
    const rest = row ? list.slice(ROW_AGENT_TILES) : [];
    return (
        <span className={`pk-tags${row ? " pk-tags-row" : ""}`} data-testid="project-tags">
            {platforms.map((p) => (
                <PlatformMark key={p} platform={p} wordClass={row ? "pk-platform-word" : undefined} />
            ))}
            {list.length > 0 && (
                <span className="pk-agents" data-testid="row-agents" aria-label={row ? undefined : "Testing agents"} role={row ? undefined : "list"}>
                    {shown.map((a) =>
                        row ? (
                            <Tooltip key={a.id} content={a.name}>
                                <span className="pk-agent" data-agent={a.id}>
                                    <AgentAvatar id={a.id} size="sm" />
                                    <span className="sr-only">{a.name}</span>
                                </span>
                            </Tooltip>
                        ) : (
                            <span key={a.id} className="pk-agent pk-agent-named" data-agent={a.id} role="listitem">
                                <AgentAvatar id={a.id} size="sm" />
                                {a.name}
                            </span>
                        ),
                    )}
                    {rest.length > 0 && (
                        <Tooltip content={rest.map((a) => a.name).join(", ")}>
                            <span className="pk-more" data-testid="row-agents-more">
                                <span aria-hidden>+{rest.length}</span>
                                <span className="sr-only">and {rest.length} more: {rest.map((a) => a.name).join(", ")}</span>
                            </span>
                        </Tooltip>
                    )}
                </span>
            )}
        </span>
    );
}

/** The header's tags: the project's own testing agents, named from the catalogue (a code project has none, so nothing is asked). */
function HeadTags({ project, kind }: { project: Pick<ProjectDetail, "id" | "platforms" | "testingModes">; kind: ProjectKind }) {
    const agentsApply = kind !== "code";
    const mine = useFetch<ProjectAgents>(agentsApply ? `/projects/${project.id}/testing-agents` : null);
    const all = useFetch<AgentList>(agentsApply ? "/testing-agents" : null);
    const names = new Map((all.data?.agents ?? []).map((a) => [a.id, shortAgentName(a.name)]));
    const agents = mine.data?.applies && all.data ? mine.data.agents.map((id) => ({ id, name: names.get(id) ?? id })) : undefined;
    return <ProjectTags kind={kind} platforms={projectShape(project).platforms} agents={agents} />;
}

/** The header of every project place: the kind's tile and the project's name (the page's one h1), then the project's tags. */
export function ProjectHead({ project, subtitle, actions, failed }: { project: Pick<ProjectDetail, "id" | "name" | "platforms" | "testingModes"> | null | undefined; subtitle?: ReactNode; actions?: ReactNode; /** The project could not be read: the page's own title stands in for its name. */ failed?: string }) {
    const kind = project ? projectKind(project) : null;
    return (
        <header className="page-head project-head" data-testid="project-head" data-kind={kind ?? undefined}>
            {kind ? <KindTile kind={kind} size="lg" labelled /> : failed ? null : <Skeleton w={52} h={52} style={{ borderRadius: 12, flex: "none" }} />}
            <div className="titles">
                <div className="pk-name-row">
                    <h1 className="t-page">{project?.name ?? failed ?? "…"}</h1>
                </div>
                {project && kind && <HeadTags project={project} kind={kind} />}
                {subtitle && <div className="sub">{subtitle}</div>}
            </div>
            {actions && <div className="actions">{actions}</div>}
        </header>
    );
}

/** A place's own title, under the project's tab bar (the h1 is the project's name). */
export function PlaceHead({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
    return (
        <header className="page-head place-head" data-testid="place-head">
            <div className="titles">
                <h2 className="t-place">{title}</h2>
                {subtitle && <div className="sub">{subtitle}</div>}
            </div>
            {actions && <div className="actions">{actions}</div>}
        </header>
    );
}
