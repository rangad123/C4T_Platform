import { useEffect } from "react";
import { projectKind, projectShape, type ProjectDetail } from "../../api";
import { ProjectHub, type HubSection } from "../../components/ProjectHub";
import { ProjectRuns } from "../../pages/ProjectRuns";
import { ProjectCompliance } from "../../pages/ProjectCompliance";
import { useFetch } from "../../lib/hooks";
import { routes, useRoute, type RunsSection } from "../../lib/router";
import { ReleasesPage } from "../manual/ReleasesPage";
import { ProjectSchedule } from "../schedules/ProjectSchedule";
import { ListSkeleton } from "../../components/ui";
import { hasWorkspace } from "../agent-workspace/workspace";
import type { ProjectAgents } from "../testing-agents/testing-agents";
import { CaseRuns } from "./CaseRuns";

/**
 * The Runs place: what happened and when. Every run, the ones that start by themselves, how results develop, and the two views
 * built on runs that used to be the Release place: signing off a version, and which control topics the tests touch.
 */
export function RunsPage({ id }: { id: string }) {
    const { parts, query } = useRoute();
    const section = (query.get("section") as RunsSection | null) ?? "runs";
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    // A code project never explores, so its runs are only runs of tests.
    const code = projectKind(project.data) === "code";
    // A Test Case Generation project's runs each add to its one tree: only its runs and their schedules (founder 2026-11-19, P7.2, O6).
    const choice = useFetch<ProjectAgents>(`/projects/${id}/testing-agents`);
    const caseAgent = choice.data ? choice.data.caseAgent === true : choice.loading ? undefined : false;
    // An Agent Workspace project: each agent's runs are on its own page, so only Schedules and After a deploy are here; everything else opens the Workspace (W3 review M4).
    const workspace = project.data && choice.data ? hasWorkspace(projectShape(project.data).testingModes, choice.data) : project.loading || choice.loading ? undefined : false;
    // Its runs live on the Test Case Generation agent's page now (Agent Workspace); only its Schedules stay here.
    // Only while the address is still this place's: a link away changes the route before this page unmounts, and must not be redirected.
    const here = parts[2] === "runs" && !parts[3];
    const moved = section === "schedules" || section === "deploys" || !here ? null : workspace ? routes.project(id) : caseAgent === true && workspace === false ? routes.projectAgent(id, "test-generation", "runs") : null;
    useEffect(() => {
        if (moved) location.replace(moved);
    }, [moved]);
    if (caseAgent === undefined || workspace === undefined || moved) return <ListSkeleton rows={3} />;
    if (workspace) {
        // Runs that start by themselves; each agent's own runs are on its page. After a deploy also holds the pull request lines.
        const only: HubSection[] = [
            { key: "schedules", label: "Schedules", hint: "Run an agent on a timetable", render: () => <ProjectSchedule id={id} section="schedules" agentId={query.get("agent")} workspace /> },
            { key: "deploys", label: "After a deploy", hint: "Run when your pipeline says a new version is out; pull request lines", render: () => <ProjectSchedule id={id} section="deploys" /> },
        ];
        return <ProjectHub id={id} place="runs" title="Schedules" subtitle="Run a testing agent on a timetable or after a deploy. Each run is that agent’s, with its own checks only, and its results are on the agent’s page." sections={only} current={section === "deploys" ? "deploys" : "schedules"} hrefOf={(k) => routes.runs(id, k as RunsSection)} />;
    }
    if (caseAgent) {
        const tcg: HubSection[] = [
            { key: "runs", label: "All runs", hint: "Every run: what each one added to the tree", render: () => <CaseRuns id={id} /> },
            { key: "schedules", label: "Schedules", hint: "Explore again on a timetable, so the tree keeps growing", render: () => <ProjectSchedule id={id} section="schedules" /> },
        ];
        return <ProjectHub id={id} place="runs" title="Runs" subtitle="Each run explores the application again, adds to the same tree of pages and writes more test cases." sections={tcg} current={section === "schedules" ? "schedules" : "runs"} hrefOf={(k) => routes.runs(id, k as RunsSection)} />;
    }
    const sections: HubSection[] = [
        { key: "runs", label: "All runs", hint: code ? "Every run of tests" : "Every exploration and every run of tests", render: () => <ProjectRuns id={id} /> },
        { key: "schedules", label: "Schedules", hint: "Run tests on a timetable and get told when something changes", render: () => <ProjectSchedule id={id} section="schedules" /> },
        { key: "deploys", label: "After a deploy", hint: "Run tests when your pipeline says a new version is out", render: () => <ProjectSchedule id={id} section="deploys" /> },
        { key: "trends", label: "Trends", hint: "How results develop, and which tests are unreliable", render: () => <ProjectSchedule id={id} section="trends" /> },
        { key: "releases", label: "Releases", hint: "Sign off a version: automated results and manual checks together", render: () => <ReleasesPage id={id} /> },
        { key: "compliance", label: "Compliance", hint: "Which security-control topics your tests touch", render: () => <ProjectCompliance id={id} /> },
    ];
    return <ProjectHub id={id} place="runs" title="Runs" subtitle="What happened and when: every run, the ones that start by themselves, how results develop, and signing off a release." sections={sections} current={section} hrefOf={(k) => routes.runs(id, k as RunsSection)} />;
}
