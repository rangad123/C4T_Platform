import { Globe, ListChecks, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type ProjectDetail } from "../api";
import { Button, Callout, LinkButton, PageHeader } from "../components/ui";
import { FieldHelp } from "../components/Tooltip";
import { usePage } from "../components/Shell";
import { normalizeUrl } from "../lib/url";
import { useConfig, useDocumentTitle, useFetch } from "../lib/hooks";
import { go, routes } from "../lib/router";
import type { AgentInputs } from "../features/requirements/AgentInputs";
import { MissingInputsDialog } from "../features/requirements/AgentInputsDialog";
import { EXPLORING_OFF_HERE } from "../features/runs/runs-here";
import { ExploreOnRunnerNote, ExploreStartError } from "../features/runs/ExploreOnRunner";
import { useReadiness } from "../features/runners/my-runner";
import { aiProblemOf, aiReadyOf, useMyAi } from "../features/aiconfig/aiconfig";
import { LevelChoice, projectLevel, ScreenReviewChoice } from "../features/explore/ExploreLevel";
import { LEVEL_SETTINGS, type ExploreLevel } from "../../../src/engine/levels";
import { projectAgentView } from "../features/testing-agents/case-agent";
import type { ProjectAgents } from "../features/testing-agents/testing-agents";

/**
 * Explore an existing project's application (`#/new?project=`): Start exploring the first time, Explore again after (with Explore every
 * page again). A new project is made on Create a project (`#/create`); the old `#/new` without a project is redirected there (lib/aliases.ts).
 */
