import { ProjectHub, type HubSection } from "../../components/ProjectHub";
import { routes, useRoute, type CasesSection } from "../../lib/router";
import { ProjectTests } from "../../pages/ProjectTests";
import { ManualCasesPage } from "../manual/ManualCasesPage";

/**
 * The Test cases place: one home for every test case, automated and manual (manual checks used to sit under Release). Review and
 * approval of AI drafts arrive with Phase 3 (docs/product-restructure/IMPLEMENTATION_ROADMAP.md).
 */
export function TestCasesPage({ id }: { id: string }) {
    const section = (useRoute().query.get("section") as CasesSection | null) ?? "automated";
    const sections: HubSection[] = [
        { key: "automated", label: "Automated", hint: "Tests the platform runs: written by the AI, recorded, built step by step or written as code", render: () => <ProjectTests id={id} /> },
        { key: "manual", label: "Manual", hint: "Checks a person does by hand, kept next to the automated tests", render: () => <ManualCasesPage id={id} /> },
    ];
    return <ProjectHub id={id} place="tests" title="Test cases" subtitle="Every check of this project: the automated tests and the ones a person does by hand." sections={sections} current={section} hrefOf={(k) => routes.cases(id, k as CasesSection)} />;
}
