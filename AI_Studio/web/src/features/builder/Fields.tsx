import { Plus, X } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui";
import { Tooltip } from "../../components/Tooltip";
import { isSafePlaceholder, type SpecAnswer } from "./builder";

export type Placeholders = SpecAnswer["placeholders"];

interface TextProps {
    id: string;
    label: string;
    help?: string;
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    required?: boolean;
    /** The {{values}} the project offers; omit for a plain text field. */
    offer?: Placeholders;
    /** A secret field: only the sign-in placeholders are offered, never free text. */
    secret?: boolean;
    list?: string[];
    maxLength?: number;
}

/** A text field that can use the project's {{placeholders}}. A secret field is a choice between the saved sign-in values. */
export function TextField({ id, label, help, value, onChange, placeholder, required, offer, secret, list, maxLength }: TextProps) {
    if (secret && offer) {
        const options = offer.credentials;
        const current = value;
        const known = current === "" || options.some((o) => `{{${o}}}` === current);
        return (
            <div className="field">
                <label htmlFor={id}>{label}</label>
                <select id={id} className="input" value={current} onChange={(e) => onChange(e.target.value)} aria-describedby={`${id}-hint`}>
                    <option value="">Leave empty</option>
                    {options.map((o) => (
                        <option key={o} value={`{{${o}}}`}>
                            {o.replace("credentials.", "Saved sign-in: ")}
                        </option>
                    ))}
                    {!known && <option value={current}>{isSafePlaceholder(current) ? current : "Keep the current value"}</option>}
                </select>
                <p className="hint" id={`${id}-hint`}>
                    This looks like a secret field, so the value comes from your saved sign-in details and is never stored in the test.
                </p>
            </div>
        );
    }
    const groups = offer
        ? [
              { label: "Test values", items: offer.values },
              { label: "Saved sign-in", items: offer.credentials },
              { label: "Environment", items: offer.env },
          ].filter((g) => g.items.length)
        : [];
    return (
        <div className="field">
            <label htmlFor={id}>{label}</label>
            <div className="bld-inline">
                <input id={id} className="input" aria-required={required || undefined} value={value} placeholder={placeholder} maxLength={maxLength} list={list ? `${id}-list` : undefined} autoComplete="off" onChange={(e) => onChange(e.target.value)} aria-describedby={help ? `${id}-hint` : undefined} />
                {list && (
                    <datalist id={`${id}-list`}>
                        {list.map((k) => (
                            <option key={k} value={k} />
                        ))}
                    </datalist>
                )}
                {groups.length > 0 && (
                    <Tooltip content="Adds {{name}} at the end of the field. The value is filled in when the test runs.">
                    <select
                        className="input bld-insert"
                        aria-label={`Insert a value into ${label.toLowerCase()}`}
                        value=""
                        onChange={(e) => {
                            if (e.target.value) onChange(`${value}{{${e.target.value}}}`);
                        }}
                    >
                        <option value="">Insert a value</option>
                        {groups.map((g) => (
                            <optgroup key={g.label} label={g.label}>
                                {g.items.map((n) => (
                                    <option key={n} value={n}>
                                        {n}
                                    </option>
                                ))}
                            </optgroup>
                        ))}
                    </select>
                    </Tooltip>
                )}
            </div>
            {help && (
                <p className="hint" id={`${id}-hint`}>
                    {help}
                </p>
            )}
        </div>
    );
}

interface MapProps {
    id: string;
    label: string;
    help?: string;
    value: Record<string, string> | undefined;
    onChange: (v: Record<string, string> | undefined) => void;
    nameLabel?: string;
    valueLabel?: string;
    /** Names that cannot be edited here (kept as they are). */
    hidden?: string[];
}

/** Name and value rows, for query values, headers, remembered values and the test's own values. */
export function MapField({ id, label, help, value, onChange, nameLabel = "Name", valueLabel = "Value", hidden = [] }: MapProps) {
    const [rows, setRows] = useState<Array<[string, string]>>(() => Object.entries(value ?? {}).filter(([k]) => !hidden.includes(k)));
    const push = (next: Array<[string, string]>) => {
        setRows(next);
        const kept = Object.fromEntries((value ? Object.entries(value).filter(([k]) => hidden.includes(k)) : []) as Array<[string, string]>);
        const obj: Record<string, string> = { ...kept };
        for (const [k, v] of next) if (k.trim() && !(k in obj)) obj[k.trim()] = v;
        onChange(Object.keys(obj).length ? obj : undefined);
    };
    return (
        <fieldset className="bld-map">
            <legend>{label}</legend>
            {help && <p className="hint">{help}</p>}
            {rows.map(([k, v], i) => (
                <div className="bld-map-row" key={i}>
                    <div className="field">
                        <label htmlFor={`${id}-k${i}`}>{nameLabel}</label>
                        <input id={`${id}-k${i}`} className="input" value={k} autoComplete="off" onChange={(e) => push(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
                    </div>
                    <div className="field">
                        <label htmlFor={`${id}-v${i}`}>{valueLabel}</label>
                        <input id={`${id}-v${i}`} className="input" value={v} autoComplete="off" onChange={(e) => push(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
                    </div>
                    <Button type="button" variant="ghost" iconOnly icon={X} className="bld-ibtn" aria-label={`Remove ${label.toLowerCase()} row ${i + 1}`} onClick={() => push(rows.filter((_, j) => j !== i))} />
                </div>
            ))}
            <div>
                <Button type="button" size="sm" icon={Plus} onClick={() => push([...rows, ["", ""]])}>
                    Add a row
                </Button>
            </div>
        </fieldset>
    );
}

interface JsonProps {
    id: string;
    label: string;
    help?: string;
    value: unknown;
    onChange: (v: unknown) => void;
    required?: boolean;
}

/** A JSON text box that only passes on text that parses; what is wrong is said next to it. */
export function JsonField({ id, label, help, value, onChange }: JsonProps) {
    const [text, setText] = useState(() => (value === undefined ? "" : JSON.stringify(value, null, 2)));
    const [bad, setBad] = useState("");
    return (
        <div className="field">
            <label htmlFor={id}>{label}</label>
            <textarea
                id={id}
                className="input bld-json"
                rows={5}
                spellCheck={false}
                value={text}
                aria-invalid={!!bad}
                aria-describedby={`${id}-hint`}
                onChange={(e) => {
                    const t = e.target.value;
                    setText(t);
                    if (t.trim() === "") {
                        setBad("");
                        return onChange(undefined);
                    }
                    try {
                        onChange(JSON.parse(t));
                        setBad("");
                    } catch {
                        setBad("That is not valid JSON yet, so it is not used. Check the quotes, commas and brackets.");
                    }
                }}
            />
            <p className={bad ? "error-text" : "hint"} id={`${id}-hint`} role={bad ? "alert" : undefined}>
                {bad || help || "JSON, for example {\"name\": \"Ada\"}."}
            </p>
        </div>
    );
}
