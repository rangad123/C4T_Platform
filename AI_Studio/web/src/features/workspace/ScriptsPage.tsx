import { FileCode2 } from "lucide-react";
import type { TestSummary } from "../../api";
import { Planned } from "../../components/Planned";
import { ProjectHub, type HubSection } from "../../components/ProjectHub";
import { BadgeKey } from "../../components/Tooltip";
import { EmptyState, ErrorState, ListSkeleton, StatusBadge, statusKey } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { frameworkLabel, friendlyError } from "../../lib/labels";
import { routes, useRoute, type ScriptsSection } from "../../lib/router";
import { BlocksPage } from "../blocks/BlocksPage";
import { HelpersPage } from "../code/HelpersPage";
import { LibrarySearch } from "../library/LibraryPage";
import { ProjectObjects } from "../objects/ProjectObjects";

/**
 * Every test's executable script, from what is stored today: the framework it is written for, whether the platform renders it
 * from the test's steps or a person owns the code, and how it last ran. Each row opens the test's Code tab (plain-English text
 * and history are the tabs beside it). Approval and the synchronisation state of text and code arrive with Phase 3.
 */
function ScriptList({ id }: { id: string }) {
    const tests = useFetch<TestSummary[]>(`/projects/${id}/tests`);
    if (tests.loading) return <ListSkeleton rows={4} />;
    if (tests.error) return <ErrorState error={friendlyError(tests.error.message)} onRetry={tests.reload} />;
    const list = tests.data ?? [];
    return (
        <div className="stack">
            {list.length === 0 ? (
                <div className="card">
                    <EmptyState icon={FileCode2} title="No scripts yet">
                        A script is made for every test case. Add test cases first, in Test cases.
                    </EmptyState>
                </div>
            ) : (
                <div className="card">
                    <div className="card-pad row" style={{ paddingBottom: 0 }}>
                        <span className="t-meta">{list.length === 1 ? "1 script" : `${list.length} scripts`}, with how each last ran</span>
                        <span className="spacer" />
                        <BadgeKey label="the badges in this list" entries={statusKey(list.map((t) => t.validationStatus))} />
                    </div>
                    <ul className="list divided" aria-label="Test scripts">
                        {list.map((t) => (
                            <li key={t.id}>
                                <a className="list-row" href={routes.testTab(t.id, "code")}>
                                    <span className="main">
                                        <span className="title">{t.title}</span>
                                        <span className="meta">
                                            {t.testId} · {frameworkLabel(t.framework)} · {t.custom ? "Code written by a person" : "Made from the test’s steps"}
                                        </span>
                                    </span>
                                    <StatusBadge status={t.validationStatus} />
                                </a>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            <Planned
                title="Review and approval"
                phase="Phase 3"
                testId="planned-script-approval"
                will={[
                    "Each script version is a draft until a Project Admin approves it. Only approved versions run.",
                    "The plain-English text and the code side by side, with whether they still match: in step, text changed, code changed, or needs regenerating.",
                    "A change to the text never overwrites code a person wrote.",
                ]}
                today={<>Open a script to see its plain-English text, its code and its version history.</>}
            />
        </div>
    );
}

/** The Test scripts place: the scripts, and the building blocks scripts share (they used to be the Library place). */
export function ScriptsPage({ id }: { id: string }) {
    const q = useRoute().query;
    const section = (q.get("section") as ScriptsSection | null) ?? "scripts";
    const edit = q.get("edit") ?? undefined;
    const sections: HubSection[] = [
        { key: "scripts", label: "Scripts", hint: "The executable script of every test case", render: () => <ScriptList id={id} /> },
        { key: "steps", label: "Reusable steps", hint: "Named groups of steps that many tests use", render: () => <BlocksPage id={id} edit={edit} key={edit ?? ""} /> },
        { key: "elements", label: "Shared elements", hint: "Buttons and fields named once and used by many tests", render: () => <ProjectObjects id={id} /> },
        { key: "helpers", label: "Helpers (code)", hint: "Code that several code tests import", render: () => <HelpersPage id={id} /> },
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
            below={section === "scripts" ? undefined : <LibrarySearch id={id} />}
        />
    );
}
