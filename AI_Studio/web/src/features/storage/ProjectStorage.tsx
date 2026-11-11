import { Archive, Download, Trash2, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError, csrfHeader, getKey } from "../../api";
import { Modal } from "../../components/Modal";
import { Badge, Button, Callout, FilePicker, Skeleton } from "../../components/ui";
import { downloadBlob, formatBytes, plural, relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { useCan } from "../auth/permissions";
import { useHere } from "../auth/project-access";
import { UsageBar } from "./StorageSettings";
import { FieldHelp } from "../../components/Tooltip";
import { logLine, type Preview, type ProjectStorage as ProjectStorageData, type RestoreResult, type RetentionState } from "./storage";
import "./storage.css";

interface Form {
    enabled: boolean;
    keepDays: string;
    keepFailedDays: string;
    keepLatestRuns: string;
    maxArtifactMB: string;
}
const toForm = (r: RetentionState): Form => ({
    enabled: r.policy.enabled,
    keepDays: String(r.policy.keepDays),
    keepFailedDays: String(r.policy.keepFailedDays),
    keepLatestRuns: String(r.policy.keepLatestRuns),
    maxArtifactMB: r.policy.maxArtifactMB ? String(r.policy.maxArtifactMB) : "",
});
const num = (s: string) => (s.trim() === "" ? NaN : Number(s));
const bodyOf = (f: Form) => ({ enabled: f.enabled, keepDays: num(f.keepDays), keepFailedDays: num(f.keepFailedDays), keepLatestRuns: num(f.keepLatestRuns), maxArtifactMB: f.maxArtifactMB.trim() === "" ? null : num(f.maxArtifactMB) });

/** Raw requests (a zip goes in and out, so these are not JSON calls). */
async function raw(path: string, init?: { method?: string; body?: Blob }): Promise<Response> {
    let res: Response;
    try {
        res = await fetch(`/api${path}`, { method: init?.method ?? "GET", headers: { ...(init?.body ? { "content-type": "application/octet-stream" } : {}), ...(getKey() ? { "x-api-key": getKey() } : {}), ...csrfHeader(init?.method) }, body: init?.body });
    } catch {
        throw new ApiError(0, "Could not reach the platform server");
    }
    if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new ApiError(res.status, data.error || res.statusText);
    }
    return res;
}

