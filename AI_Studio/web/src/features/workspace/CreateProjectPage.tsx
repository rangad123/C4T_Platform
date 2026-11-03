import { FolderPlus } from "lucide-react";
import { useState } from "react";
import { ApiError, MODE_WORDS, PLATFORM_WORDS, api, type Platform, type TestingMode } from "../../api";
import { usePage } from "../../components/Shell";
import { Button, Callout, LinkButton, PageHeader } from "../../components/ui";
import { useDocumentTitle, useFetch } from "../../lib/hooks";
import { go, routes } from "../../lib/router";
import { useAuth } from "../auth/auth";
import { sideOf, useCan } from "../auth/permissions";
import { AppDetailsFields, EMPTY_APP_DRAFT, appDraftBody, appDraftProblem, appErrorText, uploadAppFiles, type AppDraft } from "./AppDetailsFields";
import { AgentPicker, defaultAgents, fitsPlatforms, type AgentId, type AgentList } from "../testing-agents/testing-agents";

const PLATFORM_HELP: Record<Platform, string> = { web: "A website or web application, tested in browsers.", android: "An Android app, tested on emulators and phones.", ios: "An iPhone or iPad app, tested on a Mac with Xcode." };
const MODE_HELP: Record<TestingMode, string> = {
    agent: "The AI explores the application and writes tests, and can test on its own towards an objective you give it.",
    code: "Test cases with plain-English steps and the code that runs them, written, recorded or generated, reviewed and approved.",
};

interface Organization {
    id: string;
    name: string | null;
    status: string | null;
}

/**
 * Create a project (story US-010): what it is, the one platform it runs on and the one way it is tested (round 37), and the app:
 * its address, or the phone app as a file or a store link. The rest (environments, AI, members) is set up from the project's
 * dashboard, which lists what is still missing. The server checks everything again: a customer's project always goes to their
 * own organisation.
 */
