import { Download, Library, RefreshCw, Upload } from "lucide-react";
import { useState } from "react";
import { ApiError, api } from "../../api";
import { Badge, Button, Callout, EmptyState, ErrorState, LinkButton, ListSkeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { useHere } from "../auth/project-access";
import { friendlyError } from "../../lib/labels";
import { libraryHref } from "./LibrariesPage";
import { folderPath, folderTree, KIND_LABEL, type ItemKind, type ProjectLibrary as Answer } from "./libraries";
import "./libraries.css";

type Note = { tone: "success" | "danger" | "warning"; text: string; replace?: string } | null;
const KINDS: ItemKind[] = ["steps", "element", "helper"];
const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/**
 * Test scripts → Reusable libraries: the organisation's library seen from one project. Add an item (the project gets its own copy),
 * update a copy when the library has a newer version (only when someone here chooses to), and publish this project's own reusable
 * steps, helpers and shared elements to the library.
 */
export function ProjectLibrary({ id }: { id: string }) {
    const lib = useFetch<Answer>(`/projects/${id}/library`);
    const [note, setNote] = useState<Note>(null);
    const [busy, setBusy] = useState("");
    // Taking an item, updating a copy and publishing one change this project's tests (ai_studio.tests.write here).
    const noWrite = useHere(id).why("ai_studio.tests.write");
    if (lib.loading) return <ListSkeleton rows={4} />;
    if (lib.error || !lib.data) return <ErrorState error={friendlyError(lib.error?.message ?? "")} onRetry={lib.reload} />;
    const data = lib.data;

    const run = async (key: string, fn: () => Promise<unknown>, done: string, failed: string) => {
        setBusy(key);
        setNote(null);
        try {
            await fn();
            setNote({ tone: "success", text: done });
            await lib.reload();
        } catch (e) {
            const changed = e instanceof ApiError && e.status === 409 && (e.details as { changedHere?: boolean } | undefined)?.changedHere;
            setNote({ tone: changed ? "warning" : "danger", text: message(e, failed), ...(changed ? { replace: key } : {}) });
        } finally {
            setBusy("");
        }
    };
    const update = (itemId: string, name: string, replaceLocalChanges = false) =>
        run(itemId, () => api(`/projects/${id}/library/update`, { method: "POST", body: { itemId, ...(replaceLocalChanges ? { replaceLocalChanges } : {}) } }), `“${name}” in this project is now the library's latest version. Tests that use it were checked again.`, "It was not updated. Try again.");

    return (
        <div className="stack">
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <p className="t-secondary" style={{ flex: "1 1 320px" }}>
                    {data.organization.name}'s library. Adding an item gives this project its own copy; a newer library version changes nothing here until you choose Update.
                </p>
                <LinkButton size="sm" variant="ghost" icon={Library} href={libraryHref({ org: data.organization.id })}>
                    Open the library
                </LinkButton>
            </div>
            {note && (
                <Callout
                    tone={note.tone}
                    actions={
                        note.replace ? (
                            <Button size="sm" variant="danger" loading={busy === note.replace} onClick={() => void update(note.replace!, data.items.find((i) => i.id === note.replace)?.name ?? "", true)}>
                                Update anyway
                            </Button>
                        ) : undefined
                    }
                >
                    {note.text}
                </Callout>
            )}
            <section className="card" aria-labelledby="lib-available">
                <h2 className="t-section card-pad" id="lib-available" style={{ paddingBottom: 0 }}>
                    In the library
                </h2>
                {data.items.length === 0 ? (
                    <EmptyState icon={Library} title="The library is empty">
                        {data.canPublish ? "Publish reusable steps, helpers or shared elements from this project below." : "People who write tests for the whole organisation fill the library."}
                    </EmptyState>
                ) : (
                    <ul className="list divided" aria-label="Library items">
                        {data.items.map((i) => {
                            const u = i.use;
                            return (
                                <li key={i.id} className="list-row" data-testid="project-library-item">
                                    <span className="main">
                                        <span className="title truncate">{i.name}</span>
                                        <span className="meta">
                                            {KIND_LABEL[i.kind]} · version {i.version}
                                            {i.folderId ? ` · ${folderPath(data.folders, i.folderId)}` : ""}
                                            {u && u.inProject ? ` · this project has version ${u.version}${u.localName !== i.name ? ` as “${u.localName}”` : ""}` : ""}
                                        </span>
                                    </span>
                                    {u?.changedHere && <Badge tone="info">Changed in this project</Badge>}
                                    {u && u.inProject && !u.updateAvailable && !u.changedHere && <Badge tone="success">Up to date</Badge>}
                                    {u && u.inProject && (u.updateAvailable || u.changedHere) && (
                                        <Button size="sm" variant={u.updateAvailable ? "primary" : "ghost"} icon={RefreshCw} loading={busy === i.id} disabled={Boolean(busy) || Boolean(noWrite)} tip={noWrite} onClick={() => void update(i.id, u.localName)}>
                                            {u.updateAvailable ? `Update to version ${i.version}` : "Take the library's version"}
                                        </Button>
                                    )}
                                    {(!u || !u.inProject) &&
                                        (i.nameTakenHere ? (
                                            <Badge tone="warning" tip="This project already has its own one with that name. Rename it, or publish it to the library as a new version.">
                                                Name taken here
                                            </Badge>
                                        ) : (
                                            <Button size="sm" icon={Download} loading={busy === i.id} disabled={Boolean(busy) || Boolean(noWrite)} tip={noWrite} onClick={() => void run(i.id, () => api(`/projects/${id}/library/use`, { method: "POST", body: { itemId: i.id } }), `“${i.name}” added to this project.`, "It was not added. Try again.")}>
                                                Add to project
                                            </Button>
                                        ))}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>
            {!noWrite && <Publish id={id} data={data} busy={busy} run={run} />}
        </div>
    );
}

function Publish({ id, data, busy, run }: { id: string; data: Answer; busy: string; run: (key: string, fn: () => Promise<unknown>, done: string, failed: string) => Promise<void> }) {
    const [folder, setFolder] = useState("");
    const rows = KINDS.flatMap((kind) => data.local[kind].map((l) => ({ kind, ...l })));
    return (
        <section className="card" aria-labelledby="lib-publish">
            <div className="card-pad stack-sm" style={{ paddingBottom: 0 }}>
                <h2 className="t-section" id="lib-publish">
                    Publish from this project
                </h2>
                <p className="t-meta">Offer this project's reusable steps, helpers and shared elements to the other projects of {data.organization.name}. Publishing adds a version; no project changes until it chooses to update.</p>
                {!data.canPublish && <Callout tone="info">Publishing needs “write tests” for the whole organisation. You can still add library items to this project.</Callout>}
                {data.canPublish && data.folders.length > 0 && (
                    <div className="field" style={{ maxWidth: 320 }}>
                        <label htmlFor="lib-publish-folder">Folder for new items</label>
                        <select id="lib-publish-folder" className="input" value={folder} onChange={(e) => setFolder(e.target.value)}>
                            <option value="">Top level</option>
                            {folderTree(data.folders).map((f) => (
                                <option key={f.id} value={f.id}>
                                    {`${"— ".repeat(f.depth)}${f.name}`}
                                </option>
                            ))}
                        </select>
                    </div>
                )}
            </div>
            {rows.length === 0 ? (
                <p className="card-pad t-meta">This project has no reusable steps, helpers or shared elements yet.</p>
            ) : (
                <ul className="list divided" aria-label="This project's items">
                    {rows.map((r) => {
                        const key = `${r.kind}/${r.name}`;
                        return (
                            <li key={key} className="list-row" data-testid="project-local-item">
                                <span className="main">
                                    <span className="title truncate">{r.name}</span>
                                    <span className="meta">
                                        {KIND_LABEL[r.kind]}
                                        {r.itemId ? " · in the library" : ""}
                                    </span>
                                </span>
                                {data.canPublish && (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        icon={Upload}
                                        loading={busy === key}
                                        disabled={Boolean(busy)}
                                        onClick={() =>
                                            void run(
                                                key,
                                                () => api(`/projects/${id}/library/publish`, { method: "POST", body: { kind: r.kind, name: r.name, ...(r.itemId ? { itemId: r.itemId } : { folderId: folder || null }) } }),
                                                r.itemId ? `This project's “${r.name}” is now the library's latest version.` : `“${r.name}” published to the library.`,
                                                "It was not published. Try again.",
                                            )
                                        }
                                    >
                                        {r.itemId ? "Publish as new version" : "Publish to library"}
                                    </Button>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}
