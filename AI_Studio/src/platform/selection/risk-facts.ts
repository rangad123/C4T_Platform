import { workflowSteps } from "../../engine/impact/analyze.js";
import { AppIntelStore } from "../app-intel-store.js";
import type { Platform } from "../bootstrap.js";
import { pastFindings } from "../findings/past.js";
import { quarantineGate, recentExecutions } from "../quarantine-store.js";
import { detectFlaky } from "../trends.js";
import type { TestCoverage } from "./coverage.js";
import { matchesChange, readChanges } from "./preview.js";
import type { RiskFacts } from "./risk.js";

/** What the risk score (risk.ts) reads for each test: its priority, recent runs, past findings on what it reaches, quarantine and flakiness, and app-model workflows. */
export async function riskFacts(p: Platform, projectId: string, tests: TestCoverage[], apiPrefix?: string): Promise<Map<string, RiskFacts>> {
    const priority = new Map(p.repo.listTests(projectId).map((t) => [t.id, t.priority]));
    const recent = recentExecutions(p.db, tests.map((t) => t.testId));
    const gate = quarantineGate(p.db, Date.now(), projectId);
    const flaky = new Set(detectFlaky(p.db, projectId, 500).map((f) => f.id));
    const model = (await new AppIntelStore(p.sql).latest(projectId))?.model;
    const steps = model ? workflowSteps(model) : [];
    const past = (await pastFindings(p.sql, p.repo, projectId)).map((f) => ({ ...f, changes: readChanges({ endpoints: f.endpoints ?? [], pages: f.pages ?? [] }).changes }));
    const out = new Map<string, RiskFacts>();
    for (const t of tests) {
        const runs = recent.get(t.testId) ?? [];
        const workflows = new Set(steps.filter((s) => t.items.some((i) => matchesChange({ ...s.item, given: s.text }, i, apiPrefix))).map((s) => s.workflow.id));
        out.set(t.testId, {
            priority: priority.get(t.testId),
            runs: runs.length,
            failed: runs.filter((r) => r.status !== "passed").length,
            defects: past.filter((f) => f.changes.some((c) => t.items.some((i) => matchesChange(c, i, apiPrefix)))).length,
            workflows: workflows.size,
            quarantined: gate.has(t.testId),
            flaky: flaky.has(t.testId),
        });
    }
    return out;
}
