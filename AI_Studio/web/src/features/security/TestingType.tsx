import { FlaskConical, ShieldCheck } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../api";
import { CollapsedSetting } from "../../components/ProjectHub";
import { Button, Callout } from "../../components/ui";
import { go, routes, useRoute } from "../../lib/router";
import { canRun, useRole } from "./SecurityChrome";
import { TESTING_TYPES, getPendingTestingType, includesSecurity, saveTestingType, sec, setPendingTestingType, useSecurityStatus, useTestingType, type TestingType } from "./security";
import "./security.css";
import { describeApiError } from "../../lib/labels";

/** Functional testing / Security assessment / Both, as three labelled radio cards. */
export function TestingTypeChoice({ value, onChange, name = "testing-type", disabled, legend = "What kind of testing is this project for?" }: { value: TestingType; onChange: (t: TestingType) => void; name?: string; disabled?: boolean; legend?: string }) {
    return (
        <fieldset className="sec-type" data-testid="testing-type">
            <legend className="t-card">{legend}</legend>
            {TESTING_TYPES.map((t) => (
                <label key={t.value} className="check">
                    <input type="radio" name={name} value={t.value} checked={value === t.value} disabled={disabled} onChange={() => onChange(t.value)} />
                    <span>
                        <span className="title">{t.label}</span>
                        <span className="hint">{t.hint}</span>
                    </span>
                </label>
            ))}
        </fieldset>
    );
}

/**
 * The New project page asks the testing type first (only when the module is on). Functional and Both keep today's ways to start;
 * Both also stores the type when the project is made. Security assessment needs only a name, then opens Register application.
 */
export function SecurityStartGate({ children }: { children: ReactNode }) {
    const status = useSecurityStatus();
    const initial = useRoute().query.get("type");
    // The choice survives moving between the ways to start and the full options form (two mounts of this gate).
    const [type, setType] = useState<TestingType>(() => getPendingTestingType() ?? (TESTING_TYPES.some((t) => t.value === initial) ? (initial as TestingType) : "functional"));
    useEffect(() => {
        setPendingTestingType(status?.enabled ? type : undefined);
        return () => setPendingTestingType(undefined);
    }, [type, status?.enabled]);
    if (!status?.enabled) return <>{children}</>;
    return (
        <div className="stack">
            <div className="card card-pad">
                <TestingTypeChoice value={type} onChange={setType} />
            </div>
            {type === "security" ? <NewSecurityProject /> : children}
        </div>
    );
}

function NewSecurityProject() {
    const [name, setName] = useState("");
    const [error, setError] = useState("");
    const [problem, setProblem] = useState("");
    const [busy, setBusy] = useState(false);
    async function create(e: React.FormEvent) {
        e.preventDefault();
        if (!name.trim()) return setError("Enter a name for the project, for example the client’s name.");
        setError("");
        setProblem("");
        setBusy(true);
        try {
            const id = (await api<{ id: string }>("/projects", { method: "POST", body: { name: name.trim() } })).id;
            setPendingTestingType(undefined);
            try {
                await saveTestingType(id, "security");
            } catch (err) {
                // The project exists; say so plainly and let the person set the type in Settings.
                setProblem(`The project was made, but its testing type was not saved: ${describeApiError(err)} Set it under Settings.`);
                setBusy(false);
                return;
            }
            go(sec.newApplication(id));
        } catch (err) {
            setProblem(describeApiError(err));
            setBusy(false);
        }
    }
    return (
        <form className="card card-pad stack" onSubmit={(e) => void create(e)} noValidate aria-labelledby="sec-new-title">
            <div className="stack-sm">
                <h2 className="t-section" id="sec-new-title">
                    A project for security assessment
                </h2>
                <p className="t-secondary">Next you register the application, record the client’s authorization, and run a passive, read-only assessment. Nothing is sent to the application before that.</p>
            </div>
            <div className="field">
                <label htmlFor="sec-project-name">Project name</label>
                <input id="sec-project-name" className="input" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!error} aria-describedby={error ? "sec-project-name-err" : undefined} placeholder="For example the client’s name" />
                {error && (
                    <div className="error-text" id="sec-project-name-err">
                        {error}
                    </div>
                )}
            </div>
            {problem && (
                <Callout tone="danger" title="We couldn’t make the project">
                    {problem}
                </Callout>
            )}
            <div className="row">
                <Button type="submit" variant="primary" icon={ShieldCheck} loading={busy}>
                    Create project
                </Button>
            </div>
        </form>
    );
}

/** Setup: the project's testing type, shown above the Setup sections when the module is on. */
export function TestingTypeSetting({ id }: { id: string }) {
    const info = useTestingType(id);
    const role = useRole();
    const [value, setValue] = useState<TestingType | undefined>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState("");
    if (!info?.available) return null;
    const current = value ?? info.type;
    const label = TESTING_TYPES.find((t) => t.value === info.type)!.label;
    async function save() {
        setBusy(true);
        setError("");
        setSaved("");
        try {
            await saveTestingType(id, current);
            setSaved(includesSecurity(current) ? "Saved. The Security assessment section is on for this project." : "Saved. The Security assessment section is hidden for this project; its applications and findings are kept.");
            setValue(undefined);
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy(false);
        }
    }
    return (
        <div style={{ marginBottom: 16 }} data-tour="testing-type">
            <CollapsedSetting title="Testing type" summary={`${label}.${info.problem ? ` ${info.problem}` : ""}`} testId="setting-testing-type" extra={includesSecurity(info.type) ? <a className="btn btn-ghost" href={sec.overview(id)}><ShieldCheck size={18} aria-hidden />Open security assessment</a> : info.type === "functional" ? undefined : <a className="btn btn-ghost" href={routes.tests(id)}><FlaskConical size={18} aria-hidden />Open tests</a>}>
                <div className="stack-sm">
                    <TestingTypeChoice value={current} onChange={setValue} name={`testing-type-${id}`} disabled={!canRun(role)} legend="What is this project for?" />
                    <p className="hint">Changing it never deletes anything: functional tests and security findings are kept and stay apart.{canRun(role) ? "" : " Your role can look but not change this."}</p>
                    {error && <Callout tone="danger" title="We couldn’t save the testing type">{error}</Callout>}
                    {saved && (
                        <p className="t-secondary" role="status">
                            {saved}
                        </p>
                    )}
                    <div className="row">
                        <Button variant="primary" loading={busy} disabled={!canRun(role) || current === info.type} onClick={() => void save()}>
                            Save testing type
                        </Button>
                    </div>
                </div>
            </CollapsedSetting>
        </div>
    );
}

/** The project's tab bar: a Security assessment tab after Setup when the project includes it. */
export function SecurityProjectTab({ id }: { id: string }) {
    const info = useTestingType(id);
    if (!info?.available || !includesSecurity(info.type)) return null;
    return (
        <a className="tab tab-sec" href={sec.overview(id)}>
            <ShieldCheck size={16} aria-hidden />
            Security assessment
        </a>
    );
}
