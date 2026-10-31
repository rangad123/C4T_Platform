/** Types, wording and the editor's draft model for runbooks (see src/platform/routes/runbooks.ts and src/engine/runbook/schema.ts). */
import type { Tone } from "../../lib/labels";

export type StepType = "run" | "analyze" | "condition" | "notify" | "wait";
export type CheckKind = "passRate" | "noFailures" | "noHighSeverity" | "noApiBreakingChange" | "readiness";
export type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "stopped" | "timed_out";
export type RunStatus = "running" | "passed" | "failed" | "stopped" | "timed_out" | "cancelled" | "interrupted";

export type Scope = "all" | { suite?: string; tag?: string; type?: string; testIds?: string[] };

/** A step as the API stores it. */
export interface StepDef {
    id: string;
    type: StepType;
    title?: string;
    onPass?: string;
    onFail?: string;
    scope?: Scope;
    environment?: string;
    retries?: 0 | 1 | 2;
    confirmProduction?: boolean;
    includeMobile?: boolean;
    allowMutatingApiTests?: boolean;
    loadChecks?: boolean;
    condition?: { check: CheckKind; atLeast?: number };
    channelId?: string;
    message?: string;
    seconds?: number;
}

export interface Definition {
    version: 1;
    name: string;
    description?: string;
    steps: StepDef[];
}

export interface RunSummary {
    runId: string;
    runbookId: string;
    runbookName: string;
    status: RunStatus;
    finished: boolean;
    passed: boolean | null;
    reason: string | null;
    trigger: "manual" | "schedule" | "deploy";
    triggerLabel: string | null;
    cancelRequested: boolean;
    createdAt: string;
    finishedAt: string | null;
    durationMs: number | null;
    ticks: StepStatus[];
}

export interface RunStepView {
    index: number;
    id: string;
    type: StepType;
    title: string;
    status: StepStatus;
    jobId: string | null;
    reason: string | null;
    measured: string | null;
    startedAt: string | null;
    finishedAt: string | null;
}

export interface RunDetail extends RunSummary {
    steps: RunStepView[];
}

export interface Runbook {
    id: string;
    name: string;
    description: string | null;
    definition: Definition;
    titles: string[];
    updatedAt: string;
    usedBy: { schedules: Array<{ id: string; name: string }>; tokens: Array<{ id: string; label: string | null; hint: string }> };
    lastRun: RunSummary | null;
    running: boolean;
    warnings: string[];
    /** Only on a runbook just made from a template. */
    note?: string | null;
}

export interface Template {
    id: string;
    name: string;
    summary: string;
    usesChannel: boolean;
}

export interface RunbookList {
    runbooks: Runbook[];
    limits: { maxRunbooks: number; maxSteps: number; maxWaitSeconds: number; maxNameLength: number; stepMinutes: number; totalMinutes: number };
    templates: Template[];
}

// ── wording ─────────────────────────────────────────────────────────────────

/** `help`: what the status means, from finalStatus (src/engine/runbook/flow.ts) and the runner (src/platform/runbook-runner.ts). */
export const RUN_STATUS: Record<RunStatus, { label: string; tone: Tone; help: string }> = {
    running: { label: "Running", tone: "info", help: "The steps are going now, one at a time." },
    passed: { label: "Passed", tone: "success", help: "It reached the end, or a step ended it early on purpose, and no step failed." },
    failed: { label: "Failed", tone: "danger", help: "It reached the end, but a step failed on the way, even one the sequence went around." },
    stopped: { label: "Stopped after a failure", tone: "danger", help: "A step failed and the sequence then ended before its last step, as it was set to." },
    timed_out: { label: "Ran out of time", tone: "danger", help: "A step or the whole sequence took longer than it may, so it was ended." },
    cancelled: { label: "Cancelled", tone: "neutral", help: "Someone cancelled it. The job of the step that was running was asked to stop." },
    interrupted: { label: "Interrupted", tone: "warning", help: "The platform was shut down while it ran. It is not resumed: start it again if you still need it." },
};

