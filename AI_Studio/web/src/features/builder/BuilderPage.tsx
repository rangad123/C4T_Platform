import { ArrowDown, ArrowUp, Blocks, Check, ChevronDown, Code2, Copy, GripVertical, ListPlus, Plus, Trash2, Undo2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { ScriptPreview } from "../../components/ScriptPreview";
import { Badge, Button, Callout, Disclosure, EmptyState, ErrorState, LinkButton, Skeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { cleanReason, friendlyError, stepSentence } from "../../lib/labels";
import { routes } from "../../lib/router";
import { BlockPalette } from "../blocks/BlockPalette";
import type { Block, BlockList } from "../blocks/blocks";
import { SaveAsBlockDialog } from "../blocks/SaveAsBlockDialog";
import { Modal } from "../code/Modal";
import type { DslDiagnostic, Extras, ParsedSpec, SaveTextAnswer } from "../dsl/dsl";
import { TextMode } from "../dsl/TextMode";
import { useTextDraft } from "../dsl/useTextDraft";
import { changeCount, changesWord, firstLineOf, type StepMark } from "../workbench/test-model";
import { UnsavedBar } from "../workbench/UnsavedBar";
import { diffSteps, canon as canonOf } from "./stepdiff";
import { StepDiffView } from "./History";
import { StepShare } from "../objects/StepShare";
import {
    ACTION_LABEL,
    BuilderError,
    EDITABLE_ACTIONS,
    PALETTE,
    bapi,
    duplicateAt,
    errorText,
    insertAt,
    isDirty,
    moveTo,
    newKey,
    problemsFor,
    removeAt,
    replaceAt,
    specFrom,
    stepsOf,
    toItems,
    type Diag,
    type Draft,
    type Item,
    type Kind,
    type PaletteItem,
    type PreviewAnswer,
    type SaveAnswer,
    type SpecAnswer,
    type Step,
} from "./builder";
import { MapField, TextField } from "./Fields";
import { useLeaveGuard } from "./guard";
import { StepForm } from "./StepForm";
import "./builder.css";

/** What the workbench gives the editor: which view the route shows, where to put the script and the unsaved bar, the last run's marks. */
export interface EditorEmbed {
    mode: "steps" | "text";
    /** The editor changed its own view (after the checks passed): the route follows. */
    onMode: (mode: "steps" | "text") => void;
    /** False while another tab (Code, History) is showing: the editor stays mounted so unsaved work is kept, and puts nothing on screen. */
    active: boolean;
    scriptSlot: HTMLElement | null;
    barSlot: HTMLElement | null;
    /** The last run's verdict per step, only when no edit was saved after that run. */
    marks?: Array<StepMark | undefined>;
    onDirty: (summary: { count: number; label: string }) => void;
    onSaved: (r: { changed: boolean; jobId: string | null; note?: string; via: "steps" | "text" }) => void;
    /** Something changed the stored test without a save of the steps (a step became a shared element): read it again. */
    onReload: () => void;
    /** Lets the tab strip ask for a change of view and learn whether it happened (text that does not read yet stays where it is). */
    switchRef: MutableRefObject<((mode: "steps" | "text") => Promise<boolean>) | null>;
}

/** The steps and the text of a generated test, one editor with two views. The workbench puts it inside the Steps and Text tabs. */
export function StepsEditor({ id, embed, refreshKey }: { id: string; embed: EditorEmbed; /** Changes when something outside the editor changed what it may do (a run ended): the platform is asked again, the work in progress stays. */ refreshKey: number }) {
    const spec = useFetch<SpecAnswer>(`/tests/${id}/spec`);
    const first = useRef(true);
    useEffect(() => {
        if (first.current) first.current = false;
        else void spec.reload();
    }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
    // Steps saved as reusable steps, or a saved text, change the stored test: the editor starts again from what was saved.
    const [epoch, setEpoch] = useState(0);
    const [justSaved, setJustSaved] = useState<string | null>(null);
    const d = spec.data;

    if (spec.loading) {
        return (
            <div className="stack" aria-busy="true" aria-label="Loading the steps">
                <Skeleton h={80} />
                <Skeleton h={300} />
            </div>
        );
    }
    if (spec.error || !d) return <ErrorState error={friendlyError(spec.error?.message ?? "Test not found")} onRetry={spec.reload} />;
    return (
        <Editor
            key={`${d.testId}:${epoch}`}
            id={id}
            data={d}
            embed={embed}
            onRetry={spec.reload}
            justSaved={justSaved}
            onTextSaved={async (r) => {
                await spec.reload();
                embed.onSaved({ changed: r.changed, jobId: r.jobId, ...(r.note ? { note: r.note } : {}), via: "text" });
                setEpoch((n) => n + 1);
            }}
            onExtracted={async (b) => {
                await spec.reload();
                setJustSaved(b.name);
                setEpoch((n) => n + 1);
                embed.onReload();
            }}
            onShared={async () => {
                await spec.reload();
                setEpoch((n) => n + 1);
                embed.onReload();
            }}
        />
    );
}

function Editor({ id, data, embed, onRetry, onExtracted, onShared, justSaved, onTextSaved }: { id: string; data: SpecAnswer; embed: EditorEmbed; onRetry: () => Promise<void>; onExtracted: (b: Block) => Promise<void>; onShared: () => Promise<void>; justSaved: string | null; onTextSaved: (r: SaveTextAnswer) => Promise<void> }) {
    const kind: Kind = data.kind === "api" ? "api" : "web";
    const editable = data.editable;
    const draftOf = (): Draft => ({ title: data.spec.title, testData: data.spec.testData ?? {}, steps: data.spec.steps });

    const [base, setBase] = useState<Draft>(draftOf);
    const [title, setTitle] = useState(data.spec.title);
    const [testData, setTestData] = useState<Record<string, string>>(data.spec.testData ?? {});
    const [items, setItems] = useState<Item[]>(() => toItems(JSON.parse(JSON.stringify(data.spec.steps)) as Step[]));
    const [resets, setResets] = useState(0);
    const [selected, setSelected] = useState<string | null>(null);
    const [palette, setPalette] = useState(false);
    const [diags, setDiags] = useState<Diag[]>([]);
    const [preview, setPreview] = useState<{ script: string; filename: string } | null>(null);
    const [previewState, setPreviewState] = useState<"idle" | "loading" | "ok" | "error">("idle");
    const [previewError, setPreviewError] = useState("");
    const [showScript, setShowScript] = useState(true);
    const [saving, setSaving] = useState<"" | "save" | "run">("");
    const [saveError, setSaveError] = useState("");
    const [showChanges, setShowChanges] = useState(false);
    const [deleted, setDeleted] = useState<{ item: Item; index: number } | null>(null);
    const [confirmDiscard, setConfirmDiscard] = useState(false);
    const [dragFrom, setDragFrom] = useState<number | null>(null);
    const [dragOver, setDragOver] = useState<number | null>(null);
    const [focusKey, setFocusKey] = useState<string | null>(null);
    const [headFocus, setHeadFocus] = useState<string | null>(null);
    // Which row of the saved steps each row on screen started as: the last run's marks follow a step that is moved or edited.
    const [origKeys, setOrigKeys] = useState<string[]>(() => items.map((i) => i.key));
    // The Text view: the same test as one line per step. Changes made there ride along when the view changes.
    const tx = useTextDraft();
    const [mode, setMode] = useState<"steps" | "text">(embed.mode);
    const [switchError, setSwitchError] = useState("");
    const [blocked, setBlocked] = useState<{ message: string; problems: DslDiagnostic[] } | null>(null);
    const [extras, setExtras] = useState<Extras>({});
    const [savedExtras, setSavedExtras] = useState<Extras>({});
    const baseSpec = { ...data.spec, ...extras } as SpecAnswer["spec"];
    const extrasDirty = JSON.stringify(extras) !== JSON.stringify(savedExtras);

    const shared = useFetch<{ elements: Array<{ name: string; page: string | null }> }>(kind === "web" && editable ? `/projects/${data.projectId}/objects?kind=web` : null);
    const sharedList = kind === "web" ? (shared.data?.elements ?? (shared.loading ? [] : null)) : [];
    // The project's reusable steps: offered in the add-a-step list and chosen from in a "Run reusable steps" step.
    const blockList = useFetch<BlockList>(editable ? `/projects/${data.projectId}/blocks` : null);
    const blocks: Block[] | null = blockList.data?.blocks ?? null;
    const [saveAsBlock, setSaveAsBlock] = useState(false);

    const draft: Draft = { title, testData, steps: stepsOf(items) };
    const dirty = isDirty(base, draft) || extrasDirty;
    const { dialog: leaveDialog, allowLeaving } = useLeaveGuard(dirty || tx.dirty, (href) => href.startsWith(`#/tests/${id}`));
    const diff = useMemo(() => diffSteps(base, draft), [base, title, testData, items]); // eslint-disable-line react-hooks/exhaustive-deps
    const sig = JSON.stringify(draft) + JSON.stringify(extras);
    const seq = useRef(0);
    const titleProblem = title.trim().length < 3 ? "Give the test a name of at least 3 characters." : title.trim().length > data.kinds.limits.title ? `Keep the name under ${data.kinds.limits.title} characters.` : "";

    // The script follows the steps: asked for 500 ms after the last change, and an older answer never replaces a newer one.
    useEffect(() => {
        if (!editable) return;
        // The first look at the script is not delayed; later changes wait for a pause in typing.
        const delay = seq.current === 0 ? 0 : 500;
        const timer = window.setTimeout(async () => {
            const n = ++seq.current;
            setPreviewState("loading");
            try {
                const r = await bapi<PreviewAnswer>(`/tests/${id}/spec/preview`, { method: "POST", body: { spec: specFrom(baseSpec, draft) } });
                if (n !== seq.current) return;
                setDiags(r.diagnostics);
                if (r.script) setPreview({ script: r.script, filename: r.filename ?? "test.spec.ts" });
                setPreviewState("ok");
                setPreviewError("");
            } catch (e) {
                if (n !== seq.current) return;
                setPreviewState("error");
                setPreviewError(errorText(e));
            }
        }, delay);
        return () => clearTimeout(timer);
    }, [sig, editable]); // eslint-disable-line react-hooks/exhaustive-deps

    // After a change that adds a step or moves focus, put the keyboard where the person is working.
    useEffect(() => {
        if (!focusKey) return;
        const el = document.querySelector<HTMLElement>(`[data-step-key="${focusKey}"] .bld-form input, [data-step-key="${focusKey}"] .bld-form select`);
        el?.focus();
        setFocusKey(null);
    }, [focusKey, items]);
    useEffect(() => {
        if (!headFocus) return;
        document.querySelector<HTMLElement>(`[data-head-key="${headFocus}"]`)?.focus();
        setHeadFocus(null);
    }, [headFocus, items]);

    const index = (key: string | null) => (key ? items.findIndex((i) => i.key === key) : -1);
    const selectedIndex = index(selected);

    function add(p: PaletteItem) {
        addStep(p.make());
    }
    function addStep(step: Step) {
        const at = selectedIndex >= 0 ? selectedIndex + 1 : items.length;
        const next = insertAt(items, at, step);
        setItems(next);
        const key = next[at]!.key;
        setSelected(key);
        setFocusKey(key);
        setPalette(false);
        setDeleted(null);
    }
    function change(i: number, step: Step) {
        setItems((cur) => replaceAt(cur, i, step));
    }
    function remove(i: number) {
        const it = items[i]!;
        setDeleted({ item: it, index: i });
        setItems(removeAt(items, i));
        if (selected === it.key) setSelected(null);
    }
    function undoDelete() {
        if (!deleted) return;
        const next = insertAt(items, deleted.index, deleted.item.step);
        setItems(next);
        const key = next[Math.min(deleted.index, next.length - 1)]!.key;
        setSelected(key);
        setDeleted(null);
    }
    function move(i: number, to: number) {
        if (to < 0 || to >= items.length || to === i) return;
        const key = items[i]!.key;
        setItems(moveTo(items, i, to));
        setHeadFocus(key);
    }
    function goTo(stepIndex: number) {
        const it = items[stepIndex];
        if (!it) return;
        setSelected(it.key);
        window.setTimeout(() => document.getElementById(`bld-step-${it.key}`)?.scrollIntoView({ block: "nearest" }), 0);
        setFocusKey(it.key);
    }
    function discard() {
        const again = toItems(JSON.parse(JSON.stringify(base.steps)) as Step[]);
        setItems(again);
        setOrigKeys(again.map((i) => i.key));
        setTitle(base.title);
        setTestData(base.testData);
        setExtras(savedExtras);
        setResets((n) => n + 1);
        setSelected(null);
        setDeleted(null);
        setSaveError("");
        setConfirmDiscard(false);
    }

    // ── the Text view ──
    // The route says which view is showing. A route that opens on Text (a saved text, a link) writes the test as text once.
    useEffect(() => {
        if (embed.mode === "text") void showText();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    /** Writes the test as text and shows it. False when it could not be written (the view stays where it is). */
    async function showText(): Promise<boolean> {
        if (mode === "text" && tx.printed) return true;
        setSwitchError("");
        const r = await tx.enter(specFrom(baseSpec, draft));
        if (!r.ok) {
            setSwitchError(`The text view could not be opened. ${r.message}`);
            setMode("steps");
            embed.onMode("steps");
            return false;
        }
        setBlocked(null);
        setMode("text");
        embed.onMode("text");
        return true;
    }

    /** The text becomes the steps again; text that does not read yet stays where it is, with the first problem named. */
    async function showSteps(): Promise<boolean> {
        if (mode === "steps") return true;
        setSwitchError("");
        if (!tx.dirty) {
            setBlocked(null);
            setMode("steps");
            embed.onMode("steps");
            return true;
        }
        const r = await tx.leave();
        if ("message" in r) {
            setSwitchError(`The steps view could not be opened. ${r.message}`);
            return false;
        }
        const parsed = r.answer.spec;
        if (!parsed) {
            const first = r.answer.diagnostics[0];
            setBlocked({ message: first ? `Line ${first.line}: ${first.message}` : "The text could not be read.", problems: r.answer.diagnostics });
            return false;
        }
        if (parsed.kind !== kind) {
            setBlocked({ message: `This is a ${kind} test, and the text says ${parsed.kind}. The kind of a test cannot be changed.`, problems: [] });
            return false;
        }
        if (typeof data.spec.category === "string" && parsed.category !== data.spec.category) {
            setBlocked({ message: "The category of an existing test cannot be changed here. Put the Category line back.", problems: [] });
            return false;
        }
        applyParsed(parsed);
        setBlocked(null);
        setMode("steps");
        embed.onMode("steps");
        return true;
    }

    // The tab strip asks through this; the view it asks for is the one the route shows afterwards.
    const modeRef = useRef(mode);
    modeRef.current = mode;
    embed.switchRef.current = (to) => (to === "text" ? showText() : showSteps());
    useEffect(() => () => void (embed.switchRef.current = null), []); // eslint-disable-line react-hooks/exhaustive-deps
    // The route changed under the editor (Back, a typed address): follow it, and put the route back when the text does not read yet.
    useEffect(() => {
        if (embed.mode === modeRef.current) return;
        void (embed.mode === "text" ? showText() : showSteps()).then((ok) => {
            if (!ok) embed.onMode(modeRef.current);
        });
    }, [embed.mode]); // eslint-disable-line react-hooks/exhaustive-deps

    function applyParsed(parsed: ParsedSpec) {
        setTitle(parsed.title);
        setTestData(parsed.testData ?? {});
        setItems(toItems(JSON.parse(JSON.stringify(parsed.steps)) as Step[]));
        // Steps that came from text no longer line up with the last run's marks.
        setOrigKeys([]);
        setResets((n) => n + 1);
        setSelected(null);
        setDeleted(null);
        setSaveError("");
        // What the steps view does not show stays with the test; only what differs from the stored test is carried.
        const stored = data.spec as Record<string, unknown>;
        const next: Extras = {};
        const keep = <K extends keyof Extras>(k: K, fallback: Extras[K]) => {
            if (JSON.stringify(parsed[k]) !== JSON.stringify(stored[k] ?? fallback)) next[k] = parsed[k] as Extras[K];
        };
        keep("description", "");
        keep("type", "functional");
        keep("priority", "medium");
        keep("tags", []);
        keep("preconditions", []);
        keep("expectedResults", []);
        setExtras(next);
    }

    const switchNote = switchError ? (
        <Callout tone="danger" title="That did not open">
            {switchError}
        </Callout>
    ) : null;

    /** Save the steps; with `run` the platform also starts a run. Saving alone leaves the test as "Not run yet". */
    async function save(run: boolean) {
        if (saving || !dirty || titleProblem || items.length === 0) return;
        setSaving(run ? "run" : "save");
        setSaveError("");
        try {
            const r = await bapi<SaveAnswer>(`/tests/${id}/spec`, { method: "PUT", body: { spec: specFrom(baseSpec, draft), ...(run ? {} : { run: false }) } });
            allowLeaving();
            setBase(JSON.parse(JSON.stringify(draft)) as Draft);
            setSavedExtras(extras);
            setDiags(r.diagnostics);
            setShowChanges(false);
            embed.onSaved({ changed: r.changed, jobId: r.jobId, ...(r.note ? { note: r.note } : {}), via: "steps" });
        } catch (e) {
            if (e instanceof BuilderError) {
                if (e.diagnostics.length) setDiags(e.diagnostics);
                setSaveError(e.message);
            } else setSaveError(errorText(e));
        } finally {
            setSaving("");
        }
    }

    const errors = diags.filter((x) => x.severity === "error");
    const notes = diags.filter((x) => x.severity === "warning");
    const groups = PALETTE[kind];

    // The workbench shows the count in its bar and the tab strip.
    const stepChanges = dirty ? Math.max(1, changeCount(diff) + (extrasDirty ? 1 : 0)) : 0;
    const onDirty = embed.onDirty;
    useEffect(() => {
        onDirty({ count: stepChanges, label: changesWord(stepChanges) });
    }, [stepChanges]); // eslint-disable-line react-hooks/exhaustive-deps

    const blockedSave = titleProblem || (items.length === 0 ? "A test needs at least one step." : errors.length ? "Fix the problems listed first." : "");
    const bar =
        embed.barSlot && dirty && mode === "steps"
            ? createPortal(
                  <UnsavedBar
                      label={changesWord(stepChanges)}
                      preview={<StepDiffView diff={diff} leftLabel="the saved steps" rightLabel="your changes" />}
                      previewOpen={showChanges}
                      onTogglePreview={() => setShowChanges((v) => !v)}
                      canSave={!blockedSave}
                      saving={saving}
                      {...(blockedSave ? { why: blockedSave } : {})}
                      onDiscard={() => setConfirmDiscard(true)}
                      onSave={() => void save(false)}
                      onSaveAndRun={() => void save(true)}
                      problem={saveError ? <Callout tone="danger" title="The steps were not saved">{saveError}</Callout> : undefined}
                  />,
                  embed.barSlot,
              )
            : null;

    if (mode === "text") {
        return (
            <>
                <div className="stack bld-root">
                    {switchNote}
                    {tx.printed ? (
                        <TextMode
                            testId={id}
                            title={data.title}
                            draft={tx}
                            editable={editable}
                            {...(data.reason ? { editReason: data.reason } : {})}
                            carriesUnsaved={dirty}
                            stepDiff={dirty ? diff : null}
                            barSlot={embed.barSlot}
                            blocked={blocked}
                            onDiscardAndLeave={() => {
                                tx.discard();
                                setBlocked(null);
                                setMode("steps");
                                embed.onMode("steps");
                            }}
                            onSaved={async (r) => {
                                allowLeaving();
                                await onTextSaved(r);
                            }}
                            onDirty={(n) => onDirty({ count: Math.max(n, stepChanges), label: changesWord(Math.max(n, stepChanges)) })}
                            onSwitchToSteps={() => void showSteps()}
                        />
                    ) : (
                        <div aria-busy="true" aria-label="Loading the text">
                            <Skeleton h={80} />
                            <Skeleton h={300} style={{ marginTop: 12 }} />
                        </div>
                    )}
                </div>
                {leaveDialog}
            </>
        );
    }

    if (!editable) {
        return (
            <>
                <div className="stack bld-root">
                    {switchNote}
                    <Callout
                        tone={data.busy ? "warning" : "info"}
                        title={data.busy ? "A run is in progress" : data.custom ? "This is a code test, so it has no steps to edit" : "These steps cannot be edited here"}
                        actions={
                            data.custom ? (
                                <LinkButton size="sm" variant="primary" href={routes.code(id)} icon={Code2}>
                                    Edit the code
                                </LinkButton>
                            ) : data.busy ? (
                                <Button size="sm" onClick={() => void onRetry()}>
                                    Try again
                                </Button>
                            ) : undefined
                        }
                    >
                        {data.reason}
                    </Callout>
                    <section className="card" aria-labelledby="bld-steps-title">
                        <div className="card-head wrap">
                            <h2 className="t-section" id="bld-steps-title">
                                Steps
                            </h2>
                            <span className="t-meta">{items.length} in all</span>
                        </div>
                        <ol className="bld-steps" aria-label="Steps of this test">
                            {items.map((it, i) => (
                                <li key={it.key} className="bld-step">
                                    <div className="bld-bar">
                                        <span className="bld-n">Step {i + 1}</span>
                                        <span className="bld-text">{sentence(it.step)}</span>
                                        <StepShare projectId={data.projectId} testId={id} kind={data.kind} stepIndex={i} step={it.step as { locator?: { ref?: string; by?: string } }} onChanged={() => void onShared()} />
                                    </div>
                                </li>
                            ))}
                        </ol>
                    </section>
                </div>
            </>
        );
    }

    /** The mark the last run left on a row: it follows the step by its start position, and says so when the step has been edited since. */
    function markOf(it: Item): { mark: StepMark; edited: boolean } | null {
        const orig = origKeys.indexOf(it.key);
        const m = orig >= 0 ? embed.marks?.[orig] : undefined;
        if (!m) return null;
        return { mark: m, edited: canonOf(base.steps[orig]) !== canonOf(it.step) };
    }

    const scriptCard = (
        <section className="card bld-preview" aria-labelledby="bld-script-title">
            <div className="card-head wrap">
                <h2 className="t-section" id="bld-script-title">
                    Script
                </h2>
                <span className="t-meta">{previewState === "loading" ? "Updating…" : previewState === "ok" && errors.length === 0 ? "Up to date" : ""}</span>
                <span className="spacer" />
                <Button size="sm" aria-expanded={showScript} aria-controls="bld-script" onClick={() => setShowScript((v) => !v)}>
                    {showScript ? "Hide script" : "Show script"}
                </Button>
            </div>
            {showScript && (
                <div id="bld-script" className="bld-script">
                    {previewState === "error" && (
                        <div className="bld-pad">
                            <Callout tone="warning" title="The preview could not be updated">
                                {previewError}
                            </Callout>
                        </div>
                    )}
                    {previewState !== "error" && errors.length > 0 && <p className="hint bld-pad">The script below is the last one that could be created. Fix the problems to see the new one.</p>}
                    {preview ? (
                        <ScriptPreview code={preview.script} filename={preview.filename} label={preview.filename} />
                    ) : previewState === "ok" || previewState === "error" ? (
                        <p className="hint bld-pad">The script appears here as soon as the steps have no problems.</p>
                    ) : (
                        <div className="bld-pad" aria-busy="true" aria-label="Loading the preview">
                            <Skeleton w="70%" h={14} />
                            <Skeleton w="55%" h={14} style={{ marginTop: 10 }} />
                        </div>
                    )}
                </div>
            )}
        </section>
    );
    // The script sits beside the steps (the workbench's right column) while this tab shows; without that column it follows the steps.
    const scriptPlace = embed.active ? (embed.scriptSlot ? createPortal(scriptCard, embed.scriptSlot) : scriptCard) : null;

    return (
        <>
            <div className="stack bld-root">
                {switchNote}
                <div className="bld-toolbar" role="toolbar" aria-label="Edit actions">
                    <Button icon={Plus} aria-expanded={palette} aria-controls="bld-palette" onClick={() => setPalette((v) => !v)}>
                        Add a step
                    </Button>
                    <Button icon={Blocks} disabled={dirty || items.length === 0} tip={dirty ? "Save or discard your changes first." : items.length === 0 ? "Add a step first." : "Moves some of these steps into reusable steps that other tests can use. This test then runs them from there."} onClick={() => setSaveAsBlock(true)}>
                        Save steps as reusable steps
                    </Button>
                </div>

                {palette && (
                    <section className="card bld-palette" id="bld-palette" aria-labelledby="bld-palette-title">
                        <h2 className="sr-only" id="bld-palette-title">Add a step</h2>
                        <p className="t-secondary">{selectedIndex >= 0 ? `The new step goes after step ${selectedIndex + 1}.` : "The new step goes at the end."}</p>
                        {groups.map((g) => (
                            <div key={g.id} className="bld-group" role="group" aria-label={g.title}>
                                <h3 className="t-card">{g.title}</h3>
                                <div className="chips">
                                    {g.items.map((p) => (
                                        <Button key={p.id} type="button" onClick={() => add(p)}>
                                            {p.label}
                                        </Button>
                                    ))}
                                </div>
                                {g.more && g.more.length > 0 && (
                                    <details className="bld-more">
                                        <summary>More checks</summary>
                                        <div className="chips">
                                            {g.more.map((p) => (
                                                <Button key={p.id} type="button" onClick={() => add(p)}>
                                                    {p.label}
                                                </Button>
                                            ))}
                                        </div>
                                    </details>
                                )}
                            </div>
                        ))}
                        <BlockPalette projectId={data.projectId} kind={kind} blocks={blocks} failed={!!blockList.error} placeholders={data.placeholders} onAdd={addStep} />
                    </section>
                )}

                {justSaved && (
                    <Callout tone="success" title="Reusable steps saved">
                        Those steps are now “{justSaved}”. This test runs them from there, and other tests can use them too.
                    </Callout>
                )}

                <div className="bld-grid">
                    <div className="stack bld-root">
                        {diags.length > 0 && (
                            <section className="card" aria-labelledby="bld-problems-title">
                                <div className="card-head wrap">
                                    <h2 className="t-section" id="bld-problems-title">
                                        {errors.length ? "Problems to fix" : "Notes"}
                                    </h2>
                                    <span className="t-meta">{errors.length ? `${errors.length} to fix` : `${notes.length}`}</span>
                                </div>
                                <ul className="bld-problems">
                                    {diags.map((m, i) => (
                                        <li key={i}>
                                            <Badge tone={m.severity === "error" ? "danger" : "warning"}>{m.severity === "error" ? "Fix" : "Note"}</Badge>
                                            <span className="bld-pmsg">{m.message}</span>
                                            {m.stepIndex !== undefined && items[m.stepIndex] && (
                                                <Button size="sm" variant="ghost" onClick={() => goTo(m.stepIndex!)}>
                                                    Go to step {m.stepIndex + 1}
                                                </Button>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        )}
                        <section className="card card-pad stack-sm" aria-labelledby="bld-details-title">
                            <h2 className="t-section" id="bld-details-title">
                                Test details
                            </h2>
                            <div className="field">
                                <label htmlFor="bld-title">Test name</label>
                                <input id="bld-title" className="input" value={title} maxLength={data.kinds.limits.title} aria-invalid={!!titleProblem} aria-describedby={titleProblem ? "bld-title-err" : undefined} onChange={(e) => setTitle(e.target.value)} />
                                {titleProblem && (
                                    <span className="error-text" id="bld-title-err">
                                        {titleProblem}
                                    </span>
                                )}
                            </div>
                            <Disclosure label="Test values">
                                <div className="stack-sm">
                                    <p className="hint">Names you can use in steps as {"{{name}}"}. {data.placeholders.dataSet ? `The data set “${data.placeholders.dataSet}” stays attached.` : ""}</p>
                                    <MapField key={resets} id="bld-values" label="Test values" value={testData} hidden={["dataSet"]} nameLabel="Name" valueLabel="Value" onChange={(v) => setTestData(v ?? {})} />
                                    <p className="hint">Do not type passwords or keys here. Use the saved sign-in placeholders in a step instead.</p>
                                </div>
                            </Disclosure>
                        </section>

                        <section className="card" aria-labelledby="bld-steps-title">
                            <div className="card-head wrap">
                                <h2 className="t-section" id="bld-steps-title">
                                    Steps
                                </h2>
                                <span className="t-meta">{items.length} in all</span>
                            </div>
                            <div className="bld-live" role="status" aria-live="polite">
                                {deleted && (
                                    <>
                                        <span>Step {deleted.index + 1} removed.</span>
                                        <Button size="sm" icon={Undo2} onClick={undoDelete}>
                                            Undo
                                        </Button>
                                    </>
                                )}
                            </div>
                            {items.length === 0 ? (
                                <EmptyState
                                    icon={ListPlus}
                                    title="This test has no steps yet"
                                    actions={
                                        <Button variant="primary" icon={Plus} onClick={() => setPalette(true)}>
                                            Add a step
                                        </Button>
                                    }
                                >
                                    A test needs at least one step. Add one to begin.
                                </EmptyState>
                            ) : (
                                <ol className="bld-steps" aria-label="Steps of this test">
                                    {items.map((it, i) => {
                                        const open = selected === it.key;
                                        const mine = problemsFor(diags, i);
                                        const myErrors = mine.filter((m) => m.severity === "error");
                                        const editableStep = EDITABLE_ACTIONS.includes(it.step.action);
                                        const last = markOf(it);
                                        return (
                                            <li
                                                key={it.key}
                                                id={`bld-step-${it.key}`}
                                                data-step-key={it.key}
                                                className={`bld-step${open ? " is-open" : ""}${last?.mark.status === "failed" ? " is-failed" : ""}${dragOver === i && dragFrom !== null && dragFrom !== i ? " is-drop" : ""}`}
                                                onDragOver={(e) => {
                                                    if (dragFrom === null) return;
                                                    e.preventDefault();
                                                    setDragOver(i);
                                                }}
                                                onDrop={(e) => {
                                                    e.preventDefault();
                                                    if (dragFrom !== null) move(dragFrom, i);
                                                    setDragFrom(null);
                                                    setDragOver(null);
                                                }}
                                            >
                                                <div className="bld-bar">
                                                    <span
                                                        className="bld-grip"
                                                        draggable
                                                        aria-hidden="true"
                                                        title="Drag to move this step. With the keyboard: Alt+Up or Alt+Down on the step."
                                                        onDragStart={(e) => {
                                                            setDragFrom(i);
                                                            e.dataTransfer.effectAllowed = "move";
                                                            e.dataTransfer.setData("text/plain", String(i));
                                                        }}
                                                        onDragEnd={() => {
                                                            setDragFrom(null);
                                                            setDragOver(null);
                                                        }}
                                                    >
                                                        <GripVertical size={18} />
                                                    </span>
                                                    <button
                                                        type="button"
                                                        className="bld-head"
                                                        data-head-key={it.key}
                                                        aria-expanded={open}
                                                        aria-controls={`bld-form-${it.key}`}
                                                        onClick={() => setSelected(open ? null : it.key)}
                                                        onKeyDown={(e) => {
                                                            if (e.altKey && e.key === "ArrowUp") (e.preventDefault(), move(i, i - 1));
                                                            if (e.altKey && e.key === "ArrowDown") (e.preventDefault(), move(i, i + 1));
                                                        }}
                                                    >
                                                        <span className="bld-n">Step {i + 1}</span>
                                                        {last && (
                                                            <span className={`bld-mark is-${last.mark.status}`} data-testid="step-mark" data-status={last.mark.status} role="img" aria-label={last.mark.status === "passed" ? "Passed in the last run" : "Failed in the last run"}>
                                                                {last.mark.status === "passed" ? <Check size={14} aria-hidden /> : <X size={14} aria-hidden />}
                                                            </span>
                                                        )}
                                                        <span className="bld-text">{sentence(it.step)}</span>
                                                        {last?.edited && <span className="bld-edited t-meta">edited since that run</span>}
                                                        {last?.mark.status === "failed" && !last.edited && <span className="bld-err t-meta">{cleanReason(firstLineOf(last.mark.error)) || "This step failed."}</span>}
                                                        {myErrors.length > 0 && <Badge tone="danger">{myErrors.length === 1 ? "1 problem" : `${myErrors.length} problems`}</Badge>}
                                                        <ChevronDown size={16} className="bld-chev" aria-hidden />
                                                    </button>
                                                    {/* Shared elements work on the stored steps, so the action waits until nothing is unsaved. */}
                                                    {(!dirty || it.step.locator?.ref !== undefined) && <StepShare projectId={data.projectId} testId={id} kind={data.kind} stepIndex={i} step={it.step as { locator?: { ref?: string; by?: string } }} onChanged={() => void onShared()} />}
                                                    <div className="bld-acts">
                                                        <Button type="button" variant="ghost" iconOnly icon={ArrowUp} className="bld-ibtn" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, i - 1)} />
                                                        <Button type="button" variant="ghost" iconOnly icon={ArrowDown} className="bld-ibtn" aria-label={`Move step ${i + 1} down`} disabled={i === items.length - 1} onClick={() => move(i, i + 1)} />
                                                        <Button type="button" variant="ghost" iconOnly icon={Copy} className="bld-ibtn" aria-label={`Duplicate step ${i + 1}`} disabled={items.length >= data.kinds.limits.steps} onClick={() => (setItems(duplicateAt(items, i)), setDeleted(null))} />
                                                        <Button type="button" variant="ghost" iconOnly icon={Trash2} className="bld-ibtn btn-danger" aria-label={`Delete step ${i + 1}`} tip="Takes it out of your draft. Undo appears, and nothing is saved until you save." onClick={() => remove(i)} />
                                                    </div>
                                                </div>
                                                {open && (
                                                    <div className="bld-body" id={`bld-form-${it.key}`}>
                                                        <h3 className="t-card">{ACTION_LABEL[it.step.action] ?? it.step.action}</h3>
                                                        {editableStep ? (
                                                            <StepForm id={`bld-${it.key}`} step={it.step} onChange={(s) => change(i, s)} catalog={data.kinds} placeholders={data.placeholders} shared={sharedList} blocks={blocks?.filter((b) => b.kind === "any" || b.kind === kind) ?? null} projectId={data.projectId} />
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
                        </section>
                    </div>

                </div>
            </div>
            {scriptPlace}
            {bar}
            {leaveDialog}
            {saveAsBlock && (
                <SaveAsBlockDialog
                    projectId={data.projectId}
                    testId={id}
                    steps={stepsOf(items)}
                    onClose={() => setSaveAsBlock(false)}
                    onDone={(b) => {
                        setSaveAsBlock(false);
                        allowLeaving();
                        void onExtracted(b);
                    }}
                />
            )}
            {confirmDiscard && (
                <Modal
                    title="Discard your changes?"
                    titleId="bld-discard-title"
                    onClose={() => setConfirmDiscard(false)}
                    foot={
                        <>
                            <Button data-autofocus onClick={() => setConfirmDiscard(false)}>
                                Keep editing
                            </Button>
                            <Button variant="danger" onClick={discard}>
                                Discard changes
                            </Button>
                        </>
                    }
                >
                    <p className="t-secondary">The steps go back to the last saved version. This cannot be undone.</p>
                </Modal>
            )}
        </>
    );
}

/** The plain wording of a step: the person's own note if there is one, else the automatic sentence. */
function sentence(step: Step): string {
    const note = typeof step.description === "string" ? step.description.trim() : "";
    return note || stepSentence(step);
}

export { newKey };
