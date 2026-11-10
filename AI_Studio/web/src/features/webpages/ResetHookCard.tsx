import { Plus, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { FieldHelp } from "../../components/Tooltip";
import { Button, Callout, Skeleton } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { useHere } from "../auth/project-access";
import { describeApiError } from "../../lib/labels";
import type { Environment } from "../environments/environments";
import type { ResetAnswer, ResetHookRow, ResetOutcome } from "./webpages";
import "./webpages.css";

interface HeaderRow {
    name: string;
    /** "" = keep the saved value (values are write-only: the page never gets them back). */
    value: string;
    saved: boolean;
}

interface Draft {
    enabled: boolean;
    method: string;
    url: string;
    expectedStatus: string;
    headers: HeaderRow[];
}

const draftOf = (h: ResetHookRow | undefined): Draft => ({
    enabled: h?.enabled ?? true,
    method: h?.method ?? "POST",
    url: h?.url ?? "",
    expectedStatus: String(h?.expectedStatus ?? 200),
    headers: (h?.headerNames ?? []).map((name) => ({ name, value: "", saved: true })),
});

/**
 * Settings, Test data: one request the platform sends before a run so the application starts from known data (for example POST /test/reset).
 * One per place a run goes: the project's own address, and each environment that is not production.
 */
export function ResetHookCard({ projectId }: { projectId: string }) {
    const data = useFetch<ResetAnswer>(`/projects/${projectId}/test-data-reset`);
    const envs = useFetch<{ environments: Environment[] }>(`/projects/${projectId}/environments`);
    const [place, setPlace] = useState("");
    const [draft, setDraft] = useState<Draft>(draftOf(undefined));
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [outcome, setOutcome] = useState<ResetOutcome | null>(null);
    const [notice, setNotice] = useState("");
    // Saving and removing the reset is a project setting; trying it once is running (as the server asks).
    const here = useHere(projectId);
    const noSettings = here.why("ai_studio.project.settings");
    // Each control is switched off on its own (not a disabled fieldset), so the "?" help beside a field still opens.
    const ro = Boolean(noSettings);
    const noRun = here.why("ai_studio.tests.run");

    const current = data.data?.hooks.find((h) => h.environment === place);
    // A new place (or fresh data) starts the form from what is saved there.
    useEffect(() => {
        setDraft(draftOf(current));
        setOutcome(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [place, current?.updatedAt]);

    const places = [{ value: "", label: "Runs against the project’s own address" }, ...(envs.data?.environments ?? []).filter((e) => !e.production).map((e) => ({ value: e.name, label: `Runs against ${e.name}` }))];
    const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
    const setHeader = (i: number, patch: Partial<HeaderRow>) => set({ headers: draft.headers.map((h, k) => (k === i ? { ...h, ...patch } : h)) });

    async function save() {
        setBusy("save");
        setError("");
        setNotice("");
        try {
            await api(`/projects/${projectId}/test-data-reset`, {
                method: "PUT",
                body: {
                    environment: place,
                    enabled: draft.enabled,
                    method: draft.method,
                    url: draft.url.trim(),
                    expectedStatus: Number(draft.expectedStatus) || 200,
                    headers: draft.headers.filter((h) => h.name.trim()).map((h) => ({ name: h.name.trim(), ...(h.value !== "" || !h.saved ? { value: h.value } : {}) })),
                },
            });
            setNotice(draft.enabled ? "Saved. Runs reset the test data first." : "Saved, switched off. Runs do not reset the test data.");
            await data.reload();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy("");
        }
    }

    async function tryIt() {
        setBusy("try");
        setError("");
        setNotice("");
        try {
            setOutcome(await api<ResetOutcome>(`/projects/${projectId}/test-data-reset/try`, { method: "POST", body: { environment: place } }));
            await data.reload();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy("");
        }
    }

    async function remove() {
        setBusy("remove");
        setError("");
        setNotice("");
        try {
            await api(`/projects/${projectId}/test-data-reset?environment=${encodeURIComponent(place)}`, { method: "DELETE" });
            setNotice("Removed. Runs do not reset the test data.");
            await data.reload();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy("");
        }
    }

    const head = (
        <div className="row">
            <RotateCcw size={18} aria-hidden />
            <h2 className="t-section">Reset the test data before a run</h2>
        </div>
    );
    if (data.loading) {
        return (
            <section className="card card-pad stack-sm" aria-label="Reset the test data before a run">
                <Skeleton h={18} w={220} />
                <Skeleton h={64} />
            </section>
        );
    }
    if (data.error || !data.data) {
        return (
            <section className="card card-pad stack-sm" aria-label="Reset the test data before a run">
                {head}
                <Callout tone="warning" title="Could not load the reset settings" actions={<Button size="sm" onClick={() => void data.reload()}>Try again</Button>}>
                    Your tests are not affected. Try again in a moment.
                </Callout>
            </section>
        );
    }
    const methods = data.data.methods;
    return (
        <section className="card card-pad stack-sm" data-testid="reset-hook" aria-label="Reset the test data before a run">
            {head}
            <p className="t-secondary">
                Optional. The platform calls one address of your application before the tests run, so they start from the same data every time. If the call fails, the run stops and no test result changes. Production environments are never reset.
            </p>
            {places.length > 1 && (
                <div className="field">
                    <label htmlFor="wp-place">For</label>
                    <select id="wp-place" className="input" value={place} onChange={(e) => setPlace(e.target.value)}>
                        {places.map((p) => (
                            <option key={p.value} value={p.value}>
                                {p.label}
                            </option>
                        ))}
                    </select>
                </div>
            )}
            <label className="check">
                <input disabled={ro} type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
                <span>
                    <span className="title">Reset the test data before each run</span>
                    <span className="hint">Runs of existing tests only. An exploration makes its own data.</span>
                </span>
            </label>
            <div className="wp-grid">
                <div className="field">
                    <label htmlFor="wp-method">Method</label>
                    <select disabled={ro} id="wp-method" className="input" value={draft.method} onChange={(e) => set({ method: e.target.value })}>
                        {methods.map((m) => (
                            <option key={m}>{m}</option>
                        ))}
                    </select>
                </div>
                <div className="field wp-grow">
                    <label htmlFor="wp-url">Address</label>
                    <input disabled={ro} id="wp-url" className="input" value={draft.url} placeholder="/test/reset" autoComplete="off" aria-describedby="wp-url-hint" onChange={(e) => set({ url: e.target.value })} />
                    <p className="hint" id="wp-url-hint">
                        A path of your application, or a full address on the same site.
                    </p>
                </div>
                <div className="field">
                    <FieldHelp htmlFor="wp-status" label="Expected answer" help="The HTTP status the reset must answer with, such as 200 or 204. Any other answer stops the run before the tests start." />
                    <input disabled={ro} id="wp-status" className="input bld-narrow" inputMode="numeric" value={draft.expectedStatus} onChange={(e) => set({ expectedStatus: e.target.value.replace(/\D/g, "").slice(0, 3) })} />
                </div>
            </div>
            <fieldset className="wp-headers">
                <legend>Headers (optional)</legend>
                <p className="hint">For example a token your test endpoint checks. Values are stored encrypted and never shown again.</p>
                {draft.headers.map((h, i) => (
                    <div className="wp-header" key={i}>
                        <div className="field">
                            <label htmlFor={`wp-h${i}-name`}>Name</label>
                            <input id={`wp-h${i}-name`} className="input" value={h.name} autoComplete="off" disabled={ro || h.saved} onChange={(e) => setHeader(i, { name: e.target.value })} />
                        </div>
                        <div className="field wp-grow">
                            <label htmlFor={`wp-h${i}-value`}>Value</label>
                            <input disabled={ro} id={`wp-h${i}-value`} className="input" type="password" autoComplete="new-password" value={h.value} placeholder={h.saved ? "Saved. Type to replace it" : ""} onChange={(e) => setHeader(i, { value: e.target.value })} />
                        </div>
                        <Button disabled={ro} size="sm" variant="ghost" iconOnly icon={X} aria-label={`Remove the header ${h.name || i + 1}`} onClick={() => set({ headers: draft.headers.filter((_, k) => k !== i) })} />
                    </div>
                ))}
                {draft.headers.length < data.data.limits.headers && (
                    <Button disabled={ro} size="sm" variant="ghost" icon={Plus} onClick={() => set({ headers: [...draft.headers, { name: "", value: "", saved: false }] })}>
                        Add a header
                    </Button>
                )}
            </fieldset>
            {current?.last && (
                <p className="t-meta" data-testid="reset-last">
                    Last call {relativeTime(current.last.at)}: {current.last.ok ? "worked" : "failed"}. {current.last.message}
                </p>
            )}
            <div className="row wrap">
                <Button variant="primary" loading={busy === "save"} disabled={busy !== "" || !draft.url.trim() || Boolean(noSettings)} tip={noSettings} onClick={() => void save()}>
                    Save
                </Button>
                {current && (
                    <Button loading={busy === "try"} disabled={busy !== "" || Boolean(noRun)} onClick={() => void tryIt()} tip={noRun ?? "Sends the saved reset request once now, to see that it works. No test runs."}>
                        Try it now
                    </Button>
                )}
                {current && !noSettings && (
                    <Button variant="ghost" loading={busy === "remove"} disabled={busy !== ""} onClick={() => void remove()} tip="Deletes this reset request. Runs no longer reset the test data.">
                        Remove
                    </Button>
                )}
            </div>
            {outcome && (
                <Callout tone={outcome.ok ? "success" : "danger"} title={outcome.ok ? "The reset worked" : "The reset failed"}>
                    <span role="status" data-testid="reset-outcome">
                        {outcome.message}
                    </span>
                </Callout>
            )}
            {error && <Callout tone="danger">{error}</Callout>}
            {notice && (
                <Callout tone="success">
                    <span role="status">{notice}</span>
                </Callout>
            )}
        </section>
    );
}
