import { useState } from "react";
import { ArrowLeft, Link2, Pencil, Search, Trash2, Unlink, X } from "lucide-react";
import { api, type TestSummary } from "../../api";
import { ProjectPlace } from "../../components/ProjectHub";
import { Badge, Button, Callout, EmptyState, ErrorState, ListSkeleton } from "../../components/ui";
import { plural, relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { go, routes } from "../../lib/router";
import { useCan } from "../auth/permissions";
import { apiMessage, type CaseList } from "../manual/manual";
import { RequirementForm } from "./RequirementForm";
import { COVERAGE_HINT, COVERAGE_TONE, COVERAGE_WORDS, PRIORITY_WORDS, RESULT_TONE, RESULT_WORDS, SOURCE_WORDS, STATUS_HINT, STATUS_WORDS, type LinkedTest, type RequirementDetailData } from "./requirements";

/** One requirement: what it says, the test cases that cover it with their latest result, and linking more. */
export function RequirementDetail({ id, rid }: { id: string; rid: string }) {
    const r = useFetch<RequirementDetailData>(`/projects/${id}/requirements/${rid}`);
    const can = useCan();
    const canWrite = can("ai_studio.tests.write");
    const [editing, setEditing] = useState(false);
    const [linking, setLinking] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    const d = r.data;

    async function remove() {
        try {
            await api(`/projects/${id}/requirements/${rid}?confirm=1`, { method: "DELETE" });
            go(routes.requirements(id));
        } catch (e) {
            setNotice({ tone: "danger", text: apiMessage(e) });
            setConfirming(false);
        }
    }

    async function unlink(t: LinkedTest) {
        try {
            await api(`/projects/${id}/requirements/${rid}/tests/${t.id}`, { method: "DELETE" });
            setNotice({ tone: "success", text: `“${t.title}” no longer covers this requirement.` });
            await r.reload();
        } catch (e) {
            setNotice({ tone: "danger", text: apiMessage(e) });
        }
    }

    return (
        <ProjectPlace
            id={id}
            place="requirements"
            title={d ? `${d.ref} ${d.title}` : "Requirement"}
            subtitle={
                d ? (
                    <span className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                        <Badge tone={COVERAGE_TONE[d.coverage]} tip={COVERAGE_HINT[d.coverage]}>
                            {COVERAGE_WORDS[d.coverage]}
                        </Badge>
                        <span>
                            {STATUS_WORDS[d.status]}, {PRIORITY_WORDS[d.priority].toLowerCase()} priority
                        </span>
                    </span>
                ) : (
                    "What the application must do, and which test cases check it."
                )
            }
            actions={
                d && canWrite && !editing ? (
                    <>
                        <Button icon={Pencil} onClick={() => setEditing(true)}>
                            Edit
                        </Button>
                        {confirming ? (
                            <>
                                <Button variant="danger" onClick={() => void remove()}>
                                    Delete {d.ref}
                                </Button>
                                <Button variant="ghost" onClick={() => setConfirming(false)}>
                                    Keep
                                </Button>
                            </>
                        ) : (
                            <Button variant="ghost" icon={Trash2} onClick={() => setConfirming(true)}>
                                Delete
                            </Button>
                        )}
                    </>
                ) : undefined
            }
        >
            <div>
                <a href={routes.requirements(id)} className="row" style={{ gap: 4, display: "inline-flex" }}>
                    <ArrowLeft size={14} aria-hidden /> All requirements
                </a>
            </div>
            {confirming && d && (
                <Callout tone="warning" title={`Delete ${d.ref}?`}>
                    {d.counts.linked > 0 ? `${plural(d.counts.linked, "test case")} cover${d.counts.linked === 1 ? "s" : ""} it. Deleting it removes those links; the test cases stay.` : "No test case covers it. This cannot be undone."}
                </Callout>
            )}
            {notice && <Callout tone={notice.tone}>{notice.text}</Callout>}
            {r.loading ? (
                <ListSkeleton rows={3} />
            ) : r.error || !d ? (
                <ErrorState error={friendlyError(r.error?.message ?? "Requirement not found")} onRetry={r.reload} />
            ) : (
                <>
                    {editing ? (
                        <RequirementForm
                            projectId={id}
                            initial={d}
                            onCancel={() => setEditing(false)}
                            onSaved={async () => {
                                setEditing(false);
                                setNotice({ tone: "success", text: "Saved." });
                                await r.reload();
                            }}
                        />
                    ) : (
                        <section className="card card-pad stack-sm" aria-label="What the requirement says">
                            <h2 className="t-section">Description</h2>
                            <p className="req-text">{d.description || <span className="muted">No description.</span>}</p>
                            <h2 className="t-section">Acceptance criteria</h2>
                            {d.acceptanceCriteria ? (
                                <ul className="bullets">
                                    {d.acceptanceCriteria
                                        .split("\n")
                                        .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
                                        .filter(Boolean)
                                        .map((l, i) => (
                                            <li key={i}>{l}</li>
                                        ))}
                                </ul>
                            ) : (
                                <p className="muted">No acceptance criteria yet.</p>
                            )}
                            <dl className="kv">
                                <dt>Status</dt>
                                <dd>
                                    {STATUS_WORDS[d.status]}. {STATUS_HINT[d.status]}
                                </dd>
                                <dt>Source</dt>
                                <dd>{SOURCE_WORDS[d.source]}</dd>
                                <dt>Changed</dt>
                                <dd>
                                    {relativeTime(d.updatedAt)}
                                    {d.updatedBy ? ` by ${d.updatedBy}` : ""}
                                </dd>
                            </dl>
                        </section>
                    )}

                    <section className="stack-sm" aria-labelledby="req-tests">
                        <div className="section-head">
                            <h2 className="t-section" id="req-tests">
                                Test cases that cover it
                            </h2>
                            <span className="t-meta">{d.counts.linked ? `${d.counts.passed} passed, ${d.counts.failed} failed, ${d.counts.notRun} without a result` : "None yet"}</span>
                            <span className="spacer" />
                            {canWrite && !linking && (
                                <Button size="sm" icon={Link2} onClick={() => setLinking(true)}>
                                    Link test cases
                                </Button>
                            )}
                        </div>
                        {linking && (
                            <LinkPicker
                                projectId={id}
                                rid={rid}
                                linked={new Set(d.tests.map((t) => t.id))}
                                onCancel={() => setLinking(false)}
                                onLinked={async (n) => {
                                    setLinking(false);
                                    setNotice({ tone: "success", text: `Linked ${plural(n, "test case")}.` });
                                    await r.reload();
                                }}
                            />
                        )}
                        {d.tests.length === 0 ? (
                            !linking && (
                                <div className="card">
                                    <EmptyState icon={Link2} title="Nothing checks this requirement yet">
                                        Link the automated tests and manual cases that check it. Its coverage then follows their latest results.
                                    </EmptyState>
                                </div>
                            )
                        ) : (
                            <ul className="card list divided" aria-label="Linked test cases">
                                {d.tests.map((t) => (
                                    <li key={t.id} className="req-test">
                                        <a className="list-row" href={t.kind === "automated" ? routes.test(t.id) : routes.cases(id, "manual")}>
                                            <span className="main">
                                                <span className="title">
                                                    {t.key && <span className="req-ref mono">{t.key}</span>} {t.title}
                                                </span>
                                                <span className="meta">
                                                    {t.kind === "automated" ? "Automated" : "Manual"}
                                                    {t.resultAt && (
                                                        <>
                                                            <span className="dot-sep" />
                                                            Latest result {relativeTime(t.resultAt)}
                                                        </>
                                                    )}
                                                    {t.origin === "generated" && (
                                                        <>
                                                            <span className="dot-sep" />
                                                            Linked by the AI when it wrote the test
                                                        </>
                                                    )}
                                                </span>
                                            </span>
                                            <span className="tail">
                                                <Badge tone={RESULT_TONE[t.result]}>{RESULT_WORDS[t.result]}</Badge>
                                            </span>
                                        </a>
                                        {canWrite && (
                                            <Button size="sm" variant="ghost" icon={Unlink} aria-label={`Unlink ${t.title}`} onClick={() => void unlink(t)}>
                                                Unlink
                                            </Button>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                </>
            )}
        </ProjectPlace>
    );
}

/** Choose the project's automated tests and manual cases to link; the ones already linked are not offered. */
function LinkPicker({ projectId, rid, linked, onCancel, onLinked }: { projectId: string; rid: string; linked: Set<string>; onCancel: () => void; onLinked: (n: number) => void | Promise<void> }) {
    const tests = useFetch<TestSummary[]>(`/projects/${projectId}/tests`);
    const manual = useFetch<CaseList>(`/projects/${projectId}/manual-cases`);
    const [q, setQ] = useState("");
    const [picked, setPicked] = useState<Map<string, "automated" | "manual">>(new Map());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const needle = q.trim().toLowerCase();
    const options = [
        ...(tests.data ?? []).map((t) => ({ id: t.id, kind: "automated" as const, title: t.title, hint: `Automated, ${t.testId}` })),
        ...(manual.data?.cases ?? []).map((c) => ({ id: c.id, kind: "manual" as const, title: c.title, hint: `Manual, ${c.area}` })),
    ].filter((o) => !linked.has(o.id) && (!needle || `${o.title}\n${o.hint}`.toLowerCase().includes(needle)));

    async function save() {
        setBusy(true);
        setError("");
        try {
            const body = { automated: [...picked].filter(([, k]) => k === "automated").map(([i]) => i), manual: [...picked].filter(([, k]) => k === "manual").map(([i]) => i) };
            const r = await api<{ added: number }>(`/projects/${projectId}/requirements/${rid}/tests`, { method: "POST", body });
            await onLinked(r.added);
        } catch (e) {
            setError(apiMessage(e));
            setBusy(false);
        }
    }

    return (
        <section className="card card-pad stack-sm" aria-label="Link test cases">
            <div className="row">
                <h3 className="t-card">Choose test cases</h3>
                <span className="spacer" />
                <Button size="sm" variant="ghost" icon={X} onClick={onCancel} aria-label="Close the picker">
                    Close
                </Button>
            </div>
            <div className="input-wrap" style={{ maxWidth: 360 }}>
                <Search size={16} className="lead" aria-hidden />
                <input className="input" type="search" placeholder="Search test cases" aria-label="Search test cases" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {tests.loading || manual.loading ? (
                <ListSkeleton rows={3} />
            ) : options.length === 0 ? (
                <p className="t-secondary">{needle ? "No test case matches." : "Every test case of this project is already linked, or the project has none yet."}</p>
            ) : (
                <fieldset className="req-preview">
                    <legend className="sr-only">Test cases</legend>
                    {options.map((o) => (
                        <label className="check" key={o.id}>
                            <input
                                type="checkbox"
                                checked={picked.has(o.id)}
                                onChange={(e) =>
                                    setPicked((m) => {
                                        const n = new Map(m);
                                        if (e.target.checked) n.set(o.id, o.kind);
                                        else n.delete(o.id);
                                        return n;
                                    })
                                }
                            />
                            <span>
                                <span className="title">{o.title}</span>
                                <span className="hint">{o.hint}</span>
                            </span>
                        </label>
                    ))}
                </fieldset>
            )}
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="row">
                <Button variant="primary" disabled={picked.size === 0} loading={busy} onClick={() => void save()}>
                    Link {plural(picked.size, "test case")}
                </Button>
                <Button onClick={onCancel} disabled={busy}>
                    Cancel
                </Button>
            </div>
        </section>
    );
}
