import { ChevronRight, FolderInput, FolderMinus, FolderOpen, FolderPlus, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { ApiError, api, type ProjectRow } from "../../api";
import { usePage } from "../../components/Shell";
import { Badge, Button, Callout, EmptyState, ErrorState, ListSkeleton, PageHeader } from "../../components/ui";
import { useDocumentTitle, useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { routes } from "../../lib/router";

export interface FolderRow {
    id: string;
    name: string;
    organizationId: string | null;
    organizationName: string | null;
    canManage: boolean;
    projects: Array<{ id: string; name: string; archived: boolean }>;
    archivedCount: number;
}
export interface FoldersAnswer {
    folders: FolderRow[];
    canCreate: boolean;
    organizations: Array<{ id: string | null; name: string | null }>;
}

const orgWords = (o: { id: string | null; name: string | null }) => (o.id === null ? "No organisation" : (o.name ?? o.id));
const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/**
 * Folders (NAV-02): projects grouped inside an organisation, for example by client or product line. A project is in at most one
 * folder. People who create projects make, rename and remove folders and move projects in and out; everyone else sees the folders
 * that hold a project they can open. Removing a folder never removes a project.
 */
export function FoldersPage() {
    useDocumentTitle("Folders");
    usePage({ crumbs: [{ label: "Folders" }], nav: "folders" });
    const folders = useFetch<FoldersAnswer>("/folders");
    const projects = useFetch<ProjectRow[]>("/projects");
    const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    const reload = async () => {
        await Promise.all([folders.reload(), projects.reload()]);
    };
    const data = folders.data;
    const multiOrg = (data?.organizations.length ?? 0) > 1 || new Set((data?.folders ?? []).map((f) => f.organizationId)).size > 1;
    const loose = (projects.data ?? []).filter((p) => !p.folder_id);

    return (
        <>
            <PageHeader title="Folders" subtitle="Group your organisation's projects, for example by client or product line. A project is in one folder at most." />
            <div className="stack">
                {folders.loading || projects.loading ? (
                    <ListSkeleton rows={3} />
                ) : folders.error || !data ? (
                    <ErrorState error={friendlyError(folders.error?.message ?? "")} onRetry={folders.reload} />
                ) : (
                    <>
                        {note && <Callout tone={note.tone}>{note.text}</Callout>}
                        {data.canCreate && <NewFolder organizations={data.organizations} onDone={reload} onNote={setNote} />}
                        {data.folders.length === 0 ? (
                            <div className="card">
                                <EmptyState icon={FolderOpen} title="No folders yet">
                                    {data.canCreate ? "Make a folder, then move projects into it." : "None of your projects is in a folder. People who create projects can make folders."}
                                </EmptyState>
                            </div>
                        ) : (
                            data.folders.map((f) => <FolderCard key={f.id} folder={f} showOrg={multiOrg} projects={projects.data ?? []} onDone={reload} onNote={setNote} />)
                        )}
                        {loose.length > 0 && (
                            <section className="stack-sm" aria-labelledby="loose-projects">
                                <h2 className="t-section" id="loose-projects">
                                    Not in a folder
                                </h2>
                                <ul className="card list divided">
                                    {loose.map((p) => (
                                        <li key={p.id}>
                                            <a className="list-row" href={routes.project(p.id)}>
                                                <span className="main">
                                                    <span className="title truncate">{p.name}</span>
                                                </span>
                                                <ChevronRight size={18} className="chev" aria-hidden />
                                            </a>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        )}
                    </>
                )}
            </div>
        </>
    );
}

function NewFolder({ organizations, onDone, onNote }: { organizations: FoldersAnswer["organizations"]; onDone: () => Promise<void>; onNote: (n: { tone: "success" | "danger"; text: string } | null) => void }) {
    const [name, setName] = useState("");
    const [org, setOrg] = useState<string>(organizations[0]?.id ?? "");
    const [busy, setBusy] = useState(false);
    const create = async () => {
        if (!name.trim()) return onNote({ tone: "danger", text: "Give the folder a name." });
        setBusy(true);
        onNote(null);
        try {
            await api("/folders", { method: "POST", body: { name: name.trim(), ...(organizations.length ? { organizationId: org || null } : {}) } });
            onNote({ tone: "success", text: `Folder “${name.trim()}” made.` });
            setName("");
            await onDone();
        } catch (e) {
            onNote({ tone: "danger", text: message(e, "The folder was not made. Try again.") });
        } finally {
            setBusy(false);
        }
    };
    return (
        <section className="card card-pad stack-sm" aria-labelledby="new-folder-title" data-testid="new-folder">
            <h2 className="t-section" id="new-folder-title">
                New folder
            </h2>
            <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                <div className="field" style={{ flex: "1 1 220px" }}>
                    <label htmlFor="folder-name">Folder name</label>
                    <input id="folder-name" className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void create()} />
                </div>
                {organizations.length > 1 && (
                    <div className="field" style={{ flex: "1 1 200px" }}>
                        <label htmlFor="folder-org">Organisation</label>
                        <select id="folder-org" className="input" value={org} onChange={(e) => setOrg(e.target.value)}>
                            {organizations.map((o) => (
                                <option key={o.id ?? ""} value={o.id ?? ""}>
                                    {orgWords(o)}
                                </option>
                            ))}
                        </select>
                    </div>
                )}
                <Button variant="primary" icon={FolderPlus} loading={busy} disabled={busy} onClick={() => void create()}>
                    Make folder
                </Button>
            </div>
        </section>
    );
}

function FolderCard({ folder, showOrg, projects, onDone, onNote }: { folder: FolderRow; showOrg: boolean; projects: ProjectRow[]; onDone: () => Promise<void>; onNote: (n: { tone: "success" | "danger"; text: string } | null) => void }) {
    const [renaming, setRenaming] = useState(false);
    const [name, setName] = useState(folder.name);
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const run = async (fn: () => Promise<unknown>, done: string, failed: string) => {
        setBusy(true);
        onNote(null);
        try {
            await fn();
            onNote({ tone: "success", text: done });
            await onDone();
        } catch (e) {
            onNote({ tone: "danger", text: message(e, failed) });
        } finally {
            setBusy(false);
        }
    };
    // Projects that can go in: of the folder's organisation and not in it already (a project in another folder moves from there).
    const candidates = projects.filter((p) => (p.organization_id ?? null) === folder.organizationId && p.folder_id !== folder.id);
    const titleId = `folder-${folder.id}`;
    return (
        <section className="card card-pad stack-sm" aria-labelledby={titleId} data-testid="folder">
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                {renaming ? (
                    <>
                        <label className="sr-only" htmlFor={`${titleId}-name`}>
                            New name for {folder.name}
                        </label>
                        <input id={`${titleId}-name`} className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 320 }} />
                        <Button size="sm" variant="primary" loading={busy} onClick={() => void run(() => api(`/folders/${folder.id}`, { method: "PATCH", body: { name: name.trim() } }).then(() => setRenaming(false)), `Folder renamed to “${name.trim()}”.`, "The folder was not renamed. Try again.")}>
                            Save name
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => (setRenaming(false), setName(folder.name))}>
                            Cancel
                        </Button>
                    </>
                ) : (
                    <h2 className="t-section" id={titleId}>
                        {folder.name}
                    </h2>
                )}
                {showOrg && <span className="t-meta">{folder.organizationId ? (folder.organizationName ?? folder.organizationId) : "No organisation"}</span>}
                <span className="spacer" />
                {folder.canManage && !renaming && (
                    <>
                        <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setRenaming(true)}>
                            Rename
                        </Button>
                        <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirming(true)}>
                            Remove folder
                        </Button>
                    </>
                )}
            </div>
            {confirming && (
                <Callout
                    tone="warning"
                    title={`Remove the folder “${folder.name}”?`}
                    actions={
                        <>
                            <Button size="sm" variant="danger" loading={busy} onClick={() => void run(() => api(`/folders/${folder.id}`, { method: "DELETE" }), `Folder “${folder.name}” removed. Its projects are still in Projects.`, "The folder was not removed. Try again.")}>
                                Remove
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                                Keep it
                            </Button>
                        </>
                    }
                >
                    Its projects stay; they are just no longer in a folder.
                </Callout>
            )}
            {folder.projects.length === 0 ? (
                <p className="t-meta">No projects in this folder{folder.archivedCount ? ` (${folder.archivedCount} archived)` : ""}.</p>
            ) : (
                <ul className="list divided" aria-label={`Projects in ${folder.name}`}>
                    {folder.projects.map((p) => (
                        <li key={p.id} className="list-row" style={{ padding: "10px 0" }}>
                            <span className="main">
                                <a className="title truncate" href={routes.project(p.id)}>
                                    {p.name}
                                </a>
                            </span>
                            {p.archived && <Badge>Archived</Badge>}
                            {folder.canManage && (
                                <Button size="sm" variant="ghost" icon={FolderMinus} disabled={busy} onClick={() => void run(() => api(`/projects/${p.id}/folder`, { method: "PUT", body: { folderId: null } }), `${p.name} moved out of “${folder.name}”.`, "The project was not moved. Try again.")}>
                                    Move out
                                </Button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {folder.projects.length > 0 && folder.archivedCount > 0 && <p className="t-meta">And {folder.archivedCount} archived.</p>}
            {folder.canManage && candidates.length > 0 && (
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <FolderInput size={16} aria-hidden />
                    <select
                        className="input"
                        aria-label={`Move a project into ${folder.name}`}
                        value=""
                        disabled={busy}
                        style={{ maxWidth: 360 }}
                        onChange={(e) => {
                            const p = candidates.find((c) => c.id === e.target.value);
                            if (p) void run(() => api(`/projects/${p.id}/folder`, { method: "PUT", body: { folderId: folder.id } }), `${p.name} moved into “${folder.name}”.`, "The project was not moved. Try again.");
                        }}
                    >
                        <option value="">Move a project here…</option>
                        {candidates.map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.name}
                                {c.folder_id ? " (from another folder)" : ""}
                            </option>
                        ))}
                    </select>
                </div>
            )}
        </section>
    );
}
