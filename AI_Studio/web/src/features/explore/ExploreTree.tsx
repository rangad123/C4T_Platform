import { Check, ChevronRight, Circle, History, LoaderCircle, Minus, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, type EventRow, type Job, type PhaseKey, type PhaseState } from "../../api";
import { mergeEvents, type JobStream } from "../../lib/stream";
import type { RunTest } from "../runs/run-text";
import { useRunAnswer } from "../runs/runs";
import { foldExploreTree, STATE_LABEL, tally, type NodeState, type TreeNode } from "./explore-tree";
import "./explore-tree.css";

const PAGE = 500;
/** Children shown before "Show all": a long crawl stays readable. */
const SHOWN = 40;
/** Narrow screens start with every branch folded. */
const NARROW = "(max-width: 640px)";

/** Kinds the tree reads (explore-tree.ts); the rest of a job's events are not kept here. */
const TREE_KINDS = new Set(["page_visited", "page_failed", "exploration_resumed", "plan_reused", "understanding_resumed", "creation_resumed", "scenario_planned", "scenarios_queued", "scenario_started", "script_generated", "possible_defect", "scenario_skipped", "scenario_failed", "probes_reused", "pages_from_memory", "signin_reused", "reuse_reprobed", "reuse_off", "full_exploration", "understanding_reused"]);

/**
 * A job's events the tree reads: all of them read once from the platform (pages of 500), then the new ones as the live stream brings them, and
 * every few seconds while it runs without a stream. A refresh, or coming back later, rebuilds the same tree.
 */
export function useTreeEvents(jobId: string, active: boolean, stream: Pick<JobStream, "events" | "live">): EventRow[] {
    const [rows, setRows] = useState<EventRow[]>([]);
    const last = useRef(0);
    const flying = useRef(false);
    const pull = useCallback(async () => {
        if (flying.current) return;
        flying.current = true;
        try {
            for (let i = 0; i < 200; i++) {
                const page = await api<EventRow[]>(`/test-generation/${jobId}/events?after=${last.current}`);
                for (const e of page) last.current = Math.max(last.current, e.id);
                const kept = page.filter((e) => TREE_KINDS.has(e.kind));
                if (kept.length) setRows((prev) => mergeEvents(prev, kept));
                if (page.length < PAGE) break;
            }
        } catch {
            // The next pull tries again; the tree keeps what it has.
        } finally {
            flying.current = false;
        }
    }, [jobId]);
    useEffect(() => {
        last.current = 0;
        setRows([]);
        void pull();
    }, [jobId, pull]);
    // The live stream says an event of the tree arrived, but carries no event's facts (only a runner's events have them there): what is new
    // is read from the platform, with its facts, a moment later.
    const newest = stream.events.filter((e) => TREE_KINDS.has(e.kind)).at(-1)?.id ?? 0;
    useEffect(() => {
        if (newest <= last.current) return;
        const t = window.setTimeout(() => void pull(), 300);
        return () => clearTimeout(t);
    }, [newest, pull]);
    useEffect(() => {
        if (!active || stream.live) return;
        const t = window.setInterval(() => void pull(), 3000);
        return () => clearInterval(t);
    }, [active, stream.live, pull]);
    const was = useRef(active);
    useEffect(() => {
        if (was.current && !active) void pull();
        was.current = active;
    }, [active, pull]);
    return rows;
}

function Mark({ state }: { state: NodeState }) {
    return (
        <span className={`xt-mark is-${state}`} aria-hidden>
            {state === "done" ? <Check size={12} /> : state === "running" ? <LoaderCircle size={12} className="spin" /> : state === "failed" ? <X size={12} /> : state === "skipped" ? <Minus size={12} /> : <Circle size={6} />}
        </span>
    );
}

/** "3 done, 1 running": what a branch holds, said on its toggle so a folded branch still tells its progress. */
function summaryOf(n: TreeNode): string {
    const t = tally(n);
    const parts = (["running", "done", "failed", "skipped", "waiting"] as const).filter((s) => t[s]).map((s) => `${t[s]} ${STATE_LABEL[s].toLowerCase()}`);
    return parts.join(", ");
}

