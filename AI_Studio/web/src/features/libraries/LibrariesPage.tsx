import { ChevronRight, FileCode, Folder, FolderOpen, FolderPlus, Library, MousePointerClick, Pencil, Plus, Trash2, Workflow } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ApiError, api } from "../../api";
import { usePage } from "../../components/Shell";
import { Badge, Button, Callout, EmptyState, ErrorState, ListSkeleton, PageHeader } from "../../components/ui";
import { useDocumentTitle, useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { go, routes, useRoute } from "../../lib/router";
import { COMMON_ROLES, STRATEGIES, type Strategy } from "../objects/objects";
import { folderPath, folderTree, KIND_LABEL, orgParam, plural, type ItemDetail, type ItemKind, type LibraryAnswer, type LibraryFolder } from "./libraries";
import "./libraries.css";

type Note = { tone: "success" | "danger"; text: string } | null;
const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const KIND_ICON = { steps: Workflow, helper: FileCode, element: MousePointerClick } as const;

/** A link into the library page: an organisation, a folder (null: the top level) and an open item. */
export function libraryHref(o: { org?: string | null; folder?: string | null; item?: string | null }): string {
    const q = new URLSearchParams();
    if (o.org !== undefined) q.set("org", orgParam(o.org));
    if (o.folder) q.set("folder", o.folder);
    if (o.item) q.set("item", o.item);
    const s = q.toString();
    return `${routes.libraries}${s ? `?${s}` : ""}`;
}

/**
 * Reusable libraries: an organisation's reusable steps, helpers and shared elements, in nested folders. Projects take a copy of an
 * item and choose when to update it; a project's own item can be offered back as a new version (from its Test scripts).
 */
export function LibrariesPage() {
    useDocumentTitle("Reusable libraries");
    usePage({ crumbs: [{ label: "Reusable libraries" }], nav: "libraries" });
    const q = useRoute().query;
    const orgQ = q.get("org");
    const folderId = q.get("folder");
    const itemId = q.get("item");
    const lib = useFetch<LibraryAnswer>(`/libraries${orgQ ? `?organization=${encodeURIComponent(orgQ)}` : ""}`);
    const [note, setNote] = useState<Note>(null);
    const data = lib.data;
    const org = data?.organization?.id ?? null;
    const folders = data?.folders ?? [];
    const current = folderId ? folders.find((f) => f.id === folderId) : undefined;

    return (
        <>
            <PageHeader title="Reusable libraries" subtitle="Reusable steps, helpers and shared elements that your organisation's projects share. A project takes a copy and chooses when to update it." />
            <div className="stack">
                {lib.loading ? (
                    <ListSkeleton rows={4} />
                ) : lib.error || !data ? (
                    <ErrorState error={friendlyError(lib.error?.message ?? "")} onRetry={lib.reload} />
                ) : !data.organization ? (
                    <div className="card">
                        <EmptyState icon={Library} title="No library to show">
                            A library belongs to an organisation. You will see it once you work on one of its projects.
                        </EmptyState>
                    </div>
                ) : (
                    <>
                        {data.organizations.length > 1 && (
                            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                                <label htmlFor="library-org" className="t-meta">
                                    Organisation
                                </label>
                                <select id="library-org" className="input" style={{ maxWidth: 320 }} value={orgParam(org)} onChange={(e) => go(`${routes.libraries}?org=${encodeURIComponent(e.target.value)}`)}>
                                    {data.organizations.map((o) => (
                                        <option key={orgParam(o.id)} value={orgParam(o.id)}>
                                            {o.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}
                        {!data.canChange && <Callout tone="info">You can read this library and add its items to your projects. Changing it needs “write tests” for the whole organisation.</Callout>}
                        {note && <Callout tone={note.tone}>{note.text}</Callout>}
                        <div className="lib-layout">
                            <FolderTree data={data} folderId={current?.id ?? null} />
                            <div className="stack">
                                {itemId ? (
                                    <ItemPanel key={itemId} itemId={itemId} data={data} onNote={setNote} onChanged={lib.reload} />
                                ) : (
                                    <FolderPanel key={current?.id ?? "top"} data={data} folder={current ?? null} onNote={setNote} onChanged={lib.reload} />
                                )}
                            </div>
                        </div>
                    </>
                )}
            </div>
        </>
    );
}

function FolderTree({ data, folderId }: { data: LibraryAnswer; folderId: string | null }) {
    const org = data.organization!.id;
    const count = (id: string | null) => data.items.filter((i) => i.folderId === id).length;
    return (
        <nav className="card lib-tree" aria-label="Library folders">
            <a className={`lib-tree-row${folderId === null ? " active" : ""}`} href={libraryHref({ org })} aria-current={folderId === null ? "page" : undefined}>
                <Library size={16} aria-hidden />
                <span className="truncate">{data.organization!.name}</span>
                <span className="t-meta">{count(null) || ""}</span>
            </a>
            {folderTree(data.folders).map((f) => (
                <a key={f.id} className={`lib-tree-row${folderId === f.id ? " active" : ""}`} style={{ paddingLeft: `calc(var(--space-3) + ${f.depth + 1} * var(--space-4))` }} href={libraryHref({ org, folder: f.id })} aria-current={folderId === f.id ? "page" : undefined}>
                    {folderId === f.id ? <FolderOpen size={16} aria-hidden /> : <Folder size={16} aria-hidden />}
                    <span className="truncate">{f.name}</span>
                    <span className="t-meta">{count(f.id) || ""}</span>
                </a>
            ))}
        </nav>
    );
}

/** A busy flag and a runner that shows the outcome and reloads. */
function useAct(onNote: (n: Note) => void, onChanged: () => Promise<void> | void) {
    const [busy, setBusy] = useState(false);
    const act = async (fn: () => Promise<unknown>, done: string, failed: string): Promise<boolean> => {
        setBusy(true);
        onNote(null);
        try {
            await fn();
            onNote({ tone: "success", text: done });
            await onChanged();
            return true;
        } catch (e) {
            onNote({ tone: "danger", text: message(e, failed) });
            return false;
        } finally {
            setBusy(false);
        }
    };
    return { busy, act };
}

/** Folders a folder (or an item, `self` undefined) can move into: the same library, never itself or what is inside it. */
function moveTargets(folders: LibraryFolder[], self?: string): Array<{ id: string | null; label: string }> {
    const inside = (id: string | null): boolean => {
        for (let f = id ? folders.find((x) => x.id === id) : undefined, n = 0; f && n < 10; f = f.parentId ? folders.find((x) => x.id === f!.parentId) : undefined, n++) if (f.id === self) return true;
        return false;
    };
    return [{ id: null, label: "Top level" }, ...folderTree(folders).filter((f) => !self || !inside(f.id)).map((f) => ({ id: f.id, label: `${"— ".repeat(f.depth)}${f.name}` }))];
}

function FolderPanel({ data, folder, onNote, onChanged }: { data: LibraryAnswer; folder: LibraryFolder | null; onNote: (n: Note) => void; onChanged: () => Promise<void> }) {
    const org = data.organization!.id;
    const { busy, act } = useAct(onNote, onChanged);
    const [mode, setMode] = useState<"none" | "new-folder" | "rename" | "move" | "delete" | "new-item">("none");
    const [name, setName] = useState("");
    const subfolders = data.folders.filter((f) => f.parentId === (folder?.id ?? null)).sort((a, b) => a.name.localeCompare(b.name));
    const items = data.items.filter((i) => i.folderId === (folder?.id ?? null));
    const title = folder ? folder.name : data.organization!.name;
    return (
        <section className="card card-pad stack-sm" aria-labelledby="lib-folder-title" data-testid="library-folder">
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <div className="lib-head">
                    <h2 className="t-section" id="lib-folder-title">
                        {title}
                    </h2>
                    {folder && <span className="t-meta">{folderPath(data.folders, folder.id)}</span>}
                </div>
                <span className="spacer" />
                {data.canChange && (
                    <>
                        <Button size="sm" variant="ghost" icon={FolderPlus} onClick={() => (setMode("new-folder"), setName(""))}>
                            New folder
                        </Button>
                        <Button size="sm" variant="ghost" icon={Plus} onClick={() => setMode("new-item")}>
                            Add item
                        </Button>
                        {folder && (
                            <>
                                <Button size="sm" variant="ghost" icon={Pencil} onClick={() => (setMode("rename"), setName(folder.name))}>
                                    Rename
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setMode("move")}>
                                    Move
                                </Button>
                                <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setMode("delete")}>
                                    Delete folder
                                </Button>
                            </>
                        )}
                    </>
                )}
            </div>
            {(mode === "new-folder" || mode === "rename") && (
                <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                    <div className="field" style={{ flex: "1 1 220px" }}>
                        <label htmlFor="lib-folder-name">{mode === "rename" ? "New name" : "Folder name"}</label>
                        <input id="lib-folder-name" className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
                    </div>
                    <Button
                        variant="primary"
                        loading={busy}
                        onClick={() =>
                            void act(
                                () => (mode === "rename" ? api(`/libraries/folders/${folder!.id}`, { method: "PATCH", body: { name: name.trim() } }) : api("/libraries/folders", { method: "POST", body: { organizationId: org, parentId: folder?.id ?? null, name: name.trim() } })),
                                mode === "rename" ? `Folder renamed to “${name.trim()}”.` : `Folder “${name.trim()}” made.`,
                                "The folder was not saved. Try again.",
                            ).then((ok) => ok && setMode("none"))
                        }
                    >
                        {mode === "rename" ? "Save name" : "Make folder"}
                    </Button>
                    <Button variant="ghost" onClick={() => setMode("none")}>
                        Cancel
                    </Button>
                </div>
            )}
            {mode === "move" && folder && (
                <MovePicker
                    label={`Move “${folder.name}” into`}
                    targets={moveTargets(data.folders, folder.id)}
                    current={folder.parentId}
                    busy={busy}
                    onCancel={() => setMode("none")}
                    onMove={(to) => void act(() => api(`/libraries/folders/${folder.id}`, { method: "PATCH", body: { parentId: to } }), `Folder “${folder.name}” moved.`, "The folder was not moved. Try again.").then((ok) => ok && setMode("none"))}
                />
            )}
            {mode === "delete" && folder && (
                <Callout
                    tone="warning"
                    title={`Delete the folder “${folder.name}”?`}
                    actions={
                        <>
                            <Button size="sm" variant="danger" loading={busy} onClick={() => void act(() => api(`/libraries/folders/${folder.id}`, { method: "DELETE" }), `Folder “${folder.name}” deleted.`, "The folder was not deleted. Try again.").then((ok) => ok && go(libraryHref({ org, folder: folder.parentId })))}>
                                Delete
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setMode("none")}>
                                Keep it
                            </Button>
                        </>
                    }
                >
                    Only an empty folder can be deleted. Move or delete what is in it first.
                </Callout>
            )}
            {mode === "new-item" && <NewItem org={org} folderId={folder?.id ?? null} onDone={async (id) => (setMode("none"), await onChanged(), go(libraryHref({ org, folder: folder?.id ?? null, item: id })))} onCancel={() => setMode("none")} onNote={onNote} />}
            {subfolders.length === 0 && items.length === 0 ? (
                <EmptyState icon={FolderOpen} title={folder ? "This folder is empty" : "Nothing in the library yet"}>
                    {data.canChange ? "Add a helper or a shared element here, or publish reusable steps from a project: open its Test scripts, then Reusable libraries." : "People who write tests for the whole organisation fill the library."}
                </EmptyState>
            ) : (
                <ul className="list divided" aria-label={`In ${title}`}>
                    {subfolders.map((f) => (
                        <li key={f.id}>
                            <a className="list-row" href={libraryHref({ org, folder: f.id })}>
                                <Folder size={18} aria-hidden />
                                <span className="main">
                                    <span className="title truncate">{f.name}</span>
                                    <span className="meta">Folder</span>
                                </span>
                                <ChevronRight size={18} className="chev" aria-hidden />
                            </a>
                        </li>
                    ))}
                    {items.map((i) => {
                        const Icon = KIND_ICON[i.kind];
                        return (
                            <li key={i.id}>
                                <a className="list-row" href={libraryHref({ org, folder: folder?.id ?? null, item: i.id })} data-testid="library-item">
                                    <Icon size={18} aria-hidden />
                                    <span className="main">
                                        <span className="title truncate">{i.name}</span>
                                        <span className="meta">
                                            {KIND_LABEL[i.kind]} · version {i.version} · {i.usedBy === 0 ? "No project uses it yet" : `Used by ${plural(i.usedBy, "project")}`}
                                        </span>
                                    </span>
                                    <ChevronRight size={18} className="chev" aria-hidden />
                                </a>
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}

function MovePicker({ label, targets, current, busy, onMove, onCancel }: { label: string; targets: Array<{ id: string | null; label: string }>; current: string | null; busy: boolean; onMove: (to: string | null) => void; onCancel: () => void }) {
    const [to, setTo] = useState<string>(current ?? "");
    return (
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div className="field" style={{ flex: "1 1 240px" }}>
                <label htmlFor="lib-move-to">{label}</label>
                <select id="lib-move-to" className="input" value={to} onChange={(e) => setTo(e.target.value)}>
                    {targets.map((t) => (
                        <option key={t.id ?? ""} value={t.id ?? ""}>
                            {t.label}
                        </option>
                    ))}
                </select>
            </div>
            <Button variant="primary" loading={busy} onClick={() => onMove(to || null)}>
                Move here
            </Button>
            <Button variant="ghost" onClick={onCancel}>
                Cancel
            </Button>
        </div>
    );
}

/** The content editor of a helper or a shared element (reusable steps are built in a project, where they can be checked against the app). */
function ContentFields({ kind, value, onChange }: { kind: Exclude<ItemKind, "steps">; value: any; onChange: (v: any) => void }) {
    if (kind === "helper")
        return (
            <div className="field">
                <label htmlFor="lib-helper-code">Code</label>
                <textarea id="lib-helper-code" className="input mono" rows={10} spellCheck={false} value={value?.content ?? ""} onChange={(e) => onChange({ content: e.target.value })} />
            </div>
        );
    const l = value?.locator ?? { by: "role", role: "button", value: "" };
    const set = (patch: Record<string, unknown>) => onChange({ kind: value?.kind ?? "web", ...value, locator: { ...l, ...patch } });
    const strategy = STRATEGIES.find((s) => s.id === l.by) ?? STRATEGIES[0]!;
    return (
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div className="field" style={{ flex: "0 1 160px" }}>
                <label htmlFor="lib-el-kind">Used in</label>
                <select id="lib-el-kind" className="input" value={value?.kind ?? "web"} onChange={(e) => onChange({ ...value, kind: e.target.value, locator: l })}>
                    <option value="web">Web</option>
                    <option value="mobile">Mobile</option>
                    <option value="desktop">Desktop</option>
                </select>
            </div>
            <div className="field" style={{ flex: "0 1 180px" }}>
                <label htmlFor="lib-el-by">Find it by</label>
                <select id="lib-el-by" className="input" value={l.by} onChange={(e) => set({ by: e.target.value as Strategy, ...(e.target.value === "role" ? { role: l.role ?? "button" } : { role: undefined }) })}>
                    {STRATEGIES.map((s) => (
                        <option key={s.id} value={s.id}>
                            {s.label}
                        </option>
                    ))}
                </select>
            </div>
            {l.by === "role" && (
                <div className="field" style={{ flex: "0 1 160px" }}>
                    <label htmlFor="lib-el-role">Role</label>
                    <select id="lib-el-role" className="input" value={l.role ?? "button"} onChange={(e) => set({ role: e.target.value })}>
                        {COMMON_ROLES.map((r) => (
                            <option key={r} value={r}>
                                {r}
                            </option>
                        ))}
                    </select>
                </div>
            )}
            <div className="field" style={{ flex: "1 1 200px" }}>
                <label htmlFor="lib-el-value">{strategy.valueLabel}</label>
                <input id="lib-el-value" className="input" maxLength={500} value={l.value ?? ""} onChange={(e) => set({ value: e.target.value })} />
            </div>
        </div>
    );
}

function NewItem({ org, folderId, onDone, onCancel, onNote }: { org: string | null; folderId: string | null; onDone: (id: string) => Promise<void>; onCancel: () => void; onNote: (n: Note) => void }) {
    const [kind, setKind] = useState<Exclude<ItemKind, "steps">>("helper");
    const [name, setName] = useState("");
    const [content, setContent] = useState<any>({ content: "" });
    const [busy, setBusy] = useState(false);
    const save = async () => {
        setBusy(true);
        onNote(null);
        try {
            const made = await api<ItemDetail>("/libraries/items", { method: "POST", body: { organizationId: org, folderId, kind, name: name.trim(), content } });
            onNote({ tone: "success", text: `“${made.item.name}” added to the library as version 1.` });
            await onDone(made.item.id);
        } catch (e) {
            onNote({ tone: "danger", text: message(e, "It was not added. Try again.") });
        } finally {
            setBusy(false);
        }
    };
    return (
        <div className="lib-form stack-sm" data-testid="library-new-item">
            <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                <div className="field" style={{ flex: "0 1 200px" }}>
                    <label htmlFor="lib-new-kind">What</label>
                    <select id="lib-new-kind" className="input" value={kind} onChange={(e) => (setKind(e.target.value as "helper" | "element"), setContent(e.target.value === "helper" ? { content: "" } : { kind: "web", locator: { by: "role", role: "button", value: "" } }))}>
                        <option value="helper">{KIND_LABEL.helper}</option>
                        <option value="element">{KIND_LABEL.element}</option>
                    </select>
                </div>
                <div className="field" style={{ flex: "1 1 220px" }}>
                    <label htmlFor="lib-new-name">Name</label>
                    <input id="lib-new-name" className="input" maxLength={80} value={name} placeholder={kind === "helper" ? "open-checkout" : "Pay button"} onChange={(e) => setName(e.target.value)} />
                </div>
            </div>
            <ContentFields kind={kind} value={content} onChange={setContent} />
            <p className="t-meta">Reusable steps are built in a project, where they can be tried on the app: open the project's Test scripts, then Reusable libraries, and publish them.</p>
            <div className="row" style={{ gap: 8 }}>
                <Button variant="primary" icon={Plus} loading={busy} onClick={() => void save()}>
                    Add to library
                </Button>
                <Button variant="ghost" onClick={onCancel}>
                    Cancel
                </Button>
            </div>
        </div>
    );
}

/** The content of one version, in words a person reads. */
export function ContentView({ kind, content, stepsText }: { kind: ItemKind; content: any; stepsText?: string[] }): ReactNode {
    if (kind === "steps")
        return (
            <ol className="lib-steps" aria-label="Steps">
                {(stepsText ?? []).map((s, n) => (
                    <li key={n}>{s}</li>
                ))}
            </ol>
        );
    if (kind === "helper")
        return (
            <pre className="raw" aria-label="Helper code">
                {content?.content ?? ""}
            </pre>
        );
    const l = content?.locator ?? {};
    const by = STRATEGIES.find((s) => s.id === l.by)?.label ?? l.by;
    return (
        <p>
            {by}
            {l.role ? ` ${l.role}` : ""}
            {l.value ? <> “<span className="mono">{l.value}</span>”</> : null} · {content?.kind === "mobile" ? "Mobile" : content?.kind === "desktop" ? "Desktop" : "Web"}
        </p>
    );
}

function ItemPanel({ itemId, data, onNote, onChanged }: { itemId: string; data: LibraryAnswer; onNote: (n: Note) => void; onChanged: () => Promise<void> }) {
    const d = useFetch<ItemDetail>(`/libraries/items/${itemId}`);
    const org = data.organization!.id;
    const reload = async () => {
        await Promise.all([d.reload(), onChanged()]);
    };
    const { busy, act } = useAct(onNote, reload);
    const [mode, setMode] = useState<"none" | "rename" | "move" | "edit" | "delete">("none");
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [content, setContent] = useState<any>(null);
    const [versionNote, setVersionNote] = useState("");
    if (d.loading) return <ListSkeleton rows={3} />;
    if (d.error || !d.data) return <ErrorState error={friendlyError(d.error?.message ?? "")} onRetry={d.reload} />;
    const { item, versions, usedBy } = d.data;
    const can = d.data.canChange;
    const back = libraryHref({ org, folder: item.folderId });
    return (
        <section className="card card-pad stack" aria-labelledby="lib-item-title" data-testid="library-item-detail">
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <div className="lib-head">
                    <a className="t-meta" href={back}>
                        {item.folderId ? folderPath(data.folders, item.folderId) : data.organization!.name}
                    </a>
                    <h2 className="t-section" id="lib-item-title">
                        {item.name}
                    </h2>
                </div>
                <Badge>{KIND_LABEL[item.kind]}</Badge>
                <Badge tone="brand">Version {item.version}</Badge>
                <span className="spacer" />
                {can && (
                    <>
                        {item.kind !== "steps" && (
                            <Button size="sm" variant="ghost" icon={Pencil} onClick={() => (setMode("edit"), setContent(d.data!.content), setVersionNote(""))}>
                                New version
                            </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => (setMode("rename"), setName(item.name), setDescription(item.description))}>
                            Rename
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setMode("move")}>
                            Move
                        </Button>
                        <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setMode("delete")}>
                            Delete
                        </Button>
                    </>
                )}
            </div>
            {item.description && <p className="t-secondary">{item.description}</p>}
            {mode === "rename" && (
                <div className="stack-sm">
                    <div className="field">
                        <label htmlFor="lib-item-name">Name</label>
                        <input id="lib-item-name" className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
                    </div>
                    <div className="field">
                        <label htmlFor="lib-item-description">Description</label>
                        <input id="lib-item-description" className="input" maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
                    </div>
                    <p className="t-meta">Projects that took a copy keep the name they took it with.</p>
                    <div className="row" style={{ gap: 8 }}>
                        <Button variant="primary" loading={busy} onClick={() => void act(() => api(`/libraries/items/${item.id}`, { method: "PATCH", body: { name: name.trim(), description } }), "Saved.", "It was not saved. Try again.").then((ok) => ok && setMode("none"))}>
                            Save
                        </Button>
                        <Button variant="ghost" onClick={() => setMode("none")}>
                            Cancel
                        </Button>
                    </div>
                </div>
            )}
            {mode === "move" && (
                <MovePicker
                    label={`Move “${item.name}” into`}
                    targets={moveTargets(data.folders)}
                    current={item.folderId}
                    busy={busy}
                    onCancel={() => setMode("none")}
                    onMove={(to) => void act(() => api(`/libraries/items/${item.id}`, { method: "PATCH", body: { folderId: to } }), `“${item.name}” moved.`, "It was not moved. Try again.").then((ok) => ok && (setMode("none"), go(libraryHref({ org, folder: to, item: item.id }))))}
                />
            )}
            {mode === "delete" && (
                <Callout
                    tone="warning"
                    title={`Delete “${item.name}” from the library?`}
                    actions={
                        <>
                            <Button size="sm" variant="danger" loading={busy} onClick={() => void act(() => api(`/libraries/items/${item.id}`, { method: "DELETE" }), `“${item.name}” deleted from the library.`, "It was not deleted. Try again.").then((ok) => ok && go(back))}>
                                Delete
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setMode("none")}>
                                Keep it
                            </Button>
                        </>
                    }
                >
                    Its versions go with it. {usedBy.projects.length + usedBy.otherProjects > 0 ? `The ${plural(usedBy.projects.length + usedBy.otherProjects, "project")} that took a copy keep their copy.` : "No project uses it."}
                </Callout>
            )}
            {mode === "edit" && item.kind !== "steps" && (
                <div className="lib-form stack-sm">
                    <ContentFields kind={item.kind} value={content} onChange={setContent} />
                    <div className="field">
                        <label htmlFor="lib-version-note">What changed</label>
                        <input id="lib-version-note" className="input" maxLength={500} value={versionNote} onChange={(e) => setVersionNote(e.target.value)} />
                    </div>
                    <p className="t-meta">Projects that use it see that an update is available. Nothing changes in a project until someone there chooses Update.</p>
                    <div className="row" style={{ gap: 8 }}>
                        <Button
                            variant="primary"
                            loading={busy}
                            onClick={() =>
                                void act(
                                    () => api(`/libraries/items/${item.id}/content`, { method: "PUT", body: { content, note: versionNote, expectedVersion: item.version } }),
                                    "Saved as a new version.",
                                    "It was not saved. Try again.",
                                ).then((ok) => ok && setMode("none"))
                            }
                        >
                            Save version
                        </Button>
                        <Button variant="ghost" onClick={() => setMode("none")}>
                            Cancel
                        </Button>
                    </div>
                </div>
            )}
            <div className="stack-sm">
                <h3 className="t-card">Latest version</h3>
                <ContentView kind={item.kind} content={d.data.content} stepsText={d.data.stepsText} />
                {item.kind === "steps" && can && <p className="t-meta">To change these steps, change them in a project that uses them and publish them again from its Test scripts.</p>}
            </div>
            <div className="stack-sm">
                <h3 className="t-card">Used by</h3>
                {usedBy.projects.length === 0 && usedBy.otherProjects === 0 ? (
                    <p className="t-meta">No project uses it yet. Add it from a project's Test scripts, under Reusable libraries.</p>
                ) : (
                    <ul className="list divided" aria-label="Projects that use it">
                        {usedBy.projects.map((u) => (
                            <li key={u.projectId} className="list-row" style={{ padding: "8px 0" }}>
                                <span className="main">
                                    <a className="title truncate" href={routes.scripts(u.projectId, "library")}>
                                        {u.projectName}
                                    </a>
                                    <span className="meta">
                                        Has version {u.version}
                                        {u.localName !== item.name ? `, as “${u.localName}”` : ""}
                                    </span>
                                </span>
                                {u.updateAvailable && <Badge tone="warning">Update available</Badge>}
                            </li>
                        ))}
                        {usedBy.otherProjects > 0 && <li className="t-meta" style={{ padding: "8px 0" }}>And {plural(usedBy.otherProjects, "project")} you can't open.</li>}
                    </ul>
                )}
            </div>
            <div className="stack-sm">
                <h3 className="t-card">Versions</h3>
                <ol className="list divided" aria-label="Versions">
                    {versions.map((v) => (
                        <li key={v.version} className="list-row" style={{ padding: "8px 0" }}>
                            <span className="main">
                                <span className="title">
                                    Version {v.version}
                                    {v.note ? `: ${v.note}` : ""}
                                </span>
                                <span className="meta">
                                    {new Date(v.createdAt).toLocaleString()}
                                    {v.createdBy ? ` · ${v.createdBy}` : ""}
                                    {v.fromProject ? ` · published from ${v.fromProject.name ?? "a project you can't open"}` : ""}
                                </span>
                            </span>
                        </li>
                    ))}
                </ol>
            </div>
        </section>
    );
}
