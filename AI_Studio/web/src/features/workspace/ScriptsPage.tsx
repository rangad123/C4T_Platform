import { ProjectHub, type HubSection } from "../../components/ProjectHub";
import { routes, useRoute, type ScriptsSection } from "../../lib/router";
import { BlocksPage } from "../blocks/BlocksPage";
import { HelpersPage } from "../code/HelpersPage";
import { LibrarySearch } from "../library/LibraryPage";
import { ProjectLibrary } from "../libraries/ProjectLibrary";
import { ProjectObjects } from "../objects/ProjectObjects";
import { ScriptList, VersionPage } from "../review/ScriptReview";

/** The Test scripts place: the scripts, and the building blocks scripts share (they used to be the Library place). */
export function ScriptsPage({ id }: { id: string }) {
    const q = useRoute().query;
    const section = (q.get("section") as ScriptsSection | null) ?? "scripts";
    const edit = q.get("edit") ?? undefined;
    const reviewTest = q.get("test");
    const reviewVersion = Number(q.get("version")) || 0;
    const sections: HubSection[] = [
        {
            key: "scripts",
            label: "Scripts",
            hint: "The executable script of every test case, its versions and their review",
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
            subtitle="What actually runs: each test case’s script, in plain English and as code, and the pieces scripts share."
            sections={sections}
            current={section}
            hrefOf={(k) => routes.scripts(id, k as ScriptsSection)}
            below={section === "scripts" || section === "library" ? undefined : <LibrarySearch id={id} />}
        />
    );
}
