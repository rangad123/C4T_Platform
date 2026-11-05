import { ProjectHub, type HubSection } from "../../components/ProjectHub";
import { routes, useRoute, type ScriptsSection } from "../../lib/router";
import { ProjectTests } from "../../pages/ProjectTests";
import { BlocksPage } from "../blocks/BlocksPage";
import { HelpersPage } from "../code/HelpersPage";
import { LibrarySearch } from "../library/LibraryPage";
import { ProjectLibrary } from "../libraries/ProjectLibrary";
import { ProjectObjects } from "../objects/ProjectObjects";
import { ScriptList, VersionPage } from "../review/ScriptReview";

/**
 * The Test scripts place: the runnable scripts (round 38: running, New test script and importing live here, not in Test cases),
 * the review of their versions, and the building blocks scripts share.
 */
export function ScriptsPage({ id }: { id: string }) {
    const q = useRoute().query;
    const reviewTest = q.get("test");
    const reviewVersion = Number(q.get("version")) || 0;
    // A version's own link (`?test=&version=`, features/review/review.ts versionHref) opens it in Review.
    const section = (q.get("section") as ScriptsSection | null) ?? (reviewTest && reviewVersion ? "review" : "scripts");
    const edit = q.get("edit") ?? undefined;
    const sections: HubSection[] = [
        { key: "scripts", label: "Scripts", hint: "Every test script: run them, make new ones, import and export", render: () => <ProjectTests id={id} /> },
        {
            key: "review",
            label: "Review",
            hint: "Each script's versions and their review: drafts wait here until they are approved",
            // One version of a test (`?test=&version=`), or the list (features/review/ScriptReview.tsx).
            render: () => (reviewTest && reviewVersion ? <VersionPage projectId={id} testId={reviewTest} version={reviewVersion} key={`${reviewTest}:${reviewVersion}`} /> : <ScriptList id={id} />),
        },
        { key: "steps", label: "Reusable steps", hint: "Named groups of steps that many tests use", render: () => <BlocksPage id={id} edit={edit} key={edit ?? ""} /> },
        { key: "elements", label: "Shared elements", hint: "Buttons and fields named once and used by many tests", render: () => <ProjectObjects id={id} /> },
        { key: "helpers", label: "Helpers (code)", hint: "Code that several code tests import", render: () => <HelpersPage id={id} /> },
        { key: "library", label: "Reusable libraries", hint: "Take steps, helpers and elements from your organisation's library, and publish this project's own", render: () => <ProjectLibrary id={id} /> },
    ];
    return (
        <ProjectHub
            id={id}
            place="scripts"
            title="Test scripts"
            subtitle="Manage and create test scripts for automated testing of your application. Each script has two views, DSL and Code."
            sections={sections}
            current={section}
            hrefOf={(k) => routes.scripts(id, k as ScriptsSection)}
            below={section === "scripts" || section === "review" || section === "library" ? undefined : <LibrarySearch id={id} />}
        />
    );
}
