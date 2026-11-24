import { useEffect } from "react";
import { projectKind, type ProjectDetail } from "../../api";
import { ProjectHub, type HubSection } from "../../components/ProjectHub";
import { ProjectRuns } from "../../pages/ProjectRuns";
import { ProjectCompliance } from "../../pages/ProjectCompliance";
import { useFetch } from "../../lib/hooks";
import { routes, useRoute, type RunsSection } from "../../lib/router";
import { ReleasesPage } from "../manual/ReleasesPage";
import { ProjectSchedule } from "../schedules/ProjectSchedule";
import { ListSkeleton } from "../../components/ui";
import { CaseRuns } from "./CaseRuns";
import { useCaseAgent } from "./case-runs";

/**
 * The Runs place: what happened and when. Every run, the ones that start by themselves, how results develop, and the two views
 * built on runs that used to be the Release place: signing off a version, and which control topics the tests touch.
 */
export function RunsPage({ id }: { id: string }) {
    const section = (useRoute().query.get("section") as RunsSection | null) ?? "runs";
    // A code project never explores, so its runs are only runs of tests.
    const code = projectKind(useFetch<ProjectDetail>(`/projects/${id}`).data) === "code";
    // A Test Case Generation project's runs each add to its one tree: only its runs and their schedules (founder 2026-11-19, P7.2, O6).
    const caseAgent = useCaseAgent(id);
    // Its runs live on the Test Case Generation agent's page now (Agent Workspace); only its Schedules stay here.
    const moved = caseAgent === true && section !== "schedules";
    useEffect(() => {
        if (moved) location.replace(routes.projectAgent(id, "test-generation", "runs"));
    }, [moved, id]);
    if (caseAgent === undefined || moved) return <ListSkeleton rows={3} />;
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
