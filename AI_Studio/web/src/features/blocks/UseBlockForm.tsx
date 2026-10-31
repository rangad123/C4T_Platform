import { useState } from "react";
import { LinkButton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { stepSentence } from "../../lib/labels";
import { routes } from "../../lib/router";
import { setField, type Step } from "../builder/builder";
import { TextField, type Placeholders } from "../builder/Fields";
import type { Block } from "./blocks";
import "./blocks.css";

/** Values for a block's parameters: a blank value means "use the default", so only what was typed is kept. */
export function argsWith(step: Step, name: string, value: string): Step {
    const args = { ...((step.args as Record<string, string> | undefined) ?? {}) };
    if (value === "") delete args[name];
    else args[name] = value;
    return setField(step, "args", Object.keys(args).length ? args : undefined);
}

/** A read-only list of the steps inside reusable steps, fetched when it is opened. */
export function BlockSteps({ projectId, name }: { projectId: string; name: string }) {
    const [open, setOpen] = useState(false);
    const one = useFetch<Block>(open ? `/projects/${projectId}/blocks/${encodeURIComponent(name)}` : null);
    return (
        <details className="blk-inside" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
            <summary>Show the steps inside</summary>
            {one.loading && <p className="hint">Loading the steps.</p>}
            {one.error && <p className="error-text">The steps could not be loaded. Close this and open it again.</p>}
            {one.data?.steps && (
                <ol className="blk-inside-steps" aria-label={`Steps inside ${name}`}>
                    {one.data.steps.map((s, i) => (
                        <li key={i}>{s.description?.trim() || stepSentence(s)}</li>
                    ))}
                </ol>
            )}
        </details>
    );
}

interface Props {
    id: string;
    projectId: string;
    step: Step;
    onChange: (s: Step) => void;
    placeholders: Placeholders;
    /** The project's reusable steps that fit this test; null while they load. */
    blocks: Block[] | null;
}

/** The form of a "Run reusable steps" step: which steps, a value for each parameter, what is inside them and where to change them. */
export function UseBlockForm({ id, projectId, step, onChange, placeholders, blocks }: Props) {
    const name = String(step.block ?? "");
    const chosen = blocks?.find((b) => b.name === name);
    const args = (step.args as Record<string, string> | undefined) ?? {};
    return (
        <div className="bld-form" data-testid="step-form">
            <div className="field">
                <label htmlFor={`${id}-block`}>Reusable steps</label>
                <select id={`${id}-block`} className="input" value={name} onChange={(e) => onChange({ ...step, block: e.target.value, args: undefined })}>
                    {!chosen && <option value={name}>{name ? `${name} (not found)` : "Choose reusable steps"}</option>}
                    {(blocks ?? []).map((b) => (
                        <option key={b.id} value={b.name}>
                            {b.name}
                        </option>
                    ))}
                </select>
                {blocks && !chosen && name && <p className="error-text">These reusable steps are not in this project, so the test can’t run. Choose others.</p>}
            </div>
            {chosen?.description && <p className="hint">{chosen.description}</p>}
            {chosen &&
                chosen.params.map((p) => (
                    <TextField
                        key={p.name}
                        id={`${id}-arg-${p.name}`}
                        label={p.name}
                        help={`${p.description ? `${p.description}. ` : ""}${p.default !== undefined ? `Leave empty to use “${p.default}”.` : "A value is needed."}`}
                        required={p.default === undefined}
                        value={args[p.name] ?? ""}
                        offer={placeholders}
                        onChange={(v) => onChange(argsWith(step, p.name, v))}
                    />
                ))}
            {chosen && chosen.params.length === 0 && <p className="hint">These steps take no values.</p>}
            {name && chosen && <BlockSteps projectId={projectId} name={name} />}
            {name && (
                <p>
                    <LinkButton size="sm" href={routes.blocks(projectId, name)}>
                        Edit the reusable steps
                    </LinkButton>
                </p>
            )}
            <TextField id={`${id}-description`} label="Note for this step (optional)" help="Shown instead of the automatic wording." value={String(step.description ?? "")} maxLength={500} onChange={(v) => onChange(setField(step, "description", v))} />
        </div>
    );
}
