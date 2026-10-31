import { Search, UserPlus, Users } from "lucide-react";
import { useState } from "react";
import { ApiError, api } from "../../api";
import { Badge, Button, Callout, EmptyState, ErrorState, ListSkeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";

/** One person on a project (GET /api/projects/:id/members, src/platform/routes/members.ts). */
interface Member {
    personId: string;
    name: string;
    email: string;
    kind: "admin" | "customer" | "tester" | "local";
    organizationId: string | null;
    projectAdmin: boolean;
    source: "creator" | "added";
    addedAt: string;
    status: string;
}
interface Candidate {
    personId: string;
    name: string;
    email: string;
    kind: Member["kind"];
    /** Found on Crowd4Test but has never opened AI Studio: adding them creates their AI Studio record (membership only). */
    newHere?: boolean;
}

const KIND_WORDS: Record<Member["kind"], string> = { admin: "Crowd4Test staff", customer: "Customer", tester: "Tester", local: "This platform" };
const msg = (e: unknown) => (e instanceof ApiError ? e.message : "That did not work. Try again.");

/**
 * Who can open this project, and who is Project Admin (decisions D-23, D-27). People are added one by one: being a Crowd4Test
 * customer, tester or manager opens no project by itself. Project Admins approve test cases and scripts. What each person may do
 * once in comes from the features a Crowd4Test administrator gave them; this list only says who is in.
 */
export function MembersPanel({ projectId }: { projectId: string }) {
    const members = useFetch<{ members: Member[]; organizationId: string | null }>(`/projects/${projectId}/members`);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [removing, setRemoving] = useState<string | null>(null);

    const act = async (key: string, run: () => Promise<unknown>) => {
        setBusy(key);
        setError(null);
        try {
            await run();
            members.reload();
        } catch (e) {
            setError(msg(e));
        } finally {
            setBusy(null);
            setRemoving(null);
        }
    };

    if (members.loading) return <ListSkeleton rows={3} />;
    if (members.error) {
        // Reading the list needs the "Manage project members" feature: say so plainly instead of showing an error.
        if (members.error instanceof ApiError && members.error.status === 403) {
            return (
                <Callout tone="info" title="Only people who manage members can see this list">
                    Ask a Project Admin of this project, or your Crowd4Test administrator, if you need someone added.
                </Callout>
            );
        }
        return <ErrorState error={friendlyError(members.error.message)} onRetry={members.reload} />;
    }
    const list = members.data?.members ?? [];
    return (
        <div className="stack" data-testid="project-members">
            {error && <Callout tone="danger">{error}</Callout>}
            <section className="card" aria-labelledby="members-title">
                <div className="card-pad stack-sm" style={{ paddingBottom: 0 }}>
                    <h2 className="t-section" id="members-title">
                        Members
                    </h2>
                    <p className="t-secondary">Everyone who can open this project. A Project Admin approves test cases and scripts, and gets review requests.</p>
                </div>
                {list.length === 0 ? (
                    <EmptyState icon={Users} title="Nobody is on this project yet">
                        Add the testers, managers and customers who work on it.
                    </EmptyState>
                ) : (
                    <ul className="list divided" aria-label="Project members">
                        {list.map((m) => (
                            <li key={m.personId} className="list-row" style={{ flexWrap: "wrap" }}>
                                <span className="main">
                                    <span className="title truncate">{m.name || m.email}</span>
                                    <span className="meta truncate">
                                        {m.email} · {KIND_WORDS[m.kind]}
                                        {m.source === "creator" ? " · Created the project" : ""}
                                    </span>
                                </span>
                                {m.projectAdmin && <Badge tone="brand">Project Admin</Badge>}
                                <label className="check" style={{ margin: 0 }}>
                                    <input
                                        type="checkbox"
                                        checked={m.projectAdmin}
                                        disabled={busy !== null}
                                        aria-label={`${m.name || m.email} is Project Admin`}
                                        onChange={(e) => void act(`admin:${m.personId}`, () => api(`/projects/${projectId}/members/${m.personId}`, { method: "PATCH", body: { projectAdmin: e.target.checked } }))}
                                    />
                                    <span>Project Admin</span>
                                </label>
                                {removing === m.personId ? (
                                    <span className="row" style={{ gap: 8 }}>
                                        <span className="t-meta">Remove from this project?</span>
                                        <Button size="sm" variant="danger" loading={busy === `remove:${m.personId}`} onClick={() => void act(`remove:${m.personId}`, () => api(`/projects/${projectId}/members/${m.personId}`, { method: "DELETE" }))}>
                                            Remove
                                        </Button>
                                        <Button size="sm" variant="ghost" onClick={() => setRemoving(null)}>
                                            Cancel
                                        </Button>
                                    </span>
                                ) : (
                                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setRemoving(m.personId)} aria-label={`Remove ${m.name || m.email}`}>
                                        Remove
                                    </Button>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </section>
            <AddMember projectId={projectId} onAdded={members.reload} />
        </div>
    );
}

/** Find a person and add them. The list holds people who have signed in to AI Studio at least once; customers of other organisations are left out. */
function AddMember({ projectId, onAdded }: { projectId: string; onAdded: () => void }) {
    const [q, setQ] = useState("");
    const [asAdmin, setAsAdmin] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const needle = q.trim();
    const candidates = useFetch<{ people: Candidate[]; source?: "signed-in" | "crowd4test"; notice?: string }>(needle.length >= 2 ? `/projects/${projectId}/members/candidates?q=${encodeURIComponent(needle)}` : null);

    const add = async (c: Candidate) => {
        setBusy(c.personId);
        setError(null);
        try {
            await api(`/projects/${projectId}/members`, { method: "POST", body: { personId: c.personId, projectAdmin: asAdmin } });
            setQ("");
            onAdded();
        } catch (e) {
            setError(msg(e));
        } finally {
            setBusy(null);
        }
    };

    const people = candidates.data?.people ?? [];
    return (
        <section className="card card-pad stack-sm" aria-labelledby="add-member-title">
            <h2 className="t-section" id="add-member-title">
                Add someone
            </h2>
            <p className="t-secondary">Search by name or email. {candidates.data?.source === "crowd4test" ? "Everyone with a Crowd4Test account can be found, also people who have not opened AI Studio yet." : "People appear here once they have opened AI Studio."}</p>
            {candidates.data?.notice && <Callout tone="warning">{candidates.data.notice}</Callout>}
            <div className="input-wrap">
                <Search size={16} className="lead" aria-hidden />
                <input className="input" type="search" placeholder="Name or email" aria-label="Search people to add" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <label className="check">
                <input type="checkbox" checked={asAdmin} onChange={(e) => setAsAdmin(e.target.checked)} />
                <span>Add as Project Admin</span>
            </label>
            {error && <Callout tone="danger">{error}</Callout>}
            {needle.length >= 2 &&
                (candidates.loading ? (
                    <p className="t-secondary">Searching…</p>
                ) : people.length === 0 ? (
                    <p className="t-secondary">Nobody found for “{needle}”. They may not have opened AI Studio yet, or they are a customer of another organisation.</p>
                ) : (
                    <ul className="list divided" aria-label="People to add">
                        {people.map((c) => (
                            <li key={c.personId} className="list-row">
                                <span className="main">
                                    <span className="title truncate">{c.name || c.email}</span>
                                    <span className="meta truncate">
                                        {c.email} · {KIND_WORDS[c.kind]}
                                        {c.newHere ? " · Has not opened AI Studio yet" : ""}
                                    </span>
                                </span>
                                <Button size="sm" icon={UserPlus} loading={busy === c.personId} disabled={busy !== null} onClick={() => void add(c)}>
                                    Add
                                </Button>
                            </li>
                        ))}
                    </ul>
                ))}
        </section>
    );
}
