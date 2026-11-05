import { Apple, Bot, Code2, Globe, Smartphone, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { PLATFORM_WORDS, projectKind, type Platform, type ProjectDetail, type ProjectKind } from "../api";
import { Badge, Skeleton } from "./ui";
import { Tooltip } from "./Tooltip";
import "./project-kind.css";

/**
 * How a project's kind looks wherever it is shown (the projects list, the project's header): a tile with the kind's icon, a
 * chip with its word, and the platform's icon and word. A mixed project (made with both testing modes) shows both chips.
 */
export const KIND_ICON: Record<"agent" | "code", LucideIcon> = { agent: Bot, code: Code2 };
export const KIND_WORDS: Record<"agent" | "code", string> = { agent: "Agent", code: "Code" };
export const KIND_HELP: Record<"agent" | "code", string> = {
    agent: "Tested by AI agents: they explore the application, plan tests and check it.",
    code: "Tested by test scripts: written, imported or generated, then run.",
};
export const MIXED_TIP = "Made before a project had one testing mode, so it has both. Choose one in Settings → General.";
export const PLATFORM_ICONS: Record<Platform, LucideIcon> = { web: Globe, android: Smartphone, ios: Apple };

/** The kind's tile. A mixed project shows the agent's. */
export function KindTile({ kind, size = "md" }: { kind: ProjectKind; size?: "sm" | "md" | "lg" }) {
    const k = kind === "code" ? "code" : "agent";
    const Icon = KIND_ICON[k];
    return (
        <span className={`pk-tile pk-${k} pk-${size}`} data-kind={kind} aria-hidden>
            <Icon size={size === "lg" ? 26 : size === "sm" ? 14 : 18} />
        </span>
    );
}

/** The kind's chip: Agent or Code, both for a mixed project (with a tip saying why). */
export function KindChips({ kind }: { kind: ProjectKind }) {
    const chip = (k: "agent" | "code") => (
        <Badge key={k} tone={k === "code" ? "brand" : "info"} icon={KIND_ICON[k]}>
            {KIND_WORDS[k]}
        </Badge>
    );
    if (kind !== "mixed")
        return (
            <Tooltip content={KIND_HELP[kind]}>
                <span className="pk-chips" data-testid="kind-chips">
                    {chip(kind)}
                </span>
            </Tooltip>
        );
    return (
        <Tooltip content={MIXED_TIP}>
            <span className="pk-chips" data-testid="kind-chips">
                {chip("agent")}
                {chip("code")}
            </span>
        </Tooltip>
    );
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

/** The header of every project place: the kind's tile, the project's name (the page's one h1) and its kind. */
export function ProjectHead({ project, subtitle, actions, failed }: { project: Pick<ProjectDetail, "name" | "platforms" | "testingModes"> | null | undefined; subtitle?: ReactNode; actions?: ReactNode; /** The project could not be read: the page's own title stands in for its name. */ failed?: string }) {
    const kind = project ? projectKind(project) : null;
    return (
        <header className="page-head project-head" data-testid="project-head" data-kind={kind ?? undefined}>
            {kind ? <KindTile kind={kind} size="lg" /> : failed ? null : <Skeleton w={52} h={52} style={{ borderRadius: 12, flex: "none" }} />}
            <div className="titles">
                <div className="pk-name-row">
                    <h1 className="t-page">{project?.name ?? failed ?? "…"}</h1>
                    {kind && <KindChips kind={kind} />}
                </div>
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
