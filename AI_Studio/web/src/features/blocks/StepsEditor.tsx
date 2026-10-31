import { ArrowDown, ArrowUp, ChevronDown, Copy, ListPlus, Plus, Trash2, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, EmptyState } from "../../components/ui";
import { stepSentence } from "../../lib/labels";
import { ACTION_LABEL, EDITABLE_ACTIONS, PALETTE, duplicateAt, insertAt, moveTo, problemsFor, removeAt, replaceAt, type Catalog, type Diag, type Item, type PaletteItem, type Step } from "../builder/builder";
import type { Placeholders } from "../builder/Fields";
import type { SharedElement } from "../builder/LocatorField";
import { StepForm } from "../builder/StepForm";
import "../builder/builder.css";
import { BlockPalette } from "./BlockPalette";
import type { Block, BlockKind } from "./blocks";

interface Props {
    projectId: string;
    items: Item[];
    onChange: (items: Item[]) => void;
    kind: BlockKind;
    catalog: Catalog;
    placeholders: Placeholders;
    shared: SharedElement[] | null;
    /** The project's other reusable steps (a block may use them). */
    blocks: Block[] | null;
    /** The reusable steps being edited: it is never offered to itself. */
    self?: string;
    problems?: Diag[];
    maxSteps: number;
}

const sentence = (s: Step) => s.description?.trim() || stepSentence(s);

