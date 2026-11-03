import { Archive, ArchiveRestore, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, MODE_WORDS, PLATFORM_WORDS, api, projectShape, type AppDetails, type Platform, type ProjectDetail, type TestingMode } from "../../api";
import { Button, Callout, ErrorState, LinkButton, Skeleton } from "../../components/ui";
import { formatBytes } from "../storage/storage";
import { ProjectAgentsPanel } from "../testing-agents/ProjectAgentsPanel";
import { announceProjectChanged, useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { AppDetailsFields, EMPTY_APP_DRAFT, appDraftProblem, appErrorText, saveAppDraft, type AppDraft } from "./AppDetailsFields";

interface C4tProjectRow {
    id: string;
    reference: string;
    title: string;
    status: string;
}

/**
 * Project Settings → General (stories US-010, US-011): the name, the one platform the project tests and its one testing mode
 * (round 37), the app, the organisation, and the Crowd4Test project it belongs to. A project made earlier with several platforms
 * or both modes shows them all and asks for one choice when it is next saved; nothing changes until then, and tests stay.
 * Changing anything needs "Change project settings"; without it the values are shown read-only.
 */
export function ProjectGeneral({ id }: { id: string }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const p = project.data;
    const archived = Boolean(p?.archived_at);
    const canEdit = (!p?.access || p.access.permissions.includes("ai_studio.project.settings")) && !archived;
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    // One of each, or null while an older project with several has not been given one yet.
    const [platform, setPlatform] = useState<Platform | null>(null);
    const [mode, setMode] = useState<TestingMode | null>(null);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

    useEffect(() => {
        if (!p) return;
        const shape = projectShape(p);
        setName(p.name);
        setDescription((p as { description?: string | null }).description ?? "");
        setPlatform(shape.platforms.length === 1 ? shape.platforms[0]! : null);
        setMode(shape.testingModes.length === 1 ? shape.testingModes[0]! : null);
    }, [p]);

    if (project.loading) return <Skeleton h={220} />;
    if (project.error || !p) return <ErrorState error={friendlyError(project.error?.message ?? "Project not found")} onRetry={project.reload} />;

    const shape = projectShape(p);
    // An older project with several platforms or both modes: saving asks for one of each (nothing changes before).
    const severalPlatforms = shape.platforms.length > 1;
    const severalModes = shape.testingModes.length > 1;
    const changed = name.trim() !== p.name || description.trim() !== ((p as { description?: string | null }).description ?? "") || [platform].join() !== shape.platforms.join() || [mode].join() !== shape.testingModes.join();

    const save = async () => {
        if (!name.trim()) return setNote({ tone: "danger", text: "Give the project a name." });
        if (!platform) return setNote({ tone: "danger", text: "Choose the one platform this project tests. Tests of the others stay." });
        if (!mode) return setNote({ tone: "danger", text: "Choose the one testing mode of this project. Tests already made stay." });
        setBusy(true);
        setNote(null);
        try {
            await api(`/projects/${id}`, { method: "PATCH", body: { name: name.trim(), description: description.trim(), platforms: [platform], testingModes: [mode] } });
            await project.reload();
            announceProjectChanged(id);
            setNote({ tone: "success", text: "Saved." });
        } catch (e) {
            setNote({ tone: "danger", text: e instanceof ApiError ? e.message : "The change was not saved. Try again." });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="stack" data-testid="project-general">
            <section className="card card-pad stack" aria-labelledby="general-title">
                <h2 className="t-section" id="general-title">
                    Project details
                </h2>
                <div className="field">
                    <label htmlFor="general-name">Name</label>
                    <input id="general-name" className="input" maxLength={120} disabled={!canEdit} value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="field">
                    <label htmlFor="general-description">Description</label>
                    <input id="general-description" className="input" maxLength={1000} disabled={!canEdit} value={description} onChange={(e) => setDescription(e.target.value)} />
                </div>
                <fieldset className="choice-group stack-sm">
                    <legend className="t-card">Platform</legend>
                    {severalPlatforms && (
                        <Callout tone="warning" title="Choose one platform">
                            This project was set up for {shape.platforms.map((x) => PLATFORM_WORDS[x]).join(", ")}. A project now tests one platform. Choose it below and save; tests of the others stay in the project.
                        </Callout>
                    )}
                    {(Object.keys(PLATFORM_WORDS) as Platform[]).map((pl) => (
                        <label key={pl} className="check">
                            <input type="radio" name="general-platform" value={pl} disabled={!canEdit} checked={platform === pl} onChange={() => setPlatform(pl)} />
                            <span>{PLATFORM_WORDS[pl]}</span>
                        </label>
                    ))}
                </fieldset>
                <fieldset className="choice-group stack-sm">
                    <legend className="t-card">Testing mode</legend>
                    {severalModes && (
                        <Callout tone="warning" title="Choose one testing mode">
                            This project uses both {shape.testingModes.map((x) => MODE_WORDS[x]).join(" and ")}. A project now has one mode. Choose it below and save; tests already made stay.
                        </Callout>
                    )}
                    {(Object.keys(MODE_WORDS) as TestingMode[]).map((m) => (
                        <label key={m} className="check">
                            <input type="radio" name="general-mode" value={m} disabled={!canEdit} checked={mode === m} onChange={() => setMode(m)} />
                            <span>{MODE_WORDS[m]}</span>
                        </label>
                    ))}
                </fieldset>
                <p className="t-meta">
                    Engine: {platform === "web" ? "Playwright for web" : platform ? "Taqwright for phone apps" : p.codeEngines ? [p.codeEngines.web && "Playwright for web", p.codeEngines.mobile && "Taqwright for phone apps"].filter(Boolean).join(", ") : "Playwright for web"}. Changing the platform or mode hides what the other needs; tests already made stay.
                </p>
                {note && <Callout tone={note.tone}>{note.text}</Callout>}
                {canEdit ? (
                    <div>
                        <Button variant="primary" icon={Save} loading={busy} disabled={busy || !changed} onClick={() => void save()}>
                            Save changes
                        </Button>
                    </div>
                ) : archived ? (
                    <p className="t-meta">This project is archived, so its settings are read-only. Restore it below to change them.</p>
                ) : (
                    <p className="t-meta">Changing these needs “Change project settings”. Ask your Crowd4Test administrator.</p>
                )}
            </section>
            <AppSection id={id} platforms={shape.platforms} canEdit={canEdit} />
            {/* The testing agents of an AI-agent project (features/testing-agents); read again when the platform or mode changes. */}
            <ProjectAgentsPanel key={`${projectShape(p).platforms.join()}/${projectShape(p).testingModes.join()}`} id={id} canEdit={canEdit} />
            <C4tLink id={id} project={p} canEdit={canEdit} onSaved={project.reload} />
            <ArchiveOrDelete id={id} project={p} onChanged={project.reload} />
        </div>
    );
}

/**
 * The app the project tests (round 37): the address for web, the .apk or Google Play link for Android, the .ipa or App Store link
 * for iOS. An older project with several platforms shows each of them.
 */
function AppSection({ id, platforms, canEdit }: { id: string; platforms: Platform[]; canEdit: boolean }) {
    const details = useFetch<AppDetails>(`/projects/${id}/app-details`);
    const [draft, setDraft] = useState<AppDraft>(EMPTY_APP_DRAFT);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    const dirty = JSON.stringify(draft) !== JSON.stringify(EMPTY_APP_DRAFT) && (Boolean(draft.webUrl.trim()) || Boolean(draft.apk) || Boolean(draft.ipa) || (draft.androidHow === "link" && Boolean(draft.playStoreUrl.trim())) || (draft.iosHow === "link" && Boolean(draft.appStoreUrl.trim())));
    const save = async () => {
        for (const pl of platforms) {
            const problem = appDraftProblem(pl, draft, { required: false });
            if (problem) return setNote({ tone: "danger", text: problem });
        }
        setBusy(true);
        setNote(null);
        try {
            for (const pl of platforms) await saveAppDraft(id, pl, draft);
            setDraft(EMPTY_APP_DRAFT);
            await details.reload();
            announceProjectChanged(id);
            setNote({ tone: "success", text: "Saved." });
        } catch (e) {
            setNote({ tone: "danger", text: appErrorText(e, "The app was not saved. Try again.") });
        } finally {
            setBusy(false);
        }
    };
    return (
        <section className="card card-pad stack" aria-labelledby="app-title" data-testid="project-app">
            <h2 className="t-section" id="app-title">
                Application
            </h2>
            {details.loading ? (
                <Skeleton h={80} />
            ) : details.error ? (
                <Callout tone="warning">{details.error instanceof ApiError && details.error.status === 404 ? "This server does not keep app details yet." : details.error.message}</Callout>
            ) : (
                <>
                    {platforms.map((pl) => (
                        <AppDetailsFields key={pl} platform={pl} draft={draft} onChange={setDraft} current={details.data} disabled={!canEdit || busy} />
                    ))}
                    {note && <Callout tone={note.tone}>{note.text}</Callout>}
                    {canEdit && (
                        <div>
                            <Button variant="primary" icon={Save} loading={busy} disabled={busy || !dirty} onClick={() => void save()}>
                                Save the app
                            </Button>
                        </div>
                    )}
                </>
            )}
        </section>
    );
}

/** The Crowd4Test project this one belongs to (US-011). For reference only: the link gives nobody access (decision D-27). */
function C4tLink({ id, project, canEdit, onSaved }: { id: string; project: ProjectDetail; canEdit: boolean; onSaved: () => Promise<void> }) {
    const options = useFetch<{ available: boolean; projects: C4tProjectRow[]; message?: string }>(canEdit && project.organization_id ? `/projects/${id}/c4t-projects` : null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const linked = project.c4tProject ?? null;
    const set = async (c4tProjectId: string | null) => {
        setBusy(true);
        setError(null);
        try {
            await api(`/projects/${id}`, { method: "PATCH", body: { c4tProjectId } });
            await onSaved();
        } catch (e) {
            setError(e instanceof ApiError ? e.message : "The link was not saved. Try again.");
        } finally {
            setBusy(false);
        }
    };
    return (
        <section className="card card-pad stack-sm" aria-labelledby="c4t-link-title" data-testid="project-c4t-link">
            <h2 className="t-section" id="c4t-link-title">
                Crowd4Test project
            </h2>
            <p className="t-secondary">For reference: which crowd-testing project of the same organisation this one belongs to. Linking gives nobody access.</p>
            {linked ? (
                <p>
                    Linked to <strong>{linked.reference ?? linked.id}</strong>
                    {linked.title ? `, ${linked.title}` : ""}.
                </p>
            ) : (
                <p className="t-meta">Not linked.</p>
            )}
            {!project.organization_id ? (
                <p className="t-meta">Only a project that belongs to an organisation can be linked.</p>
            ) : !canEdit ? null : options.error ? (
                <Callout tone="warning">{options.error instanceof ApiError && options.error.status === 404 ? "Linking is not available on this server yet." : options.error.message}</Callout>
            ) : options.data && !options.data.available ? (
                <p className="t-meta">{options.data.message ?? "Linking is not available for this project."}</p>
            ) : (
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <select className="input" aria-label="Crowd4Test project" disabled={busy || options.loading} value={linked?.id ?? ""} onChange={(e) => void set(e.target.value || null)} style={{ maxWidth: 420 }}>
                        <option value="">Not linked</option>
                        {(options.data?.projects ?? []).map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.reference}, {c.title}
                            </option>
                        ))}
                    </select>
                </div>
            )}
            {error && <Callout tone="danger">{error}</Callout>}
        </section>
    );
}

