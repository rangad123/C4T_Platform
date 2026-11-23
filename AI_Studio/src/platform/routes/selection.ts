/**
 * Test-selection preview: which tests a change would call for (docs/features/selection-preview.md). Read-only: nothing here starts,
 * skips or chooses a run, and deploy triggers keep running every runnable test.
 *
 *   GET  /api/projects/:id/test-coverage                      the pages and endpoints each test touches, declared or observed
 *   POST /api/projects/:id/selection-preview                  { pages?: string[], endpoints?: string[] } → the recommendation
 *
 * The preview judges the deploy target (no variant, no named environment: what a deploy trigger runs), the viewer's runnable set, and
 * compares that set with each active deploy trigger's maker's (parity.ts); coverage freshness rules are in coverage.ts (freshnessOf).
 *   GET  /api/projects/:id/selection-preview/detected-changes the change set the platform saw in earlier jobs (to preview or edit)
 *   POST /api/projects/:id/selection-run                      { selection: "focused" | "full" (default), pages?, endpoints? } → a
 *        validation run (the existing job) of the focused set (every test the preview proposes) or of every runnable test. Only a
 *        person (or the trigger API's explicit `selection` field) chooses focused; nothing picks it automatically.
 */
import { z } from "zod";
import { ownerIdOfActor } from "../agent-store.js";
import { actorOf } from "../auth/access.js";
import { assertC4tOwnerMayRun } from "../c4t-service.js";
import { currentActor } from "../auth/actor.js";
import { HttpError } from "../http-error.js";
import { runnableTestIds } from "../scheduler.js";
import { refuseUnlessRunsStart } from "../suite-run.js";
import { riskFacts } from "../selection/risk-facts.js";
import { detectedChanges, projectCoverage } from "../selection/facts.js";
import { heldWhy } from "../selection/held.js";
import { triggerParity } from "../selection/parity.js";
import { focusedSelection, matchesChange, MAX_CHANGES, previewSelection, readChanges } from "../selection/preview.js";
import type { RouteCtx } from "./types.js";

const Entry = z.string().trim().min(1).max(500);
const PreviewBody = z
    .object({ pages: z.array(Entry).max(MAX_CHANGES).optional(), endpoints: z.array(Entry).max(MAX_CHANGES).optional() })
    .strict();

const RunBody = z
    .object({ selection: z.enum(["focused", "full"]).default("full"), pages: z.array(Entry).max(MAX_CHANGES).optional(), endpoints: z.array(Entry).max(MAX_CHANGES).optional() })
    .strict();

/** Why a readable test is not in this person's runnable set (scheduler.ts runnableTestIds decides; this only puts it in words). */
function cannotRunWhy(kind: string): string {
    if (kind === "mobile" || kind === "desktop") return `Cannot run on your runner: ${kind} tests need a device or a runner set up for them.`;
    return "Cannot run on your runner: automated runs leave it out here (its framework is switched off, it is a load check, its plug-in is not loaded, or it is a hand-written test not allowed in automated runs).";
}

