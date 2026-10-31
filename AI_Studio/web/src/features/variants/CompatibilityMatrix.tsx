import { Check, Minus, MonitorSmartphone, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, artifactUrl } from "../../api";
import { Button, Callout, Disclosure, SeverityBadge } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import { cleanReason, describeApiError, stepSentence } from "../../lib/labels";
import { VariantPicker } from "./VariantPicker";
import { VARIANT_UI, variantLabel, type CompatDetail, type CompatEntry } from "./variants";
import "./variants.css";

interface MatrixTest extends Partial<CompatDetail> {
    id: string;
    kind: string;
    validationStatus: string;
    spec: { steps: unknown[] };
}

/**
 * The compatibility matrix on a test's page: one row per browser / screen size, saying whether the test passed
 * there, failed (with the failing step and evidence), could not run, or was not repeated (with the reason).
 */
export function CompatibilityMatrix({ test, onChanged }: { test: MatrixTest; onChanged: () => void | Promise<void> }) {
    if (test.kind !== "web") return null;
    const entries = test.compatibility ?? {};
    const hasEntries = Object.keys(entries).length > 0;
    const eligible = test.variantCheck?.eligible !== false;
    const failing = VARIANT_UI.filter((v) => entries[v.id]?.status === "failed");
    const passed = VARIANT_UI.filter((v) => entries[v.id]?.status === "passed");
    const couldNotRun = VARIANT_UI.filter((v) => entries[v.id]?.status === "unavailable");

    return (
        <section className="section stack-sm" aria-label="Other browsers and screen sizes">
            <div className="row">
                <MonitorSmartphone size={18} aria-hidden />
                <h2 className="t-section">Other browsers &amp; screen sizes</h2>
            </div>

            {failing.length > 0 && (
                <Callout tone="warning" title="This doesn’t behave the same everywhere">
                    It passes in Chrome on a desktop, but fails on {failing.map((v) => v.label).join(" and ")}.{" "}
                    <SeverityBadge severity="medium" basis="Works for some visitors and not for others" tipFocusable />
                </Callout>
            )}
            {failing.length === 0 && passed.length > 0 && (
                <Callout tone="success" title={couldNotRun.length ? "Passed everywhere it could run" : "Works on every browser and screen size we checked"}>
                    {couldNotRun.length ? `${couldNotRun.map((v) => v.label).join(" and ")} couldn’t run here, so we can’t say how it behaves there.` : `Checked on ${passed.map((v) => v.label).join(", ")}.`}
                </Callout>
            )}

            {hasEntries ? (
                <ul className="compat-list" aria-label="Result on each browser and screen size">
                    <Row name="Chrome (desktop)" mark="passed" label={test.validationStatus === "VALIDATED" ? "Passed" : "Main run"} detail="This is the test’s main run." muted={test.validationStatus !== "VALIDATED"} />
                    {VARIANT_UI.map((v) => (
                        <EntryRow key={v.id} name={v.label} entry={entries[v.id]} steps={test.spec.steps} />
                    ))}
                </ul>
            ) : eligible ? (
                <p className="t-secondary">This test hasn’t been checked on other browsers or screen sizes yet. Pick where to repeat it.</p>
            ) : (
                <p className="t-secondary" data-testid="compat-not-checked">Not checked on other browsers or screen sizes. {test.variantCheck?.reason}</p>
            )}

            {eligible &&
                (hasEntries ? (
                    <Disclosure label="Check again">
                        <Runner testId={test.id} onChanged={onChanged} />
                    </Disclosure>
                ) : (
                    <Runner testId={test.id} onChanged={onChanged} />
                ))}
        </section>
    );
}

