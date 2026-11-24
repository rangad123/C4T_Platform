/**
 * The API Testing Agent's outcome (SPEC §3): the endpoint table (method, path, the statuses the API answered, whether the answers match
 * the API document) and its verified API findings. Computed on read from what its runs saved: the API tests the engine made per endpoint
 * (orchestrator.ts persistNew meta.endpoint), the statuses each run saw (drift-store.ts api_snapshots), and the findings of its tests
 * (candidate_findings, verified states only). A newer run's word on an endpoint replaces an older one's; a stopped run's part counts.
 */
import { CONTRACT_FAILURE_PREFIX } from "../../engine/contracts/check.js";
import { operationKey } from "../../engine/contracts/drift.js";
import { reproduction } from "../../engine/findings/classify.js";
import { STATE_LABEL, type FindingState } from "../../engine/findings/lifecycle.js";
import { CandidateFindingStore } from "../candidate-finding-store.js";
import { listSnapshots } from "../drift-store.js";
import { fromCandidate } from "../findings/adapters.js";
import type { JobRow, TestRow } from "../repo.js";
import type { AgentOutcomeCtx, AgentOutcomeModule } from "./types.js";
import { VERIFIED_STATES as VERIFIED } from "./security.js";

export type ContractMatch = "matches" | "differs" | "not-checked";

export interface ApiEndpoint {
    method: string;
    path: string;
    /** Every HTTP status it answered in that run, ascending; empty when no answer was recorded. */
    statuses: number[];
    contract: ContractMatch;
    /** What differs from the document, when it differs. */
    contractNote: string | null;
    /** The run this row comes from. */
    jobId: string;
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
    endpoints: ApiEndpoint[];
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

function endpointsOf(ctx: AgentOutcomeCtx, runs: JobRow[]): ApiEndpoint[] {
    const snapshots = new Map(listSnapshots(ctx.p.db, ctx.projectId).map((s) => [s.jobId, s.operations]));
    const out = new Map<string, ApiEndpoint>();
    // Newest run first: an endpoint it tested is its row.
    for (const job of runs) {
        const mine = new Map<string, ApiEndpoint>();
        for (const t of apiTestsOf(ctx, job)) {
            const key = endpointOf(t);
            if (!key || out.has(key)) continue;
            const [method = "", ...rest] = key.split(" ");
            const path = rest.join(" ");
            const row = mine.get(key) ?? { method, path, statuses: statusesOf(snapshots.get(job.id), method, path), contract: "not-checked" as ContractMatch, contractNote: null, jobId: job.id };
            // One test of the endpoint whose answer differed from the document is enough; it matches when a contract check passed.
            if (t.validationReason?.includes(CONTRACT_FAILURE_PREFIX)) Object.assign(row, { contract: "differs", contractNote: contractNote(t.validationReason) });
            else if (row.contract === "not-checked" && hasContract(t) && t.validationStatus === "VALIDATED") row.contract = "matches";
            mine.set(key, row);
        }
        for (const [k, v] of mine) out.set(k, v);
    }
    return [...out.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
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

const build = async (ctx: AgentOutcomeCtx, runs: JobRow[]): Promise<ApiOutcome> => ({ runs: runs.length, endpoints: endpointsOf(ctx, runs), findings: await findingsOf(ctx, runs) });
const counted = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const outcome: AgentOutcomeModule<ApiOutcome> = {
    outcome: (ctx) => build(ctx, ctx.runs),
    runOutcome: async (ctx, jobId) => {
        const run = ctx.runs.find((j) => j.id === jobId);
        return run && build(ctx, [run]);
    },
    headline: (o) => {
        if (!o.runs) return null;
        const differs = o.endpoints.filter((e) => e.contract === "differs").length;
        return [counted(o.endpoints.length, "endpoint"), differs ? `${differs} off its contract` : null, o.findings.length ? counted(o.findings.length, "verified finding") : null].filter(Boolean).join(", ");
    },
};
