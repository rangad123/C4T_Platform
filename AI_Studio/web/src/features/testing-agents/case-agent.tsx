import { FolderPlus, LayoutDashboard } from "lucide-react";
import type { ProjectDetail } from "../../api";
import { Callout, LinkButton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { routes } from "../../lib/router";
import { projectAgentView, type ProjectAgentView } from "./case-agent-view";
import type { ProjectAgents } from "./testing-agents";

export { projectAgentView, type ProjectAgentView } from "./case-agent-view";

/** The project's agent view (`projectId` null: nothing to read yet, still loading). */
export function useProjectAgentView(projectId: string | null): ProjectAgentView {
    const project = useFetch<ProjectDetail>(projectId ? `/projects/${projectId}` : null);
    const agents = useFetch<ProjectAgents>(projectId ? `/projects/${projectId}/testing-agents` : null);
    // An answer that failed is read as "not one": the page then keeps its usual view, and the server still refuses what it must.
    const loading = projectId === null || project.loading || agents.loading;
    return { loading, ...projectAgentView(project.data, agents.data) };
}

export const SCRIPTS_IN_CODE_PROJECTS = "Test scripts belong to code projects";
export const SCRIPTS_IN_CODE_PROJECTS_BODY = "Download this project's test cases and import them into a code project.";

/** What a Test Case Generation project shows where a test script would be: where test scripts live, and the way there. */
export function ScriptsInCodeProjects({ projectId }: { projectId: string }) {
    return (
        <div data-testid="scripts-in-code-projects">
            <Callout
                tone="info"
                title={SCRIPTS_IN_CODE_PROJECTS}
                actions={
                    <>
                        <LinkButton size="sm" variant="primary" icon={LayoutDashboard} href={routes.project(projectId)}>
                            Open the test cases
                        </LinkButton>
                        <LinkButton size="sm" variant="ghost" icon={FolderPlus} href={routes.createProject}>
                            Create a code project
                        </LinkButton>
                    </>
                }
            >
                {SCRIPTS_IN_CODE_PROJECTS_BODY} This project’s agent writes test cases only: nothing here is a script or runs.
            </Callout>
        </div>
    );
}
