import { ClipboardCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, api, type ProjectDetail } from "../../api";
import { BadgeKey, keyEntries } from "../../components/Tooltip";
import { Badge, Button, Callout, EmptyState, ErrorState, ListSkeleton, Skeleton } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { SOURCE_WORDS, STATE, STATE_ORDER, versionHref, type QueueItem, type ReviewPolicy } from "./review";
import { StateBadge } from "./ScriptReview";

/**
 * Drafts waiting for review across the projects where the person may approve (GET /api/reviews): each opens its version on the
 * project's Test scripts page. A person's own change says so: another Project Admin approves it.
 */
export function ReviewQueueCard() {
    const queue = useFetch<{ reviewer: boolean; items: QueueItem[] }>("/reviews");
    const items = queue.data?.items ?? [];
    return (
        <section className="card" aria-labelledby="review-queue-title" data-testid="review-queue">
            <div className="card-pad stack-sm" style={{ paddingBottom: items.length ? 0 : undefined }}>
                <div className="row" style={{ flexWrap: "wrap" }}>
                    <h2 className="t-section" id="review-queue-title">
                        Drafts waiting for review
                    </h2>
                    <span className="spacer" />
                    {items.length > 0 && <BadgeKey label="the badges in this list" entries={keyEntries(STATE_ORDER, items.map((i) => i.state), (k) => STATE[k].label, (k) => STATE[k].text)} />}
                </div>
                <p className="t-secondary">Test versions that do not run until a Project Admin approves them.</p>
            </div>
            {queue.loading ? (
                <div className="card-pad">
                    <ListSkeleton rows={2} />
                </div>
            ) : queue.error ? (
                <div className="card-pad">
                    <ErrorState error={friendlyError(queue.error.message)} onRetry={queue.reload} />
                </div>
            ) : items.length === 0 ? (
                <EmptyState icon={ClipboardCheck} title={queue.data?.reviewer ? "Nothing to review" : "No reviews for you"}>
                    {queue.data?.reviewer ? "Every test version in your projects is decided." : "Drafts show here for Project Admins who may approve tests."}
                </EmptyState>
            ) : (
                <ul className="list divided" aria-label="Drafts waiting for review">
                    {items.map((i) => (
                        <li key={`${i.testId}:${i.version}`}>
                            <a className="list-row" href={versionHref(i.projectId, i.testId, i.version)} style={{ flexWrap: "wrap" }}>
                                <span className="main">
                                    <span className="title truncate">
                                        {i.testKey} {i.title}
                                    </span>
                                    <span className="meta truncate">
                                        {i.projectName} · version {i.version} · {SOURCE_WORDS[i.source]} · {i.author} {relativeTime(i.updatedAt)}
                                    </span>
                                </span>
                                <span className="row" style={{ gap: 6 }}>
                                    {i.yours && <Badge tone="neutral">Your change</Badge>}
                                    <StateBadge state={i.state} />
                                </span>
                            </a>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

const POLICY_ROWS: Array<{ key: keyof ReviewPolicy; label: string; hint: string }> = [
    { key: "aiGenerated", label: "Tests the AI writes", hint: "New tests and rewrites from the AI start as drafts." },
    { key: "edits", label: "Changes people make", hint: "Edited steps, code, imports and restored versions start as drafts." },
    { key: "healing", label: "Repairs after a failed run", hint: "A fix the platform makes after a failure starts as a draft." },
    { key: "soleAdminSelfApprove", label: "The only Project Admin may approve their own change", hint: "Otherwise nobody approves their own change. With more than one Project Admin, another one always approves." },
];

/** Project settings: what needs approval before it runs (all on by default). Changing it needs "Change project settings". */
export function ReviewPolicyCard({ projectId }: { projectId: string }) {
    const policy = useFetch<ReviewPolicy>(`/projects/${projectId}/review-policy`);
    const project = useFetch<ProjectDetail>(`/projects/${projectId}`);
    const canEdit = !project.data?.access || project.data.access.permissions.includes("ai_studio.project.settings");
    const [value, setValue] = useState<ReviewPolicy | null>(null);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    useEffect(() => {
        if (policy.data) setValue(policy.data);
    }, [policy.data]);
    const save = async () => {
        if (!value) return;
        setBusy(true);
        setNote(null);
        try {
            setValue(await api<ReviewPolicy>(`/projects/${projectId}/review-policy`, { method: "PUT", body: value }));
            setNote({ tone: "success", text: "Saved. It applies to changes from now on." });
        } catch (e) {
            setNote({ tone: "danger", text: e instanceof ApiError ? e.message : "That did not work. Try again." });
        } finally {
            setBusy(false);
        }
    };
    return (
        <section className="card card-pad stack-sm" aria-labelledby="review-policy-title" data-testid="review-policy">
            <h2 className="t-section" id="review-policy-title">
                Review and approval
            </h2>
            <p className="t-secondary">Only approved test versions run. Choose which changes a Project Admin approves first; the others are approved at once.</p>
            {policy.error ? (
                <ErrorState error={friendlyError(policy.error.message)} onRetry={policy.reload} />
            ) : !value ? (
                <Skeleton h={120} />
            ) : (
                <form
                    className="stack-sm"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void save();
                    }}
                >
                    {POLICY_ROWS.map((r) => (
                        <label key={r.key} className="check" style={{ alignItems: "flex-start" }}>
                            <input type="checkbox" checked={value[r.key]} disabled={!canEdit || busy} onChange={(e) => setValue({ ...value, [r.key]: e.target.checked })} />
                            <span>
                                {r.label}
                                <span className="t-meta" style={{ display: "block" }}>
                                    {r.hint}
                                </span>
                            </span>
                        </label>
                    ))}
                    {note && <Callout tone={note.tone}>{note.text}</Callout>}
                    {canEdit ? (
                        <div>
                            <Button type="submit" variant="primary" loading={busy}>
                                Save
                            </Button>
                        </div>
                    ) : (
                        <p className="t-meta">Changing this needs permission to change project settings.</p>
                    )}
                </form>
            )}
        </section>
    );
}