export function CreateProjectPage() {
    useDocumentTitle("Create a project");
    usePage({ crumbs: [{ label: "Projects", href: routes.home }, { label: "Create a project" }], nav: "projects" });
    const can = useCan();
    const me = useAuth().state?.me;
    const side = sideOf(me);
    // Crowd4Test staff choose the organisation; customers create in their own; local installs have none.
    const orgs = useFetch<{ organizations: Organization[] }>(side === "admin" ? "/organizations" : null);
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [platform, setPlatform] = useState<Platform>("web");
    const [mode, setMode] = useState<TestingMode | null>(null);
    const [app, setApp] = useState<AppDraft>(EMPTY_APP_DRAFT);
    const [organizationId, setOrganizationId] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Set when the project was made but its app file was refused: the form then offers to open the project instead. */
    const [created, setCreated] = useState<string | null>(null);
    // The testing agents of an AI-agent project (features/testing-agents): untouched, the defaults for the platform.
    const agentList = useFetch<AgentList>(mode === "agent" ? "/testing-agents" : null);
    const [pickedAgents, setPickedAgents] = useState<AgentId[] | null>(null);
    const allAgents = agentList.data?.agents ?? [];
    const agents = (pickedAgents ?? defaultAgents(allAgents, [platform])).filter((id) => allAgents.some((a) => a.id === id && fitsPlatforms(a, [platform])));

    const missing = !name.trim() ? "Give the project a name." : !mode ? "Choose how the project is tested: AI agent or code." : mode === "agent" && agentList.data && agents.length === 0 ? "Choose at least one testing agent." : appDraftProblem(platform, app, { required: true });

    if (!can("ai_studio.project.create")) {
        return (
            <>
                <PageHeader title="Create a project" />
                <Callout tone="info" title="You can’t create projects">
                    Ask your Crowd4Test administrator, or a Project Admin of an existing project to add you to it.
                </Callout>
            </>
        );
    }

    const submit = async () => {
        if (missing) return setError(missing);
        setBusy(true);
        setError(null);
        try {
            const p = await api<{ id: string }>("/projects", {
                method: "POST",
                body: { name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), platforms: [platform], testingModes: [mode!], ...(mode === "agent" && agentList.data ? { agents } : {}), ...appDraftBody(platform, app), ...(organizationId ? { organizationId } : {}) },
            });
            // The app file goes after the project exists. If it is refused, the project stays and Settings says how to add it.
            try {
                await uploadAppFiles(p.id, platform, app);
            } catch (e) {
                setError(`The project was created, but the app file was not saved: ${appErrorText(e, "the upload failed")}. Add it in the project’s Settings, General.`);
                setCreated(p.id);
                setBusy(false);
                return;
            }
            go(routes.project(p.id));
        } catch (e) {
            setError(e instanceof ApiError ? e.message : "The project could not be created. Try again.");
            setBusy(false);
        }
    };

    const orgList = orgs.data?.organizations ?? [];
    return (
        <>
            <PageHeader title="Create a project" subtitle="One project is one application you test. You can change all of this later in the project’s Settings." />
            <form
                className="card card-pad stack"
                style={{ maxWidth: 720 }}
                onSubmit={(e) => {
                    e.preventDefault();
                    void submit();
                }}
                noValidate
                data-testid="create-project"
            >
                <div className="field">
                    <label htmlFor="project-name">Project name</label>
                    <input id="project-name" className="input" required autoFocus maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Gift shop website" />
                </div>
                <div className="field">
                    <label htmlFor="project-description">Description (optional)</label>
                    <input id="project-description" className="input" maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
                </div>
                {side === "admin" && orgList.length > 0 && (
                    <div className="field">
                        <label htmlFor="project-org">Organisation</label>
                        <select id="project-org" className="input" value={organizationId} onChange={(e) => setOrganizationId(e.target.value)}>
                            <option value="">No organisation (Crowd4Test internal)</option>
                            {orgList.map((o) => (
                                <option key={o.id} value={o.id}>
                                    {o.name ?? o.id}
                                </option>
                            ))}
                        </select>
                    </div>
                )}
                <fieldset className="choice-group stack-sm">
                    <legend className="t-card">Platform</legend>
                    <p className="t-meta">One platform per project. To test the same product on another platform, make a second project.</p>
                    {(Object.keys(PLATFORM_WORDS) as Platform[]).map((p) => (
                        <label key={p} className="check">
                            <input type="radio" name="project-platform" value={p} checked={platform === p} onChange={() => setPlatform(p)} />
                            <span className="choice-text">
                                <span className="title">{PLATFORM_WORDS[p]}</span>
                                <span className="t-meta">{PLATFORM_HELP[p]}</span>
                            </span>
                        </label>
                    ))}
                </fieldset>
                <AppDetailsFields platform={platform} draft={app} onChange={setApp} offerLater />
                <fieldset className="choice-group stack-sm">
                    <legend className="t-card">Testing mode</legend>
                    <p className="t-meta">One mode per project. You can change it later in Settings; tests already made stay.</p>
                    {(Object.keys(MODE_WORDS) as TestingMode[]).map((m) => (
                        <label key={m} className="check">
                            <input type="radio" name="project-mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
                            <span className="choice-text">
                                <span className="title">{MODE_WORDS[m]}</span>
                                <span className="t-meta">{MODE_HELP[m]}</span>
                            </span>
                        </label>
                    ))}
                </fieldset>
                {mode === "agent" && agentList.data && <AgentPicker agents={allAgents} platforms={[platform]} value={agents} onChange={setPickedAgents} />}
                {mode === "agent" && agentList.error && <Callout tone="warning">The testing agents could not be loaded, so the project starts with the usual checks. Choose its agents later in Settings.</Callout>}
                <p className="t-meta">
                    The engine is chosen for you: {platform === "web" ? "Playwright for web" : "Taqwright for phone apps"}.
                </p>
                {error && (
                    <Callout tone="danger" actions={created ? <LinkButton size="sm" href={routes.projectSettings(created)}>Open the project’s settings</LinkButton> : undefined}>
                        {error}
                    </Callout>
                )}
                <div className="row" style={{ gap: 12 }}>
                    <Button type="submit" variant="primary" icon={FolderPlus} loading={busy} disabled={busy || Boolean(created)}>
                        Create project
                    </Button>
                    <a href={routes.home}>Cancel</a>
                </div>
            </form>
        </>
    );
}