interface DeleteReport {
    tests: number;
    runs: number;
    files: number;
    bytes: number;
    kept: string[];
}

/**
 * Archive, restore and delete (US-012). Archiving makes the project read-only, takes it out of the lists and stops its runs and
 * schedules; it can be restored. Only an archived project can be deleted, after typing its name: its data and stored files go,
 * AI usage and the Activity list stay. Each needs "Change project settings" and Project Admin of this project.
 */
function ArchiveOrDelete({ id, project, onChanged }: { id: string; project: ProjectDetail; onChanged: () => Promise<void> }) {
    const archived = Boolean(project.archived_at);
    const canAct = !project.access || (project.access.projectAdmin && project.access.permissions.includes("ai_studio.project.settings"));
    const [confirmArchive, setConfirmArchive] = useState(false);
    const [typed, setTyped] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [deleted, setDeleted] = useState<DeleteReport | null>(null);

    const act = async (fn: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        try {
            await fn();
        } catch (e) {
            setError(e instanceof ApiError ? e.message : "That did not work. Try again.");
        } finally {
            setBusy(false);
        }
    };
    const archive = () =>
        act(async () => {
            await api(`/projects/${id}/archive`, { method: "POST" });
            setConfirmArchive(false);
            announceProjectChanged(id);
            await onChanged();
        });
    const restore = () =>
        act(async () => {
            await api(`/projects/${id}/unarchive`, { method: "POST" });
            announceProjectChanged(id);
            await onChanged();
        });
    const remove = () =>
        act(async () => {
            const r = await api<{ deleted: boolean; report: DeleteReport }>(`/projects/${id}`, { method: "DELETE", body: { name: typed } });
            setDeleted(r.report);
        });

    if (deleted) {
        return (
            <section className="card card-pad stack-sm" aria-labelledby="archive-title" data-testid="project-archive">
                <h2 className="t-section" id="archive-title">
                    Project deleted
                </h2>
                <Callout tone="success" title={`${project.name} was deleted.`}>
                    Removed {deleted.tests === 1 ? "1 test" : `${deleted.tests} tests`}, {deleted.runs === 1 ? "1 run" : `${deleted.runs} runs`} and {deleted.files === 1 ? "1 stored file" : `${deleted.files} stored files`} ({formatBytes(deleted.bytes)}), with its settings and results. Its AI usage and the Activity list are kept.
                </Callout>
                <div>
                    <LinkButton href={routes.home}>Back to projects</LinkButton>
                </div>
            </section>
        );
    }

    return (
        <section className="card card-pad stack-sm" aria-labelledby="archive-title" data-testid="project-archive">
            <h2 className="t-section" id="archive-title">
                Archive or delete
            </h2>
            {!archived ? (
                <>
                    <p className="t-secondary">Archiving makes the project read-only and takes it out of the project lists. Its schedules and deploy triggers stop starting runs. You can restore it at any time.</p>
                    {!canAct ? (
                        <p className="t-meta">Only a Project Admin with “Change project settings” can archive or delete this project.</p>
                    ) : confirmArchive ? (
                        <Callout
                            tone="warning"
                            title={`Archive ${project.name}?`}
                            actions={
                                <>
                                    <Button size="sm" variant="primary" icon={Archive} loading={busy} onClick={() => void archive()}>
                                        Archive
                                    </Button>
                                    <Button size="sm" variant="ghost" onClick={() => setConfirmArchive(false)}>
                                        Cancel
                                    </Button>
                                </>
                            }
                        >
                            Nobody can change it or run its tests until it is restored. Everything in it stays.
                        </Callout>
                    ) : (
                        <div>
                            <Button icon={Archive} onClick={() => setConfirmArchive(true)}>
                                Archive project
                            </Button>
                        </div>
                    )}
                    <p className="t-meta">To delete the project, archive it first.</p>
                </>
            ) : (
                <>
                    <Callout tone="info" title="This project is archived">
                        It is read-only, left out of the project lists, and starts no runs. Restore it to work on it again.
                    </Callout>
                    {canAct ? (
                        <>
                            <div>
                                <Button icon={ArchiveRestore} loading={busy} onClick={() => void restore()}>
                                    Restore project
                                </Button>
                            </div>
                            <div className="stack-sm" style={{ borderTop: "1px solid var(--border-default)", paddingTop: 16 }}>
                                <h3 className="t-card">Delete for good</h3>
                                <p className="t-secondary">
                                    Deleting removes the project with its tests, scripts, runs and results, settings, test accounts and every stored file (screenshots, videos, traces, apps). Its AI usage and the Activity list are kept. This cannot be undone.
                                </p>
                                <div className="field" style={{ maxWidth: 420 }}>
                                    <label htmlFor="delete-confirm">
                                        Type <strong>{project.name}</strong> to confirm
                                    </label>
                                    <input id="delete-confirm" className="input" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
                                </div>
                                <div>
                                    <Button variant="danger" icon={Trash2} loading={busy} disabled={busy || typed.trim() !== project.name.trim()} onClick={() => void remove()}>
                                        Delete project
                                    </Button>
                                </div>
                            </div>
                        </>
                    ) : (
                        <p className="t-meta">Only a Project Admin with “Change project settings” can restore or delete this project.</p>
                    )}
                </>
            )}
            {error && <Callout tone="danger">{error}</Callout>}
        </section>
    );
}
