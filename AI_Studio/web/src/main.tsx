import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "./components/Shell";
import { AuthGate } from "./features/auth/AuthGate";
import { RunDetail } from "./features/runs/RunDetail";
import { RunsPage } from "./features/runs/RunsPage";
import { SetupPage } from "./features/setup/SetupPage";
import { AgentRunsPage } from "./features/workspace/AgentRunsPage";
import { RequirementsPage } from "./features/workspace/RequirementsPage";
import { ScriptsPage } from "./features/workspace/ScriptsPage";
import { SuitesPage } from "./features/workspace/SuitesPage";
import { TestCasesPage } from "./features/workspace/TestCasesPage";
import { CreateProjectPage } from "./features/workspace/CreateProjectPage";
import { DashboardPage, FoldersPage, ProfilePage, RunnersPage, TestDevelopmentPage } from "./features/workspace/GlobalPages";
import { NewCodePage } from "./features/code/EditorPage";
import { RecorderPage } from "./features/recorder/RecorderPage";
import { ReleaseDetail } from "./features/manual/ReleaseDetail";
import { GuidePage } from "./features/guide/GuidePage";
import { SecurityHome, SecurityPage } from "./features/security/SecurityPage";
import { HelpProvider } from "./features/guide/HelpContext";
import { TourProvider } from "./features/guide/Tour";
import { resolveAlias } from "./lib/aliases";
import { useRoute } from "./lib/router";
import { Home } from "./pages/Home";
import { NewProject } from "./pages/NewProject";
import { ProjectOverview } from "./pages/ProjectOverview";
import { Settings } from "./pages/Settings";
import { TestDetail } from "./pages/TestDetail";
import { tabOf } from "./features/workbench/test-model";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles.css";

function Pages() {
    const { parts, query } = useRoute();
    const [a, b, c, d] = parts;
    if (!a) return <Home />;
    if (a === "new") return <NewProject projectId={query.get("project") ?? undefined} initialUrl={query.get("url") ?? undefined} />;
    // The global places (docs/product-restructure/INFORMATION_ARCHITECTURE.md). `#/` stays the project list.
    if (a === "dashboard") return <DashboardPage />;
    if (a === "create") return <CreateProjectPage />;
    if (a === "develop") return <TestDevelopmentPage />;
    if (a === "runners") return <RunnersPage />;
    if (a === "folders") return <FoldersPage />;
    if (a === "profile") return <ProfilePage />;
    if (a === "settings") return <Settings />;
    if (a === "security") return <SecurityHome />;
    if (a === "guide") return <GuidePage />;
    // One page per test; the tab is the route (`#/tests/:id/steps|text|code|history`, the bare route opens Steps; `/builder` is redirected in App).
    if (a === "tests" && b) return <TestDetail id={b} key={b} tab={tabOf(c) ?? "steps"} />;
    if (a === "projects" && b) {
        // The places, in lifecycle order. Older links (the Library, Release and Setup places, schedule, runners, objects, blocks,
        // helpers, releases, manual-cases, compliance) are redirected in App (lib/aliases.ts).
        if (c === "requirements") return <RequirementsPage id={b} key={b} />;
        if (c === "tests") return <TestCasesPage id={b} key={b} />;
        if (c === "suites") return <SuitesPage id={b} key={b} />;
        if (c === "scripts") return <ScriptsPage id={b} key={b} />;
        if (c === "agent") return <AgentRunsPage id={b} key={b} />;
        if (c === "runs") return d ? <RunDetail id={b} jobId={d} key={`${b}/${d}`} /> : <RunsPage id={b} key={b} />;
        if (c === "settings") return <SetupPage id={b} key={b} />;
        if (c === "release" && d) return <ReleaseDetail id={b} releaseId={d} key={`${b}/${d}`} />;
        if (c === "write-code") return <NewCodePage id={b} key={b} />;
        // The Security Assessment section: its own pages under #/projects/:id/security/... (separate from functional testing).
        if (c === "security") return <SecurityPage id={b} rest={parts.slice(3)} key={`${b}/security`} />;
        if (c === "record") return <RecorderPage id={b} key={b} />;
        return <ProjectOverview id={b} key={b} />;
    }
    return <Home />;
}

function App() {
    const { parts, query } = useRoute();
    // An old link goes to the place and section that now hold the page; replacing (not pushing) keeps Back working.
    const moved = resolveAlias(parts, query);
    useEffect(() => {
        if (moved) location.replace(`${location.pathname}${location.search}${moved}`);
    }, [moved]);
    if (moved) return null;
    return (
        <AuthGate>
            <HelpProvider>
                <TourProvider>
                    <Shell routeKey={parts.join("/")}>
                        <Pages />
                    </Shell>
                </TourProvider>
            </HelpProvider>
        </AuthGate>
    );
}

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