const firstLine = (s: string | undefined) => (s ?? "").replace(/\u001b\[[0-9;]*m/g, "").split("\n").find((l) => l.trim())?.trim() ?? "";

function Row({ name, mark, label, detail, muted, children }: { name: string; mark: CompatEntry["status"]; label: string; detail?: string; muted?: boolean; children?: React.ReactNode }) {
    return (
        <li>
            <span className={`mark ${mark}`} aria-hidden>
                {mark === "passed" ? <Check size={16} /> : mark === "failed" ? <X size={16} /> : <Minus size={16} />}
            </span>
            <span className="name">{name}</span>
            <span className="what">
                <span>
                    <strong style={{ color: mark === "failed" ? "var(--status-error-fg)" : muted ? "var(--text-muted)" : undefined }}>{label}</strong>
                    {detail && <span className="t-meta"> · {detail}</span>}
                </span>
                {children}
            </span>
        </li>
    );
}

function EntryRow({ name, entry, steps }: { name: string; entry: CompatEntry | undefined; steps: unknown[] }) {
    if (!entry) return <Row name={name} mark="skipped" label="Not checked" muted />;
    const when = `checked ${relativeTime(entry.ranAt)}`;
    const stale = entry.stale ? <span className="t-meta">This was checked before the test’s latest run, so it may be out of date. Check again to refresh it.</span> : null;
    switch (entry.status) {
        case "passed":
            return <Row name={name} mark="passed" label="Passed" detail={when}>{stale}</Row>;
        case "unavailable":
            return (
                <Row name={name} mark="unavailable" label="Couldn’t run here" detail={when} muted>
                    <span className="why">{entry.reason}</span>
                    {stale}
                </Row>
            );
        case "skipped":
            return (
                <Row name={name} mark="skipped" label="Not repeated" muted>
                    <span className="why">{entry.reason}</span>
                </Row>
            );
        case "failed": {
            const shot = entry.artifacts.find((a) => a.kind === "screenshot");
            const video = entry.artifacts.find((a) => a.kind === "video");
            const trace = entry.artifacts.find((a) => a.kind === "trace");
            const step = entry.failedStep ? steps[entry.failedStep.index] : undefined;
            return (
                <Row name={name} mark="failed" label="Fails here" detail={when}>
                    {entry.failedStep && <span>Fails at step {entry.failedStep.index + 1}{step ? `: ${stepSentence(step)}` : ""}</span>}
                    {entry.reason && <span className="why">{cleanReason(firstLine(entry.reason.replace(/^\d+\.\s.*? - /, ""))).slice(0, 240)}</span>}
                    {shot && (
                        <a href={artifactUrl(shot.id)} target="_blank" rel="noreferrer">
                            <img src={artifactUrl(shot.id)} alt={`Screenshot on ${name} at the moment of failure`} loading="lazy" />
                        </a>
                    )}
                    {(shot || video || trace) && (
                        <span className="links">
                            {shot && <a href={artifactUrl(shot.id)} target="_blank" rel="noreferrer">Screenshot</a>}
                            {video && <a href={artifactUrl(video.id)} target="_blank" rel="noreferrer">Recording</a>}
                            {trace && <a href={artifactUrl(trace.id)} download>Detailed trace</a>}
                        </span>
                    )}
                    {stale}
                </Row>
            );
        }
    }
}

/** Pick browsers / screen sizes and run the check for this one test, then wait for the result. */
function Runner({ testId, onChanged }: { testId: string; onChanged: () => void | Promise<void> }) {
    const [picked, setPicked] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const alive = useRef(true);
    useEffect(() => () => void (alive.current = false), []);

    async function run() {
        setBusy(true);
        setError("");
        try {
            const { jobId } = await api<{ jobId: string }>(`/tests/${testId}/variants`, { method: "POST", body: { variants: picked } });
            for (;;) {
                await new Promise((r) => setTimeout(r, 1500));
                const job = await api(`/test-generation/${jobId}`);
                if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) {
                    if (job.status === "FAILED" && job.error && job.error !== "Cancelled") setError(job.error);
                    break;
                }
            }
            await onChanged();
        } catch (e) {
            if (alive.current) setError(describeApiError(e));
        } finally {
            if (alive.current) setBusy(false);
        }
    }

    return (
        <div className="stack-sm">
            <VariantPicker value={picked} onChange={setPicked} disabled={busy} />
            {error && <Callout tone="danger" title="We couldn’t check that">{error}</Callout>}
            <div className="row">
                <Button variant="primary" icon={RefreshCw} loading={busy} disabled={busy || picked.length === 0} onClick={() => void run()}>
                    {busy ? "Checking…" : picked.length ? `Check on ${picked.map(variantLabel).join(", ")}` : "Check on other browsers"}
                </Button>
            </div>
        </div>
    );
}