export function NewProject({ projectId, agentId }: { projectId: string; /** A run of one testing agent (`#/new?project=&agent=`, Agent Workspace D1). */ agentId?: string | null }) {
    const existing = useFetch<ProjectDetail>(`/projects/${projectId}`);
    // A project that never ran anything is explored for the first time: there is nothing to explore "again" or to reuse.
    const first = existing.data ? !existing.data.latestJob : false;
    const title = first ? "Start exploring" : "Explore again";
    useDocumentTitle(title);
    usePage({ crumbs: [{ label: "Projects", href: routes.home }, { label: existing.data?.name ?? "Project", href: routes.project(projectId) }, { label: title }], nav: "projects" });
    const config = useConfig();
    // What the project's testing agents need lives on its Requirements tab (round 38); here only whether something mandatory is missing.
    const inputs = useFetch<AgentInputs>(`/projects/${projectId}/agent-inputs`);
    // A run of one agent asks only for what that agent misses.
    const missing = (inputs.data?.missing ?? []).filter((m) => !agentId || m.agent === agentId);
    const [askOpen, setAskOpen] = useState(false);
    const asked = useRef(false);
    useEffect(() => {
        if (!asked.current && missing.length) {
            asked.current = true;
            setAskOpen(true);
        }
    }, [missing.length]);

    const [url, setUrl] = useState("");
    const [urlError, setUrlError] = useState("");
    const [scope, setScope] = useState("");
    // How much to explore (the project's saved level, else Thorough) and whether every page goes to the AI again.
    const [level, setLevel] = useState<ExploreLevel | null>(null);
    const [fullExploration, setFullExploration] = useState(false);
    // AI screen review: null = the level decides; set only when the person changes the box.
    const [screenReview, setScreenReview] = useState<boolean | null>(null);
    // Hidden when the project's testing agents leave it off (no UX agent).
    const agentSwitches = useFetch<ProjectAgents>(`/projects/${projectId}/testing-agents`);
    const screenReviewOff = agentSwitches.data?.applies === true && agentSwitches.data.switches?.visionChecks === "off";
    // A Test Case Generation project (founder 2026-11-19): the exploration builds the tree and writes test cases, and nothing is run.
    const caseAgent = agentId ? agentId === "test-generation" : projectAgentView(existing.data, agentSwitches.data).caseAgent;
    // Where the person comes from and goes back to: the agent's own page for a run of one agent.
    const home = agentId ? routes.projectAgent(projectId, agentId) : routes.project(projectId);
    const chosenLevel = level ?? projectLevel(existing.data);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<unknown>(null);
    // Runners mode (round 51): the exploration runs on the person's own runner, so it starts only once that runner can take it.
    const ready = useReadiness({ can: ["web", "explore"] });
    const runnersOnly = ready.mode === "runners";
    const blocked = runnersOnly ? ready.loading || !ready.ready : config?.runsHere === false;

    useEffect(() => {
        if (existing.data?.application?.url && !url) setUrl(existing.data.application.url);
    }, [existing.data]); // eslint-disable-line react-hooks/exhaustive-deps

    // Without a usable AI key of the person's the web application cannot be explored; the API can, so only the API is explored here (said in the callout).
    const myAi = useMyAi().data;
    const aiReady = aiReadyOf(myAi);
    const aiMissing = aiReady === false;
    // The AI screen review is the level's: offered only where the level turns it on, as a way to keep screenshots from the AI provider.
    const offerReview = !screenReviewOff && LEVEL_SETTINGS[chosenLevel].visionByDefault && aiReady === true;
    const agents = inputs.data?.applies && inputs.data.agents ? inputs.data.agents : null;
    // A Test Case Generation project may work from its active requirements alone, with no address (SPEC R16).
    const activeRequirements = useFetch<{ requirements: unknown[] }>(caseAgent ? `/projects/${projectId}/requirements?status=active` : null);
    const fromRequirements = caseAgent && !url.trim() && (activeRequirements.data?.requirements.length ?? 0) > 0;

    function submit(e: React.FormEvent) {
        e.preventDefault();
        void begin();
    }

    /** Explore, then stop at a plan: nothing is created or run until the person has looked (see the plan on the project page). */
    async function begin() {
        setError(null);
        if (runnersOnly && blocked) return;
        if (missing.length) return setAskOpen(true);
        if (caseAgent && !url.trim() && !fromRequirements) return setUrlError(NO_ADDRESS_OR_REQUIREMENTS);
        let address: string | undefined;
        if (!fromRequirements) {
            const n = normalizeUrl(url);
            if (!n.url) return setUrlError(n.error!);
            address = n.url;
        }
        setUrlError("");
        setBusy(true);
        try {
            const id = projectId;
            // The checks are the project's testing agents' (the server applies them, or its usual checks when none are saved), and the
            // sign-in, API access, OpenAPI document and requirements are the ones kept on the Requirements tab.
            await api(`/projects/${id}/test-generation`, {
                method: "POST",
                body: { url: address, plan: true, ...(agentId ? { agentId } : {}), ...(aiMissing && !caseAgent ? { targets: ["api"] } : {}), scope: scope.trim() || undefined, level: chosenLevel, ...(fullExploration && !first ? { fullExploration: true } : {}), ...(screenReview !== null && offerReview ? { visionChecks: screenReview } : {}) },
            });
            go(home);
        } catch (err) {
            setError(err);
            setBusy(false);
        }
    }

    const form = (
        <form className="stack" onSubmit={submit} noValidate>
            <div className="card card-pad stack">
                <div className="field">
                    <label htmlFor="url" className="lg">
                        Application URL
                    </label>
                    <p className="hint" id="url-hint">
                        {caseAgent ? `Enter the address of the website, or leave it empty to write the test cases from the project’s requirements. ${CASE_AGENT_HINT}` : "Enter the address of the website you want to test. We’ll explore it and show you a plan. Nothing is created until you say so."}
                    </p>
                    <div className="input-wrap">
                        <Globe size={18} className="lead" aria-hidden />
                        <input
                            id="url"
                            className="input input-lg"
                            type="text"
                            inputMode="url"
                            autoComplete="url"
                            placeholder="https://example.com"
                            value={url}
                            onChange={(e) => {
                                setUrl(e.target.value);
                                setUrlError("");
                            }}
                            aria-describedby="url-hint"
                            aria-invalid={!!urlError}
                        />
                    </div>
                    {urlError && <div className="error-text">{urlError}</div>}
                </div>
                <div className="field">
                    <FieldHelp htmlFor="scope" label="Focus (optional)" help={`Told to the AI when it ${caseAgent ? "writes the test cases" : "plans which tests to write"}. The whole application is still explored.`} />
                    <input id="scope" className="input" value={scope} onChange={(e) => setScope(e.target.value)} placeholder="Everything — or e.g. “search and checkout only”" />
                </div>
                <LevelChoice value={chosenLevel} onChange={setLevel} caseAgent={caseAgent} />
                {offerReview && <ScreenReviewChoice level={chosenLevel} canReadImages value={screenReview} onChange={setScreenReview} />}
                {!first && (
                    <label className="check">
                        <input type="checkbox" data-testid="full-exploration" checked={fullExploration} onChange={(e) => setFullExploration(e.target.checked)} />
                        <span>
                            <span className="title">Explore every page again</span>
                            <span className="hint">Pages unchanged since the last exploration are normally reused. This sends every page to the AI again.</span>
                        </span>
                    </label>
                )}

                {aiMissing && (
                    <Callout tone="warning" title="You have no usable AI key" actions={<LinkButton size="sm" href={routes.aiKeys}>Open AI keys</LinkButton>}>
                        {aiProblemOf(myAi)} {caseAgent ? "Writing test cases needs it." : "Exploring the web application needs it, so only the application’s API is explored here. API tests are created without the AI."}
                    </Callout>
                )}
                {runnersOnly ? (
                    <ExploreOnRunnerNote ready={ready} />
                ) : config?.runsHere === false && (
                    <Callout tone="warning" title="Exploring does not run here">
                        <span data-testid="exploring-off">{EXPLORING_OFF_HERE} Explore where tests run, or once tests are switched on here.</span>
                    </Callout>
                )}
                {error !== null && <ExploreStartError error={error} />}

                <div className="row">
                    <Button type="submit" variant="primary" size="lg" icon={Sparkles} loading={busy} disabled={blocked}>
                        {busy ? "Starting…" : title}
                    </Button>
                    {agents && (
                        <span className="hint" data-testid="explore-agents">
                            {agentId ? oneAgentSentence(agents, agentId) : caseAgent ? caseAgentSentence(agents.names) : agents.source === "chosen" ? `Checked by this project’s testing agents: ${agents.names.join(", ")}.` : "No testing agents saved for this project yet, so every kind of test is planned."}
                        </span>
                    )}
                </div>
                <p className="t-meta" data-testid="ai-note">
                    {caseAgent ? "Exploring uses your AI key: it reads each page and writes the test cases in plain English." : "Exploring a web application uses your AI key: it decides what to test, writes the tests and corrects a test that fails along the way. Tests for an API alone are created without it."}
                </p>
            </div>
            <p className="t-meta" data-testid="inputs-note">
                <ListChecks size={14} aria-hidden style={{ verticalAlign: "-2px", marginRight: 6 }} />
                {caseAgent ? (
                    <>
                        The sign-in the agent uses is kept in <a href={routes.projectSettings(projectId, "signin")}>Settings → Sign-in</a>; the requirements on the project’s <a href={routes.requirements(projectId)}>Requirements</a> tab.
                    </>
                ) : (
                    <>
                        The sign-in and API access the agents use are kept in <a href={routes.projectSettings(projectId, "signin")}>Settings → Sign-in</a>; the OpenAPI document and the requirements on the project’s <a href={routes.requirements(projectId)}>Requirements</a> tab. Which agents test it is set in <a href={routes.projectSettings(projectId)}>Settings → General</a>.
                    </>
                )}
            </p>
            {askOpen && <MissingInputsDialog projectId={projectId} missing={missing} onClose={() => setAskOpen(false)} />}
        </form>
    );

    return (
        <div style={{ maxWidth: 720 }}>
            <PageHeader
                title={title}
                subtitle={first ? "Explore this application for the first time. You see a plan before anything is created." : caseAgent ? "Explore this application again. What it finds is added to the same tree, with its test cases." : "Explore this application again. Existing tests are kept."}
                actions={
                    <LinkButton href={home} variant="ghost">
                        Cancel
                    </LinkButton>
                }
            />
            {form}
        </div>
    );
}

