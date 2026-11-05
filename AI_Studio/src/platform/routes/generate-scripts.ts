import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { MAX_SCRIPTS_PER_CALL, NO_MODEL_FOR_SCRIPTS, writeCaseScript, type CaseForScript } from "../../engine/authoring/case-script.js";
import { JobMeter } from "../../engine/llm/metered.js";
import { projectLlm } from "../ai-config.js";
import { isAppUri } from "../../engine/desktop/target.js";
import { assertHoldsHere, callerCredentials } from "../auth/access.js";
import { currentActor } from "../auth/actor.js";
import { DslRefusal, DslService } from "../dsl-service.js";
import { HttpError } from "../http-error.js";
import type { ManualCase } from "../../engine/manual/cases.js";
import { ManualCaseStore } from "../manual-case-store.js";
import { projectSetupOf } from "../project-setup.js";
import { RequirementStore } from "../requirement-store.js";
import { withJobStarter, withVersionSource } from "../review-store.js";
import { aiSkipReason, usageStoreFor } from "../usage-store.js";
import type { RouteCtx } from "./types.js";

/**
 * "Generate test scripts using AI" (Test cases place, code-based projects): each chosen written case of type Automated that has no
 * script yet is written by the project's AI as a text script, saved through the path "Write it as text" uses, as the AI's draft
 * (drafts never run until approved), and linked to its case (`linkedTestIds`, one script per case) and to the case's requirement.
 *
 *   POST /api/projects/:id/manual-cases/generate-scripts   { caseIds?: string[], dryRun?: boolean }
 *        → { created: [{ caseId, testId, key }], skipped: [{ caseId, reason, detail }], eligible?: string[] }
 *
 * No case ids means every case of the project. At most MAX_SCRIPTS_PER_CALL scripts are written per call; the rest are skipped with
 * reason "later" (the page sends them in the next call). `dryRun` writes nothing and calls no AI: it says which cases would get a
 * script, so the page can say how many before it starts. A project without an application address is refused before anything (a
 * script is saved for that address), and one call per project writes at a time: a second answers 409 until the first has finished.
 */

const Body = z.object({
    caseIds: z.array(z.string().min(1).max(64)).max(500).optional(),
    dryRun: z.boolean().optional(),
});

export type SkipReason = "manual" | "has-script" | "not-found" | "later" | "ai-failed" | "refused";
const SKIP_WORDS: Record<Exclude<SkipReason, "ai-failed" | "refused">, string> = {
    manual: "A manual test case: a person does it, so no script is made.",
    "has-script": "This test case already has its test script.",
    "not-found": "Not a test case of this project.",
    later: `At most ${MAX_SCRIPTS_PER_CALL} scripts are written at a time. Generate again for the rest.`,
};

const AGENT_PROJECT = "Test scripts are made for code-based projects. In an AI agent project the agents decide what to check.";
export const NO_ADDRESS_FOR_SCRIPTS = "This project has no application address yet, and a test script is saved for the address it tests. Add the address in Settings → General, then generate the test scripts.";
export const SCRIPTS_BEING_WRITTEN = "Test scripts are already being written for this project. Wait until that has finished, then generate the rest.";
const PHONE_PROJECT = "The AI writes test scripts as text steps, and text steps cover web and API tests only for now. This project tests a phone app: write its scripts by hand or import them.";
/** Cases written at the same time (each one or two model calls). */
const CONCURRENCY = 3;

