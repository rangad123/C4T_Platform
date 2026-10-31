import { ASSERT_INFO, RESPONSE_INFO, fieldsFor, looksSecret, setCheck, setField, type Catalog, type FieldDef, type Step } from "./builder";
import { JsonField, MapField, TextField, type Placeholders } from "./Fields";
import { LocatorField, type SharedElement } from "./LocatorField";
import type { Block } from "../blocks/blocks";
import { UseBlockForm } from "../blocks/UseBlockForm";
import { TestFileField } from "./TestFileField";

interface Props {
    /** Unique per step on the page. */
    id: string;
    step: Step;
    onChange: (s: Step) => void;
    catalog: Catalog;
    placeholders: Placeholders;
    shared: SharedElement[] | null;
    /** The project's reusable steps (for a "Run reusable steps" step); null while they load. */
    blocks?: Block[] | null;
    projectId?: string;
}

const KEYS = ["Enter", "Tab", "Escape", "Space", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"];
/** These checks compare numbers, so a typed number is stored as one. */
const NUMERIC = new Set(["status", "statusBelow", "count"]);

function expectedFrom(step: Step, text: string): string | number | undefined {
    if (text === "") return undefined;
    const numeric = (step.action === "assert" && step.check === "count") || (step.action === "assertResponse" && NUMERIC.has(String(step.check)));
    return numeric && /^\d+$/.test(text.trim()) ? Number(text) : text;
}

/** The form for one step, built from the field table: every action the schema has, with typed fields. */
export function StepForm({ id, step, onChange, catalog, placeholders, shared, blocks = null, projectId = "" }: Props) {
    const set = (name: string, value: unknown) => onChange(setField(step, name, value));
    if (step.action === "useBlock") return <UseBlockForm id={id} projectId={projectId} step={step} onChange={onChange} placeholders={placeholders} blocks={blocks} />;
    const fields = fieldsFor(step);

    function render(f: FieldDef) {
        const fid = `${id}-${f.name}`;
        switch (f.kind) {
            case "locator":
            case "optLocator":
                return <LocatorField key={f.name} id={fid} label={f.label} value={step[f.name]} optional={f.kind === "optLocator"} shared={shared} catalog={catalog} onChange={(l) => set(f.name, l)} />;
            case "text": {
                const raw = step[f.name];
                const secret = step.action === "fill" && f.name === "value" && looksSecret(step.locator);
                return (
                    <TextField
                        key={f.name}
                        id={fid}
                        label={f.label}
                        help={f.help}
                        required={f.required}
                        placeholder={f.placeholder}
                        value={raw === undefined ? "" : String(raw)}
                        offer={f.placeholders ? placeholders : undefined}
                        secret={secret}
                        onChange={(v) => (f.name === "expected" ? set("expected", expectedFrom(step, v)) : f.required ? onChange({ ...step, [f.name]: v }) : set(f.name, v))}
                    />
                );
            }
            case "key":
                return <TextField key={f.name} id={fid} label={f.label} help={f.help} required value={String(step.key ?? "")} list={KEYS} onChange={(v) => onChange({ ...step, key: v })} />;
            case "flag":
                // Ticked = true; unticked removes the key, so a step that never used it stays exactly as it was.
                return (
                    <div className="field" key={f.name}>
                        <label className="bld-check" htmlFor={fid}>
                            <input id={fid} type="checkbox" checked={step[f.name] === true} aria-describedby={f.help ? `${fid}-hint` : undefined} onChange={(e) => set(f.name, e.target.checked ? true : undefined)} />
                            <span>{f.label}</span>
                        </label>
                        {f.help && (
                            <p className="hint" id={`${fid}-hint`}>
                                {f.help}
                            </p>
                        )}
                    </div>
                );
            case "testFile":
                return <TestFileField key={f.name} id={fid} label={f.label} help={f.help} projectId={projectId} value={String(step[f.name] ?? "")} onChange={(v) => onChange({ ...step, [f.name]: v })} />;
            case "ms":
                return (
                    <div className="field" key={f.name}>
                        <label htmlFor={fid}>{f.label}</label>
                        <input id={fid} className="input bld-narrow" type="number" min={0} max={10000} step={100} value={step.ms ?? 0} aria-describedby={`${fid}-hint`} onChange={(e) => onChange({ ...step, ms: Math.max(0, Math.min(10000, Math.floor(Number(e.target.value) || 0))) })} />
                        <p className="hint" id={`${fid}-hint`}>
                            {f.help}
                        </p>
                    </div>
                );
            case "tick":
                return (
                    <div className="field" key={f.name}>
                        <label htmlFor={fid}>{f.label}</label>
                        <select id={fid} className="input" value={step.checked === false ? "no" : "yes"} onChange={(e) => onChange({ ...step, checked: e.target.value === "yes" })}>
                            <option value="yes">Tick it</option>
                            <option value="no">Untick it</option>
                        </select>
                    </div>
                );
            case "method":
                return (
                    <div className="field" key={f.name}>
                        <label htmlFor={fid}>{f.label}</label>
                        <select id={fid} className="input" value={step.method ?? "GET"} onChange={(e) => onChange({ ...step, method: e.target.value })}>
                            {catalog.httpMethods.map((m) => (
                                <option key={m}>{m}</option>
                            ))}
                        </select>
                    </div>
                );
            case "emailUse":
                return (
                    <div className="field" key={f.name}>
                        <label htmlFor={fid}>{f.label}</label>
                        <select id={fid} className="input" value={step.use === "link" ? "link" : "code"} onChange={(e) => onChange(e.target.value === "link" ? { ...step, use: "link", locator: undefined } : { ...step, use: "code" })}>
                            <option value="code">Its code, typed into a field</option>
                            <option value="link">Its link, opened in the page</option>
                        </select>
                    </div>
                );
            case "auth":
                return (
                    <div className="field" key={f.name}>
                        <label htmlFor={fid}>{f.label}</label>
                        <select id={fid} className="input" value={step.auth === "none" ? "none" : "default"} onChange={(e) => onChange({ ...step, auth: e.target.value })}>
                            <option value="default">Use the saved sign-in</option>
                            <option value="none">Send without signing in</option>
                        </select>
                    </div>
                );
            case "map":
                return <MapField key={f.name} id={fid} label={f.label} help={f.help} value={step[f.name]} onChange={(v) => set(f.name, v)} nameLabel={f.name === "extract" ? "Name to remember it as" : "Name"} valueLabel={f.name === "extract" ? "Where in the answer" : "Value"} />;
            case "json":
                return <JsonField key={f.name} id={fid} label={f.label} help={f.help} value={step[f.name]} onChange={(v) => set(f.name, v)} />;
            case "assertCheck":
            case "responseCheck": {
                const info = f.kind === "assertCheck" ? ASSERT_INFO : RESPONSE_INFO;
                const all = f.kind === "assertCheck" ? catalog.assertChecks : catalog.responseChecks;
                const known = all.filter((c) => info[c]);
                const common = known.filter((c) => !info[c]!.more);
                const more = known.filter((c) => info[c]!.more);
                return (
                    <div className="field" key={f.name}>
                        <label htmlFor={fid}>{f.label}</label>
                        <select id={fid} className="input" value={String(step.check ?? "")} onChange={(e) => onChange(setCheck(step, e.target.value))}>
                            {!known.includes(String(step.check)) && <option value={String(step.check ?? "")}>{String(step.check ?? "")}</option>}
                            <optgroup label="Common checks">
                                {common.map((c) => (
                                    <option key={c} value={c}>
                                        {info[c]!.label}
                                    </option>
                                ))}
                            </optgroup>
                            <optgroup label="More checks">
                                {more.map((c) => (
                                    <option key={c} value={c}>
                                        {info[c]!.label}
                                    </option>
                                ))}
                            </optgroup>
                        </select>
                    </div>
                );
            }
        }
    }

    return (
        <div className="bld-form" data-testid="step-form">
            {fields.map(render)}
            <TextField id={`${id}-description`} label="Note for this step (optional)" help="Shown instead of the automatic wording." value={String(step.description ?? "")} maxLength={500} onChange={(v) => set("description", v)} />
        </div>
    );
}