/** What an exploration of a Test Case Generation project does (SPEC P4.3): no checks, nothing run. */
const CASE_AGENT_HINT = "We’ll explore the application, add to its tree and write test cases. Nothing is run.";
const CASE_AGENT_NAME = "Test Case Generation Agent";
/** SPEC R16.2, as the server says it (case-agent.ts NO_ADDRESS_OR_REQUIREMENTS). */
const NO_ADDRESS_OR_REQUIREMENTS = "Add the application's address or a requirements document first.";

/** A run of one agent (Agent Workspace D1): only that agent works. */
function oneAgentSentence(agents: { ids: string[]; names: string[] }, agentId: string): string {
    const name = agents.names[agents.ids.indexOf(agentId)] ?? "testing agent";
    return agentId === "test-generation" ? `The ${CASE_AGENT_NAME} writes this project’s test cases.` : `Only the ${name} runs: its own checks, nothing else.`;
}

/** Who writes the test cases; other agents chosen with it wait for their own screens (owner decision Q6, 2026-11-20). */
function caseAgentSentence(names: string[]): string {
    const others = names.filter((n) => n !== CASE_AGENT_NAME);
    const base = `The ${CASE_AGENT_NAME} writes this project’s test cases.`;
    if (!others.length) return base;
    const list = others.length > 1 ? `${others.slice(0, -1).join(", ")} and ${others.at(-1)}` : others[0];
    return `${base} The ${list} ${others.length > 1 ? "come" : "comes"} back in a later update.`;
}
