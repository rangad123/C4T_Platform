import { FolderPlus } from "lucide-react";
import { useState } from "react";
import { ApiError, MODE_WORDS, PLATFORM_WORDS, api, type Platform, type TestingMode } from "../../api";
import { usePage } from "../../components/Shell";
import { Button, Callout, PageHeader } from "../../components/ui";
import { useDocumentTitle, useFetch } from "../../lib/hooks";
import { go, routes } from "../../lib/router";
import { useAuth } from "../auth/auth";
import { sideOf, useCan } from "../auth/permissions";

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
 * Create a project (story US-010): what it is, what it runs on, and how it is tested. Only what those choices need is asked; the
 * rest (environments, the app, AI, runners) is set up from the project's dashboard, which lists what is still missing. The server
 * checks everything again: a customer's project always goes to their own organisation.
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
    const [platforms, setPlatforms] = useState<Platform[]>(["web"]);
    const [modes, setModes] = useState<TestingMode[]>(["agent", "code"]);
    const [organizationId, setOrganizationId] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const toggle = <T extends string>(list: T[], value: T, set: (l: T[]) => void) => set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
    const missing = !name.trim() ? "Give the project a name." : platforms.length === 0 ? "Choose at least one platform." : modes.length === 0 ? "Choose at least one testing mode." : null;

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
                body: { name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), platforms, testingModes: modes, ...(organizationId ? { organizationId } : {}) },
            });
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
                data-testid="create-project"
            >
                <div className="field">
                    <label htmlFor="project-name">Name</label>
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
                    <legend className="t-card">Platforms</legend>
                    {(Object.keys(PLATFORM_WORDS) as Platform[]).map((p) => (
                        <label key={p} className="check">
                            <input type="checkbox" checked={platforms.includes(p)} onChange={() => toggle(platforms, p, setPlatforms)} />
                            <span className="choice-text">
                                <span className="title">{PLATFORM_WORDS[p]}</span>
                                <span className="t-meta">{PLATFORM_HELP[p]}</span>
                            </span>
                        </label>
                    ))}
                </fieldset>
                <fieldset className="choice-group stack-sm">
                    <legend className="t-card">Testing modes</legend>
                    {(Object.keys(MODE_WORDS) as TestingMode[]).map((m) => (
                        <label key={m} className="check">
                            <input type="checkbox" checked={modes.includes(m)} onChange={() => toggle(modes, m, setModes)} />
                            <span className="choice-text">
                                <span className="title">{MODE_WORDS[m]}</span>
                                <span className="t-meta">{MODE_HELP[m]}</span>
                            </span>
                        </label>
                    ))}
                </fieldset>
                <p className="t-meta">
                    Engines are chosen for you: Playwright for web{platforms.some((p) => p !== "web") ? ", Taqwright for phone apps" : ""}.
                </p>
                {error && <Callout tone="danger">{error}</Callout>}
                <div className="row" style={{ gap: 12 }}>
                    <Button type="submit" variant="primary" icon={FolderPlus} loading={busy} disabled={busy}>
                        Create project
                    </Button>
                    <a href={routes.home}>Cancel</a>
                </div>
            </form>
        </>
    );
}
