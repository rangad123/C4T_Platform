/**
 * The progress tree of an exploration: its stages, then the pages it found, then the test ideas, then the tests, each with a state. Built only
 * from what the platform already records (the job's stage states, its events and the run's tests): nothing is asked of the AI.
 * Pure (no React, no network), so a test folds recorded events with the same rules the page uses.
 *
 * The events it reads: page_visited / page_failed (the crawl), exploration_resumed / plan_reused (pages kept from before), scenario_planned
 * (the plan), scenarios_queued, scenario_started, script_generated, possible_defect, scenario_skipped, scenario_failed (writing each idea),
 * creation_resumed (tests kept from a stopped creation). Older jobs lack the `data` some of these carry; their messages are read instead.
 *
 * What the exploration reused from the last one (sheet #8): a page whose earlier probe results were taken (page_visited with `reusedFrom`)
 * carries a "Reused" badge with the date; one tried again after reuse was switched off (reuse_reprobed) loses it and says so. The crawl
 * stage also says what was reused (probes_reused, pages_from_memory, signin_reused) and, as a warning, that reuse was switched off and why
 * (reuse_off, full_exploration); the reading stage says how many unchanged pages were not sent to the AI again (understanding_reused).
 *
 * A later kind of stage (for example exploring by objectives) adds its own node to `stages` with the same shape.
 */
import type { EventRow, PhaseKey, PhaseState } from "../../api.js";
import type { RunState, RunTest } from "../runs/run-text.js";

export type NodeState = "waiting" | "running" | "done" | "failed" | "skipped";

export interface TreeNode {
    id: string;
    label: string;
    state: NodeState;
    /** A short second line: why it failed or was skipped, or what it holds. */
    detail?: string;
    /** A word beside the label: "Reused 2026-11-10" (taken from an earlier exploration) or a warning ("Reuse off"). */
    badge?: { text: string; tone: "info" | "warning" };
    children: TreeNode[];
}

const day = (iso: unknown): string | undefined => (typeof iso === "string" && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : undefined);
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface StageNode extends TreeNode {
    phase: PhaseKey;
}

/** The words for each state, shown next to every node (never colour alone). */
export const STATE_LABEL: Record<NodeState, string> = { waiting: "Waiting", running: "Running", done: "Done", failed: "Failed", skipped: "Skipped" };

const TEST_STATE: Record<RunState, { state: NodeState; detail?: string }> = {
    waiting: { state: "waiting" },
    running: { state: "running" },
    passed: { state: "done", detail: "Passing" },
    failed: { state: "failed", detail: "Failing" },
    finding: { state: "failed", detail: "Needs a look" },
    not_run: { state: "skipped", detail: "Not run" },
};

const PHASE_STATE: Record<PhaseState, NodeState> = { pending: "waiting", running: "running", done: "done", failed: "failed", skipped: "skipped" };

