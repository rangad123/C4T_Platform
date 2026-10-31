/**
 * `ai-test run --env <name>`: read a project's results for one named environment (staging, production...) and turn them
 * into the same neutral test list every report is rendered from. A test the environment skipped (production is
 * read-only) or never ran there is "not run", never a pass.
 */
import type { Severity } from "../engine/validation/severity.js";
import type { ApiClient } from "./client.js";
import { categorize, cleanReason, type CiTest, type CollectOptions, type EvidenceItem, type TestOutcome } from "./model.js";

interface EnvironmentResults {
    environment: { name: string; production: boolean };
    tests: Array<{
        id: string;
        testId: string;
        title: string;
        suite: string;
        kind: string;
        type: string;
        priority: string;
        result: {
            status: "passed" | "failed" | "finding" | "skipped";
            reason?: string;
            durationMs: number | null;
            failedStep?: { index: number; title: string };
            artifacts: Array<{ id: string; kind: string }>;
            severity?: { severity: Severity; basis: string } | null;
        } | null;
    }>;
}

const IMAGES = new Set(["screenshot", "visual-diff", "visual-actual", "vision-shot"]);
const FILES = new Set(["video", "trace"]);
const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;

const OUTCOME: Record<string, { outcome: TestOutcome; validation: string }> = {
    passed: { outcome: "passed", validation: "VALIDATED" },
    finding: { outcome: "finding", validation: "NEEDS_REVIEW" },
    failed: { outcome: "failed", validation: "FAILED_VALIDATION" },
    skipped: { outcome: "not_run", validation: "PENDING" },
};

export async function collectEnvironmentTests(client: ApiClient, projectId: string, environment: string, opts: CollectOptions): Promise<CiTest[]> {
    const data = await client.json<EnvironmentResults>("GET", `/projects/${projectId}/environments/${encodeURIComponent(environment)}/results`);
    const out: CiTest[] = [];
    for (const t of data.tests) {
        const r = t.result;
        const mapped = r ? OUTCOME[r.status]! : { outcome: "not_run" as TestOutcome, validation: "PENDING" };
        const test: CiTest = {
            id: t.id,
            testId: t.testId,
            title: t.title,
            suite: t.suite,
            kind: t.kind,
            type: t.type,
            priority: t.priority,
            outcome: mapped.outcome,
            validation: mapped.validation,
            // A skipped test says why it was skipped; a passed one has nothing to explain.
            reason: r && r.status !== "passed" ? cleanReason(r.reason) : undefined,
            durationMs: r?.durationMs ?? 0,
            attempts: r && r.status !== "skipped" ? 1 : 0,
            evidence: [],
            ...(opts.platformUrl ? { link: `${opts.platformUrl.replace(/\/+$/, "")}/#/tests/${t.id}` } : {}),
        };
        if (r && mapped.outcome === "finding") {
            test.severity = r.severity?.severity ?? "medium";
            test.severityBasis = r.severity?.basis;
            test.category = categorize(test.reason);
        }
        if (r?.failedStep) test.failedStep = { number: r.failedStep.index + 1, title: r.failedStep.title };
        if (r && (r.status === "failed" || r.status === "finding")) {
            for (const a of r.artifacts) {
                if (!IMAGES.has(a.kind) && !(opts.files && FILES.has(a.kind))) continue;
                try {
                    const bytes = await client.bytes(`/artifacts/${a.id}`);
                    if (bytes.length <= MAX_EVIDENCE_BYTES) test.evidence.push({ kind: a.kind as EvidenceItem["kind"], data: bytes });
                } catch {
                    /* evidence that vanished is not worth failing the run for */
                }
            }
        }
        out.push(test);
    }
    // Flaky tests the team put in quarantine still run here and are reported, but their failures do not fail the gate.
    try {
        const q = await client.json<{ active: Array<{ testId: string; gating: boolean; reason: string; expiresAt: string }> }>("GET", `/projects/${projectId}/quarantine`);
        const held = new Map(q.active.filter((e) => e.gating).map((e) => [e.testId, e]));
        for (const t of out) {
            const e = held.get(t.id);
            if (e) t.quarantine = { reason: e.reason, expiresAt: e.expiresAt };
        }
    } catch {
        /* an older server without quarantine: nothing is held */
    }
    return out;
}
