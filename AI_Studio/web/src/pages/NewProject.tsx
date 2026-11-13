import { ArrowLeft, Compass, FileCheck2, Globe, ListChecks, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type ProjectDetail } from "../api";
import { Button, Callout, LinkButton, PageHeader } from "../components/ui";
import { FieldHelp } from "../components/Tooltip";
import { usePage } from "../components/Shell";
import { normalizeUrl } from "../lib/url";
import { useConfig, useDocumentTitle, useFetch } from "../lib/hooks";
import { go, routes } from "../lib/router";
import { Welcome } from "../features/onboarding/Welcome";
import { HelpPlace } from "../features/guide/HelpContext";
import { SeeHow } from "../features/guide/SeeHow";
import { SecurityStartGate } from "../features/security/TestingType";
import { applyPendingTestingType } from "../features/security/security";
import type { AgentInputs } from "../features/requirements/AgentInputs";
import { MissingInputsDialog } from "../features/requirements/AgentInputsDialog";
import { EXPLORING_OFF_HERE } from "../features/runs/runs-here";
import { ExploreOnRunnerNote, ExploreStartError } from "../features/runs/ExploreOnRunner";
import { useReadiness } from "../features/runners/my-runner";
import { LevelChoice, projectLevel, ScreenReviewChoice } from "../features/explore/ExploreLevel";
import type { ExploreLevel } from "../../../src/engine/levels";

