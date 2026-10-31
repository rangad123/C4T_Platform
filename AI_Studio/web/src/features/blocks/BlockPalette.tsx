import { useState } from "react";
import { Button } from "../../components/ui";
import { routes } from "../../lib/router";
import type { Step } from "../builder/builder";
import { TextField, type Placeholders } from "../builder/Fields";
import { fitsKind, type Block } from "./blocks";
import { argsWith } from "./UseBlockForm";
import "./blocks.css";

interface Props {
    projectId: string;
    kind: "web" | "api";
    /** The project's reusable steps; null while they load or when they could not be loaded. */
    blocks: Block[] | null;
    failed?: boolean;
    placeholders: Placeholders;
    onAdd: (step: Step) => void;
    /** Reusable steps never list themselves (a block cannot use itself). */
    exclude?: string;
}

/** The "Reusable steps" group of the add-a-step palette: each set of the project, with a small form when it has parameters. */
export function BlockPalette({ projectId, kind, blocks, failed, placeholders, onAdd, exclude }: Props) {
    const [choosing, setChoosing] = useState<Block | null>(null);
    const [step, setStep] = useState<Step>({ action: "useBlock", block: "" });
    const usable = (blocks ?? []).filter((b) => fitsKind(b, kind) && b.name !== exclude);

    function pick(b: Block) {
        const fresh: Step = { action: "useBlock", block: b.name };
        if (b.params.length === 0) return onAdd(fresh);
        setChoosing(b);
        setStep(fresh);
    }
    function confirm() {
        const args = (step.args as Record<string, string> | undefined) ?? {};
        onAdd({ action: "useBlock", block: step.block, ...(Object.keys(args).length ? { args } : {}) });
        setChoosing(null);
    }

    return (
        <div className="bld-group" role="group" aria-label="Reusable steps">
            <h3 className="t-card">Reusable steps</h3>
            {blocks === null && !failed && <p className="hint">Loading your reusable steps.</p>}
            {failed && <p className="hint">Your reusable steps could not be loaded. Close this and open it again.</p>}
            {blocks !== null && usable.length === 0 && (
                <p className="hint">
                    No reusable steps for this kind of test yet. Choose steps in the list and save them as reusable steps, or <a href={routes.blocks(projectId)}>create some</a>.
                </p>
            )}
            {usable.length > 0 && (
                <div className="chips">
                    {usable.map((b) => (
                        <Button key={b.id} type="button" aria-pressed={choosing?.id === b.id} onClick={() => pick(b)} tip={b.description ?? undefined}>
                            {b.name}
                            {b.params.length > 0 && <span className="blk-chip-note"> ({b.params.length === 1 ? "1 value" : `${b.params.length} values`})</span>}
                        </Button>
                    ))}
                </div>
            )}
            {choosing && (
                <form
                    className="blk-pick"
                    aria-label={`Values for ${choosing.name}`}
                    onSubmit={(e) => {
                        e.preventDefault();
                        confirm();
                    }}
                >
                    <p className="t-secondary">Values for “{choosing.name}”. A value you leave empty uses its default.</p>
                    {choosing.params.map((p) => (
                        <TextField
                            key={p.name}
                            id={`blk-pick-${p.name}`}
                            label={p.name}
                            help={`${p.description ? `${p.description}. ` : ""}${p.default !== undefined ? `Default: “${p.default}”.` : "A value is needed."}`}
                            required={p.default === undefined}
                            value={(step.args as Record<string, string> | undefined)?.[p.name] ?? ""}
                            offer={placeholders}
                            onChange={(v) => setStep(argsWith(step, p.name, v))}
                        />
                    ))}
                    <div className="blk-pick-acts">
                        <Button type="submit" variant="primary" disabled={choosing.params.some((p) => p.default === undefined && !((step.args as Record<string, string> | undefined)?.[p.name] ?? "").trim())}>
                            Add these steps
                        </Button>
                        <Button type="button" variant="ghost" onClick={() => setChoosing(null)}>
                            Cancel
                        </Button>
                    </div>
                </form>
            )}
        </div>
    );
}
