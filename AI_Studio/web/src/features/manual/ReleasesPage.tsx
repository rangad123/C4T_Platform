import { ChevronRight, ClipboardCheck, ListChecks, Plus } from "lucide-react";
import { useState } from "react";
import { api, type ProjectDetail } from "../../api";
import { usePage } from "../../components/Shell";
import { Badge, Button, Callout, EmptyState, ErrorState, LinkButton, ListSkeleton, PageHeader } from "../../components/ui";
import { plural, relativeTime } from "../../lib/format";
import { useDocumentTitle, useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { go, routes } from "../../lib/router";
import { ProjectTabs } from "../../pages/ProjectOverview";
import { apiMessage, DECISION_BADGE, type ReleaseSummary, type ReleaseView } from "./manual";
import { BadgeKey } from "../../components/Tooltip";
import "./manual.css";

interface Listing {
    releases: ReleaseSummary[];
    manualCases: number;
}

/** The Releases tab: every release of the project with its decision, and a way to open a new one. */
export function ReleasesPage({ id }: { id: string }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const list = useFetch<Listing>(`/projects/${id}/releases`);
    const [creating, setCreating] = useState(false);
    const name = project.data?.name;
    useDocumentTitle(name ? `Releases, ${name}` : "Releases");
    usePage({ crumbs: [{ label: "Projects", href: routes.home }, { label: name ?? "…", href: routes.project(id) }, { label: "Releases" }], nav: "projects" });

    const releases = list.data?.releases ?? [];
    const cases = list.data?.manualCases ?? 0;

    return (
        <>
            <PageHeader
                title="Releases"
                subtitle={
                    <>
                        Check a release against the automated results and your manual checks, then record who approved it.{" "}
                        <BadgeKey label="the release decisions" entries={releases.map((r) => ({ word: DECISION_BADGE[r.status].label, text: DECISION_BADGE[r.status].help }))} />
                    </>
                }
                actions={
                    <>
                        <LinkButton href={routes.manualCases(id)} icon={ListChecks}>
                            Manual cases{list.data ? ` (${cases})` : ""}
                        </LinkButton>
                        <Button variant="primary" icon={Plus} onClick={() => setCreating(true)} disabled={creating}>
                            New release
                        </Button>
                    </>
                }
            />
            <ProjectTabs id={id} active="runs" count={project.data?.test_count} />

            <div className="stack">
                {creating && <NewRelease projectId={id} onCancel={() => setCreating(false)} />}

                {list.loading ? (
                    <ListSkeleton rows={3} />
                ) : list.error ? (
                    <ErrorState error={friendlyError(list.error.message)} onRetry={list.reload} />
                ) : releases.length === 0 ? (
                    <div className="card">
                        <EmptyState
                            icon={ClipboardCheck}
                            title="No releases yet"
                            actions={
                                !creating && (
                                    <>
                                        <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
                                            New release
                                        </Button>
                                        <LinkButton href={routes.manualCases(id)}>Add manual cases</LinkButton>
                                    </>
                                )
                            }
                        >
                            A release is a checkpoint. It brings together what the automated tests found and the checks your team runs by hand, and it records who approved the release and why.
                        </EmptyState>
                    </div>
                ) : (
                    <ul className="card list divided" aria-label="Releases">
                        {releases.map((r) => {
                            const badge = DECISION_BADGE[r.status];
                            return (
                                <li key={r.id}>
                                    <a className="list-row" href={routes.release(id, r.id)}>
                                        <span className="main">
                                            <span className="title">{r.name}</span>
                                            <span className="meta">{r.sentence.slice(`Release ${r.name}: `.length)}</span>
                                            <span className="meta">
                                                {r.signedBy && r.signedAt ? `${r.status === "approved" ? "Approved" : "Rejected"} by ${r.signedBy}, ${relativeTime(r.signedAt)}` : `Opened ${relativeTime(r.createdAt)}`}
                                                {r.rollup.total > 0 ? `, ${plural(r.rollup.total, "manual check")}` : ""}
                                            </span>
                                        </span>
                                        <span className="tail">
                                            <Badge tone={badge.tone} tip={badge.help}>{badge.label}</Badge>
                                        </span>
                                        <ChevronRight size={18} className="chev" aria-hidden />
                                    </a>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </>
    );
}

function NewRelease({ projectId, onCancel }: { projectId: string; onCancel: () => void }) {
    const [name, setName] = useState("");
    const [notes, setNotes] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        if (!name.trim()) return setError("Give the release a name, like 2.4 or October launch.");
        setBusy(true);
        setError("");
        try {
            const made = await api<ReleaseView>(`/projects/${projectId}/releases`, { method: "POST", body: { name: name.trim(), notes: notes.trim() } });
            go(routes.release(projectId, made.id));
        } catch (err) {
            setError(apiMessage(err));
            setBusy(false);
        }
    }

    return (
        <form className="card card-pad stack-sm" onSubmit={submit} aria-label="New release" noValidate>
            <h2 className="t-section">New release</h2>
            <p className="t-secondary">Opening a release records how the automated tests look now. You then mark each manual check.</p>
            <div className="field">
                <label htmlFor="rel-new-name">Release name</label>
                <input id="rel-new-name" className="input" value={name} maxLength={80} placeholder="2.4" autoFocus onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
                <label htmlFor="rel-new-notes">Notes (optional)</label>
                <textarea id="rel-new-notes" className="input" rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="row">
                <Button type="submit" variant="primary" loading={busy}>
                    Open release
                </Button>
                <Button type="button" onClick={onCancel} disabled={busy}>
                    Cancel
                </Button>
            </div>
        </form>
    );
}