/** On a project: what its files use, when old ones are removed, and a backup to download or restore. */
export function ProjectStorage({ projectId }: { projectId: string }) {
    const storage = useFetch<ProjectStorageData>(`/projects/${projectId}/storage`);
    const retention = useFetch<RetentionState>(`/projects/${projectId}/retention`);
    const [form, setForm] = useState<Form | null>(null);
    const [saved, setSaved] = useState<Form | null>(null);
    const [busy, setBusy] = useState<"" | "save" | "preview" | "run" | "backup" | "restore">("");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [preview, setPreview] = useState<Preview | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [withFiles, setWithFiles] = useState(false);
    const [withoutSecurity, setWithoutSecurity] = useState(false);
    const [file, setFile] = useState<File | null>(null);
    const [restored, setRestored] = useState<RestoreResult | null>(null);
    // What the server asks: the clean-up settings, removing now and the backup are platform settings (in this project); the preview
    // and "I have entered them" are project settings; restoring makes a new project, so it is the platform-wide permission.
    const here = useHere(projectId);
    const noPlatform = here.why("ai_studio.platform.settings");
    const noSettings = here.why("ai_studio.project.settings");
    const mayRestore = useCan()("ai_studio.platform.settings");

    useEffect(() => {
        if (retention.data && !form) {
            setForm(toForm(retention.data));
            setSaved(toForm(retention.data));
        }
    }, [retention.data, form]);

    const loading = (storage.loading || retention.loading) && !storage.data;
    if (loading) {
        return (
            <section className="card card-pad stack-sm" aria-label="Storage and backup">
                <Skeleton w={200} h={20} />
                <Skeleton h={60} />
            </section>
        );
    }
    if (storage.error || retention.error || !storage.data || !retention.data || !form || !saved) {
        return (
            <section className="card card-pad stack-sm" aria-label="Storage and backup">
                <h2 className="t-section">Storage and backup</h2>
                <Callout tone="warning" title="Could not load storage details" actions={<Button size="sm" onClick={() => { void storage.reload(); void retention.reload(); }}>Try again</Button>}>
                    This does not affect your tests. Try again in a moment.
                </Callout>
            </section>
        );
    }

    const s = storage.data;
    const r = retention.data;
    const dirty = JSON.stringify(form) !== JSON.stringify(saved);
    const setField = (k: keyof Form, v: string | boolean) => {
        setForm({ ...form, [k]: v });
        setPreview(null);
        setNotice("");
    };

    async function save() {
        setBusy("save");
        setError("");
        setNotice("");
        try {
            await api(`/projects/${projectId}/retention`, { method: "PUT", body: bodyOf(form!) });
            setSaved(form);
            setNotice(form!.enabled ? "Saved. Old files will be removed once a day, and never while a run is going." : "Saved. Nothing is removed automatically.");
            await retention.reload();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy("");
        }
    }

    async function showPreview() {
        setBusy("preview");
        setError("");
        setNotice("");
        try {
            setPreview(await api<Preview>(`/projects/${projectId}/retention/preview`, { method: "POST", body: bodyOf(form!) }));
        } catch (e) {
            setPreview(null);
            setError(describeApiError(e));
        } finally {
            setBusy("");
        }
    }

    async function run() {
        setConfirming(false);
        setBusy("run");
        setError("");
        try {
            const out = await api<{ sentence: string }>(`/projects/${projectId}/retention/run`, { method: "POST", body: { confirm: true } });
            setNotice(out.sentence);
            setPreview(null);
            await Promise.all([storage.reload(), retention.reload()]);
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy("");
        }
    }

    async function backup() {
        setBusy("backup");
        setError("");
        try {
            const res = await raw(`/projects/${projectId}/backup?evidence=${withFiles}${withoutSecurity && storage.data?.securityData ? "&withoutSecurity=true" : ""}`);
            const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "backup.zip";
            downloadBlob(await res.blob(), name);
            setNotice("The backup was downloaded. It holds no passwords, tokens or other secrets.");
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy("");
        }
    }

    async function restore() {
        if (!file) return;
        setBusy("restore");
        setError("");
        setRestored(null);
        try {
            const res = await raw(`/projects/restore`, { method: "POST", body: file });
            setRestored((await res.json()) as RestoreResult);
            setFile(null);
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy("");
        }
    }

    async function clearNeeds() {
        await api(`/projects/${projectId}/restore-needs`, { method: "DELETE" });
        await storage.reload();
    }

    const canRemove = saved.enabled && !dirty && r.policy.enabled && !r.busy;
    const keptLines = preview
        ? Object.entries(preview.kept).filter(([, n]) => n > 0).map(([k, n]) => `${plural(n, "old file")} kept: ${KEPT[k] ?? k}`)
        : [];

    return (
        <section className="card card-pad stack-sm st-card" aria-label="Storage and backup" data-testid="storage-card">
            <div className="row">
                <Archive size={18} aria-hidden />
                <h2 className="t-section">Storage and backup</h2>
                <span className="spacer" />
                <Badge tone={r.policy.enabled ? "info" : "neutral"}>{r.policy.enabled ? "Old files are removed automatically" : "Old files are kept"}</Badge>
            </div>
            <p className="t-secondary" data-testid="storage-summary">
                This project’s files use <strong>{s.usage.text}</strong> ({plural(s.usage.files, "file")}).
                {s.removed.files > 0 ? ` ${plural(s.removed.files, "file")} (${s.removed.text}) were removed earlier to save space.` : ""}
            </p>
            <UsageBar usage={s.usage} label={`This project’s files by kind, ${s.usage.text} in total`} />

            {s.needsSecrets.length > 0 && (
                <Callout tone="warning" title="Enter these again, they are not in a backup" actions={<Button size="sm" disabled={Boolean(noSettings)} tip={noSettings} onClick={() => void clearNeeds()}>I have entered them</Button>}>
                    {s.needsSecrets.map((n) => n.label).join("; ")}.
                </Callout>
            )}

            <form
                className="st-block"
                aria-label="Remove old files"
                onSubmit={(e) => {
                    e.preventDefault();
                    void save();
                }}
            >
                <h3 className="t-card">Remove old files</h3>
                <p className="t-secondary">
                    Screenshots, recordings and traces of old runs can be removed to save space. Your tests, their results and history, issues and releases are never removed.
                    {r.source === "platform" && r.platformDefaultDays ? ` This project uses the platform default of ${r.platformDefaultDays} days until you save your own settings.` : ""}
                </p>
                <label className="check">
                    <input type="checkbox" checked={form.enabled} disabled={Boolean(noPlatform)} onChange={(e) => setField("enabled", e.target.checked)} />
                    <span>
                        <span className="title">Remove old files automatically</span>
                        <span className="hint">Once a day, and never while a run is going. Off by default.</span>
                    </span>
                </label>
                <div className="st-grid">
                    <div className="field">
                        <label htmlFor="st-days">Keep files of passed runs for (days)</label>
                        <input id="st-days" className="input" type="number" inputMode="numeric" min={r.limits.keepDays.min} max={r.limits.keepDays.max} value={form.keepDays} disabled={Boolean(noPlatform)} onChange={(e) => setField("keepDays", e.target.value)} />
                    </div>
                    <div className="field">
                        <label htmlFor="st-failed">Keep files of failed runs for (days)</label>
                        <input id="st-failed" className="input" type="number" inputMode="numeric" min={r.limits.keepFailedDays.min} max={r.limits.keepFailedDays.max} value={form.keepFailedDays} disabled={Boolean(noPlatform)} onChange={(e) => setField("keepFailedDays", e.target.value)} />
                    </div>
                    <div className="field">
                        <FieldHelp htmlFor="st-latest" label="Always keep the latest runs of each test" helpLabel="keeping the newest runs" help="The newest runs of every test, per browser and environment, keep their files however old they are." />
                        <input id="st-latest" className="input" type="number" inputMode="numeric" min={r.limits.keepLatestRuns.min} max={r.limits.keepLatestRuns.max} value={form.keepLatestRuns} disabled={Boolean(noPlatform)} onChange={(e) => setField("keepLatestRuns", e.target.value)} />
                    </div>
                    <div className="field">
                        <FieldHelp htmlFor="st-cap" label="Size limit in MB (optional)" helpLabel="the size limit" help="When this project’s files take more than this, the oldest files that nothing keeps are removed until they fit." />
                        <input id="st-cap" className="input" type="number" inputMode="numeric" min={r.limits.maxArtifactMB.min} placeholder="No limit" value={form.maxArtifactMB} disabled={Boolean(noPlatform)} onChange={(e) => setField("maxArtifactMB", e.target.value)} />
                    </div>
                </div>
                <p className="t-meta">Files of tests that are failing now, of runs an issue or a release is based on, and approved screenshots are always kept.</p>
                <div className="st-actions">
                    <Button type="submit" variant="primary" loading={busy === "save"} disabled={busy !== "" || !dirty || Boolean(noPlatform)} tip={noPlatform}>Save settings</Button>
                    <Button type="button" onClick={() => void showPreview()} loading={busy === "preview"} disabled={busy !== "" || Boolean(noSettings)} tip={noSettings ?? "Counts what the values in the form would remove. Nothing is removed."}>Preview</Button>
                    <Button type="button" variant="danger" icon={Trash2} onClick={() => setConfirming(true)} disabled={busy !== "" || !canRemove || Boolean(noPlatform)} tip={noPlatform}>
                        Remove old files now
                    </Button>
                </div>
                {!canRemove && !noPlatform && <p className="t-meta">{r.busy ? "A run is going. Files can be removed when it has finished." : !saved.enabled ? "Turn on automatic removal and save to remove files." : dirty ? "Save your changes to remove files." : ""}</p>}
                {preview && (
                    <Callout tone="info" title={preview.sentence}>
                        {preview.files > 0 ? `The oldest are from ${new Date(preview.oldest!).toLocaleDateString()}. Nothing has been removed yet.` : "Nothing has been removed."}
                    </Callout>
                )}
                {keptLines.length > 0 && (
                    <ul className="st-kept" aria-label="Old files that are kept">
                        {keptLines.map((l) => (
                            <li key={l}>{l}</li>
                        ))}
                    </ul>
                )}
                {r.recent.length > 0 && (
                    <details>
                        <summary>Recent clean-ups</summary>
                        <ul className="st-history">
                            {r.recent.slice(0, 5).map((x) => (
                                <li key={x.id}>
                                    {logLine(x)} <span className="t-meta">{relativeTime(x.at)}</span>
                                </li>
                            ))}
                        </ul>
                    </details>
                )}
            </form>

            {!noPlatform && <div className="st-block">
                <h3 className="t-card">Backup</h3>
                <p className="t-secondary">A backup holds the tests, scripts, manual cases, releases, runbooks, environments and schedules of this project. It never holds passwords, tokens, webhook addresses or other secrets: you enter those again after restoring.</p>
                <label className="check">
                    <input type="checkbox" checked={withFiles} onChange={(e) => setWithFiles(e.target.checked)} />
                    <span>
                        <span className="title">Include approved screenshots and recent evidence files</span>
                        <span className="hint">Up to 50 MB. Makes the file larger.</span>
                    </span>
                </label>
                {s.securityData && (
                    <label className="check">
                        <input type="checkbox" checked={withoutSecurity} onChange={(e) => setWithoutSecurity(e.target.checked)} />
                        <span>
                            <span className="title">Leave out the security assessment data</span>
                            <span className="hint">For restoring on a platform version from before the security data was part of a backup, which refuses a file that holds it. The download is recorded in Activity.</span>
                        </span>
                    </label>
                )}
                <div className="st-actions">
                    <Button
                        icon={Download}
                        onClick={() => void backup()}
                        loading={busy === "backup"}
                        disabled={busy !== ""}
                        tip={s.securityData && !withoutSecurity ? "Downloads a zip of this project, with its security assessment data: applications, authorizations, assessments and findings. Saved sign-ins and other secrets are never in it." : undefined}
                    >
                        Download backup
                    </Button>
                </div>
                {mayRestore && <>
                <h3 className="t-card" style={{ marginTop: 8 }}>Restore from a backup</h3>
                <p className="t-secondary">Restoring always creates a new project. Nothing in your existing projects changes, and nothing is run: restored tests wait for you to run them.</p>
                <FilePicker id="st-restore" accept=".zip,application/zip" file={file} onChange={(f) => { setFile(f); setRestored(null); }} label="Choose backup file" />
                <div className="st-actions">
                    {/* src/platform/backup.ts restoreBackup and src/security/backup.ts importSecurityData: what a restore brings back. */}
                    <Button
                        icon={Upload}
                        onClick={() => void restore()}
                        loading={busy === "restore"}
                        disabled={busy !== "" || !file}
                        tip={file ? "Security assessment data in the file comes back too: authorizations withdrawn, unfinished assessments stopped, saved sign-ins to enter again." : "Choose a backup file first."}
                    >
                        Restore as a new project
                    </Button>
                </div>
                {restored && (
                    <Callout tone="success" title={restored.message} actions={<a className="btn btn-sm" href={routes.project(restored.project.id)}>Open the new project</a>}>
                        {restored.needsSecrets.length > 0 ? `Enter these again: ${restored.needsSecrets.map((n) => n.label).join("; ")}.` : undefined}
                    </Callout>
                )}
                {restored && restored.notes.length > 0 && (
                    <ul className="st-kept" aria-label="Notes about the restore">
                        {restored.notes.map((n) => (
                            <li key={n}>{n}</li>
                        ))}
                    </ul>
                )}
                </>}
            </div>}

            {error && <Callout tone="danger">{error}</Callout>}
            {notice && <Callout tone="success">{notice}</Callout>}
            {confirming && !noPlatform && <ConfirmRemove projectId={projectId} preview={preview ?? undefined} onCancel={() => setConfirming(false)} onConfirm={() => void run()} />}
        </section>
    );
}

