import { Plus } from "lucide-react";
import { useCan } from "../features/auth/permissions";
import { routes } from "../lib/router";
import { LinkButton } from "./ui";

/**
 * "New project" lives in the Projects page header (and in its empty state, which is the new-project page itself), not in the sidebar.
 * It opens Create a project (details, platforms, testing modes); exploring with AI is a step from the new project's dashboard.
 * Shown only with the feature it needs; the server refuses regardless.
 */
export function NewProjectLink() {
    const can = useCan();
    if (!can("ai_studio.project.create")) return null;
    return (
        <LinkButton href={routes.createProject} variant="primary" icon={Plus}>
            New project
        </LinkButton>
    );
}
