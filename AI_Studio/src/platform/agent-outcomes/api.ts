/**
 * The API Testing Agent's outcome (SPEC §3; owner 2026-11-25: "only test the APIs and show results, PASS and FAIL"): one table of its API
 * tests (method, path, the status and contract each expects, PASS or FAIL, and for a failure what was sent and what came back) and its
 * verified API findings. Computed on read from what its runs saved: the API tests the engine made (orchestrator.ts persistNew,
 * meta.endpoint), the statuses each run saw (drift-store.ts api_snapshots), and the findings of its tests (candidate_findings, verified
 * states only). A newer run's tests of an endpoint replace an older run's; a stopped run's part counts.
 */
import { CONTRACT_FAILURE_PREFIX } from "../../engine/contracts/check.js";
import { operationKey } from "../../engine/contracts/drift.js";
import { reproduction } from "../../engine/findings/classify.js";
import { STATE_LABEL, type FindingState } from "../../engine/findings/lifecycle.js";
import type { TestSpec } from "../../engine/spec/schema.js";
import { CandidateFindingStore } from "../candidate-finding-store.js";
import { listSnapshots } from "../drift-store.js";
import { fromCandidate } from "../findings/adapters.js";
import type { JobRow, TestRow } from "../repo.js";
import type { AgentOutcomeCtx, AgentOutcomeModule } from "./types.js";
import { VERIFIED_STATES as VERIFIED } from "./security.js";

export type ContractMatch = "matches" | "differs" | "not-checked";
export type ApiResult = "pass" | "fail" | "not-run";

/** What a failed API test sent and what came back: the request as the test states it, the statuses answered, and why it failed. */
export interface ApiEvidence {
    request: { method: string; path: string; query: Record<string, string> | null; body: string | null };
    response: { statuses: number[]; reason: string };
}

export interface ApiTestRow {
    testId: string;
    testKey: string;
    title: string;
    method: string;
    path: string;
    /** The status the test expects ("200", "2xx"), or null when it checks none. */
    expectedStatus: string | null;
    contract: ContractMatch;
    /** What differs from the document, when it differs. */
    contractNote: string | null;
    result: ApiResult;
    /** The run this row comes from. */
    jobId: string;
    /** The statuses that run saw for its endpoint (the report's and the Workspace card's "actual"). */
    answered: number[];
    /** A failed test's evidence; null otherwise. */
    evidence: ApiEvidence | null;
}

export interface ApiFinding {
    id: string;
    testId: string;
    endpoint: string | null;
    title: string;
    state: FindingState;
    stateLabel: string;
    severity: string | null;
    expected: string;
    observed: string;
    /** Attempts that failed the same way, of all attempts. */
    reproduced: { same: number; of: number };
}

export interface ApiOutcome {
    runs: number;
    /** One run's report (`?run=`): which run, numbered as in the Runs list. */
    run?: { jobId: string; number: number; status: JobRow["status"]; createdAt: string };
    /** The card's line, said again above the table (apiHeadline). */
    headline: string;
    /** The counts the card's headline and the Outcome tab both say. */
    summary: { tests: number; passed: number; failed: number; notRun: number };
    tests: ApiTestRow[];
    findings: ApiFinding[];
}

/** This agent's own tests in a run: API tests that are not another agent's checks (security, access, speed, load). */
const isApiTest = (t: TestRow) => t.kind === "api" && !["security", "access", "performance", "load"].some((k) => t.generationMeta?.[k]);
const endpointOf = (t: TestRow): string | null => (typeof t.generationMeta?.endpoint === "string" ? t.generationMeta.endpoint : null);
const hasContract = (t: TestRow) => t.spec.steps.some((s) => s.action === "assertResponse" && (s as { check?: string }).check === "matchesSchema");
/** The contract check's own sentence, without its prefix, its advice and its severity tags. */
const contractNote = (reason: string) => reason.slice(reason.indexOf(CONTRACT_FAILURE_PREFIX) + CONTRACT_FAILURE_PREFIX.length).split(/^how to fix:/im)[0]!.replace(/\s*\[(?:high|medium|low)\]/g, "").trim();
const apiTestsOf = (ctx: AgentOutcomeCtx, job: JobRow) => ctx.p.repo.listTests(ctx.projectId, { jobId: job.id }).filter(isApiTest);
/**
 * The statuses a run saw for an endpoint. The snapshot keys a call by its templated address (drift.ts operationKey), which keeps an id
 * that does not look like one (`/products/p1`), so each `{}` of the endpoint's template matches any one segment.
 */
function statusesOf(ops: Record<string, { statuses: number[] }> | undefined, method: string, path: string): number[] {
    if (!ops) return [];
    const key = operationKey(method, path);
    if (ops[key]) return ops[key].statuses;
    const want = key.split(/[ /]/);
    const all = Object.entries(ops).filter(([k]) => {
        const got = k.split(/[ /]/);
        return got.length === want.length && want.every((w, i) => w === got[i] || w === "{}");
    });
    return [...new Set(all.flatMap(([, o]) => o.statuses))].sort((a, b) => a - b);
}

