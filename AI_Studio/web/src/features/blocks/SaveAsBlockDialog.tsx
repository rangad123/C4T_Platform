import { Plus, X } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Button, Callout } from "../../components/ui";
import { stepSentence } from "../../lib/labels";
import type { Step } from "../builder/builder";
import { Modal } from "../../components/Modal";
import { blockError, type Block } from "./blocks";
import "./blocks.css";

interface Props {
    projectId: string;
    testId: string;
    steps: Step[];
    onClose: () => void;
    /** The steps now live in a block and the test uses it. */
    onDone: (block: Block) => void;
}

interface ParamRow {
    name: string;
    replace: string;
}

const clip = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** "Save these steps as reusable steps": choose a range of steps, name it, and optionally turn some text in them into a value. */
export function SaveAsBlockDialog({ projectId, testId, steps, onClose, onDone }: Props) {
    const [from, setFrom] = useState(0);
    const [to, setTo] = useState(Math.min(steps.length - 1, 0));
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [params, setParams] = useState<ParamRow[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<{ message: string; items: string[] } | null>(null);

    const label = (i: number) => `Step ${i + 1}: ${clip(steps[i]!.description?.trim() || stepSentence(steps[i]))}`;
    const count = to - from + 1;

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        if (!name.trim()) return setError({ message: "Give the reusable steps a name.", items: [] });
        if (to < from) return setError({ message: "The last step can’t come before the first one.", items: [] });
        const rows = params.filter((p) => p.name.trim() || p.replace.trim());
        for (const p of rows) if (!p.name.trim() || !p.replace.trim()) return setError({ message: "Each value needs a name and the text in the steps that it stands for.", items: [] });
        setBusy(true);
        try {
            const out = await api<{ block: Block }>(`/projects/${projectId}/blocks/from-steps`, {
                method: "POST",
                body: { testId, from, to, name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), ...(rows.length ? { params: rows.map((p) => ({ name: p.name.trim(), replace: p.replace })) } : {}) },
            });
            onDone(out.block);
        } catch (err) {
            setError(blockError(err));
            setBusy(false);
        }
    }

    return (
        <Modal
            title="Save steps as reusable steps"
            titleId="blk-save-title"
            wide
            onClose={onClose}
            foot={
                <>
                    <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
                        Cancel
                    </Button>
                    <Button type="submit" form="blk-save-form" variant="primary" loading={busy}>
                        Save reusable steps
                    </Button>
                </>
            }
        >
            <form id="blk-save-form" className="blk-form" onSubmit={submit} noValidate>
                <p className="t-secondary">The steps you choose move into a set that other tests can use. This test keeps working: it runs them from there.</p>
                <div className="field">
                    <label htmlFor="blk-save-name">Name</label>
                    <input id="blk-save-name" className="input" value={name} maxLength={80} autoComplete="off" onChange={(e) => setName(e.target.value)} aria-describedby="blk-save-name-help" />
                    <span className="hint" id="blk-save-name-help">
                        For example “Sign in”. Tests refer to the steps by this name.
                    </span>
                </div>
                <div className="blk-two">
                    <div className="field">
                        <label htmlFor="blk-save-from">First step</label>
                        <select id="blk-save-from" className="input" value={from} onChange={(e) => (setFrom(Number(e.target.value)), Number(e.target.value) > to && setTo(Number(e.target.value)))}>
                            {steps.map((_, i) => (
                                <option key={i} value={i}>
                                    {label(i)}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="field">
                        <label htmlFor="blk-save-to">Last step</label>
                        <select id="blk-save-to" className="input" value={to} onChange={(e) => setTo(Number(e.target.value))}>
                            {steps.map((_, i) => (
                                <option key={i} value={i} disabled={i < from}>
                                    {label(i)}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>
                <p className="hint" role="status">
                    {count === 1 ? "1 step will be saved." : `${count} steps will be saved.`}
                </p>
                <fieldset className="blk-params">
                    <legend>Values (optional)</legend>
                    <p className="hint">Turn text in these steps into a value that each test can set. Type a name, and the exact text it stands for.</p>
                    {params.map((p, i) => (
                        <div className="blk-param-row" key={i}>
                            <div className="field">
                                <label htmlFor={`blk-save-pn-${i}`}>Name of value {i + 1}</label>
                                <input id={`blk-save-pn-${i}`} className="input" value={p.name} autoComplete="off" onChange={(e) => setParams(params.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))} />
                            </div>
                            <div className="field">
                                <label htmlFor={`blk-save-pr-${i}`}>Text it stands for</label>
                                <input id={`blk-save-pr-${i}`} className="input" value={p.replace} autoComplete="off" onChange={(e) => setParams(params.map((r, j) => (j === i ? { ...r, replace: e.target.value } : r)))} />
                            </div>
                            <Button type="button" variant="ghost" iconOnly icon={X} className="bld-ibtn" aria-label={`Remove value ${i + 1}`} onClick={() => setParams(params.filter((_, j) => j !== i))} />
                        </div>
                    ))}
                    {params.length < 10 && (
                        <div>
                            <Button type="button" size="sm" icon={Plus} onClick={() => setParams([...params, { name: "", replace: "" }])}>
                                Add a value
                            </Button>
                        </div>
                    )}
                </fieldset>
                <div className="field">
                    <label htmlFor="blk-save-desc">Description (optional)</label>
                    <input id="blk-save-desc" className="input" value={description} maxLength={300} autoComplete="off" onChange={(e) => setDescription(e.target.value)} />
                </div>
                {error && (
                    <Callout tone="danger" title="The steps were not saved">
                        {error.message}
                        {error.items.length > 0 && (
                            <ul className="bullets">
                                {error.items.map((t, i) => (
                                    <li key={i}>{t}</li>
                                ))}
                            </ul>
                        )}
                    </Callout>
                )}
            </form>
        </Modal>
    );
}