const IDEA_ID = /^([A-Z]+-\d+)\b/;
const dataOf = (e: EventRow) => (e.data && typeof e.data === "object" ? (e.data as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export interface TreeInput {
    phases: readonly PhaseKey[];
    progress: Record<PhaseKey, PhaseState>;
    events: readonly EventRow[];
    tests: readonly RunTest[];
    /** The job is still going. Once it is over, what was waiting or running was not reached. */
    active: boolean;
    /** The job ended because someone stopped it. */
    stopped: boolean;
}

function testNode(t: RunTest): TreeNode {
    const s = TEST_STATE[t.state];
    return { id: `test:${t.id}`, label: `${t.testId} ${t.title}`, state: s.state, ...(s.detail ? { detail: s.detail } : {}), children: [] };
}

/** The state of a group from its children: running if any runs, waiting if any waits, failed if any failed, else done. */
function groupState(children: TreeNode[]): NodeState {
    if (!children.length) return "waiting";
    if (children.some((c) => c.state === "running")) return "running";
    if (children.some((c) => c.state === "waiting")) return "waiting";
    if (children.every((c) => c.state === "skipped")) return "skipped";
    return children.some((c) => c.state === "failed") ? "failed" : "done";
}

/** Once the job is over, nothing is still waiting or running: what the stop came before is said to be not reached. */
function settle(n: TreeNode, input: TreeInput): TreeNode {
    const children = n.children.map((c) => settle(c, input));
    if (input.active || (n.state !== "waiting" && n.state !== "running")) return { ...n, children };
    const detail = n.state === "running" ? (input.stopped ? "Stopped here" : "Did not finish") : input.stopped ? "Not reached: the exploration was stopped" : "Not reached";
    return { ...n, state: "skipped", detail, children };
}

/**
 * The stages a job's tree shows: a plan stops after planning; a check agent's run (Agent Workspace D1: accessibility, UX...) plans no
 * test ideas, which are Test Case Generation's work, so that stage is not part of it.
 */
export function treePhases(job: { planOnly?: boolean; agentId?: string }): PhaseKey[] {
    if (job.planOnly) return ["discovery", "understanding", "planning"];
    if (job.agentId && job.agentId !== "test-generation") return ["discovery", "understanding", "generation", "validation"];
    return ["discovery", "understanding", "planning", "generation", "validation"];
}

export function foldExploreTree(input: TreeInput): StageNode[] {
    const pages: TreeNode[] = [];
    const ideasPlanned: TreeNode[] = [];
    const ideas = new Map<string, TreeNode>();
    const ideaOfTest = new Map<string, string>();
    const notes: Partial<Record<PhaseKey, TreeNode[]>> = {};
    const note = (phase: PhaseKey, id: string, label: string, extra: Pick<TreeNode, "badge" | "detail"> = {}) => (notes[phase] ??= []).push({ id, label, state: "done", ...extra, children: [] });
    const REUSED = (since?: string): TreeNode["badge"] => ({ text: since ? `Reused ${since}` : "Reused", tone: "info" });
    const OFF: TreeNode["badge"] = { text: "Reuse off", tone: "warning" };
    /** The crawl's pages by path (the last visit of each), for the badges a later event changes. */
    const pageByPath = new Map<string, TreeNode>();
    /** The paths the crawl's last probes_reused names as reused, when it names them all. */
    let finalReused: Set<string> | undefined;
    let reprobed = false;
    const idea = (id: string, title?: string): TreeNode => {
        let n = ideas.get(id);
        if (!n) {
            n = { id: `idea:${id}`, label: title ? `${id} ${title}` : id, state: "waiting", children: [] };
            ideas.set(id, n);
        } else if (title && n.label === id) n.label = `${id} ${title}`;
        return n;
    };

    for (const e of input.events) {
        const d = dataOf(e);
        switch (e.kind) {
            case "page_visited": {
                const path = /^Visited (\S+)/.exec(e.message)?.[1] ?? str(d.url) ?? e.message;
                const since = day(d.reusedFrom);
                const n: TreeNode = { id: `page:${e.id}`, label: path, state: "done", ...(since ? { badge: REUSED(since), detail: `Unchanged since ${since}: its menus, conditional fields and validation messages were taken from then, not tried again` } : {}), children: [] };
                pages.push(n);
                pageByPath.set(path, n);
                break;
            }
            case "probes_reused": {
                const n = typeof d.pages === "number" ? d.pages : 0;
                const since = day(d.since);
                const paths = Array.isArray(d.paths) ? (d.paths as unknown[]).filter((p): p is string => typeof p === "string") : [];
                if (paths.length >= n) finalReused = new Set(paths);
                const checked = typeof d.spotChecked === "number" ? d.spotChecked : 0;
                note("discovery", `note:${e.id}`, `${count(n, "page", "pages")} unchanged${since ? ` since ${since}` : ""}: not tried again`, { badge: REUSED(since), detail: `${count(checked, "page was", "pages were")} tried anyway as a spot check and matched.` });
                break;
            }
            case "pages_from_memory": {
                const n = typeof d.pages === "number" ? d.pages : 0;
                const gone = typeof d.gone === "number" ? d.gone : 0;
                note("discovery", `note:${e.id}`, `Started from ${count(n, "page", "pages")} the last exploration knew`, { badge: REUSED(), ...(gone ? { detail: `${count(gone, "known page is", "known pages are")} gone now and ${gone === 1 ? "was" : "were"} left out.` } : {}) });
                break;
            }
            case "signin_reused": {
                const since = day(d.since);
                note("discovery", `note:${e.id}`, `Went straight to the sign-in page${str(d.path) ? ` ${d.path}` : ""}`, { badge: REUSED(since), detail: "The form was still filled and the sign-in checked." });
                break;
            }
            case "reuse_reprobed":
                reprobed = true;
                note("discovery", `note:${e.id}`, `${count(typeof d.pages === "number" ? d.pages : 0, "page was", "pages were")} tried again after reuse was switched off`);
                break;
            case "reuse_off":
                note("discovery", `note:${e.id}`, "Reuse of the last exploration was switched off for the rest of this run", { badge: OFF, detail: str(d.reason) ? `Why: ${d.reason}.` : e.message });
                break;
            case "full_exploration":
                note("discovery", `note:${e.id}`, "Everything was explored again, as asked: nothing was reused", { badge: OFF });
                break;
            case "understanding_reused": {
                const n = typeof d.pages === "number" ? d.pages : Number(/(\d+)/.exec(e.message)?.[1] ?? 0);
                note("understanding", `note:${e.id}`, `${count(n, "unchanged page was", "unchanged pages were")} not sent to the AI again`, { badge: REUSED() });
                break;
            }
            case "page_failed":
                pages.push({ id: `page:${e.id}`, label: /^Could not load (\S+?):?\s/.exec(e.message)?.[1] ?? e.message, state: "failed", detail: "Could not be loaded", children: [] });
                break;
            case "exploration_resumed":
            case "plan_reused":
            {
                const kept = typeof d.pages === "number" ? d.pages : Number(/(\d+) pages?\b/.exec(e.message)?.[1] ?? NaN);
                note("discovery", `note:${e.id}`, Number.isFinite(kept) ? `${kept} ${kept === 1 ? "page" : "pages"} kept from before, not explored again` : "Pages kept from before, not explored again");
                break;
            }
            case "understanding_resumed":
                note("understanding", `note:${e.id}`, "The reading of the application was kept from before");
                break;
            case "creation_resumed":
                note("generation", `note:${e.id}`, typeof d.carried === "number" ? `${d.carried} tests kept from the stopped creation, not made again` : "Tests kept from the stopped creation, not made again");
                break;
            case "scenario_planned": {
                const id = str(d.scenarioId) ?? IDEA_ID.exec(e.message)?.[1];
                const title = str(d.title) ?? e.message.replace(/^\S+\s+(\[[^\]]*\]\s*)?/, "");
                if (id) ideasPlanned.push({ id: `planned:${id}`, label: `${id} ${title}`, state: "done", children: [] });
                break;
            }
            case "scenarios_queued":
                for (const s of Array.isArray(d.scenarios) ? (d.scenarios as Array<{ scenarioId?: unknown; title?: unknown }>) : []) if (str(s.scenarioId)) idea(String(s.scenarioId), str(s.title));
                break;
            case "scenario_started": {
                const id = str(d.scenarioId) ?? IDEA_ID.exec(e.message)?.[1];
                if (id) {
                    const n = idea(id, e.message.replace(/^\S+\s+/, ""));
                    n.state = "running";
                }
                break;
            }
            case "script_generated":
            case "possible_defect": {
                const id = str(d.scenarioId);
                const testId = str(d.testId) ?? IDEA_ID.exec(e.message)?.[1];
                if (id) {
                    const n = idea(id);
                    n.state = "done";
                    if (e.kind === "possible_defect") n.detail = "Written; the application did not behave as expected";
                    if (testId) ideaOfTest.set(testId, id);
                }
                break;
            }
            case "scenario_skipped":
            case "scenario_failed": {
                const id = str(d.scenarioId) ?? IDEA_ID.exec(e.message)?.[1];
                if (id) {
                    const n = idea(id);
                    n.state = e.kind === "scenario_failed" ? "failed" : "skipped";
                    n.detail = e.kind === "scenario_failed" ? "Could not be written" : /could not be authored/.test(e.message) ? "Could not be written in this application" : "Not written";
                }
                break;
            }
        }
    }

    // Pages tried again after reuse went off keep none of the earlier results: no badge (only the ones the crawl still names stay reused).
    if (reprobed || finalReused) {
        for (const [path, n] of pageByPath) {
            if (!n.badge || finalReused?.has(path)) continue;
            delete n.badge;
            n.detail = reprobed ? "Tried again after reuse was switched off" : undefined;
            if (!n.detail) delete n.detail;
        }
    }

    // The tests: under the idea each was written for, the others (the checks) in one group.
    const checks: TreeNode[] = [];
    for (const t of input.tests) {
        const id = ideaOfTest.get(t.testId);
        const owner = id ? ideas.get(id) : undefined;
        if (owner) owner.children.push(testNode(t));
        else checks.push(testNode(t));
    }

    const childrenOf = (phase: PhaseKey): TreeNode[] => {
        const kept = notes[phase] ?? [];
        switch (phase) {
            case "discovery":
                return [...kept, ...pages];
            case "planning":
                return ideasPlanned;
            case "generation": {
                const written = [...ideas.values()];
                const group: TreeNode[] = checks.length ? [{ id: "checks", label: `Checks (${checks.length})`, state: groupState(checks), children: checks }] : [];
                return [...kept, ...written, ...group];
            }
            default:
                return kept;
        }
    };

    return input.phases.map((phase): StageNode => ({ ...settle({ id: `stage:${phase}`, label: phase, state: PHASE_STATE[input.progress[phase]], children: childrenOf(phase) }, input), phase }));
}

/** How many nodes below a node, and how many of them are in each state (the line a collapsed node shows). */
export function tally(n: TreeNode): Record<NodeState, number> & { total: number } {
    const out = { waiting: 0, running: 0, done: 0, failed: 0, skipped: 0, total: 0 };
    for (const c of n.children) {
        out[c.state]++;
        out.total++;
    }
    return out;
}
