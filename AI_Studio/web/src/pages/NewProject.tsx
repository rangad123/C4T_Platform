import { ArrowLeft, Compass, FileCheck2, Globe, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type ProjectDetail } from "../api";
import { Button, Callout, Disclosure, FilePicker, LinkButton, PageHeader } from "../components/ui";
import { FieldHelp } from "../components/Tooltip";
import { usePage } from "../components/Shell";
import { toBase64 } from "../lib/format";
import { normalizeUrl } from "../lib/url";
import { describeApiError } from "../lib/labels";
import { useConfig, useDocumentTitle, useFetch } from "../lib/hooks";
import { go, routes } from "../lib/router";
import { AlsoCheckOn } from "../features/variants/AlsoCheckOn";
import { useAgentSwitches } from "../features/testing-agents/useAgentSwitches";
import type { AgentSwitch } from "../features/testing-agents/testing-agents";
import { Welcome } from "../features/onboarding/Welcome";
import { HelpPlace } from "../features/guide/HelpContext";
import { SeeHow } from "../features/guide/SeeHow";
import { SecurityStartGate } from "../features/security/TestingType";
import { applyPendingTestingType } from "../features/security/security";

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

    const [url, setUrl] = useState(initialUrl ?? "");
    const [urlError, setUrlError] = useState("");
    // Round 37: a new project's name is always typed; it is never made from the address.
    const [name, setName] = useState("");
    const [nameError, setNameError] = useState("");
    const [web, setWeb] = useState(true);
    const [apiTests, setApiTests] = useState(true);
    const [accessibility, setAccessibility] = useState(true);
    const [healthChecks, setHealthChecks] = useState(true);
    const [securityChecks, setSecurityChecks] = useState(true);
    const [performanceChecks, setPerformanceChecks] = useState(false);
    const [loadChecks, setLoadChecks] = useState(false);
    const [inputChecks, setInputChecks] = useState(true);
    const [contractChecks, setContractChecks] = useState(true);
    const [useMemory, setUseMemory] = useState(true);
    const [fullExploration, setFullExploration] = useState(false);
    const [visual, setVisual] = useState(false);
    const [visionChecks, setVisionChecks] = useState(false);
    const [variants, setVariants] = useState<string[]>([]);
    const [reqFile, setReqFile] = useState<File | null>(null);
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [totpSecret, setTotpSecret] = useState("");
    const [apiToken, setApiToken] = useState("");
    const [oauth, setOauth] = useState({ tokenUrl: "", clientId: "", clientSecret: "", scope: "" });
    const [openApiUrl, setOpenApiUrl] = useState("");
    const [scope, setScope] = useState("");
    const [allowMutating, setAllowMutating] = useState(false);
    const [cleanupAfter, setCleanupAfter] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    // The project's saved testing agents decide these checks (features/testing-agents): a check no chosen agent owns is off and locked.
    const agentSwitches = useAgentSwitches(projectId, { apiTests: setApiTests, accessibility: setAccessibility, healthChecks: setHealthChecks, contractChecks: setContractChecks, inputChecks: setInputChecks, performanceChecks: setPerformanceChecks, loadChecks: setLoadChecks, securityChecks: setSecurityChecks, visual: setVisual, visionChecks: setVisionChecks });
    const off = (k: AgentSwitch) => agentSwitches?.[k] === "off";
    /** A project created by a failed attempt is reused when the user retries, instead of creating duplicates. */
    const createdProject = useRef<string | undefined>(undefined);
    // A new project starts at the choice of how to start (explore, record, bring tests); a link that names a project or an address goes straight to the form.
    const choosing = !projectId && !initialUrl;
    const [step, setStep] = useState<"choose" | "form">(choosing ? "choose" : "form");

    useEffect(() => {
        if (existing.data?.application?.url && !url) setUrl(existing.data.application.url);
    }, [existing.data]); // eslint-disable-line react-hooks/exhaustive-deps

    const aiMissing = web && config && !config.llm.configured;
    const parts = [web && "web application", apiTests && "API", web && accessibility && "accessibility", web && healthChecks && "page health", securityChecks && "basic security", (web || apiTests) && performanceChecks && "speed", apiTests && loadChecks && "load", web && inputChecks && "form input", web && visual && "visual changes", web && visionChecks && "AI screen review"].filter(Boolean) as string[];

    function submit(e: React.FormEvent) {
        e.preventDefault();
        void begin();
    }

    /** Explore, then stop at a plan: nothing is created or run until the person has looked (see the plan on the project page). */
    async function begin() {
        setError("");
        const needsName = !projectId && !createdProject.current;
        if (needsName && !name.trim()) setNameError("Give the project a name.");
        const n = normalizeUrl(url);
        if (!n.url) return setUrlError(n.error!);
        if (needsName && !name.trim()) return;
        if (!web && !apiTests) return setError("Choose at least one thing to test under Advanced options.");
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
            const hasCreds = username || password || apiToken || oauth.tokenUrl;
            await api(`/projects/${id}/test-generation`, {
                method: "POST",
                body: {
                    url: n.url,
                    plan: true,
                    targets: [web && "web", apiTests && "api"].filter(Boolean),
                    accessibility: web ? accessibility : undefined,
                    healthChecks: web ? healthChecks : undefined,
                    securityChecks,
                    performanceChecks: (web || apiTests) && performanceChecks ? true : undefined,
                    loadChecks: apiTests && loadChecks ? true : undefined,
                    inputChecks: web ? inputChecks : undefined,
                    contractChecks: apiTests ? contractChecks : undefined,
                    useMemory: web && !useMemory ? false : undefined,
                    fullExploration: web && useMemory && fullExploration ? true : undefined,
                    visual: web ? visual : undefined,
                    visionChecks: web && visionChecks ? true : undefined,
                    variants: web && variants.length ? variants : undefined,
                    scope: scope.trim() || undefined,
                    allowMutatingApiTests: allowMutating || undefined,
                    cleanupAfter: allowMutating && !cleanupAfter ? false : undefined,
                    openApiUrl: openApiUrl.trim() || undefined,
                    requirements: reqFile ? { filename: reqFile.name, contentBase64: await toBase64(reqFile) } : undefined,
                    credentials: hasCreds
                        ? {
                              username: username || undefined,
                              password: password || undefined,
                              totpSecret: totpSecret.trim() || undefined,
                              apiToken: apiToken || undefined,
                              oauth2: oauth.tokenUrl ? { tokenUrl: oauth.tokenUrl, clientId: oauth.clientId, clientSecret: oauth.clientSecret, scope: oauth.scope || undefined } : undefined,
                          }
                        : undefined,
                },
            });
            go(routes.project(id));
        } catch (err) {
            setError(describeApiError(err));
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

                {aiMissing && (
                    <Callout tone="warning" title="The AI model isn’t set up on this server" actions={<LinkButton size="sm" href={routes.settings}>How to set it up</LinkButton>}>
                        Web testing needs an AI model, so the exploration would fail. API tests don’t, so turn off “Web application” under Advanced options to run only those.
                    </Callout>
                )}
                {error && <Callout tone="danger" title="We couldn’t start the exploration">{error}</Callout>}

                <div className="row">
                    <Button type="submit" variant="primary" size="lg" icon={Sparkles} loading={busy}>
                        {busy ? "Starting…" : projectId ? "Explore again" : "Start exploring"}
                    </Button>
                    <span className="hint">{parts.length ? `We’ll test: ${parts.join(", ")}.` : "Nothing selected to test."}</span>
                </div>
                <p className="t-meta" data-testid="ai-note">
                    Exploring a web application uses the AI model: it decides what to test, writes the tests and corrects a test that fails along the way. Tests for an API alone are created without it.
                </p>
            </div>

            <div className="card" style={{ padding: "0 20px" }}>
                <Disclosure label="Advanced options">
                    <div className="stack" style={{ gap: 0 }}>
                        {agentSwitches && projectId && (
                            <p className="t-meta opt-group" data-testid="agent-switch-note">
                                This project’s testing agents set these checks. A check that is greyed out comes with an agent the project does not use: add it in <a href={routes.projectSettings(projectId)}>Settings → General</a>.
                            </p>
                        )}
                        <fieldset className="stack-sm opt-group" style={{ border: 0, margin: 0, minWidth: 0 }}>
                            <legend className="t-card" style={{ marginBottom: 8 }}>
                                What should we test?
                            </legend>
                            <label className="check">
                                <input type="checkbox" checked={web} onChange={(e) => setWeb(e.target.checked)} />
                                <span>
                                    <span className="title">Web application</span>
                                    <span className="hint">Realistic user journeys, such as signing in, searching and checking out.</span>
                                </span>
                            </label>
                            <label className="check">
                                <input type="checkbox" checked={apiTests} disabled={off("apiTests")} onChange={(e) => setApiTests(e.target.checked)} />
                                <span>
                                    <span className="title">API</span>
                                    <span className="hint">Found from the application’s OpenAPI document or the requests it makes.</span>
                                </span>
                            </label>
                            <label className="check">
                                <input type="checkbox" checked={accessibility} disabled={!web || off("accessibility")} onChange={(e) => setAccessibility(e.target.checked)} />
                                <span>
                                    <span className="title">Accessibility checks</span>
                                    <span className="hint">Automatic WCAG 2.1 AA checks of key pages.</span>
                                </span>
                            </label>
                            <label className="check">
                                <input type="checkbox" checked={healthChecks} disabled={!web || off("healthChecks")} onChange={(e) => setHealthChecks(e.target.checked)} />
                                <span>
                                    <span className="title">Page health checks</span>
                                    <span className="hint">Looks for script errors, failed requests, broken links and insecure content on key pages.</span>
                                </span>
                            </label>
                            <label className="check">
                                <input type="checkbox" checked={contractChecks} disabled={!apiTests || off("contractChecks")} onChange={(e) => setContractChecks(e.target.checked)} />
                                <span>
                                    <span className="title">Check API responses against the documentation</span>
                                    <span className="hint">When the API has an OpenAPI description, real responses are compared with it: missing fields, wrong types, unexpected values.</span>
                                </span>
                            </label>
                            <label className="check">
                                <input type="checkbox" checked={inputChecks} disabled={!web || off("inputChecks")} onChange={(e) => setInputChecks(e.target.checked)} />
                                <span>
                                    <span className="title">Check how forms handle unusual input</span>
                                    <span className="hint">Tries harmless odd text (HTML-like, very long, emoji) in search forms. Forms that send data are only touched if you enable tests that change data; login and payment forms never are.</span>
                                </span>
                            </label>
                            <label className="check">
                                <input type="checkbox" checked={useMemory} disabled={!web} onChange={(e) => setUseMemory(e.target.checked)} />
                                <span>
                                    <span className="title">Start from what we learned last time</span>
                                    <span className="hint">Keeps notes about this site’s structure (page addresses, journey names; never page text or passwords) so a new exploration is steadier and can tell you what changed. The whole site is still explored every time.</span>
                                </span>
                            </label>
                            <label className="check">
                                <input type="checkbox" checked={fullExploration} disabled={!web || !useMemory} onChange={(e) => setFullExploration(e.target.checked)} />
                                <span>
                                    <span className="title">Send every page to the AI again</span>
                                    <span className="hint">Normally pages that have not changed since the last exploration are not sent to the AI again, and what it understood about them then is used. Tick this to have every page looked at afresh (uses more AI).</span>
                                </span>
                            </label>
                            <label className="check">
                                <input type="checkbox" checked={performanceChecks} disabled={(!web && !apiTests) || off("performanceChecks")} onChange={(e) => setPerformanceChecks(e.target.checked)} />
                                <span>
                                    <span className="title">Speed checks (takes longer)</span>
                                    <span className="hint">Loads key pages three times and checks how fast the main content appears, how stable the layout is and how heavy the page is. Also times a few safe API endpoints, one request at a time (not a load test).</span>
                                </span>
                            </label>
                            <label className="check">
                                <input type="checkbox" checked={loadChecks} disabled={!apiTests || off("loadChecks")} onChange={(e) => setLoadChecks(e.target.checked)} />
                                <span>
                                    <span className="title">Load check (test environments only)</span>
                                    <span className="hint">Checks that up to 3 safe API endpoints stay fast and error-free when 10 people use them at once. It only reads (GET), stops at once if the application starts failing, and never runs on a production environment. Sends up to 300 requests to each of up to 3 pages of your application. Use a test environment.</span>
                                </span>
                            </label>
                            <label className="check">
                                <input type="checkbox" checked={securityChecks} disabled={off("securityChecks")} onChange={(e) => setSecurityChecks(e.target.checked)} />
                                <span>
                                    <span className="title">Basic security checks</span>
                                    <span className="hint">A read-only look at security headers, cookies, exposed files and the HTTPS certificate. Nothing is attacked or changed.</span>
                                </span>
                            </label>
                            <label className="check">
                                <input type="checkbox" checked={visual} disabled={!web || off("visual")} onChange={(e) => setVisual(e.target.checked)} />
                                <span>
                                    <span className="title">Visual change detection</span>
                                    <span className="hint">Saves a screenshot of key pages and flags later differences. Not suited to pages that change on every load.</span>
                                </span>
                            </label>
                            <label className="check">
                                <input type="checkbox" checked={visionChecks} disabled={!web || off("visionChecks")} onChange={(e) => setVisionChecks(e.target.checked)} />
                                <span>
                                    <span className="title">AI screen review (needs a vision-capable AI model)</span>
                                    <span className="hint">An AI model looks at screenshots of key pages and says whether the screen looks right: overlapping or cut-off elements, broken images, unreadable text. It is a judgement, so problems are reported as “please look” with the screenshot attached. Screenshots are sent to your AI provider. If your model can’t read images, these checks are reported as not run.</span>
                                </span>
                            </label>
                        </fieldset>

                        {web && !off("variants") && <AlsoCheckOn value={variants} onChange={setVariants} />}

                        <div className="stack-sm opt-group">
                            <div>
                                <div className="t-card">Sign in</div>
                                <p className="hint">Optional. Lets us test pages behind a login. Use a dedicated test account, never a real one.</p>
                            </div>
                            <div className="grid-2">
                                <div className="field">
                                    <label htmlFor="user">Username or email</label>
                                    <input id="user" className="input" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
                                </div>
                                <div className="field">
                                    <label htmlFor="pass">Password</label>
                                    <input id="pass" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                                </div>
                            </div>
                            <div className="field">
                                <label htmlFor="totp">Authenticator secret (optional)</label>
                                <input id="totp" className="input" type="password" autoComplete="off" spellCheck={false} value={totpSecret} onChange={(e) => setTotpSecret(e.target.value)} aria-describedby="totp-hint" />
                                <p id="totp-hint" className="hint">Only if the login asks for a one-time code from an authenticator app. Paste the setup key (letters and digits) shown when the test account was enrolled. Codes sent by email or text message can’t be used.</p>
                            </div>
                        </div>

                        <div className="stack-sm opt-group">
                            <div>
                                <div className="t-card">API access</div>
                                <p className="hint">Optional. Needed to test endpoints that require authorization. Use a token or OAuth2 client credentials.</p>
                            </div>
                            <div className="field">
                                <label htmlFor="token">Bearer token</label>
                                <input id="token" className="input" type="password" autoComplete="off" value={apiToken} onChange={(e) => setApiToken(e.target.value)} />
                            </div>
                            <Disclosure label="Use OAuth2 client credentials instead">
                            <div className="grid-2">
                                <div className="field">
                                    <label htmlFor="o-url">OAuth2 token URL</label>
                                    <input id="o-url" className="input" type="url" value={oauth.tokenUrl} onChange={(e) => setOauth({ ...oauth, tokenUrl: e.target.value })} />
                                </div>
                                <div className="field">
                                    <label htmlFor="o-scope">OAuth2 scope</label>
                                    <input id="o-scope" className="input" value={oauth.scope} onChange={(e) => setOauth({ ...oauth, scope: e.target.value })} />
                                </div>
                                <div className="field">
                                    <label htmlFor="o-id">OAuth2 client ID</label>
                                    <input id="o-id" className="input" autoComplete="off" value={oauth.clientId} onChange={(e) => setOauth({ ...oauth, clientId: e.target.value })} />
                                </div>
                                <div className="field">
                                    <label htmlFor="o-secret">OAuth2 client secret</label>
                                    <input id="o-secret" className="input" type="password" autoComplete="new-password" value={oauth.clientSecret} onChange={(e) => setOauth({ ...oauth, clientSecret: e.target.value })} />
                                </div>
                            </div>
                            </Disclosure>
                        </div>

                        <div className="field opt-group">
                            <div className="t-card">Requirements document</div>
                            <p className="hint">Optional. Upload a .txt, .md, .pdf or .docx file and we’ll make sure tests cover each requirement.</p>
                            <FilePicker id="req" accept=".txt,.md,.markdown,.pdf,.docx" file={reqFile} onChange={setReqFile} label="Choose a document" />
                        </div>

                        <div className="stack-sm opt-group">
                            <div className="field">
                                <FieldHelp htmlFor="scope" label="Focus" help="Told to the AI when it plans which tests to write. The whole application is still explored." />
                                <input id="scope" className="input" value={scope} onChange={(e) => setScope(e.target.value)} placeholder="Everything — or e.g. “search and checkout only”" />
                            </div>
                            <div className="field">
                                <label htmlFor="oas">OpenAPI document URL</label>
                                <input id="oas" className="input" type="url" value={openApiUrl} onChange={(e) => setOpenApiUrl(e.target.value)} placeholder="Found automatically if left empty" />
                            </div>
                            <label className="check">
                                <input type="checkbox" checked={allowMutating} onChange={(e) => setAllowMutating(e.target.checked)} />
                                <span>
                                    <span className="title">Include API tests that change data</span>
                                    <span className="hint">Creates, updates and deletes records in the real application. Off by default; only enable on a test environment.</span>
                                </span>
                            </label>
                            {allowMutating && (
                                <label className="check">
                                    <input type="checkbox" checked={cleanupAfter} onChange={(e) => setCleanupAfter(e.target.checked)} />
                                    <span>
                                        <span className="title">Remove the records these tests create afterwards</span>
                                        <span className="hint">
                                            Only records a test created in that run are removed, and only where the application describes how to remove them.
                                            {!cleanupAfter && " Cleanup is off: the records the tests create will stay in the application."}
                                        </span>
                                    </span>
                                </label>
                            )}
                        </div>
                    </div>
                </Disclosure>
            </div>
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
                explore={{ url, setUrl, urlError, clearUrlError: () => setUrlError(""), busy, error, onExplore: () => void begin(), onOptions: () => setStep("form"), autoFocus: welcome }}
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
                        explore={{ url, setUrl, urlError, clearUrlError: () => setUrlError(""), busy, error, onExplore: () => void begin(), onOptions: () => setStep("form"), autoFocus: true }}
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
