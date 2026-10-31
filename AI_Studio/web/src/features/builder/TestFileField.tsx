import { useFetch } from "../../lib/hooks";
import { routes } from "../../lib/router";
import type { TestFilesAnswer } from "../webpages/webpages";

interface Props {
    id: string;
    label: string;
    help?: string;
    projectId: string;
    value: string;
    onChange: (v: string) => void;
}

/** Choose one of the project's test files for an upload step. A name the library does not have is kept and said plainly. */
export function TestFileField({ id, label, help, projectId, value, onChange }: Props) {
    const files = useFetch<TestFilesAnswer>(projectId ? `/projects/${projectId}/test-files` : null);
    const names = (files.data?.files ?? []).map((f) => f.name);
    const known = names.includes(value);
    return (
        <div className="field">
            <label htmlFor={id}>{label}</label>
            {files.loading ? (
                <p className="hint">Loading the test files…</p>
            ) : (
                <select id={id} className="input" value={value} aria-describedby={`${id}-hint`} onChange={(e) => onChange(e.target.value)}>
                    {!known && <option value={value}>{value ? `${value} (not in the test files)` : "Choose a file"}</option>}
                    {names.map((n) => (
                        <option key={n} value={n}>
                            {n}
                        </option>
                    ))}
                </select>
            )}
            <p className="hint" id={`${id}-hint`}>
                {files.error ? "The test files could not be loaded. " : names.length === 0 && !files.loading ? "This project has no test files yet. " : ""}
                {help} <a href={routes.library(projectId, "data")}>Manage test files</a>
            </p>
        </div>
    );
}
