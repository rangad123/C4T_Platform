import { useEffect } from "react";
import { CASES_SECTIONS, go, routes, useRoute, type CasesSection } from "../../lib/router";
import { TestCaseList } from "../manual/ManualCasesPage";

/** What links to the runnable tests' list carried when it was this place (`routes.newTest`, the dashboard's filters). */
const SCRIPT_LIST_PARAMS = ["start", "status", "git", "quality", "quarantine"];

/**
 * The Test cases place: the project's written test cases in one list, filtered by type (round 38). The runnable tests are test
 * scripts and live on Test scripts. `?section=automated|manual` (the two sections of earlier versions) opens the list with that
 * type chosen; `?case=` opens one case. A link meant for the runnable tests' list goes on to Test scripts.
 */
export function TestCasesPage({ id }: { id: string }) {
    const query = useRoute().query;
    const asked = query.get("section");
    const filter: CasesSection = asked && (CASES_SECTIONS as readonly string[]).includes(asked) ? (asked as CasesSection) : "all";
    const forScripts = SCRIPT_LIST_PARAMS.some((k) => query.has(k));
    const scripts = routes.tests(id);
    const forward = forScripts && !scripts.startsWith(`#/projects/${id}/tests`);
    const qs = query.toString();
    useEffect(() => {
        if (!forward) return;
        const rest = new URLSearchParams(qs);
        rest.delete("section");
        go(`${scripts}${scripts.includes("?") ? "&" : "?"}${rest.toString()}`);
    }, [forward, scripts, qs]);
    if (forward) return null;
    return <TestCaseList id={id} filter={filter} open={query.get("case")} />;
}