export function NewProject({ welcome = false, projectId, initialUrl }: { welcome?: boolean; projectId?: string; initialUrl?: string }) {
    useDocumentTitle(welcome ? "" : "New project");
    const existing = useFetch<ProjectDetail>(projectId ? `/projects/${projectId}` : null);
    usePage(
        welcome
            ? { crumbs: [{ label: "Projects" }], nav: "projects" }
            : projectId
              ? { crumbs: [{ label: "Projects", href: routes.home }, { label: existing.data?.name ?? "Project", href: routes.project(projectId) }, { label: "Explore again" }], nav: "projects" }
              : { crumbs: [{ label: "Projects", href: routes.home }, { label: "New project" }], nav: "projects" },
    );
    const config = useConfig();
    // What the project's testing agents need lives on its Requirements tab (round 38); here only whether something mandatory is missing.
    const inputs = useFetch<AgentInputs>(projectId ? `/projects/${projectId}/agent-inputs` : null);
    const missing = inputs.data?.missing ?? [];
    const [askOpen, setAskOpen] = useState(false);
    const asked = useRef(false);
    useEffect(() => {
        if (!asked.current && missing.length) {
            asked.current = true;
            setAskOpen(true);
        }
    }, [missing.length]);

    const [url, setUrl] = useState(initialUrl ?? "");
    const [urlError, setUrlError] = useState("");
    // Round 37: a new project's name is always typed; it is never made from the address.
    const [name, setName] = useState("");
    const [nameError, setNameError] = useState("");
    const [scope, setScope] = useState("");
    // How much to explore (the project's saved level, else Thorough) and whether every page goes to the AI again.
    const [level, setLevel] = useState<ExploreLevel | null>(null);
    const [fullExploration, setFullExploration] = useState(false);
    // AI screen review: null = the level decides; set only when the person changes the box.
    const [screenReview, setScreenReview] = useState<boolean | null>(null);
    // Hidden when the project's testing agents leave it off (no UX agent).
    const agentSwitches = useFetch<{ applies?: boolean; switches?: Record<string, string> }>(projectId ? `/projects/${projectId}/testing-agents` : null);
    const screenReviewOff = agentSwitches.data?.applies === true && agentSwitches.data.switches?.visionChecks === "off";
    const chosenLevel = level ?? projectLevel(existing.data);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<unknown>(null);
    // Runners mode (round 51): the exploration runs on the person's own runner, so it starts only once that runner can take it.
    const ready = useReadiness({ can: ["web", "explore"] });
    const runnersOnly = ready.mode === "runners";
    const blocked = runnersOnly ? ready.loading || !ready.ready : config?.runsHere === false;
    /** A project created by a failed attempt is reused when the user retries, instead of creating duplicates. */
    const createdProject = useRef<string | undefined>(undefined);
    // A new project starts at the choice of how to start (explore, record, bring tests); a link that names a project or an address goes straight to the form.
    const choosing = !projectId && !initialUrl;
    const [step, setStep] = useState<"choose" | "form">(choosing ? "choose" : "form");

    useEffect(() => {
        if (existing.data?.application?.url && !url) setUrl(existing.data.application.url);
    }, [existing.data]); // eslint-disable-line react-hooks/exhaustive-deps

    // Without an AI model the web application cannot be explored; the API can, so only the API is explored here (said in the callout).
    const aiMissing = Boolean(config && !config.llm.configured);
    const agents = inputs.data?.applies && inputs.data.agents ? inputs.data.agents : null;

    function submit(e: React.FormEvent) {
        e.preventDefault();
        void begin();
    }

    /** Explore, then stop at a plan: nothing is created or run until the person has looked (see the plan on the project page). */
    async function begin() {
        setError(null);
        if (runnersOnly && blocked) return;
        if (missing.length) return setAskOpen(true);
        const needsName = !projectId && !createdProject.current;
        if (needsName && !name.trim()) setNameError("Give the project a name.");
        const n = normalizeUrl(url);
        if (!n.url) return setUrlError(n.error!);
        if (needsName && !name.trim()) return;
        setUrlError("");
        setNameError("");
        setBusy(true);
        try {
            let id = projectId ?? createdProject.current;
            if (!id) {
                // The typed name (a name already taken is refused); a web project explored by the AI agent.
                id = (await api("/projects", { method: "POST", body: { name: name.trim(), platforms: ["web"], testingModes: ["agent"] } })).id as string;
                createdProject.current = id;
                await applyPendingTestingType(id);
            }
            // The checks are the project's testing agents' (the server applies them, or its usual checks when none are saved), and the
            // sign-in, API access, OpenAPI document and requirements are the ones kept on the Requirements tab.
            await api(`/projects/${id}/test-generation`, {
                method: "POST",
                body: { url: n.url, plan: true, ...(aiMissing ? { targets: ["api"] } : {}), scope: scope.trim() || undefined, level: chosenLevel, ...(fullExploration ? { fullExploration: true } : {}), ...(screenReview !== null && !screenReviewOff ? { visionChecks: screenReview } : {}) },
            });
            go(routes.project(id));
        } catch (err) {
            setError(err);
            setBusy(false);
        }
    }

    const form = (
        <form className="stack" onSubmit={submit} noValidate>
            <div className="card card-pad stack">
                {!projectId && (
                    <div className="field">
                        <label htmlFor="name" className="lg">
                            Project name
                        </label>
                        <input id="name" className="input input-lg" required maxLength={120} autoComplete="off" value={name} onChange={(e) => (setName(e.target.value), setNameError(""))} placeholder="Gift shop website" aria-invalid={!!nameError} autoFocus={!welcome} />
                        {nameError && <div className="error-text">{nameError}</div>}
                    </div>
                )}
                <div className="field">
                    <label htmlFor="url" className="lg">
                        Application URL
                    </label>
                    <p className="hint" id="url-hint">
                        Enter the address of the website you want to test. We’ll explore it and show you a plan. Nothing is created until you say so.
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
                            autoFocus={welcome}
                        />
                    </div>
                    {urlError && <div className="error-text">{urlError}</div>}
                </div>
                <div className="field">
                    <FieldHelp htmlFor="scope" label="Focus (optional)" help="Told to the AI when it plans which tests to write. The whole application is still explored." />
                    <input id="scope" className="input" value={scope} onChange={(e) => setScope(e.target.value)} placeholder="Everything — or e.g. “search and checkout only”" />
                </div>
                <LevelChoice value={chosenLevel} onChange={setLevel} />
                {!screenReviewOff && <ScreenReviewChoice level={chosenLevel} canReadImages={Boolean(config?.llm.configured)} value={screenReview} onChange={setScreenReview} />}
                {projectId && (
                    <label className="row" style={{ alignItems: "flex-start" }}>
                        <input type="checkbox" data-testid="full-exploration" checked={fullExploration} onChange={(e) => setFullExploration(e.target.checked)} />
                        <span>
                            Explore every page again
                            <span className="t-meta" style={{ display: "block" }}>
                                Pages unchanged since the last exploration are normally reused. This sends every page to the AI again.
                            </span>
                        </span>
                    </label>
                )}

                {aiMissing && (
                    <Callout tone="warning" title="The AI model isn’t set up on this server" actions={<LinkButton size="sm" href={routes.settings}>How to set it up</LinkButton>}>
                        Exploring the web application needs it, so only the application’s API is explored here. API tests are created without the AI.
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
                        {busy ? "Starting…" : projectId ? "Explore again" : "Start exploring"}
                    </Button>
                    {agents && (
                        <span className="hint" data-testid="explore-agents">
                            {agents.source === "chosen" ? `Checked by this project’s testing agents: ${agents.names.join(", ")}.` : "No testing agents saved for this project yet, so the usual checks run."}
                        </span>
                    )}
                </div>
                <p className="t-meta" data-testid="ai-note">
                    Exploring a web application uses the AI model: it decides what to test, writes the tests and corrects a test that fails along the way. Tests for an API alone are created without it.
                </p>
            </div>
            <p className="t-meta" data-testid="inputs-note">
                <ListChecks size={14} aria-hidden style={{ verticalAlign: "-2px", marginRight: 6 }} />
                {projectId ? (
                    <>
                        Sign-in details, API access, the OpenAPI document and the requirements the agents use are kept on the project’s <a href={routes.requirements(projectId)}>Requirements</a> tab. Which agents test it is set in <a href={routes.projectSettings(projectId)}>Settings → General</a>.
                    </>
                ) : (
                    <>Once the project is made, keep its sign-in details, API access, OpenAPI document and requirements on its Requirements tab.</>
                )}
            </p>
            {askOpen && projectId && <MissingInputsDialog projectId={projectId} missing={missing} onClose={() => setAskOpen(false)} />}
        </form>
    );

    const back = choosing ? (
        <Button type="button" variant="ghost" icon={ArrowLeft} onClick={() => setStep("choose")}>
            Back
        </Button>
    ) : null;

    // Three ways to start, side by side; the options form is one click away from the first.
    if (choosing && step === "choose") {
        const chooser = (
            <Welcome
                aiConfigured={config ? config.llm.configured : undefined}
                explore={{ url, setUrl, urlError, clearUrlError: () => setUrlError(""), busy, error, blocked: runnersOnly && blocked, runnerNote: runnersOnly ? <ExploreOnRunnerNote ready={ready} /> : null, onExplore: () => void begin(), onOptions: () => setStep("form"), autoFocus: welcome }}
                name={{ value: name, set: (v: string) => (setName(v), setNameError("")), error: nameError, setError: setNameError }}
            />
        );
        if (!welcome) {
            return (
                <div className="stack">
                    <PageHeader
                        title="Create a test project"
                        subtitle="How would you like to start?"
                        actions={
                            <LinkButton href={routes.home} variant="ghost">
                                Cancel
                            </LinkButton>
                        }
                    />
                    <SecurityStartGate>{chooser}</SecurityStartGate>
                </div>
            );
        }
    }

    if (welcome) {
        return (
            <div className="stack" style={{ gap: 28 }}>
                <div className="hero c4t-deep">
                    <span className="eyebrow">Automated web and API testing</span>
                    <h1>Test any web application automatically</h1>
                    <p>Let the AI explore your application and propose tests, record one yourself, or bring the tests you already have. Every test is run before you rely on it.</p>
                </div>
                <HelpPlace place="welcome" />
                <SeeHow topic="first-steps" query="start in 10 minutes" />
                <SecurityStartGate>
                {step === "choose" ? (
                    <Welcome
                        aiConfigured={config ? config.llm.configured : undefined}
                        explore={{ url, setUrl, urlError, clearUrlError: () => setUrlError(""), busy, error, blocked: runnersOnly && blocked, runnerNote: runnersOnly ? <ExploreOnRunnerNote ready={ready} /> : null, onExplore: () => void begin(), onOptions: () => setStep("form"), autoFocus: true }}
                        name={{ value: name, set: (v: string) => (setName(v), setNameError("")), error: nameError, setError: setNameError }}
                    />
                ) : (
                    <div className="stack" style={{ maxWidth: 720, width: "100%" }}>
                        <div>{back}</div>
                        {form}
                    </div>
                )}
                </SecurityStartGate>
                <div className="how" aria-label="How it works">
                    {[
                        { icon: Globe, title: "1. Enter your URL", text: "Point us at a staging or test version of your application." },
                        { icon: Compass, title: "2. We explore and show a plan", text: "We find the pages and user journeys and tell you which tests we would create. Nothing is created yet." },
                        { icon: FileCheck2, title: "3. You approve, we run", text: "Choose what to include. Every test is run before you rely on it. Download them or run them in your own pipeline." },
                    ].map((s) => (
                        <div className="card item" key={s.title}>
                            <span className="num">
                                <s.icon size={15} aria-hidden />
                            </span>
                            <div className="t-card">{s.title}</div>
                            <p className="t-secondary">{s.text}</p>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div style={{ maxWidth: 720 }}>
            <PageHeader
                title={projectId ? "Explore again" : "Create a test project"}
                subtitle={projectId ? "Explore this application again. Existing tests are kept." : "What would you like to test?"}
                actions={
                    <>
                        {back}
                        <LinkButton href={projectId ? routes.project(projectId) : routes.home} variant="ghost">
                            Cancel
                        </LinkButton>
                    </>
                }
            />
            {projectId ? form : <SecurityStartGate>{form}</SecurityStartGate>}
        </div>
    );
}