export function registerSelectionRoutes({ app, repo, p, project, applicationFor, assertNoActiveJob, startValidationJob }: RouteCtx): void {
    app.get("/api/projects/:id/test-coverage", async (req) => {
        const id = (req.params as { id: string }).id;
        project(id);
        const c = await projectCoverage(repo, p.store, id);
        return { tests: c.tests, ...(c.apiPrefix ? { apiPrefix: c.apiPrefix } : {}) };
    });

    app.post("/api/projects/:id/selection-preview", async (req) => {
        const id = (req.params as { id: string }).id;
        project(id);
        const body = PreviewBody.parse(req.body ?? {});
        if (!body.pages?.length && !body.endpoints?.length) throw new HttpError(400, "Name at least one changed page or endpoint.");
        // The tests a deploy trigger would run today, as this person would run them (their runner decides what can run). Every other test
        // is listed under "Cannot run" with why, never hidden.
        const owner = ownerIdOfActor(actorOf(req) ?? currentActor());
        let runnable: Set<string> | undefined;
        try {
            runnable = new Set(await runnableTestIds(repo, id, "validate", owner));
        } catch {
            runnable = undefined;
        }
        const c = await projectCoverage(repo, p.store, id);
        // Tests with no approved version are left out of every run (review-store.ts pinRun): no runner runs them.
        const approved = new Set(repo.db.all<{ test_case_id: string }>("SELECT DISTINCT test_case_id FROM test_versions WHERE project_id = ? AND state = 'approved'", id).map((r) => r.test_case_id));
        const cannotRun = new Map<string, { why: string; unreadable?: boolean; nowhere?: boolean; held?: boolean }>();
        for (const t of repo.listTests(id)) {
            if (t.unreadable) cannotRun.set(t.id, { why: "Cannot run: its stored steps cannot be read. Open it to fix or delete it.", unreadable: true });
            else if (!approved.has(t.id)) cannotRun.set(t.id, { why: "Cannot run: it has no approved version yet, and runs leave it out until one is approved.", nowhere: true });
            // Held back by every run until approved again (review-store.ts toRun), worked out read-only (held.ts).
            else if (c.held.has(t.id)) cannotRun.set(t.id, { why: heldWhy(c.held.get(t.id)!), nowhere: true, held: true });
            else if (runnable && !runnable.has(t.id)) cannotRun.set(t.id, { why: cannotRunWhy(t.kind) });
        }
        // Each active deploy trigger runs on its maker's runner: compared with this person's set (parity.ts), after the same check on its
        // maker the trigger makes before a run (a Crowd4Test maker must still be active there).
        const parity = await triggerParity(repo, id, runnable, (by) => assertC4tOwnerMayRun(p, by));
        const { changes, ignored, notProcessed } = readChanges(body, c.app);
        if (!changes.length) throw new HttpError(400, "None of the entries is a page address or an endpoint (a method and a path, such as POST /orders/{id}).");
        const risk = await riskFacts(p, id, c.tests, c.apiPrefix);
        return { ...previewSelection(c.tests, changes, ignored, { apiPrefix: c.apiPrefix, notProcessed, cannotRun, parity, risk }), scope: runnable ? "runnable" : "all", freshDays: c.freshDays };
    });

    app.post("/api/projects/:id/selection-run", async (req, reply) => {
        const id = (req.params as { id: string }).id;
        project(id);
        const body = RunBody.parse(req.body ?? {});
        const named = Boolean(body.pages?.length || body.endpoints?.length);
        if (body.selection === "focused" && !named) throw new HttpError(400, "A focused run needs the changed pages or endpoints.");
        refuseUnlessRunsStart(p);
        const runnable = await runnableTestIds(repo, id, "validate", ownerIdOfActor(actorOf(req) ?? currentActor()));
        let testIds = runnable;
        let fullRunReasons: string[] = [];
        if (body.selection === "focused") {
            const c = await projectCoverage(repo, p.store, id);
            ({ testIds, fullRunReasons } = focusedSelection(c.tests, new Set(runnable), body, c.app, c.apiPrefix));
        }
        if (!testIds.length) throw new HttpError(409, body.selection === "focused" ? "No runnable test is proposed for this change. Run the full suite instead." : "This project has no tests that can be run yet.");
        const application = await applicationFor(id);
        await assertNoActiveJob(id, { verifyYields: true });
        const job = await startValidationJob(id, application.id, testIds);
        return reply.code(202).send({ jobId: job.id, selection: body.selection, testCount: testIds.length, ...(fullRunReasons.length ? { fullRunReasons } : {}) });
    });

    app.get("/api/projects/:id/selection-preview/detected-changes", async (req) => {
        const id = (req.params as { id: string }).id;
        project(id);
        return detectedChanges(repo, id);
    });
}