const RESULT: Record<string, ApiResult> = { VALIDATED: "pass", FAILED_VALIDATION: "fail", NEEDS_REVIEW: "fail" };
const firstStep = <A extends TestSpec["steps"][number]["action"]>(t: TestRow, action: A, ok: (s: Extract<TestSpec["steps"][number], { action: A }>) => boolean = () => true) =>
    t.spec.steps.find((s): s is Extract<TestSpec["steps"][number], { action: A }> => s.action === action && ok(s as never));
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

function rowOf(t: TestRow, job: JobRow, ops: Record<string, { statuses: number[] }> | undefined): ApiTestRow {
    const req = firstStep(t, "request");
    const [method = req?.method ?? "", ...rest] = (endpointOf(t) ?? `${req?.method ?? ""} ${req?.path ?? ""}`).split(" ");
    const path = rest.join(" ");
    const status = firstStep(t, "assertResponse", (s) => s.check === "status" || s.check === "statusClass");
    const reason = t.validationReason ?? "";
    const contract: ContractMatch = reason.includes(CONTRACT_FAILURE_PREFIX) ? "differs" : hasContract(t) && t.validationStatus === "VALIDATED" ? "matches" : "not-checked";
    const result = RESULT[t.validationStatus] ?? "not-run";
    const answered = statusesOf(ops, method, path);
    const body = req?.body === undefined ? null : clip(typeof req.body === "string" ? req.body : JSON.stringify(req.body, null, 2), 2000);
    return {
        testId: t.id,
        testKey: t.testKey,
        title: t.title,
        method,
        path,
        expectedStatus: status?.expected === undefined ? null : String(status.expected),
        contract,
        contractNote: contract === "differs" ? contractNote(reason) : null,
        result,
        jobId: job.id,
        answered,
        evidence:
            result === "fail"
                ? { request: { method: req?.method ?? method, path: req?.path ?? path, query: req?.query ?? null, body }, response: { statuses: answered, reason: clip(reason.trim(), 1500) } }
                : null,
    };
}

/** Its API tests, the newest run's tests of an endpoint (or of a workflow, by its title) replacing an older run's. */
function testsOf(ctx: AgentOutcomeCtx, runs: JobRow[]): ApiTestRow[] {
    const snapshots = new Map(listSnapshots(ctx.p.db, ctx.projectId).map((s) => [s.jobId, s.operations]));
    const claimed = new Set<string>();
    const out: ApiTestRow[] = [];
    for (const job of runs) {
        const mine = new Set<string>();
        for (const t of apiTestsOf(ctx, job)) {
            const key = endpointOf(t) ?? t.title;
            if (claimed.has(key)) continue;
            mine.add(key);
            out.push(rowOf(t, job, snapshots.get(job.id)));
        }
        for (const k of mine) claimed.add(k);
    }
    return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method) || a.testKey.localeCompare(b.testKey));
}

async function findingsOf(ctx: AgentOutcomeCtx, runs: JobRow[]): Promise<ApiFinding[]> {
    const tests = new Map(runs.flatMap((j) => apiTestsOf(ctx, j)).map((t) => [t.id, t]));
    const verified = await new CandidateFindingStore(ctx.p.sql).inStates(ctx.projectId, VERIFIED);
    return verified.flatMap((r) => {
        const t = r.testId ? tests.get(r.testId) : undefined;
        if (!t) return [];
        // The view redacts and cuts the texts (findings/adapters.ts).
        const v = fromCandidate(r, { id: t.id, title: t.title, spec: t.spec, meta: t.generationMeta });
        return [{ id: r.id, testId: t.id, endpoint: endpointOf(t), title: v.title, state: r.state, stateLabel: STATE_LABEL[r.state], severity: r.severity, expected: v.expected.text, observed: v.observed, reproduced: reproduction(v.attempts) }];
    });
}

async function build(ctx: AgentOutcomeCtx, runs: JobRow[]): Promise<ApiOutcome> {
    const tests = testsOf(ctx, runs);
    const n = (r: ApiResult) => tests.filter((t) => t.result === r).length;
    const summary = { tests: tests.length, passed: n("pass"), failed: n("fail"), notRun: n("not-run") };
    const findings = await findingsOf(ctx, runs);
    return { runs: runs.length, headline: apiHeadline({ summary, findings }), summary, tests, findings };
}
const counted = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The one line the Workspace card shows, and the Outcome tab above its table: "12 API tests: 10 passed, 2 failed, 1 verified finding". */
export function apiHeadline(o: Pick<ApiOutcome, "summary" | "findings">): string {
    const s = o.summary;
    const parts = [`${s.passed} passed`, `${s.failed} failed`, s.notRun ? `${s.notRun} not run` : null, o.findings.length ? counted(o.findings.length, "verified finding") : null].filter(Boolean);
    return `${counted(s.tests, "API test")}: ${parts.join(", ")}`;
}

export const outcome: AgentOutcomeModule<ApiOutcome> = {
    outcome: (ctx) => build(ctx, ctx.runs),
    runOutcome: async (ctx, jobId) => {
        const at = ctx.runs.findIndex((j) => j.id === jobId);
        const run = ctx.runs[at];
        return run && { ...(await build(ctx, [run])), run: { jobId: run.id, number: ctx.runs.length - at, status: run.status, createdAt: run.createdAt } };
    },
    headline: (o) => (o.runs ? o.headline : null),
};