/** The step list of the reusable-steps editor: the same forms and the same add-a-step choices as the test builder, without a script preview. */
export function StepsEditor({ projectId, items, onChange, kind, catalog, placeholders, shared, blocks, self, problems = [], maxSteps }: Props) {
    const [palette, setPalette] = useState(items.length === 0);
    const [selected, setSelected] = useState<string | null>(null);
    const [deleted, setDeleted] = useState<{ item: Item; index: number } | null>(null);
    const [focus, setFocus] = useState<string | null>(null);
    const groupsFor = kind === "any" ? [...PALETTE.web, ...PALETTE.api.filter((g) => !PALETTE.web.some((w) => w.id === g.id))] : PALETTE[kind];
    // An "any" block is checked as a web block first, then as an API block; the palette offers both kinds of step, the platform says which fits.
    const blockKind: "web" | "api" = kind === "api" ? "api" : "web";
    const index = selected ? items.findIndex((i) => i.key === selected) : -1;

    useEffect(() => {
        if (!focus) return;
        document.querySelector<HTMLElement>(`[data-step-key="${focus}"] .bld-form input, [data-step-key="${focus}"] .bld-form select`)?.focus();
        setFocus(null);
    }, [focus, items]);

    function add(step: Step) {
        if (items.length >= maxSteps) return;
        const at = index >= 0 ? index + 1 : items.length;
        const next = insertAt(items, at, step);
        onChange(next);
        setSelected(next[at]!.key);
        setFocus(next[at]!.key);
        setPalette(false);
        setDeleted(null);
    }
    const addItem = (p: PaletteItem) => add(p.make());

    return (
        <div className="stack-sm">
            <div className="bld-toolbar" role="toolbar" aria-label="Edit steps">
                <Button type="button" icon={Plus} aria-expanded={palette} aria-controls="blk-palette" disabled={items.length >= maxSteps} onClick={() => setPalette((v) => !v)}>
                    Add a step
                </Button>
                <span className="t-meta">
                    {items.length} of {maxSteps} steps
                </span>
            </div>
            {palette && (
                <section className="card bld-palette" id="blk-palette" aria-label="Add a step">
                    <p className="t-secondary">{index >= 0 ? `The new step goes after step ${index + 1}.` : "The new step goes at the end."}</p>
                    {groupsFor.map((g) => (
                        <div key={g.id} className="bld-group" role="group" aria-label={g.title}>
                            <h3 className="t-card">{g.title}</h3>
                            <div className="chips">
                                {g.items.map((p) => (
                                    <Button key={p.id} type="button" onClick={() => addItem(p)}>
                                        {p.label}
                                    </Button>
                                ))}
                            </div>
                            {g.more && g.more.length > 0 && (
                                <details className="bld-more">
                                    <summary>More checks</summary>
                                    <div className="chips">
                                        {g.more.map((p) => (
                                            <Button key={p.id} type="button" onClick={() => addItem(p)}>
                                                {p.label}
                                            </Button>
                                        ))}
                                    </div>
                                </details>
                            )}
                        </div>
                    ))}
                    <BlockPalette projectId={projectId} kind={blockKind} blocks={blocks} placeholders={placeholders} exclude={self} onAdd={add} />
                </section>
            )}
            <div className="bld-live" role="status" aria-live="polite">
                {deleted && (
                    <>
                        <span>Step {deleted.index + 1} removed.</span>
                        <Button type="button" size="sm" icon={Undo2} onClick={() => (onChange(insertAt(items, deleted.index, deleted.item.step)), setDeleted(null))}>
                            Undo
                        </Button>
                    </>
                )}
            </div>
            {items.length === 0 ? (
                <EmptyState icon={ListPlus} title="No steps yet" actions={<Button type="button" variant="primary" icon={Plus} onClick={() => setPalette(true)}>Add a step</Button>}>
                    Reusable steps need at least one step. Add one to begin.
                </EmptyState>
            ) : (
                <ol className="bld-steps card" aria-label="Steps of these reusable steps">
                    {items.map((it, i) => {
                        const open = selected === it.key;
                        const mine = problemsFor(problems, i);
                        const errors = mine.filter((m) => m.severity === "error");
                        const editable = EDITABLE_ACTIONS.includes(it.step.action);
                        return (
                            <li key={it.key} data-step-key={it.key} className={`bld-step${open ? " is-open" : ""}`}>
                                <div className="bld-bar">
                                    <button type="button" className="bld-head" aria-expanded={open} aria-controls={`blk-form-${it.key}`} onClick={() => setSelected(open ? null : it.key)}>
                                        <span className="bld-n">Step {i + 1}</span>
                                        <span className="bld-text">{sentence(it.step)}</span>
                                        {errors.length > 0 && <Badge tone="danger">{errors.length === 1 ? "1 problem" : `${errors.length} problems`}</Badge>}
                                        <ChevronDown size={16} className="bld-chev" aria-hidden />
                                    </button>
                                    <div className="bld-acts">
                                        <Button type="button" variant="ghost" iconOnly icon={ArrowUp} className="bld-ibtn" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => onChange(moveTo(items, i, i - 1))} />
                                        <Button type="button" variant="ghost" iconOnly icon={ArrowDown} className="bld-ibtn" aria-label={`Move step ${i + 1} down`} disabled={i === items.length - 1} onClick={() => onChange(moveTo(items, i, i + 1))} />
                                        <Button type="button" variant="ghost" iconOnly icon={Copy} className="bld-ibtn" aria-label={`Duplicate step ${i + 1}`} disabled={items.length >= maxSteps} onClick={() => (onChange(duplicateAt(items, i)), setDeleted(null))} />
                                        <Button type="button" variant="ghost" iconOnly icon={Trash2} className="bld-ibtn btn-danger" aria-label={`Delete step ${i + 1}`} tip="Takes it out of your draft. Undo appears, and nothing is saved until you save." onClick={() => (setDeleted({ item: it, index: i }), onChange(removeAt(items, i)), selected === it.key && setSelected(null))} />
                                    </div>
                                </div>
                                {open && (
                                    <div className="bld-body" id={`blk-form-${it.key}`}>
                                        <h3 className="t-card">{ACTION_LABEL[it.step.action] ?? it.step.action}</h3>
                                        {editable ? (
                                            <StepForm id={`blk-${it.key}`} step={it.step} onChange={(s) => onChange(replaceAt(items, i, s))} catalog={catalog} placeholders={placeholders} shared={shared} blocks={(blocks ?? []).filter((b) => b.name !== self)} projectId={projectId} />
                                        ) : (
                                            <p className="t-secondary">This kind of step cannot be changed here. You can move it, duplicate it or delete it.</p>
                                        )}
                                        {mine.length > 0 && (
                                            <ul className="bld-step-problems">
                                                {mine.map((m, j) => (
                                                    <li key={j} className={m.severity === "error" ? "error-text" : "hint"}>
                                                        {m.message}
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ol>
            )}
        </div>
    );
}