function Node({ node, label, detail, open: startOpen, level, phaseState }: { node: TreeNode; label?: string; detail?: string; open: boolean; level: number; /** A stage: its state as the job says it (the class the checklist's steps carried). */ phaseState?: PhaseState }) {
    const [open, setOpen] = useState(startOpen);
    const touched = useRef(false);
    // A stage that starts running opens by itself, unless the person already opened or closed it.
    useEffect(() => {
        if (startOpen && !touched.current) setOpen(true);
    }, [startOpen]);
    const [all, setAll] = useState(false);
    const listId = useId();
    const kids = node.children;
    const shown = all ? kids : kids.slice(0, SHOWN);
    const text = detail ?? node.detail;
    return (
        <li className={`xt-node is-${node.state}${phaseState ? ` ${phaseState}` : ""}`} data-testid={`xt-${node.id}`} data-state={node.state}>
            <div className="xt-row">
                <Mark state={node.state} />
                <span className="xt-what">
                    <span className={level === 0 ? "xt-name xt-stage" : "xt-name"}>{label ?? node.label}</span>
                    <span className="xt-state">{STATE_LABEL[node.state]}</span>
                    {node.badge && (
                        <span className={`xt-badge is-${node.badge.tone}`} data-testid="xt-badge">
                            {node.badge.tone === "warning" ? <TriangleAlert size={12} aria-hidden /> : <History size={12} aria-hidden />}
                            {node.badge.text}
                        </span>
                    )}
                    {text && <span className="t-meta xt-detail">{text}</span>}
                </span>
            </div>
            {kids.length > 0 && (
                <>
                    <button type="button" className="xt-toggle" aria-expanded={open} aria-controls={listId} onClick={() => {
                            touched.current = true;
                            setOpen(!open);
                        }}>
                        <ChevronRight size={14} className="chev" aria-hidden />
                        {open ? "Hide" : "Show"} {kids.length} {kids.every((k) => k.id.startsWith("note:")) ? (kids.length === 1 ? "detail" : "details") : level === 0 ? itemWord(node, kids.length) : kids.length === 1 ? "test" : "tests"}
                        <span className="t-meta"> ({summaryOf(node)})</span>
                    </button>
                    <ul id={listId} className="xt-list" hidden={!open}>
                        {shown.map((c) => (
                            <Node key={c.id} node={c} open={false} level={level + 1} />
                        ))}
                        {kids.length > shown.length && (
                            <li className="xt-more">
                                <button type="button" className="xt-toggle" onClick={() => setAll(true)}>
                                    Show all {kids.length}
                                </button>
                            </li>
                        )}
                    </ul>
                </>
            )}
        </li>
    );
}

const itemWord = (n: TreeNode, count: number): string => {
    const one = count === 1;
    // Notes beside the pages (what was kept or reused): the count is of both, so it says items.
    if (n.children.some((c) => c.id.startsWith("note:"))) return one ? "item" : "items";
    switch (n.id) {
        case "stage:discovery":
            return one ? "page" : "pages";
        case "stage:planning":
            return one ? "test idea" : "test ideas";
        default:
            return one ? "item" : "items";
    }
};

/**
 * The exploration as a tree: each stage with its state, and under it what it worked on (pages, test ideas, tests), each with its own state.
 * Nested lists with a disclosure button per branch, so a screen reader hears the structure and every state as a word. A running stage starts
 * open on a wide screen; on a small one every branch starts folded and says what it holds on its button.
 */
export function ExploreTree({ job, active, tests, events, stageText }: { job: Pick<Job, "progress" | "planOnly" | "cancelled" | "error">; active: boolean; tests: readonly RunTest[]; events: readonly EventRow[]; /** The words of a stage (the checklist's own, lib/labels phaseText). */ stageText: (phase: PhaseKey, state: PhaseState) => { title: string; detail?: string } }) {
    const phases: PhaseKey[] = job.planOnly ? ["discovery", "understanding", "planning"] : ["discovery", "understanding", "planning", "generation", "validation"];
    const stopped = job.error === "Cancelled";
    const stages = useMemo(() => foldExploreTree({ phases, progress: job.progress, events, tests, active, stopped }), [job.progress, job.planOnly, events, tests, active, stopped]); // eslint-disable-line react-hooks/exhaustive-deps
    const [narrow] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NARROW).matches);
    return (
        <ol className="steps xtree" aria-label="Exploration progress" data-testid="explore-tree">
            {stages.map((s) => {
                // A stage the stop came during or before reads as not done ("Create test scripts"), never as still going.
                const t = stageText(s.phase, s.state === "skipped" && job.progress[s.phase] !== "skipped" ? "pending" : job.progress[s.phase]);
                const title = job.progress[s.phase] === "skipped" ? `${t.title.replace(/…$/, "")} (not needed)` : t.title;
                return <Node key={s.id} node={s} label={title} detail={s.detail ?? (s.state !== "skipped" ? t.detail : undefined)} open={!narrow && s.state === "running"} level={0} phaseState={job.progress[s.phase]} />;
            })}
        </ol>
    );
}

/**
 * The tree for a job of its own: reads the job's events (useTreeEvents) and, for one that creates tests, the run's tests (the same answer
 * the Runs page reads).
 */
export function JobExploreTree({ job, active, stream, stageText, tests }: { job: Pick<Job, "jobId" | "projectId" | "progress" | "planOnly" | "cancelled" | "error">; active: boolean; stream: JobStream; stageText: (phase: PhaseKey, state: PhaseState) => { title: string; detail?: string }; /** Already read by the page; else read here. */ tests?: readonly RunTest[] }) {
    const events = useTreeEvents(job.jobId, active, stream);
    // The page's own live stream of this job, never a second one (useRunAnswer's `shared`).
    const own = useRunAnswer(job.projectId, tests || job.planOnly ? null : job.jobId, active, stream);
    return <ExploreTree job={job} active={active} tests={tests ?? own.data?.tests ?? []} events={events} stageText={stageText} />;
}