const KEPT: Record<string, string> = {
    kind: "approved screenshots and other files that are never removed",
    "no-run": "files that belong to no run",
    "latest-runs": "the latest runs of each test",
    failure: "tests that are failing now",
    visual: "screenshots waiting to be accepted as the new baseline",
    issue: "the run an issue was filed from",
    release: "the runs a release was based on",
};

/** Asks before removing. It recalculates what will go, so the number is current. */
function ConfirmRemove({ projectId, preview, onCancel, onConfirm }: { projectId: string; preview?: Preview; onCancel: () => void; onConfirm: () => void }) {
    const [fresh, setFresh] = useState<Preview | null>(preview ?? null);
    /** Why the count could not be worked out now: said instead of a check that never ends (Cancel stays). */
    const [failed, setFailed] = useState<string | null>(null);
    useEffect(() => {
        void api<Preview>(`/projects/${projectId}/retention/preview`, { method: "POST" }).then(setFresh, (e) => setFailed(describeApiError(e)));
    }, [projectId]);
    return (
        <Modal
            title="Remove old files?"
            titleId="st-confirm-title"
            onClose={onCancel}
            foot={
                <>
                    <Button onClick={onCancel}>Cancel</Button>
                    <Button variant="danger" icon={Trash2} onClick={onConfirm} disabled={!fresh || fresh.files === 0}>
                        {fresh && fresh.files > 0 ? `Remove ${plural(fresh.files, "file")} (${formatBytes(fresh.bytes)})` : "Nothing to remove"}
                    </Button>
                </>
            }
        >
            {fresh ? <p>{fresh.sentence}</p> : !failed && <p>Checking what would be removed.</p>}
            {failed && (
                <Callout tone="danger" title="Could not check what would be removed">
                    {failed}
                </Callout>
            )}
            <p className="t-secondary">This deletes the files from the disk and cannot be undone. Test results and history stay.</p>
        </Modal>
    );
}