export const STEP_STATUS: Record<StepStatus, string> = {
    pending: "Waiting",
    running: "Running",
    passed: "Passed",
    failed: "Failed",
    skipped: "Skipped",
    stopped: "Stopped",
    timed_out: "Ran out of time",
};

/** The colour of one tick in the mini ribbon (shared tokens): pass, fail, in between, nothing yet. */
export function tickOf(s: StepStatus): "pass" | "fail" | "attention" | "idle" {
    if (s === "passed") return "pass";
    if (s === "failed" || s === "timed_out") return "fail";
    if (s === "running" || s === "stopped") return "attention";
    return "idle";
}

export const STEP_TYPE_LABEL: Record<StepType, string> = {
    run: "Run tests",
    analyze: "Explore again",
    condition: "Check the result",
    notify: "Tell the team",
    wait: "Wait",
};

export const CHECK_LABEL: Record<CheckKind, string> = {
    passRate: "The pass rate is at least",
    noFailures: "Nothing failed",
    noHighSeverity: "There are no high-severity findings",
    noApiBreakingChange: "The API has no breaking changes",
    readiness: "The project is ready to release",
};

export const PLACEHOLDERS: Array<{ name: string; help: string }> = [
    { name: "project", help: "the project’s name" },
    { name: "status", help: "passed or failed, so far" },
    { name: "passRate", help: "the share of tests that passed in the last run" },
    { name: "failed", help: "how many tests failed in the last run" },
    { name: "runUrl", help: "a link to this run" },
];

export const TRIGGER_TEXT: Record<RunSummary["trigger"], string> = { manual: "Started by hand", schedule: "Started by a schedule", deploy: "Started after a deploy" };

// ── the editor's draft ──────────────────────────────────────────────────────

export type ScopeKind = "all" | "suite" | "tag" | "type" | "tests";

/** Every field of every kind of step, as the form holds it. Converted to and from the API's shape. */
export interface DraftStep {
    id: string;
    type: StepType;
    title: string;
    onPass: string;
    onFail: string;
    scopeKind: ScopeKind;
    suite: string;
    tag: string;
    testType: string;
    testIds: string[];
    environment: string;
    retries: 0 | 1 | 2;
    confirmProduction: boolean;
    includeMobile: boolean;
    allowMutating: boolean;
    loadChecks: boolean;
    check: CheckKind;
    atLeast: number;
    channelId: string;
    message: string;
    seconds: number;
}

export interface Draft {
    name: string;
    description: string;
    steps: DraftStep[];
}

export const DEFAULT_MESSAGE = "{{project}}: the run {{status}}. {{passRate}} passed, {{failed}} failing. {{runUrl}}";

export function newStep(type: StepType, existing: DraftStep[]): DraftStep {
    let n = existing.length + 1;
    const ids = new Set(existing.map((s) => s.id));
    while (ids.has(`step-${n}`)) n++;
    return {
        id: `step-${n}`,
        type,
        title: "",
        onPass: "next",
        onFail: "stop",
        scopeKind: "all",
        suite: "",
        tag: "",
        testType: "",
        testIds: [],
        environment: "",
        retries: 1,
        confirmProduction: false,
        includeMobile: false,
        allowMutating: false,
        loadChecks: false,
        check: "passRate",
        atLeast: 90,
        channelId: "",
        message: DEFAULT_MESSAGE,
        seconds: 10,
    };
}

export const emptyDraft = (): Draft => ({ name: "", description: "", steps: [newStep("run", [])] });

