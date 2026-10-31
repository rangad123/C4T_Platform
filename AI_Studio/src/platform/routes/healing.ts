/**
 * Routes for locator healing. A proposal is a suggestion made after a failed run; the only way it changes a test is the
 * apply route below, which a person calls. Nothing here (or anywhere else) applies a proposal on its own.
 */
import { applyLocator, sameLocator } from "../../engine/healing/apply.js";
import { unhealableTest } from "../../engine/healing/failure.js";
import { defaultAdapterFor, renderWithAdapter } from "../../engine/frameworks/index.js";
import { CustomScriptStore } from "../custom-script-store.js";
import { describeStep } from "../../engine/spec/schema.js";
import { HealingStore, type StoredProposal } from "../healing-store.js";
import { HttpError } from "../http-error.js";
import { storeScript } from "../repo-sink.js";
import { refOf } from "../../engine/locators/refs.js";
import { locatorServices } from "./locators.js";
import type { RouteCtx } from "./types.js";

/** Only a test that did not pass can be healed: a passing test has nothing to repair. */
const FAILED = new Set(["FAILED_VALIDATION", "NEEDS_REVIEW"]);

export function registerHealingRoutes(ctx: RouteCtx): void {
    const { app, repo, p } = ctx;
    const store = new HealingStore(p.db);
    const shared = locatorServices(ctx);

    /** A step that uses a shared element (object repository): the element and the other tests that use it. */
    const sharedOf = (t: NonNullable<ReturnType<typeof repo.getTest>>, stepIndex: number) => {
        const step = t.spec.steps[stepIndex];
        const name = step && "locator" in step ? refOf(step.locator) : undefined;
        if (name === undefined) return undefined;
        const element = shared.store.getByName(t.projectId, name);
        return { name, element, others: element ? shared.usersOf(t.projectId, name).filter((u) => u.id !== t.id) : [] };
    };

    const testOr404 = (id: string) => {
        const t = repo.getTest(id);
        if (!t) throw new HttpError(404, "Test not found");
        return t;
    };
    const proposalOf = (testId: string, pid: string): StoredProposal => {
        const prop = store.get(pid);
        if (!prop || prop.testId !== testId) throw new HttpError(404, "Suggestion not found");
        return prop;
    };

    /** Can this suggestion be applied right now, and if not, why not (in words a person can act on)? */
    const blocker = (t: NonNullable<ReturnType<typeof repo.getTest>>, prop: StoredProposal): string | undefined => {
        if (prop.status !== "proposed") return prop.status === "applied" ? "This suggestion was already applied." : "This suggestion was dismissed.";
        // A hand-written test's script is the person's own code; a suggestion made for its old steps would not fit it.
        if (new CustomScriptStore(repo.db).isCustom(t.id)) return "This is a code test, so repair suggestions do not apply to it. Edit the code instead.";
        if (!FAILED.has(t.validationStatus)) return "Suggestions can only be applied to a test that did not pass.";
        const never = unhealableTest(t.spec);
        if (never) return `This test is not healed: ${never}.`;
        const step = t.spec.steps[prop.stepIndex];
        // A step that uses a shared element is compared with the element's locator, which is where a repair would be written.
        const sh = step && "locator" in step && step.locator ? sharedOf(t, prop.stepIndex) : undefined;
        const current = sh ? sh.element?.locator : step && "locator" in step ? step.locator : undefined;
        if (!current || !sameLocator(current, prop.oldLocator)) return "The test has changed since this suggestion was made.";
        return undefined;
    };

    const publicProposal = (t: NonNullable<ReturnType<typeof repo.getTest>>, prop: StoredProposal) => {
        const blocked = blocker(t, prop);
        const step = t.spec.steps[prop.stepIndex];
        const sh = step ? sharedOf(t, prop.stepIndex) : undefined;
        return {
            id: prop.id,
            stepIndex: prop.stepIndex,
            stepTitle: step ? describeStep(step) : null,
            oldLocator: prop.oldLocator,
            newLocator: prop.newLocator,
            oldDescription: prop.oldDescription,
            newDescription: prop.newDescription,
            confidence: prop.confidence,
            confidenceLabel: prop.confidenceLabel,
            reason: prop.reason,
            status: prop.status,
            createdAt: prop.createdAt,
            decidedAt: prop.decidedAt,
            canApply: !blocked,
            ...(blocked ? { blockedReason: blocked } : {}),
            // Only for a step that uses a shared element: applying the fix changes the element, so it changes the other tests too.
            ...(sh ? { shared: { name: sh.name, otherTests: sh.others.length, tests: sh.others.slice(0, 5).map((u) => ({ id: u.id, testId: u.testKey, title: u.title })) } } : {}),
        };
    };

    app.get("/api/tests/:id/healing", async (req) => {
        const t = testOr404((req.params as { id: string }).id);
        return { testId: t.id, validationStatus: t.validationStatus, proposals: store.list(t.id).map((prop) => publicProposal(t, prop)) };
    });

    app.post("/api/tests/:id/healing/:pid/dismiss", async (req) => {
        const { id, pid } = req.params as { id: string; pid: string };
        const t = testOr404(id);
        const prop = proposalOf(t.id, pid);
        if (prop.status !== "proposed") throw new HttpError(409, prop.status === "applied" ? "This suggestion was already applied." : "This suggestion was already dismissed.");
        store.decide(prop.id, "dismissed");
        return publicProposal(t, store.get(prop.id)!);
    });

    app.post("/api/tests/:id/healing/:pid/apply", async (req, reply) => {
        const { id, pid } = req.params as { id: string; pid: string };
        const t = testOr404(id);
        const prop = proposalOf(t.id, pid);
        const blocked = blocker(t, prop);
        if (blocked) throw new HttpError(409, blocked);
        await ctx.assertNoActiveJob(t.projectId);

        // A step that uses a shared element: one fix for every test that uses it. The element changes, not the step.
        const sh = sharedOf(t, prop.stepIndex);
        if (sh?.element) {
            const accepted = (req.body as { acceptSharedChange?: unknown } | undefined)?.acceptSharedChange === true;
            if (sh.others.length && !accepted) {
                throw new HttpError(409, `This also changes ${sh.others.length} other test${sh.others.length === 1 ? "" : "s"} that use${sh.others.length === 1 ? "s" : ""} the shared element “${sh.name}”. Confirm to apply the fix to all of them.`, {
                    requiresConfirmation: true,
                    otherTests: sh.others.length,
                    tests: sh.others.slice(0, 5).map((u) => ({ id: u.id, testId: u.testKey, title: u.title })),
                });
            }
            if (!store.decide(prop.id, "applied")) throw new HttpError(409, "This suggestion was just decided by someone else.");
            shared.store.update(t.projectId, sh.element.id, { locator: prop.newLocator });
            const outcome = await shared.propagate(t.projectId, [t.id, ...sh.others.map((u) => u.id)], sh.name);
            const started = outcome.revalidation.status === "started" ? outcome.revalidation.jobId : null;
            return reply.code(202).send({
                jobId: started,
                status: started ? repo.getJob(started)?.status ?? "QUEUED" : "waiting",
                scriptId: (repo.getCurrentScript(t.id)?.id as string | undefined) ?? null,
                proposal: publicProposal(repo.getTest(t.id)!, store.get(prop.id)!),
                shared: { name: sh.name, ...outcome },
            });
        }

        // The only change: the locator of that one step. What the step does or checks stays exactly as it was.
        const changed = applyLocator(t.spec, prop.stepIndex, prop.oldLocator, prop.newLocator);
        if (!changed.ok) throw new HttpError(409, changed.reason);
        const application = await ctx.applicationFor(t.projectId);
        const adapter = defaultAdapterFor(t.spec.kind);
        const framework = adapter.id;
        const origin = new URL(application.url).origin;
        const suiteSlug = (repo.getSuite(t.suiteId)?.slug as string | undefined) ?? "general";
        const script = renderWithAdapter(changed.spec, framework, { baseUrl: origin });
        const scriptId = await storeScript(repo, p.store, t.projectId, t.id, suiteSlug, script, adapter.executable);

        // Everything from here is synchronous: the busy check, the spec change and the new job cannot be interleaved by another request.
        let job;
        try {
            await ctx.assertNoActiveJob(t.projectId);
            if (!store.decide(prop.id, "applied")) throw new HttpError(409, "This suggestion was just decided by someone else.");
            repo.updateTest(t.id, { spec: changed.spec });
            job = await ctx.startValidationJob(t.projectId, application.id, [t.id]);
        } catch (e) {
            // A run started while the new script was being saved: put the stored script back in line with the unchanged test.
            await storeScript(repo, p.store, t.projectId, t.id, suiteSlug, renderWithAdapter(t.spec, framework, { baseUrl: origin }), adapter.executable);
            throw e;
        }
        return reply.code(202).send({ jobId: job.id, status: job.status, scriptId, proposal: publicProposal(repo.getTest(t.id)!, store.get(prop.id)!) });
    });
}
