import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { CHECK_ON_DEVICE, writePhoneCaseScript } from "../../engine/authoring/case-phone-script.js";
import { MAX_SCRIPTS_PER_CALL, NO_MODEL_FOR_SCRIPTS, scriptTitleOf, writeCaseScript, type CaseForScript } from "../../engine/authoring/case-script.js";
import { JobMeter } from "../../engine/llm/metered.js";
import { projectLlm } from "../ai-config.js";
import { isAppUri } from "../../engine/desktop/target.js";
import { MobileTargetSchema } from "../../engine/mobile/target.js";
import type { TestSpec } from "../../engine/spec/schema.js";
import { assertHoldsHere, callerCredentials } from "../auth/access.js";
import { currentActor } from "../auth/actor.js";
import { DslRefusal, DslService } from "../dsl-service.js";
import { FrameworkSettingsStore, turnedOffForSpecs } from "../framework-settings-store.js";
import { HttpError } from "../http-error.js";
import type { ManualCase } from "../../engine/manual/cases.js";
import { ManualCaseStore } from "../manual-case-store.js";
import { projectSetupOf } from "../project-setup.js";
import { RequirementStore } from "../requirement-store.js";
import { withJobStarter, withVersionSource } from "../review-store.js";
import { aiSkipReason, usageStoreFor } from "../usage-store.js";
import type { RouteCtx } from "./types.js";

