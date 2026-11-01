import { Undo2, Wrench } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Badge, Button, Callout, Disclosure, Term } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { bapi } from "../builder/builder";
import { CONFIDENCE_TEXT, locatorText, newName, sameLocator, type Suggestion, type SuggestionList } from "./healing";
import "./healing.css";

const FINISHED = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];

/**
 * "We found a likely replacement for the “Add to cart” button". Shown on a test that did not pass because an element could not
 * be found. Nothing changes until the person presses Apply; Apply edits that one step, then runs the test again.
 * After Apply the card says what changed and offers Undo: it puts the old way of finding the element back through the steps editor
 * (so it is saved as a new version in the test's history) and runs the test again. A repair of a shared element has no one-press
 * undo, because it changed other tests too: the card shows what it was so the element can be set back by hand.
 */
export function HealingSuggestion({ testId, projectId, onChanged }: { testId: string; projectId?: string; onChanged: () => Promise<void> | void }) {
    const list = useFetch<SuggestionList>(`/tests/${testId}/healing`);
    const [busy, setBusy] = useState<"" | "apply" | "dismiss" | "undo">("");
    const [error, setError] = useState("");
    const [rerunning, setRerunning] = useState(false);
    const [undone, setUndone] = useState<string | null>(null);
    /** What the run just queued really runs, when that is not this fix: a draft never runs. */
    const [runNote, setRunNote] = useState("");
    const runNoteBox = runNote ? <Callout tone="info" title="This run does not use the fix yet">{runNote}</Callout> : null;

    const proposals = list.data?.proposals ?? [];
    const open = proposals.find((p) => p.status === "proposed" && p.canApply);
    const last = proposals.find((p) => p.status === "applied" || p.status === "dismissed");
    const applied = !open && last?.status === "applied" ? last : undefined;
    // Whether the step still finds its element the way the repair set it: only then can Undo put the old way back without undoing something else.
    const current = useFetch<{ spec: { steps: Array<{ locator?: unknown }> }; editable: boolean; reason?: string }>(applied && !applied.shared && !undone ? `/tests/${testId}/spec` : null);
    const stepNow = applied ? current.data?.spec.steps[applied.stepIndex]?.locator : undefined;
    const canUndo = !!applied && !applied.shared && !!current.data?.editable && !!stepNow && sameLocator(stepNow, applied.newLocator);

    async function waitFor(jobId: string) {
        setRerunning(true);
        for (;;) {
            await new Promise((r) => setTimeout(r, 1500));
            const job = await api<{ status: string }>(`/test-generation/${jobId}`);
            if (FINISHED.includes(job.status)) break;
        }
    }

    async function decide(p: Suggestion, kind: "apply" | "dismiss") {
        setBusy(kind);
        setError("");
        try {
            // A fix of a shared element changes every test that uses it: pressing the button is the person's confirmation.
            const body = kind === "apply" && p.shared ? { acceptSharedChange: true } : undefined;
            const out = await api<{ jobId?: string | null; note?: string }>(`/tests/${testId}/healing/${p.id}/${kind}`, { method: "POST", ...(body ? { body } : {}) });
            if (kind === "apply" && out.jobId) setRunNote(out.note ?? "");
            // The test now runs again with the new locator; wait for the result, then show the test page as it stands.
            if (kind === "apply" && out.jobId) await waitFor(out.jobId);
            await list.reload();
            await onChanged();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy("");
            setRerunning(false);
        }
    }

    async function undo(p: Suggestion) {
        setBusy("undo");
        setError("");
        try {
            // The whole spec as it is now, with only this step's locator put back: nothing else about the test changes.
            const now = await bapi<{ spec: { steps: Array<Record<string, unknown>> } & Record<string, unknown> }>(`/tests/${testId}/spec`);
            const steps = now.spec.steps.map((s, i) => (i === p.stepIndex ? { ...s, locator: p.oldLocator } : s));
            const saved = await bapi<{ jobId: string | null; note?: string }>(`/tests/${testId}/spec`, { method: "PUT", body: { spec: { ...now.spec, steps }, note: `Undid the repair of ${p.oldDescription}` } });
            setUndone(p.oldDescription);
            setRunNote(saved.jobId ? (saved.note ?? "") : "");
            if (saved.jobId) await waitFor(saved.jobId);
            await list.reload();
            await onChanged();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy("");
            setRerunning(false);
        }
    }

    // A suggestion is a bonus: while loading, or if it cannot be fetched, the test page simply shows nothing extra.
    if (list.loading || list.error) return null;
    if (undone) {
        return (
            <Callout tone="info" title="Repair undone">
                The step finds {undone} the way it did before. {rerunning ? "Running the test again…" : "The test was run again."} {runNote}
            </Callout>
        );
    }
    if (!open) {
        // An old repair that was changed since is history, not a card: the card is for a repair that can still be undone (or explained, for a shared element).
        if (applied && (applied.shared || canUndo || current.loading)) {
            return (
                <section className="card card-pad stack-sm heal" aria-labelledby="heal-applied-title" id="heal-card" data-testid="healing-applied">
                    <div className="heal-head">
                        <Wrench size={20} className="ico" aria-hidden />
                        <div className="stack-sm" style={{ gap: 6 }}>
                            <h2 className="t-section" id="heal-applied-title">
                                Repair applied
                            </h2>
                            <p>
                                {applied.oldDescription} is now found as {applied.newDescription}
                                {applied.decidedAt ? `, ${relativeTime(applied.decidedAt)}` : ""}. Only that step changed.
                            </p>
                        </div>
                    </div>
                    <Disclosure label="See what changed">
                        <div className="heal-diff" role="group" aria-label="What changed">
                            <div className="side">
                                <div className="k">Before</div>
                                <code>{locatorText(applied.oldLocator)}</code>
                            </div>
                            <div className="side after">
                                <div className="k">Now</div>
                                <code>{locatorText(applied.newLocator)}</code>
                            </div>
                        </div>
                    </Disclosure>
                    {applied.shared && (
                        <p className="t-secondary" data-testid="healing-applied-shared">
                            This changed the <Term word="shared element">shared element</Term> “{applied.shared.name}”, so it changed {applied.shared.otherTests === 0 ? "no other test" : `${applied.shared.otherTests} other test${applied.shared.otherTests === 1 ? "" : "s"}`} too. To go back, set the element to “{locatorText(applied.oldLocator)}” under{" "}
                            {projectId ? <a href={routes.objects(projectId)}>Shared elements</a> : "Shared elements"}.
                        </p>
                    )}
                    {error && <Callout tone="danger">{error}</Callout>}
                    {runNoteBox}
                    {canUndo && (
                        <div className="heal-acts">
                            <Button icon={Undo2} loading={busy === "undo"} disabled={!!busy} onClick={() => void undo(applied)}>
                                {rerunning ? "Running the test again…" : "Undo this repair"}
                            </Button>
                            <span className="t-meta">Puts the old way back as a new version in the history, then runs the test again.</span>
                        </div>
                    )}
                </section>
            );
        }
        return last ? (
            <>
                {runNoteBox}
                <p className="t-meta" data-testid="healing-history">
                    {last.status === "applied" ? `You applied a suggested fix for ${last.oldDescription}` : `You dismissed a suggestion for ${last.oldDescription}`} {last.decidedAt ? relativeTime(last.decidedAt) : ""}.
                </p>
            </>
        ) : null;
    }

    return (
        <section className="card card-pad heal" aria-labelledby="heal-title" id="heal-card" data-testid="healing-suggestion">
            <div className="heal-head">
                <Wrench size={20} className="ico" aria-hidden />
                <div className="stack-sm" style={{ gap: 6 }}>
                    <h2 className="t-section" id="heal-title">
                        We found a likely replacement for {open.oldDescription}
                    </h2>
                    <p>
                        It is now {newName(open.newLocator)}{" "}
                        <Badge tone={open.confidenceLabel === "high" ? "success" : open.confidenceLabel === "medium" ? "info" : "warning"} tip="How closely the new element matches the old one: its role, name, label, text or test id. A repair is only suggested when exactly one element on the page matches this well.">{CONFIDENCE_TEXT[open.confidenceLabel]}</Badge>
                    </p>
                    <p className="t-secondary">{open.reason}</p>
                </div>
            </div>
            <div className="heal-diff" role="group" aria-label="What would change">
                <div className="side">
                    <div className="k">Now</div>
                    <code>{locatorText(open.oldLocator)}</code>
                </div>
                <div className="side after">
                    <div className="k">After applying</div>
                    <code>{locatorText(open.newLocator)}</code>
                </div>
            </div>
            {open.shared && (
                <p className="t-secondary" data-testid="healing-shared">
                    This step uses the <Term word="shared element">shared element</Term> “{open.shared.name}”, so the <Term word="repair">repair</Term> changes the element.
                    {open.shared.otherTests > 0
                        ? ` This also changes ${open.shared.otherTests} other test${open.shared.otherTests === 1 ? "" : "s"}: ${open.shared.tests.map((t) => t.title).join(", ")}${open.shared.otherTests > open.shared.tests.length ? " and more" : ""}.`
                        : " No other test uses it."}
                </p>
            )}
            <p className="t-meta">
                {open.shared ? (
                    "Only how the element is found changes. What the tests do and check stays the same. If a test still fails afterwards, the application itself is what changed."
                ) : (
                    <>
                        Only step {open.stepIndex + 1}
                        {open.stepTitle ? ` (“${open.stepTitle}”)` : ""} changes: how it finds its element. What the test does and checks stays the same. If the test still fails afterwards, the application itself is what changed. You can undo it afterwards.
                    </>
                )}
            </p>
            {error && <Callout tone="danger">{error}</Callout>}
            {runNoteBox}
            <div className="heal-acts">
                <Button variant="primary" loading={busy === "apply"} disabled={!!busy} onClick={() => decide(open, "apply")}>
                    {rerunning ? "Running the test again…" : open.shared && open.shared.otherTests > 0 ? `Apply to ${open.shared.otherTests + 1} tests and run again` : "Apply and run again"}
                </Button>
                <Button variant="ghost" loading={busy === "dismiss"} disabled={!!busy} tip="Leaves the test as it is. The same suggestion is not made again." onClick={() => decide(open, "dismiss")}>
                    Dismiss
                </Button>
            </div>
        </section>
    );
}
