import { Search } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Button, Callout } from "../../components/ui";
import { Tooltip } from "../../components/Tooltip";
import { describeApiError } from "../../lib/labels";
import { plural } from "../../lib/format";
import { KIND_TEXT, type Proposal } from "./objects";
import "./objects.css";

interface Done {
    created: number;
    reused: number;
    tests: number;
    steps: number;
}

/**
 * "Find elements to share": a preview of locators that several tests spell out identically, with a proposed name for each.
 * Nothing changes until the person ticks proposals and confirms.
 */
export function ExtractPanel({ projectId, onApplied }: { projectId: string; onApplied: () => void }) {
    const [proposals, setProposals] = useState<Proposal[] | null>(null);
    const [picked, setPicked] = useState<Record<string, boolean>>({});
    const [names, setNames] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState<"" | "find" | "apply">("");
    const [error, setError] = useState("");
    const [done, setDone] = useState<Done | null>(null);

    async function find() {
        setBusy("find");
        setError("");
        setDone(null);
        try {
            const out = await api<{ proposals: Proposal[] }>(`/projects/${projectId}/objects/extract`, { method: "POST", body: { dryRun: true } });
            setProposals(out.proposals);
            setPicked(Object.fromEntries(out.proposals.map((p) => [p.key, true])));
            setNames(Object.fromEntries(out.proposals.map((p) => [p.key, p.name])));
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy("");
        }
    }

    async function apply() {
        const chosen = (proposals ?? []).filter((p) => picked[p.key]);
        if (!chosen.length) return setError("Tick at least one element to share.");
        setBusy("apply");
        setError("");
        try {
            const out = await api<Done & { created: unknown[] }>(`/projects/${projectId}/objects/extract`, {
                method: "POST",
                body: { dryRun: false, apply: chosen.map((p) => ({ key: p.key, ...(p.existing ? {} : { name: (names[p.key] ?? p.name).trim() }) })) },
            });
            setDone({ created: Array.isArray(out.created) ? out.created.length : 0, reused: out.reused, tests: out.tests, steps: out.steps });
            setProposals(null);
            onApplied();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy("");
        }
    }

    return (
        <section className="card obj-extract" aria-labelledby="obj-extract-title">
            <div className="card-head wrap">
                <Search size={18} aria-hidden />
                <h2 className="t-section" id="obj-extract-title">Find elements to share</h2>
                <span className="spacer" />
                <Button size="sm" loading={busy === "find"} disabled={!!busy} onClick={find}>{proposals ? "Look again" : "Find elements to share"}</Button>
            </div>
            <div className="obj-body stack-sm">
                {!proposals && !done && <p className="t-secondary">Looks through your tests for elements that appear in more than one place and proposes a named element for each. You see the list first; nothing changes until you confirm.</p>}
                {done && (
                    <Callout tone="success" title="Shared elements are ready">
                        {done.created ? `${plural(done.created, "element")} created. ` : ""}{done.reused ? `${plural(done.reused, "existing element")} reused. ` : ""}{plural(done.steps, "step")} in {plural(done.tests, "test")} now use them. The generated scripts stay the same.
                    </Callout>
                )}
                {proposals && proposals.length === 0 && <p className="t-secondary" data-testid="no-proposals">No element appears in more than one place, so there is nothing to share yet.</p>}
                {proposals && proposals.length > 0 && (
                    <>
                        <ul className="obj-proposals" aria-label="Proposed shared elements">
                            {proposals.map((p) => (
                                <li key={p.key} className="obj-proposal">
                                    <label className="obj-check">
                                        <input type="checkbox" checked={Boolean(picked[p.key])} onChange={(e) => setPicked({ ...picked, [p.key]: e.target.checked })} />
                                        <span>
                                            <span className="obj-code">{p.description}</span>
                                            <span className="t-meta"> {KIND_TEXT[p.kind]}, {plural(p.uses, "place")} in {plural(p.testCount, "test")}</span>
                                        </span>
                                    </label>
                                    {p.existing ? (
                                        <p className="t-meta obj-indent">Already named “{p.existing}”. The steps will use it.</p>
                                    ) : (
                                        <div className="field obj-indent">
                                            <label htmlFor={`obj-pn-${p.key}`} className="t-meta">Name</label>
                                            <input id={`obj-pn-${p.key}`} className="input" value={names[p.key] ?? p.name} maxLength={80} onChange={(e) => setNames({ ...names, [p.key]: e.target.value })} />
                                        </div>
                                    )}
                                    {/* The line is cut to one row: its tooltip holds the whole list. */}
                                    <Tooltip content={`Used in ${p.tests.map((t) => t.title).join(", ")}${p.testCount > p.tests.length ? " and more" : ""}`}>
                                        <p className="t-meta obj-indent truncate" tabIndex={0}>Used in {p.tests.map((t) => t.title).join(", ")}{p.testCount > p.tests.length ? " and more" : ""}</p>
                                    </Tooltip>
                                </li>
                            ))}
                        </ul>
                        <div className="obj-acts">
                            <Button variant="primary" loading={busy === "apply"} disabled={!!busy} onClick={apply}>Create shared elements</Button>
                            <span className="t-meta">The ticked elements become shared elements and those steps use them.</span>
                        </div>
                    </>
                )}
                {error && <Callout tone="danger">{error}</Callout>}
            </div>
        </section>
    );
}