/**
 * "Generate test scripts using AI" (Test cases and Test scripts places, code-based projects): each chosen written case of type
 * Automated that has no script yet is written by the project's AI, saved as the AI's draft (drafts never run until approved), and
 * linked to its case (`linkedTestIds`, one script per case) and to the case's requirement. What the AI writes follows the project's
 * platform:
 *  - web (also a project from before round 37 with web and a phone app): a text script, saved through the path "Write it as text" uses;
 *  - Android: a phone test (a `mobile` spec, engine/authoring/case-phone-script.ts), saved through the platform's spec import (the
 *    path an imported phone test takes), its elements found by visible text or accessibility label and the draft saying it needs
 *    checking on the device;
 *  - iOS only: refused in plain words (the AI does not write iOS scripts yet).
 *
 *   POST /api/projects/:id/manual-cases/generate-scripts   { caseIds?: string[], dryRun?: boolean }
 *        → { form: "text" | "phone", created: [{ caseId, testId, key }], skipped: [{ caseId, reason, detail }], eligible?: string[], note?: string }
 *
 * No case ids means every case of the project. At most MAX_SCRIPTS_PER_CALL scripts are written per call; the rest are skipped with
 * reason "later" (the page sends them in the next call). `dryRun` writes nothing and calls no AI: it says which cases would get a
 * script, so the page can say how many before it starts. A web project without an application address, an Android project without
 * its app, and a project whose engine is switched off are refused before anything (the AI would be paid for scripts that cannot be
 * saved), and one call per project writes at a time: a second answers 409 until the first has finished.
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
export const IOS_PROJECT = "The AI writes phone test scripts for Android apps only for now. This project tests an iOS app: write its scripts by hand or import them.";
export const NO_APP_FOR_SCRIPTS = "This project has no Android app yet, and a phone test script is saved for the app it tests. Add the app under Settings, Mobile app, then generate the test scripts.";
/** What the AI writes for this project: text steps (web and API) or a phone test (Android). */
export type ScriptForm = "text" | "phone";
type Target = { form: "text"; address: string } | { form: "phone"; appPackage: string | null };
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
        const target = targetOf(pid, setup.platforms);
        const form = target.form;

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
        if (body.dryRun) return { form, created: [], skipped, eligible };
        const now = eligible.slice(0, MAX_SCRIPTS_PER_CALL);
        for (const caseId of eligible.slice(MAX_SCRIPTS_PER_CALL)) skip(caseId, "later");
        if (now.length === 0) return { form, created: [], skipped };
        // Two calls at once could each write a script for the same case: the second waits its turn (taken before anything is awaited).
        if (writing.has(pid)) throw new HttpError(409, SCRIPTS_BEING_WRITTEN);
        writing.add(pid);
        try {
            return await writeScripts(req, pid, now, byId, skipped, target);
        } finally {
            writing.delete(pid);
        }
    });

    /**
     * What the AI writes here and where it is saved, or a refusal said before any AI call (and in the dry run): without an address, or
     * without the Android app, no script could be saved, and the AI would be paid for nothing.
     */
    function targetOf(pid: string, platforms: readonly string[]): Target {
        const latest = repo.getLatestApplicationPublic(pid);
        if (platforms.includes("web")) {
            const address = (latest?.url as string | undefined) ?? null;
            if (!address || isAppUri(address) || !/^https?:/i.test(address)) throw new HttpError(409, NO_ADDRESS_FOR_SCRIPTS);
            return { form: "text", address };
        }
        if (!platforms.includes("android")) throw new HttpError(409, IOS_PROJECT);
        const app = MobileTargetSchema.safeParse(latest?.config?.mobile);
        if (!app.success || !(app.data.appPackage || app.data.apkPath)) throw new HttpError(409, NO_APP_FOR_SCRIPTS);
        // Taqwright switched off for this project (Runners, Frameworks): the import would refuse every script.
        const off = turnedOffForSpecs(new FrameworkSettingsStore(p.db), pid, [{ kind: "mobile", platform: "android" }]);
        if (off) throw new HttpError(409, off);
        return { form: "phone", appPackage: app.data.appPackage ?? null };
    }

    /** A phone script saved the way an imported phone test is (POST /specs: every import rule), without running it. */
    async function savePhone(pid: string, spec: TestSpec, headers: Record<string, string>): Promise<{ testId: string; key: string }> {
        const { testId: _draft, ...rest } = spec;
        void _draft;
        const res = await app.inject({ method: "POST", url: `/api/projects/${pid}/specs`, payload: { specs: [rest], validate: false }, headers });
        const answer = (res.body ? JSON.parse(res.body) : {}) as { tests?: Array<{ id: string; testId: string }>; error?: string; details?: unknown };
        if (res.statusCode >= 400) throw new HttpError(res.statusCode === 400 ? 422 : res.statusCode, `The phone test script was not saved: ${firstMessage(answer) ?? "it is not a valid test."}`);
        const made = answer.tests?.[0];
        if (!made) throw new HttpError(500, "The phone test script could not be saved.");
        return { testId: made.id, key: made.testId };
    }

    async function writeScripts(req: FastifyRequest, pid: string, now: string[], byId: Map<string, ManualCase>, skipped: Array<{ caseId: string; reason: SkipReason; detail: string }>, target: Target) {
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
            const own = c.requirementId && !linkedReqs.some((r) => r.id === c.requirementId) ? await requirements.get(pid, c.requirementId) : undefined;
            const reqRefs = [...new Set([...(own ? [own.ref] : []), ...linkedReqs.map((r) => r.ref)])];
            // A title too short for a test is made whole here (with the case's reference), never left for the AI to fix.
            const input: CaseForScript = { ref: c.ref ?? c.title, title: scriptTitleOf({ ref: c.ref ?? "", title: c.title }), area: c.area, priority: c.priority, steps: c.steps, requirement: reqWords, requirementRefs: reqRefs };
            // The AI's work for this case: a text script (web) or a phone test spec (Android).
            let written: { text: string } | { spec: TestSpec };
            try {
                written = target.form === "phone" ? { spec: (await writePhoneCaseScript(model, input, { appPackage: target.appPackage })).spec } : { text: (await writeCaseScript(model, input, { address: target.address })).text };
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
                made = await withJobStarter(starter, () => withVersionSource("ai", () => ("spec" in written ? savePhone(pid, written.spec, headers) : dsl.create(pid, written.text, headers, { run: false }))));
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
        // A phone script was written without the app: the answer says so too (the draft's description says it as well).
        return { form: target.form, created, skipped, ...(target.form === "phone" && created.length ? { note: CHECK_ON_DEVICE } : {}) };
    }
}

/** The first message in the import's answer (its `details` carry zod issues or plain messages). */
function firstMessage(answer: { error?: string; details?: unknown }): string | undefined {
    const find = (x: unknown): string | undefined => {
        if (!x || typeof x !== "object") return undefined;
        if (Array.isArray(x)) {
            for (const i of x) {
                const m = find(i);
                if (m) return m;
            }
            return undefined;
        }
        const o = x as { message?: unknown; issues?: unknown };
        return typeof o.message === "string" ? o.message : find(o.issues);
    };
    return (find(answer.details) ?? answer.error)?.slice(0, 300);
}