export function toDraft(def: Definition): Draft {
    const steps = def.steps.map((s): DraftStep => {
        const base = newStep(s.type, []);
        const scope = s.scope ?? "all";
        const scopeKind: ScopeKind = scope === "all" ? "all" : scope.testIds ? "tests" : scope.suite ? "suite" : scope.tag ? "tag" : scope.type ? "type" : "all";
        return {
            ...base,
            id: s.id,
            title: s.title ?? "",
            onPass: s.onPass ?? "next",
            onFail: s.onFail ?? "stop",
            scopeKind,
            suite: scope !== "all" ? (scope.suite ?? "") : "",
            tag: scope !== "all" ? (scope.tag ?? "") : "",
            testType: scope !== "all" ? (scope.type ?? "") : "",
            testIds: scope !== "all" ? (scope.testIds ?? []) : [],
            environment: s.environment ?? "",
            retries: s.retries ?? 1,
            confirmProduction: Boolean(s.confirmProduction),
            includeMobile: Boolean(s.includeMobile),
            allowMutating: Boolean(s.allowMutatingApiTests),
            loadChecks: Boolean(s.loadChecks),
            check: s.condition?.check ?? "passRate",
            atLeast: s.condition?.atLeast ?? 90,
            channelId: s.channelId ?? "",
            message: s.message ?? DEFAULT_MESSAGE,
            seconds: s.seconds ?? 10,
        };
    });
    return { name: def.name, description: def.description ?? "", steps: sanitizeRoutes(steps) };
}

/** A route may only point at a step that comes later; anything else goes back to the default. */
export function sanitizeRoutes(steps: DraftStep[]): DraftStep[] {
    const index = new Map(steps.map((s, i) => [s.id, i]));
    const ok = (route: string, from: number) => route === "next" || route === "stop" || ((index.get(route) ?? -1) > from);
    return steps.map((s, i) => ({ ...s, onPass: ok(s.onPass, i) ? s.onPass : "next", onFail: ok(s.onFail, i) ? s.onFail : "stop" }));
}

export function toDefinition(d: Draft): Definition {
    const steps = d.steps.map((s): StepDef => {
        const out: StepDef = { id: s.id, type: s.type };
        if (s.title.trim()) out.title = s.title.trim();
        if (s.onPass !== "next") out.onPass = s.onPass;
        // A wait or message step always moves on, so it has no "if it fails" route.
        if (s.onFail !== "stop" && s.type !== "wait" && s.type !== "notify") out.onFail = s.onFail;
        if (s.type === "run") {
            out.scope = s.scopeKind === "all" ? "all" : s.scopeKind === "suite" ? { suite: s.suite.trim() } : s.scopeKind === "tag" ? { tag: s.tag.trim() } : s.scopeKind === "type" ? { type: s.testType.trim() } : { testIds: s.testIds };
            out.retries = s.retries;
            if (s.environment) {
                out.environment = s.environment;
                if (s.confirmProduction) out.confirmProduction = true;
            }
            if (s.includeMobile) out.includeMobile = true;
        } else if (s.type === "analyze") {
            if (s.allowMutating) out.allowMutatingApiTests = true;
            if (s.loadChecks) out.loadChecks = true;
        } else if (s.type === "condition") {
            out.condition = s.check === "passRate" ? { check: "passRate", atLeast: s.atLeast } : { check: s.check };
        } else if (s.type === "notify") {
            out.channelId = s.channelId;
            out.message = s.message;
        } else {
            out.seconds = s.seconds;
        }
        return out;
    });
    return { version: 1, name: d.name.trim(), ...(d.description.trim() ? { description: d.description.trim() } : {}), steps };
}

/** What a step does, in a short phrase (for the "go to step" choices and the summary line). */
export function describeDraftStep(s: DraftStep): string {
    if (s.title.trim()) return s.title.trim();
    switch (s.type) {
        case "run":
            return s.scopeKind === "all" ? "Run all tests" : s.scopeKind === "suite" ? `Run the “${s.suite}” suite` : s.scopeKind === "tag" ? `Run tests tagged “${s.tag}”` : s.scopeKind === "type" ? `Run ${s.testType} tests` : `Run ${s.testIds.length} chosen test${s.testIds.length === 1 ? "" : "s"}`;
        case "analyze":
            return "Explore again";
        case "condition":
            return s.check === "passRate" ? `Check that at least ${s.atLeast}% passed` : CHECK_LABEL[s.check];
        case "notify":
            return "Tell the team";
        case "wait":
            return `Wait ${s.seconds} second${s.seconds === 1 ? "" : "s"}`;
    }
}
