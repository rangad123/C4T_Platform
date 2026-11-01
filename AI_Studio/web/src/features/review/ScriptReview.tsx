import { ArrowLeft, Check, FileCode2, MessageSquare, Send, X } from "lucide-react";
import { useMemo, useState } from "react";
import { ApiError, api } from "../../api";
import { BadgeKey, keyEntries } from "../../components/Tooltip";
import { Badge, Button, Callout, EmptyState, ErrorState, ListSkeleton, StatusBadge, statusKey } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { frameworkLabel, friendlyError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { lineDiff } from "../code/code";
import "../code/code.css";
import { DiffView } from "../code/VersionHistory";
import { COMMENT_WORDS, SOURCE_WORDS, STATE, STATE_ORDER, SYNC, SYNC_ORDER, versionHref, type ReviewPolicy, type ScriptRow, type VersionDetail, type VersionState, type SyncStatus } from "./review";

const msg = (e: unknown) => (e instanceof ApiError ? e.message : "That did not work. Try again.");

export function StateBadge({ state }: { state: VersionState }) {
    return (
        <Badge tone={STATE[state].tone} tip={STATE[state].text}>
            {STATE[state].label}
        </Badge>
    );
}
export function SyncBadge({ sync }: { sync: SyncStatus }) {
    return (
        <Badge tone={SYNC[sync].tone} tip={SYNC[sync].text}>
            {SYNC[sync].label}
        </Badge>
    );
}

/** What the project's policy asks to be approved, in one line. */
function policyLine(p: ReviewPolicy): string {
    const parts = [p.aiGenerated && "tests the AI writes", p.edits && "changes people make", p.healing && "repairs after a failed run"].filter(Boolean) as string[];
    return parts.length ? `This project approves ${parts.join(", ")} before they run.` : "This project's policy approves every change at once.";
}

/**
 * Every test's script with its review state: the latest version, whether it is approved, whether its plain-English steps and code
 * are in step, and who changed it last. A test with no approved version does not run (drafts never run). Each row opens the version.
 */
export function ScriptList({ id }: { id: string }) {
    const data = useFetch<{ scripts: ScriptRow[]; policy: ReviewPolicy; canApprove: boolean }>(`/projects/${id}/scripts`);
    if (data.loading) return <ListSkeleton rows={4} />;
    if (data.error) return <ErrorState error={friendlyError(data.error.message)} onRetry={data.reload} />;
    const list = data.data?.scripts ?? [];
    const waiting = list.filter((s) => s.waiting).length;
    const open = list.filter((s) => s.latest && (s.latest.state === "draft" || s.latest.state === "in_review")).length;
    if (list.length === 0) {
        return (
            <div className="card">
                <EmptyState icon={FileCode2} title="No scripts yet">
                    A script is made for every test case. Add test cases first, in Test cases.
                </EmptyState>
            </div>
        );
    }
    return (
        <div className="stack" data-testid="script-review-list">
            <div className="card card-pad stack-sm">
                <p className="t-secondary">
                    {policyLine(data.data!.policy)} Only approved versions run; the rest wait. <a href={routes.projectSettings(id, "members")}>Change what needs approval</a>
                </p>
                <p className="t-meta" data-testid="script-review-counts">
                    {open === 1 ? "1 version waits for a decision" : `${open} versions wait for a decision`}
                    {waiting > 0 ? ` · ${waiting === 1 ? "1 test has" : `${waiting} tests have`} no approved version and does not run` : ""}
                </p>
            </div>
            <div className="card">
                <div className="card-pad row" style={{ paddingBottom: 0, flexWrap: "wrap" }}>
                    <span className="t-meta">{list.length === 1 ? "1 script" : `${list.length} scripts`}, with their latest version</span>
                    <span className="spacer" />
                    <BadgeKey
                        label="the badges in this list"
                        entries={[
                            ...keyEntries(STATE_ORDER, list.map((s) => s.latest?.state), (k) => STATE[k].label, (k) => STATE[k].text),
                            ...keyEntries(SYNC_ORDER, list.map((s) => s.latest?.sync), (k) => SYNC[k].label, (k) => SYNC[k].text),
                            ...statusKey(list.map((s) => s.validationStatus)),
                        ]}
                    />
                </div>
                <ul className="list divided" aria-label="Test scripts">
                    {list.map((s) => (
                        <li key={s.testId}>
                            <a className="list-row" href={s.latest ? versionHref(id, s.testId, s.latest.version) : routes.testTab(s.testId, "code")} style={{ flexWrap: "wrap" }}>
                                <span className="main">
                                    <span className="title">{s.title}</span>
                                    <span className="meta">
                                        {s.testKey} · {frameworkLabel(s.framework)} · {s.custom ? "Code written by a person" : "Made from the test’s steps"}
                                        {s.latest ? ` · version ${s.latest.version}, ${s.latest.author} ${relativeTime(s.latest.updatedAt)}` : " · no version yet"}
                                        {s.approvedVersion !== null && s.latest && s.approvedVersion !== s.latest.version ? ` · version ${s.approvedVersion} runs` : ""}
                                    </span>
                                </span>
                                <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                                    {s.latest && <StateBadge state={s.latest.state} />}
                                    {s.latest && <SyncBadge sync={s.latest.sync} />}
                                    {s.waiting && <Badge tone="warning">Waiting for approval</Badge>}
                                    <StatusBadge status={s.validationStatus} />
                                </span>
                            </a>
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
}

/** A decision that needs words: the text box and its button, shown on demand. */
function WordsForm({ label, button, tone, required, onSubmit, onCancel }: { label: string; button: string; tone: "primary" | "danger" | "secondary"; required: boolean; onSubmit: (text: string) => Promise<void>; onCancel: () => void }) {
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const fieldId = `review-${button.toLowerCase().replace(/\W+/g, "-")}`;
    return (
        <form
            className="stack-sm"
            onSubmit={(e) => {
                e.preventDefault();
                setBusy(true);
                void onSubmit(text.trim()).finally(() => setBusy(false));
            }}
        >
            <div className="field">
                <label htmlFor={fieldId}>{label}</label>
                <textarea id={fieldId} className="input" rows={3} maxLength={2000} value={text} autoFocus onChange={(e) => setText(e.target.value)} />
            </div>
            <div className="row">
                <Button type="submit" variant={tone} loading={busy} disabled={required && !text.trim()}>
                    {button}
                </Button>
                <Button type="button" variant="ghost" onClick={onCancel}>
                    Cancel
                </Button>
            </div>
        </form>
    );
}

/** One version of a test's script: its steps and code beside the approved version's, the comments, and the review actions. */
export function VersionPage({ projectId, testId, version }: { projectId: string; testId: string; version: number }) {
    const detail = useFetch<VersionDetail>(`/tests/${testId}/review/${version}`);
    const history = useFetch<{ versions: Array<{ version: number; state: VersionState; author: string; updatedAt: string }> }>(`/tests/${testId}/review`);
    const [open, setOpen] = useState<"approve" | "reject" | "changes" | "submit" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<string | null>(null);
    const [comment, setComment] = useState("");
    const [commenting, setCommenting] = useState(false);
    const d = detail.data;
    const textDiff = useMemo(() => (d?.approved ? lineDiff(d.approved.text, d.text) : []), [d]);
    const codeDiff = useMemo(() => (d?.approved && d.approved.code !== null && d.code !== null ? lineDiff(d.approved.code, d.code) : []), [d]);

    const act = async (path: string, body: unknown, after: string) => {
        setError(null);
        setDone(null);
        try {
            await api(`/tests/${testId}/review/${version}/${path}`, { method: "POST", body });
            setOpen(null);
            setDone(after);
            detail.reload();
            history.reload();
        } catch (e) {
            setError(msg(e));
        }
    };

    if (detail.loading) return <ListSkeleton rows={4} />;
    if (detail.error || !d) return <ErrorState error={friendlyError(detail.error?.message ?? "Not found")} onRetry={detail.reload} />;
    const back = routes.scripts(projectId);
    return (
        <div className="stack" data-testid="script-version">
            <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                <a href={back} className="row" style={{ gap: 6 }}>
                    <ArrowLeft size={16} aria-hidden /> All scripts
                </a>
                <span className="spacer" />
                <a href={routes.testTab(testId, "steps")}>Open the test</a>
            </div>
            <section className="card card-pad stack-sm" aria-labelledby="version-title">
                <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                    <h2 className="t-section" id="version-title">
                        {d.testKey} {d.title}, version {d.version}
                    </h2>
                    <StateBadge state={d.state} />
                    <SyncBadge sync={d.sync} />
                </div>
                <p className="t-secondary">
                    {SOURCE_WORDS[d.source]} · {d.author} · {relativeTime(d.updatedAt)}
                    {d.decision ? ` · ${STATE[d.state].label} by ${d.decision.by} ${relativeTime(d.decision.at)}${d.decision.note ? `: ${d.decision.note}` : ""}` : ""}
                </p>
                {d.regenNote && <Callout tone="warning">{d.regenNote}</Callout>}
                {d.state === "approved" ? (
                    <p className="t-meta">This is the version that runs.</p>
                ) : d.approved ? (
                    <p className="t-meta">Runs use version {d.approved.version} until this one is approved.</p>
                ) : d.state !== "superseded" ? (
                    <p className="t-meta">This test has no approved version, so runs leave it out and say it is waiting for approval.</p>
                ) : null}
                {done && (
                    <Callout tone="success" title={done}>
                        {null}
                    </Callout>
                )}
                {error && <Callout tone="danger">{error}</Callout>}
                {d.actions.approveBlocked && <Callout tone="info">{d.actions.approveBlocked}</Callout>}
                {open === null && (d.actions.approve || d.actions.reject || d.actions.requestChanges || d.actions.submit) && (
                    <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                        {d.actions.approve && (
                            <Button variant="primary" icon={Check} onClick={() => setOpen("approve")}>
                                Approve
                            </Button>
                        )}
                        {d.actions.requestChanges && <Button onClick={() => setOpen("changes")}>Ask for changes</Button>}
                        {d.actions.reject && (
                            <Button variant="danger" icon={X} onClick={() => setOpen("reject")}>
                                Reject
                            </Button>
                        )}
                        {d.actions.submit && (
                            <Button icon={Send} onClick={() => setOpen("submit")}>
                                Send for review
                            </Button>
                        )}
                    </div>
                )}
                {open === "approve" && <WordsForm label="Note (optional)" button="Approve this version" tone="primary" required={false} onCancel={() => setOpen(null)} onSubmit={(note) => act("approve", { seen: d.updatedAt, ...(note ? { note } : {}) }, "Approved. This version runs from now on.")} />}
                {open === "changes" && <WordsForm label="What should change" button="Ask for changes" tone="secondary" required onCancel={() => setOpen(null)} onSubmit={(c) => act("request-changes", { comment: c }, "Sent back as a draft, with your comment.")} />}
                {open === "reject" && <WordsForm label="Why it is rejected" button="Reject this version" tone="danger" required onCancel={() => setOpen(null)} onSubmit={(reason) => act("reject", { reason }, "Rejected. It will never run.")} />}
                {open === "submit" && <WordsForm label="Note for the reviewer (optional)" button="Send for review" tone="primary" required={false} onCancel={() => setOpen(null)} onSubmit={(note) => act("submit", note ? { note } : {}, "Sent to the Project Admins for review.")} />}
            </section>

            <section className="card card-pad stack-sm" aria-labelledby="steps-title">
                <h2 className="t-section" id="steps-title">
                    Plain-English steps
                </h2>
                {d.note && <p className="t-meta">{d.note}</p>}
                {d.approved ? <DiffView rows={textDiff} leftLabel={`Version ${d.approved.version} (approved)`} rightLabel={`Version ${d.version}`} /> : <pre className="code" data-testid="version-text">{d.text || "No plain-English form."}</pre>}
            </section>

            <section className="card card-pad stack-sm" aria-labelledby="code-title">
                <h2 className="t-section" id="code-title">
                    Code
                </h2>
                {d.codeNote && <p className="t-meta">{d.codeNote}</p>}
                {d.code === null ? null : d.approved && d.approved.code !== null ? <DiffView rows={codeDiff} leftLabel={`Version ${d.approved.version} (approved)`} rightLabel={`Version ${d.version}`} /> : <pre className="code" data-testid="version-code">{d.code}</pre>}
            </section>

            <section className="card card-pad stack-sm" aria-labelledby="comments-title">
                <h2 className="t-section" id="comments-title">
                    Comments
                </h2>
                {d.comments.length === 0 ? (
                    <p className="t-secondary">No comments yet.</p>
                ) : (
                    <ul className="list divided" aria-label="Comments">
                        {d.comments.map((c) => (
                            <li key={c.id} className="list-row">
                                <span className="main">
                                    <span className="meta">
                                        {c.authorName} {COMMENT_WORDS[c.kind]} · {relativeTime(c.createdAt)}
                                    </span>
                                    {c.body && <span className="title" style={{ whiteSpace: "pre-wrap", fontWeight: 400 }}>{c.body}</span>}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
                {d.actions.comment && (
                    <form
                        className="stack-sm"
                        onSubmit={(e) => {
                            e.preventDefault();
                            setCommenting(true);
                            setError(null);
                            api(`/tests/${testId}/review/${version}/comments`, { method: "POST", body: { body: comment.trim() } })
                                .then(() => {
                                    setComment("");
                                    detail.reload();
                                })
                                .catch((err) => setError(msg(err)))
                                .finally(() => setCommenting(false));
                        }}
                    >
                        <div className="field">
                            <label htmlFor="review-comment">Add a comment</label>
                            <textarea id="review-comment" className="input" rows={2} maxLength={4000} value={comment} onChange={(e) => setComment(e.target.value)} />
                        </div>
                        <div>
                            <Button type="submit" icon={MessageSquare} loading={commenting} disabled={!comment.trim()}>
                                Comment
                            </Button>
                        </div>
                    </form>
                )}
            </section>

            {(history.data?.versions.length ?? 0) > 1 && (
                <section className="card" aria-labelledby="versions-title">
                    <div className="card-pad" style={{ paddingBottom: 0 }}>
                        <h2 className="t-section" id="versions-title">
                            Versions
                        </h2>
                    </div>
                    <ul className="list divided" aria-label="Versions">
                        {history.data!.versions.map((v) => (
                            <li key={v.version}>
                                <a className="list-row" href={versionHref(projectId, testId, v.version)} aria-current={v.version === version ? "page" : undefined}>
                                    <span className="main">
                                        <span className="title">Version {v.version}</span>
                                        <span className="meta">
                                            {v.author} · {relativeTime(v.updatedAt)}
                                        </span>
                                    </span>
                                    <StateBadge state={v.state} />
                                </a>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </div>
    );
}
