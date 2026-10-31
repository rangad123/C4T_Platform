import { Table2, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Button, Callout, FilePicker, ListSkeleton } from "../../components/ui";
import { SeeHow } from "../guide/SeeHow";
import { plural, relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import type { DataSetBrief } from "./environments";
import "./environments.css";

interface DataSetFull extends DataSetBrief {
    rows: Array<Record<string, string>>;
    tests: Array<{ id: string; testId: string; title: string }>;
}

const PREVIEW_ROWS = 5;
const NAME_OK = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
/** A file name makes a fine first guess for the data set's name. */
const nameFromFile = (file: string) => file.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[^A-Za-z]+/, "").slice(0, 40);

/**
 * Tests → ⋯ More actions → Test data. A data set is a small table (CSV, JSON or YAML) that a test can name: it is then run once for
 * every row, with the row's values in place of {{column}}. Not a place for passwords: the table ends up inside the downloaded scripts.
 */
export function TestDataPanel({ projectId, onClose }: { projectId: string; onClose?: () => void }) {
    const list = useFetch<{ dataSets: DataSetBrief[]; limits: { maxRows: number; maxColumns: number; maxRowsPerTest: number } }>(`/projects/${projectId}/test-data`);
    const [file, setFile] = useState<File | null>(null);
    const [name, setName] = useState("");
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [open, setOpen] = useState<DataSetFull | null>(null);

    const sets = list.data?.dataSets ?? [];
    const limits = list.data?.limits;
    const exists = sets.some((d) => d.name === name.trim());

    async function send(replace: boolean) {
        if (!file) return;
        setBusy("import");
        setError("");
        setNotice("");
        try {
            const body = { name: name.trim(), content: await file.text(), filename: file.name };
            const res = await api<DataSetBrief>(replace ? `/projects/${projectId}/test-data/${name.trim()}` : `/projects/${projectId}/test-data`, { method: replace ? "PUT" : "POST", body });
            setNotice(`${replace ? "Replaced" : "Imported"} “${res.name}”: ${plural(res.rowCount, "row")}, ${plural(res.columns.length, "column")}.${res.truncated ? ` Only the first ${res.testedRows} rows are tested by one test.` : ""}`);
            setFile(null);
            setName("");
            setOpen(null);
            await list.reload();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy("");
        }
    }

    async function show(d: DataSetBrief) {
        setError("");
        if (open?.name === d.name) return setOpen(null);
        try {
            setOpen(await api<DataSetFull>(`/projects/${projectId}/test-data/${d.name}`));
        } catch (e) {
            setError(describeApiError(e));
        }
    }

    async function remove(d: DataSetBrief) {
        setBusy(`rm-${d.name}`);
        setError("");
        setNotice("");
        try {
            await api(`/projects/${projectId}/test-data/${d.name}`, { method: "DELETE" });
            setNotice(`Removed “${d.name}”.`);
            if (open?.name === d.name) setOpen(null);
            await list.reload();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy("");
        }
    }

    return (
        <section className="card card-pad stack-sm" aria-label="Test data">
            <div className="row">
                <Table2 size={18} aria-hidden />
                <h2 className="t-section">Test data</h2>
                <span className="spacer" />
                {onClose && <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>}
            </div>
            <p className="t-secondary">
                Run one test with many sets of values. Import a table, then name it in a test (<code>dataSet</code> in its test data) and use its columns as {"{{column}}"} in the steps: the test runs once for every row.
                Don’t put passwords here: the table is part of the scripts you download.
            </p>

            {list.loading ? (
                <ListSkeleton rows={2} />
            ) : list.error ? (
                <Callout tone="danger">We couldn’t load the test data. Close this panel and try again.</Callout>
            ) : (
                <>
                    {sets.length === 0 ? (
                        <>
                            <p className="t-meta">No data sets yet.</p>
                            <SeeHow topic="test-data" />
                        </>
                    ) : (
                        <ul className="env-list" aria-label="Saved data sets">
                            {sets.map((d) => (
                                <li key={d.name}>
                                    <div className="row">
                                        <strong>{d.name}</strong>
                                        <span className="t-meta">
                                            {plural(d.rowCount, "row")} · {d.columns.join(", ")}
                                        </span>
                                        <span className="spacer" />
                                        <span className="t-meta">{d.usedBy ? `Used by ${plural(d.usedBy, "test")}` : "Not used yet"} · {relativeTime(d.updatedAt)}</span>
                                    </div>
                                    {d.truncated && <p className="t-meta">A test runs only the first {d.testedRows} of these rows.</p>}
                                    <div className="row">
                                        <Button size="sm" variant="ghost" aria-expanded={open?.name === d.name} onClick={() => void show(d)} aria-label={`${open?.name === d.name ? "Hide" : "Show"} rows of ${d.name}`}>
                                            {open?.name === d.name ? "Hide rows" : "Show rows"}
                                        </Button>
                                        <Button size="sm" variant="ghost" onClick={() => setName(d.name)} aria-label={`Replace ${d.name}`} tip="Puts this name in Import a table below: choose a file there to replace the rows.">Replace</Button>
                                        <span className="spacer" />
                                        <Button size="sm" variant="ghost" icon={Trash2} loading={busy === `rm-${d.name}`} disabled={!!busy} onClick={() => void remove(d)} aria-label={`Remove ${d.name}`} tip={d.usedBy ? "A table a test uses can't be removed: change those tests first." : "Deletes this table at once."}>Remove</Button>
                                    </div>
                                    {open?.name === d.name && (
                                        <div className="data-table-wrap">
                                            <table className="data-table">
                                                <thead>
                                                    <tr>{open.columns.map((c) => <th key={c}>{c}</th>)}</tr>
                                                </thead>
                                                <tbody>
                                                    {open.rows.slice(0, PREVIEW_ROWS).map((r, i) => (
                                                        <tr key={i}>{open.columns.map((c) => <td key={c}>{r[c]}</td>)}</tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                            {open.rows.length > PREVIEW_ROWS && <p className="t-meta" style={{ padding: "6px 10px" }}>…and {open.rows.length - PREVIEW_ROWS} more.</p>}
                                        </div>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}

                    <div className="stack-sm">
                        <h3 className="t-card">Import a table</h3>
                        <FilePicker id="data-file" accept=".csv,.tsv,.json,.yaml,.yml,text/csv,application/json" file={file} label="Choose a CSV, JSON or YAML file" onChange={(f) => { setFile(f); if (f && !name.trim()) setName(nameFromFile(f.name)); }} />
                        <div className="field" style={{ maxWidth: 320 }}>
                            <label htmlFor="data-name">Data set name</label>
                            <input id="data-name" className="input" value={name} placeholder="logins" autoComplete="off" onChange={(e) => setName(e.target.value)} />
                        </div>
                        <p className="t-meta">
                            Up to {limits?.maxRows ?? 200} rows and {limits?.maxColumns ?? 20} columns. One test runs the first {limits?.maxRowsPerTest ?? 25} rows. Excel files aren’t supported yet: save the sheet as CSV.
                        </p>
                        {name.trim() !== "" && !NAME_OK.test(name.trim()) && <Callout tone="warning">The name uses letters, digits, - or _, and starts with a letter.</Callout>}
                        <div className="row">
                            <Button variant="primary" loading={busy === "import"} disabled={!!busy || !file || !NAME_OK.test(name.trim()) || exists} onClick={() => void send(false)}>
                                Import
                            </Button>
                            {exists && (
                                <Button loading={busy === "import"} disabled={!!busy || !file} onClick={() => void send(true)}>
                                    Replace “{name.trim()}”
                                </Button>
                            )}
                        </div>
                    </div>
                    {error && <Callout tone="danger">{error}</Callout>}
                    {notice && <Callout tone="success">{notice}</Callout>}
                </>
            )}
        </section>
    );
}
