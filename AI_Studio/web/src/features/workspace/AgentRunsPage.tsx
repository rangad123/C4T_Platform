import { projectShape, type ProjectDetail } from "../../api";
import { Planned } from "../../components/Planned";
import { ProjectPlace } from "../../components/ProjectHub";
import { Callout } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { routes } from "../../lib/router";

/**
 * The Agent runs place (decision D-21, flow B): the AI pursues an objective in the application, live, on a runner. Not built yet
 * (Phase 5 builds it on the runner and run work of Phase 4). The AI writing tests, the other half of agent mode, already exists and
 * is linked from here.
 */
export function AgentRunsPage({ id }: { id: string }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const agentOff = project.data && !projectShape(project.data).testingModes.includes("agent");
    return (
        <ProjectPlace id={id} place="agent" title="Agent runs" subtitle="Give the AI an objective. It plans, you approve the plan, and it tests the application on a runner.">
            {agentOff && (
                <Callout tone="info" title="Agent mode is off for this project">
                    Turn it on in <a href={routes.projectSettings(id, "general")}>Settings → General</a> to use agent runs.
                </Callout>
            )}
            <Planned
                title="Agent runs"
                phase="Phase 5"
                testId="planned-agent-runs"
                will={[
                    "Write an objective, for example “A new customer can sign up and buy a gift card”, and choose the environment.",
                    "The AI writes a plan and lists what the runner needs. A Project Admin approves the plan before anything runs.",
                    "The run happens on an eligible runner of this project, with only the actions the project allows.",
                    "Live progress, then a report with every action, screenshots and logs. It says whether a failure is in the application, the agent, the environment or the runner.",
                    "Turn a good run into a test case to keep.",
                ]}
                today={
                    <>
                        The AI already writes tests for you: <a href={routes.newProject({ project: id })}>explore the application</a>, or describe one test in your own words from{" "}
                        <a href={routes.tests(id)}>Test cases</a> (New test → Describe it).
                    </>
                }
            />
        </ProjectPlace>
    );
}
