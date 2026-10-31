import { Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../../api";
import { Badge, Button, Callout, ErrorState, Skeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { toItems, stepsOf, isDirty, type Item, type Step } from "../builder/builder";
import { useLeaveGuard } from "../builder/guard";
import type { SharedElement } from "../builder/LocatorField";
import { appliesToText, blockError, KIND_CHOICES, placeholdersFor, type Block, type BlockChange, type BlockKind, type BlockList, type BlockParam } from "./blocks";
import { StepsEditor } from "./StepsEditor";
import "./blocks.css";

interface Props {
    projectId: string;
    /** The list answer (blocks, catalog, placeholders). */
    list: BlockList;
    /** The reusable steps to change; absent = new ones. */
    existing?: Block;
    onCancel: () => void;
    onSaved: (block: Block, text: { tone: "success" | "warning"; title: string; text: string }) => void;
}

/** The page for adding or changing reusable steps: name, kind, values (parameters) and the steps, in the same editor the test builder uses. */
export function BlockEditor({ projectId, list, existing, onCancel, onSaved }: Props) {
    // The list holds no steps: the full block is fetched when one is changed.
    const full = useFetch<Block>(existing ? `/projects/${projectId}/blocks/${encodeURIComponent(existing.name)}` : null);
    if (existing && full.loading) {
        return (
            <div className="stack" aria-busy="true" aria-label="Loading the reusable steps">
                <Skeleton w={320} h={28} />
                <Skeleton h={220} />
            </div>
        );
    }
    if (existing && (full.error || !full.data)) return <ErrorState error={friendlyError(full.error?.message ?? "These reusable steps were not found")} onRetry={full.reload} />;
    return <Form projectId={projectId} list={list} existing={full.data} onCancel={onCancel} onSaved={onSaved} />;
}

function Form({ projectId, list, existing, onCancel, onSaved }: Omit<Props, "existing"> & { existing?: Block }) {
    const shared = useFetch<{ elements: SharedElement[] }>(`/projects/${projectId}/objects?kind=web`);
    const [name, setName] = useState(existing?.name ?? "");
    const [description, setDescription] = useState(existing?.description ?? "");
    const [kind, setKind] = useState<BlockKind>(existing?.kind ?? "web");
    const [params, setParams] = useState<BlockParam[]>(existing?.params ?? []);
    const [items, setItems] = useState<Item[]>(() => toItems(JSON.parse(JSON.stringify(existing?.steps ?? [])) as Step[]));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<{ message: string; items: string[] } | null>(null);

    const draft = { name, description, kind, params, steps: stepsOf(items) };
    const base = useMemo(() => ({ name: existing?.name ?? "", description: existing?.description ?? "", kind: existing?.kind ?? "web", params: existing?.params ?? [], steps: existing?.steps ?? [] }), [existing]);
    const dirty = isDirty(base as never, draft as never);
    const { dialog, allowLeaving } = useLeaveGuard(dirty);
    const placeholders = placeholdersFor(list.placeholders, params);
    const maxSteps = 40;

    function setParam(i: number, patch: Partial<BlockParam>) {
        setParams(params.map((p, j) => (j === i ? { ...p, ...patch } : p)));
    }

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        if (busy) return;
        setError(null);
        if (!name.trim()) return setError({ message: "Give the reusable steps a name.", items: [] });
        if (items.length === 0) return setError({ message: "Add at least one step.", items: [] });
        const cleaned = params.filter((p) => p.name.trim()).map((p) => ({ name: p.name.trim(), ...(p.description?.trim() ? { description: p.description.trim() } : {}), ...(p.default !== undefined && p.default !== "" ? { default: p.default } : {}) }));
        const body = { name: name.trim(), ...(description.trim() ? { description: description.trim() } : existing ? { description: null } : {}), kind, params: cleaned, steps: stepsOf(items) };
        setBusy(true);
        try {
            if (existing) {
                const out = await api<BlockChange>(`/projects/${projectId}/blocks/${encodeURIComponent(existing.name)}`, { method: "PUT", body: { ...body, expectedVersion: existing.version } });
                allowLeaving();
                onSaved(out, { tone: out.revalidation.status === "waiting" ? "warning" : "success", title: "Changes saved", text: appliesToText(out) });
            } else {
                const out = await api<Block>(`/projects/${projectId}/blocks`, { method: "POST", body });
                allowLeaving();
                onSaved(out, { tone: "success", title: "Reusable steps added", text: "Use them in a test from the Add a step list, or save steps of a test as reusable steps." });
            }
        } catch (err) {
            setError(blockError(err));
            setBusy(false);
        }
    }

    const users = existing?.usedBy.count ?? 0;
    return (
        <form className="stack blk-editor" onSubmit={submit} noValidate>
            <section className="card card-pad stack-sm" aria-labelledby="blk-details-title">
                <h2 className="t-section" id="blk-details-title">
                    {existing ? "Change reusable steps" : "Add reusable steps"}
                </h2>
                <div className="field">
                    <label htmlFor="blk-name">Name</label>
                    <input id="blk-name" className="input" value={name} maxLength={80} autoComplete="off" onChange={(e) => setName(e.target.value)} aria-describedby="blk-name-help" />
                    <span className="hint" id="blk-name-help">
                        For example “Sign in”. Tests refer to these steps by this name.
                    </span>
                </div>
                <div className="field">
                    <label htmlFor="blk-desc">Description (optional)</label>
                    <input id="blk-desc" className="input" value={description} maxLength={300} autoComplete="off" onChange={(e) => setDescription(e.target.value)} />
                </div>
                <div className="field">
                    <label htmlFor="blk-kind">Used in</label>
                    <select id="blk-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value as BlockKind)} aria-describedby="blk-kind-help">
                        {KIND_CHOICES.map((k) => (
                            <option key={k.id} value={k.id}>
                                {k.label}
                            </option>
                        ))}
                    </select>
                    <span className="hint" id="blk-kind-help">
                        {KIND_CHOICES.find((k) => k.id === kind)!.help}
                    </span>
                </div>
            </section>

            <section className="card card-pad stack-sm" aria-labelledby="blk-params-title">
                <h2 className="t-section" id="blk-params-title">
                    Values
                </h2>
                <p className="hint">A value lets each test fill in something different, such as who signs in. Use it in a step as {"{{name}}"}. A value with a default is optional.</p>
                {params.map((p, i) => (
                    <div className="blk-param-row" key={i}>
                        <div className="field">
                            <label htmlFor={`blk-pn-${i}`}>Name of value {i + 1}</label>
                            <input id={`blk-pn-${i}`} className="input" value={p.name} maxLength={40} autoComplete="off" onChange={(e) => setParam(i, { name: e.target.value })} />
                        </div>
                        <div className="field">
                            <label htmlFor={`blk-pd-${i}`}>Default for value {i + 1}</label>
                            <input id={`blk-pd-${i}`} className="input" value={p.default ?? ""} maxLength={500} autoComplete="off" onChange={(e) => setParam(i, { default: e.target.value })} />
                        </div>
                        <div className="field">
                            <label htmlFor={`blk-pt-${i}`}>What it is for</label>
                            <input id={`blk-pt-${i}`} className="input" value={p.description ?? ""} maxLength={200} autoComplete="off" onChange={(e) => setParam(i, { description: e.target.value })} />
                        </div>
                        <Button type="button" variant="ghost" iconOnly icon={X} className="bld-ibtn" aria-label={`Remove value ${i + 1}`} onClick={() => setParams(params.filter((_, j) => j !== i))} />
                    </div>
                ))}
                {params.length < 10 && (
                    <div>
                        <Button type="button" size="sm" icon={Plus} onClick={() => setParams([...params, { name: "" }])}>
                            Add a value
                        </Button>
                    </div>
                )}
            </section>

            <section className="card card-pad stack-sm" aria-labelledby="blk-steps-title">
                <h2 className="t-section" id="blk-steps-title">
                    Steps
                </h2>
                <StepsEditor
                    projectId={projectId}
                    items={items}
                    onChange={setItems}
                    kind={kind}
                    catalog={list.catalog}
                    placeholders={placeholders}
                    shared={kind === "api" ? [] : (shared.data?.elements ?? (shared.loading ? [] : null))}
                    blocks={list.blocks}
                    self={existing?.name}
                    maxSteps={maxSteps}
                />
            </section>

            {existing && users > 0 && (
                <Callout tone="info">
                    {users === 1 ? "1 test uses" : `${users} tests use`} these steps. If you change the steps, those tests are updated and run again. Nothing is saved if one of them would stop working.
                </Callout>
            )}
            {error && (
                <Callout tone="danger" title="The reusable steps were not saved">
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
            <div className="blk-foot">
                {dirty && <Badge tone="warning">Unsaved changes</Badge>}
                <span className="spacer" />
                <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
                    Cancel
                </Button>
                <Button type="submit" variant="primary" loading={busy} disabled={!existing ? false : !dirty}>
                    {existing ? "Save changes" : "Add reusable steps"}
                </Button>
            </div>
            {dialog}
        </form>
    );
}