export function registerGenerateScriptRoutes(ctx: RouteCtx): void {
    const { app, p, repo } = ctx;
    const cases = new ManualCaseStore(p.db);
    const requirements = new RequirementStore(p.sql);
    const dsl = new DslService(ctx);
    /** Projects a call is writing scripts for right now (this server runs one process). */
    const writing = new Set<string>();
    /** One script per case: a linked test that still exists in this project is its script. */
    const hasScript = (pid: string, linkedTestIds: readonly string[]) => linkedTestIds.some((t) => repo.getTest(t)?.projectId === pid);

    app.post("/api/projects/:id/manual-cases/generate-scripts", async (req) => {
        const { id: pid } = req.params as { id: string };
        const row = ctx.project(pid);
        // ROUTE_PERMISSIONS asks for the AI's permission (ai_studio.tests.generate); the scripts are saved, so adding tests is needed too.
        assertHoldsHere(app, req, pid, "ai_studio.tests.write");
        const body = Body.parse(req.body ?? {});
        const setup = projectSetupOf(row);
        if (!setup.testingModes.includes("code")) throw new HttpError(409, AGENT_PROJECT);
        if (!setup.platforms.includes("web")) throw new HttpError(409, PHONE_PROJECT);
        // Said before any AI call (and in the dry run): without an address no script could be saved, and the AI would be paid for nothing.
        const address = (repo.getLatestApplicationPublic(pid)?.url as string | undefined) ?? null;
        if (!address || isAppUri(address) || !/^https?:/i.test(address)) throw new HttpError(409, NO_ADDRESS_FOR_SCRIPTS);

        // Which cases: the chosen ones (in the order given) or all of them; which of those get a script now.
        const all = cases.listCases(pid);
        const byId = new Map(all.map((c) => [c.id, c]));
        const chosen = body.caseIds?.length ? [...new Set(body.caseIds)] : all.map((c) => c.id);
        const skipped: Array<{ caseId: string; reason: SkipReason; detail: string }> = [];
        const eligible: string[] = [];
        const skip = (caseId: string, reason: Exclude<SkipReason, "ai-failed" | "refused">) => skipped.push({ caseId, reason, detail: SKIP_WORDS[reason] });
        for (const caseId of chosen) {
            const c = byId.get(caseId);
            if (!c) skip(caseId, "not-found");
            else if (c.automation !== "automated") skip(caseId, "manual");
            else if (hasScript(pid, c.linkedTestIds)) skip(caseId, "has-script");
            else eligible.push(caseId);
        }
        if (body.dryRun) return { created: [], skipped, eligible };
        const now = eligible.slice(0, MAX_SCRIPTS_PER_CALL);
        for (const caseId of eligible.slice(MAX_SCRIPTS_PER_CALL)) skip(caseId, "later");
        if (now.length === 0) return { created: [], skipped };
        // Two calls at once could each write a script for the same case: the second waits its turn (taken before anything is awaited).
        if (writing.has(pid)) throw new HttpError(409, SCRIPTS_BEING_WRITTEN);
        writing.add(pid);
        try {
            return await writeScripts(req, pid, now, byId, skipped, address);
        } finally {
            writing.delete(pid);
        }
    });

    async function writeScripts(req: FastifyRequest, pid: string, now: string[], byId: Map<string, ManualCase>, skipped: Array<{ caseId: string; reason: SkipReason; detail: string }>, address: string) {
        // The project's AI and who pays for it (ai-config.ts), as the other AI routes do.
        const { llm, billing, blocked } = await projectLlm(p, pid);
        if (llm.modelName === "unavailable") throw new HttpError(422, blocked ?? NO_MODEL_FOR_SCRIPTS, { modelMissing: true });
        const usage = usageStoreFor(p.db, p.config);
        if (aiSkipReason(usage, pid)) throw new HttpError(409, "The AI token limit was reached, so the AI cannot write test scripts now. You can still write them by hand.");
        const meter = new JobMeter({ backend: usage, jobId: `scripts-${randomUUID()}`, projectId: pid, billing });
        const model = meter.wrap(llm);
        const headers = callerCredentials(req);
        // The person who asked is the author of the AI's drafts, so someone else approves them (as with an agent run's draft).
        const actor = currentActor();
        const starter = actor.kind === "user" || actor.kind === "key" || actor.kind === "open" ? { kind: actor.kind, ...(actor.id ? { id: actor.id } : {}) } : undefined;

        const created: Array<{ caseId: string; testId: string; key: string }> = [];
        const one = async (caseId: string) => {
            const c = byId.get(caseId)!;
            const linkedReqs = await requirements.forTest(pid, c.id);
            const reqIds = [...new Set([...(c.requirementId ? [c.requirementId] : []), ...linkedReqs.map((r) => r.id)])];
            const reqWords = c.requirement || linkedReqs.map((r) => `${r.ref} ${r.title}`).join("; ");
            const input: CaseForScript = { ref: c.ref ?? c.title, title: c.title, area: c.area, priority: c.priority, steps: c.steps, requirement: reqWords };
            let text: string;
            try {
                text = (await writeCaseScript(model, input, { address })).text;
            } catch (e) {
                skipped.push({ caseId, reason: "ai-failed", detail: e instanceof Error ? e.message : "The AI did not write a script." });
                return;
            }
            // Checked again right before saving: the case may have been deleted, or got its script, while the AI was writing.
            const current = cases.getCase(pid, caseId);
            if (!current) return void skipped.push({ caseId, reason: "not-found", detail: SKIP_WORDS["not-found"] });
            if (hasScript(pid, current.linkedTestIds)) return void skipped.push({ caseId, reason: "has-script", detail: SKIP_WORDS["has-script"] });
            let made: { testId: string; key: string };
            try {
                made = await withJobStarter(starter, () => withVersionSource("ai", () => dsl.create(pid, text, headers, { run: false })));
            } catch (e) {
                // The save path's own rules (shared elements, reusable steps, secrets typed in, addresses) refused the text.
                if (e instanceof DslRefusal || e instanceof HttpError) {
                    skipped.push({ caseId, reason: "refused", detail: e.message });
                    return;
                }
                throw e;
            }
            // One script per case: the case points at it, and the script covers the case's requirement.
            const fresh = cases.getCase(pid, caseId);
            const linked = [...new Set([...(fresh?.linkedTestIds ?? c.linkedTestIds), made.testId])];
            p.db.run("UPDATE manual_cases SET linked_json = ?, updated_at = ? WHERE id = ? AND project_id = ?", JSON.stringify(linked), new Date().toISOString(), caseId, pid);
            for (const rid of reqIds) {
                try {
                    await requirements.link(pid, rid, { automated: [made.testId], manual: [] }, "generated");
                } catch {
                    // A requirement deleted meanwhile: the script stays, without that link.
                }
            }
            created.push({ caseId, testId: made.testId, key: made.key });
        };
        /** One case's work never rejects: an unexpected error is that case's failure, so the answer (and the meter) waits for all of them. */
        const settled = async (caseId: string) => {
            try {
                await one(caseId);
            } catch (e) {
                req.log.warn({ err: e }, "generate-scripts: a case failed unexpectedly");
                skipped.push({ caseId, reason: "refused", detail: "The test script could not be saved because of a problem on the server. Try this test case again." });
            }
        };
        try {
            const queue = [...now];
            await Promise.all(
                Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
                    for (let next = queue.shift(); next; next = queue.shift()) await settled(next);
                }),
            );
        } finally {
            meter.finish();
        }
        // In the order the cases were chosen, whatever order the model answered in.
        created.sort((a, b) => now.indexOf(a.caseId) - now.indexOf(b.caseId));
        return { created, skipped };
    }
}
