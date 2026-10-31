import { Save } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, MODE_WORDS, PLATFORM_WORDS, api, projectShape, type Platform, type ProjectDetail, type TestingMode } from "../../api";
import { Planned } from "../../components/Planned";
import { Button, Callout, ErrorState, Skeleton } from "../../components/ui";
import { announceProjectChanged, useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";

interface C4tProjectRow {
    id: string;
    reference: string;
    title: string;
    status: string;
}

/**
 * Project Settings → General (stories US-010, US-011): the name, what the project tests (platforms) and how (testing modes), the
 * organisation, and the Crowd4Test project it belongs to. Turning a platform or mode off only hides it: tests already made stay.
 * Changing anything needs "Change project settings"; without it the values are shown read-only.
 */
export function ProjectGeneral({ id }: { id: string }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const p = project.data;
    const canEdit = !p?.access || p.access.permissions.includes("ai_studio.project.settings");
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [platforms, setPlatforms] = useState<Platform[]>([]);
    const [modes, setModes] = useState<TestingMode[]>([]);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

    useEffect(() => {
        if (!p) return;
        const shape = projectShape(p);
        setName(p.name);
        setDescription((p as { description?: string | null }).description ?? "");
        setPlatforms(shape.platforms);
        setModes(shape.testingModes);
    }, [p]);

    if (project.loading) return <Skeleton h={220} />;
    if (project.error || !p) return <ErrorState error={friendlyError(project.error?.message ?? "Project not found")} onRetry={project.reload} />;

    const shape = projectShape(p);
    const changed = name.trim() !== p.name || description.trim() !== ((p as { description?: string | null }).description ?? "") || platforms.join() !== shape.platforms.join() || modes.join() !== shape.testingModes.join();
    const toggle = <T extends string>(list: T[], value: T, set: (l: T[]) => void) => set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

    const save = async () => {
        if (!name.trim()) return setNote({ tone: "danger", text: "Give the project a name." });
        if (platforms.length === 0) return setNote({ tone: "danger", text: "Choose at least one platform." });
        if (modes.length === 0) return setNote({ tone: "danger", text: "Choose at least one testing mode." });
        setBusy(true);
        setNote(null);
        try {
            await api(`/projects/${id}`, { method: "PATCH", body: { name: name.trim(), description: description.trim(), platforms, testingModes: modes } });
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
                    <legend className="t-card">Platforms</legend>
                    {(Object.keys(PLATFORM_WORDS) as Platform[]).map((pl) => (
                        <label key={pl} className="check">
                            <input type="checkbox" disabled={!canEdit} checked={platforms.includes(pl)} onChange={() => toggle(platforms, pl, setPlatforms)} />
                            <span>{PLATFORM_WORDS[pl]}</span>
                        </label>
                    ))}
                </fieldset>
                <fieldset className="choice-group stack-sm">
                    <legend className="t-card">Testing modes</legend>
                    {(Object.keys(MODE_WORDS) as TestingMode[]).map((m) => (
                        <label key={m} className="check">
                            <input type="checkbox" disabled={!canEdit} checked={modes.includes(m)} onChange={() => toggle(modes, m, setModes)} />
                            <span>{MODE_WORDS[m]}</span>
                        </label>
                    ))}
                </fieldset>
                <p className="t-meta">
                    Engines: {p.codeEngines ? [p.codeEngines.web && "Playwright for web", p.codeEngines.mobile && "Taqwright for phone apps"].filter(Boolean).join(", ") : "Playwright for web"}. Turning a platform or mode off only hides it; tests already made stay.
                </p>
                {note && <Callout tone={note.tone}>{note.text}</Callout>}
                {canEdit ? (
                    <div>
                        <Button variant="primary" icon={Save} loading={busy} disabled={busy || !changed} onClick={() => void save()}>
                            Save changes
                        </Button>
                    </div>
                ) : (
                    <p className="t-meta">Changing these needs “Change project settings”. Ask your Crowd4Test administrator.</p>
                )}
            </section>
            <C4tLink id={id} project={p} canEdit={canEdit} onSaved={project.reload} />
            <Planned title="Archive or delete" phase="Phase 1, next" testId="planned-project-archive" will={["Archive the project: it becomes read-only and leaves the lists, and can be restored.", "Delete it after typing its name, with its files."]} />
        </div>
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
