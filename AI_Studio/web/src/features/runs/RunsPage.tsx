import { ProjectHub, type HubSection } from "../../components/ProjectHub";
import { ProjectRuns } from "../../pages/ProjectRuns";
import { ProjectCompliance } from "../../pages/ProjectCompliance";
import { routes, useRoute, type RunsSection } from "../../lib/router";
import { ReleasesPage } from "../manual/ReleasesPage";
import { ProjectSchedule } from "../schedules/ProjectSchedule";

/**
 * The Runs place: what happened and when. Every run, the ones that start by themselves, how results develop, and the two views
 * built on runs that used to be the Release place: signing off a version, and which control topics the tests touch.
 */
export function RunsPage({ id }: { id: string }) {
    const section = (useRoute().query.get("section") as RunsSection | null) ?? "runs";
    const sections: HubSection[] = [
        { key: "runs", label: "All runs", hint: "Every exploration and every run of tests", render: () => <ProjectRuns id={id} /> },
        { key: "schedules", label: "Schedules", hint: "Run tests on a timetable and get told when something changes", render: () => <ProjectSchedule id={id} section="schedules" /> },
        { key: "deploys", label: "After a deploy", hint: "Run tests when your pipeline says a new version is out", render: () => <ProjectSchedule id={id} section="deploys" /> },
        { key: "trends", label: "Trends", hint: "How results develop, and which tests are unreliable", render: () => <ProjectSchedule id={id} section="trends" /> },
        { key: "releases", label: "Releases", hint: "Sign off a version: automated results and manual checks together", render: () => <ReleasesPage id={id} /> },
        { key: "compliance", label: "Compliance", hint: "Which security-control topics your tests touch", render: () => <ProjectCompliance id={id} /> },
    ];
    return <ProjectHub id={id} place="runs" title="Runs" subtitle="What happened and when: every run, the ones that start by themselves, how results develop, and signing off a release." sections={sections} current={section} hrefOf={(k) => routes.runs(id, k as RunsSection)} />;
}
