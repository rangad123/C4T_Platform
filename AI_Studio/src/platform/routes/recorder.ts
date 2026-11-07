import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { checkElement, locatorKey as specLocatorKey } from "../../engine/locators/index.js";
import { REC_ASSERT_CHECKS, REC_LIMITS, REC_STRATEGIES, type RecLocator } from "../../engine/recorder/model.js";
import { buildRecordedSpec, foreignOrigins, toSpecLocator } from "../../engine/recorder/spec.js";
import { assertMayRun, environmentStore } from "../environment-run.js";
import { HttpError } from "../http-error.js";
import { LocatorStore, NameTakenError } from "../locator-store.js";
import { assertAgentTarget, callerIdOf, chooseRecorder, maySeeSession, sessionHosts } from "../agent-record.js";
import { callerCredentials } from "../auth/access.js";
import { currentActor } from "../auth/actor.js";
import { getAgentServices } from "../agent-services.js";
import { liveOpenWarnings } from "../live-warnings.js";
import { browserInstalled, DEFAULT_CAPS, hasDisplay, RecorderService, type RecorderOptions } from "../recorder-service.js";
import type { RouteCtx } from "./types.js";

/** Tests set the service's caps, address guard and raw-message tap here before building the server. Normal runs leave it empty. */
export const recorderOptions: RecorderOptions = {};
const services = new WeakMap<FastifyInstance, RecorderService>();
/** The recorder of a built server (tests use it to read the browser's process id). */
export const recorderOf = (app: FastifyInstance): RecorderService | undefined => services.get(app);

const Locator = z.object({
    strategy: z.enum(REC_STRATEGIES),
    value: z.string().min(1).max(300),
    name: z.string().max(REC_LIMITS.maxLocatorText).optional(),
    exact: z.boolean().optional(),
});
const Assert = z.object({ check: z.enum(REC_ASSERT_CHECKS), expected: z.union([z.string().max(500), z.number()]).optional() });

const StartBody = z.object({
    url: z.string().min(1).max(2000),
    headed: z.boolean().optional(),
    environment: z.string().min(1).max(80).optional(),
    /** Recording on a production environment needs the same explicit confirmation as running there. */
    confirmProduction: z.boolean().optional(),
    /** Where the browser runs. Absent: on the agent when the project's runner setting is an agent, else on the platform (as before). */
    on: z.enum(["platform", "agent"]).optional(),
    agentId: z.string().min(1).max(64).optional(),
});
const InspectBody = z.object({ on: z.boolean(), mode: z.enum(["locator", "assertion"]).optional(), check: z.enum(REC_ASSERT_CHECKS).optional() });
const PatchBody = z.object({ locator: Locator.optional(), value: z.string().max(2000).optional(), assert: Assert.optional() }).refine((b) => b.locator || b.value !== undefined || b.assert, "Nothing to change");
const SaveBody = z.object({ title: z.string().trim().min(3, "Give the test a title of at least 3 characters").max(160), category: z.string().trim().min(1).max(80).optional() });
const ShareBody = z.object({ name: z.string().min(1).max(200) });

/** Test recorder and inspector routes (Builder AM). Everything under /api/ is behind the API key like every other route. */
export function registerRecorderRoutes(ctx: RouteCtx): void {
    const { app, p, repo, project } = ctx;
    const service = new RecorderService({ maxLocal: p.config.RECORDINGS_MAX, ...recorderOptions });
    services.set(app, service);
    app.addHook("onClose", async () => {
        await service.closeAll();
    });
    const envs = () => environmentStore(repo, p.config);
    const elements = () => new LocatorStore(repo.db);
    const rec = (rid: string) => {
        const r = service.get(rid);
        if (!r) throw new HttpError(404, "Recording not found. It may have been discarded or the platform was restarted.");
        return r;
    };
    // A recording or live session on a person's own computer is its starter's alone: for anyone else every route of it (read, drive, edit, save,
    // stop, discard, the live session's act and snapshot) answers "not found", like an id that does not exist. Registered before those routes.
    app.addHook("preHandler", async (req) => {
        if (!req.routeOptions.url?.startsWith("/api/recordings/:rid")) return;
        const rid = (req.params as { rid?: string }).rid;
        const driver = rid ? getAgentServices(p).records.byRecording(rid) : undefined;
        if (!maySeeSession(driver, callerIdOf(currentActor()))) throw new HttpError(404, "Recording not found. It may have been discarded or the platform was restarted.");
    });
    const stepIndex = (raw: string) => {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) throw new HttpError(400, "A step number is a whole number from 0.");
        return n;
    };

    app.post("/api/projects/:id/recordings", async (req, reply) => {
        const { id } = req.params as { id: string };
        project(id);
        const body = StartBody.parse(req.body);
        const headed = body.headed ?? true;
        const agents = getAgentServices(p);
        // The caller's own computers and the project's team runners: another person's computer never hosts their recording.
        const caller = callerIdOf(currentActor());
        const where = chooseRecorder({ ...(body.on ? { on: body.on } : {}), ...(body.agentId ? { agentId: body.agentId } : {}), headed, runner: agents.store.getRunner(id), agents: sessionHosts(agents.store, id, caller, agents.clock()), caller });
        if (where.kind === "platform") {
            if (headed && !hasDisplay()) throw new HttpError(422, "This computer has no screen for a recording window. Turn \"Show the browser\" off, or run the platform on a machine with a screen.");
            if (!browserInstalled()) throw new HttpError(422, "No browser is installed on the machine that runs the platform. Run: npx playwright install chromium");
        }
        let url: string;
        if (body.environment) {
            const env = await assertMayRun(envs().get(id, body.environment), body.environment, body.confirmProduction);
            let u: URL;
            try {
                u = new URL(body.url, env.baseUrl);
            } catch {
                throw new HttpError(400, "That address is not valid.");
            }
            if (u.origin !== new URL(env.baseUrl).origin) throw new HttpError(400, `The address must be on ${env.name}'s site (${new URL(env.baseUrl).origin}).`);
            url = u.toString();
        } else {
            try {
                const u = new URL(body.url);
                if (!/^https?:$/.test(u.protocol)) throw new Error("scheme");
                url = u.toString();
            } catch {
                throw new HttpError(400, "Enter a full address starting with http:// or https://");
            }
        }
        if (where.kind === "agent") {
            // The address is reached from the agent's network: only its shape is checked here (http or https, no credentials), the platform fetches nothing.
            assertAgentTarget(url);
            const agent = where.agent;
            return reply.code(201).send(service.register(id, () => agents.startRecording({ projectId: id, agent, startUrl: url, headed, ...(body.environment ? { environment: body.environment } : {}), caps: { ...DEFAULT_CAPS, ...recorderOptions.caps }, ...(recorderOptions.remote ? { remote: recorderOptions.remote } : {}), startedBy: caller })));
        }
        await service.guardUrl(url);
        const started = service.start(id, { url, headed, ...(body.environment ? { environment: body.environment } : {}) });
        // Said once, in the answer to opening: a private address is allowed while BLOCK_PRIVATE_TARGETS is off, and a live session reads the page back.
        const warnings = await liveOpenWarnings(url);
        return reply.code(201).send(warnings.length ? { ...started, warnings } : started);
    });

    app.get("/api/recordings/:rid", async (req) => rec((req.params as { rid: string }).rid));

    app.post("/api/recordings/:rid/inspect", async (req) => {
        const b = InspectBody.parse(req.body);
        return service.setInspect((req.params as { rid: string }).rid, { on: b.on, ...(b.mode ? { mode: b.mode } : {}), ...(b.check ? { check: b.check } : {}) });
    });

    app.patch("/api/recordings/:rid/steps/:index", async (req) => {
        const { rid, index } = req.params as { rid: string; index: string };
        const b = PatchBody.parse(req.body);
        return service.patchStep(rid, stepIndex(index), { ...(b.locator ? { locator: b.locator as RecLocator } : {}), ...(b.value !== undefined ? { value: b.value } : {}), ...(b.assert ? { assert: b.assert } : {}) });
    });

    app.delete("/api/recordings/:rid/steps/:index", async (req) => {
        const { rid, index } = req.params as { rid: string; index: string };
        return service.deleteStep(rid, stepIndex(index));
    });

    app.post("/api/recordings/:rid/stop", async (req) => {
        const { rid } = req.params as { rid: string };
        rec(rid);
        return service.stop(rid);
    });

    app.delete("/api/recordings/:rid", async (req) => {
        const { rid } = req.params as { rid: string };
        rec(rid);
        await service.discard(rid);
        return { ok: true };
    });

    // ── make a step use a shared element of the object repository ─────────────────
    app.post("/api/recordings/:rid/steps/:index/share", async (req) => {
        const { rid, index } = req.params as { rid: string; index: string };
        const body = ShareBody.parse(req.body);
        const r = rec(rid);
        const step = service.step(rid, stepIndex(index));
        if (!step.locator) throw new HttpError(400, "This step has no element to share.");
        const c = checkElement({ name: body.name, kind: "web", locator: toSpecLocator(step.locator) });
        if (!c.ok) throw new HttpError(400, c.error);
        const store = elements();
        const existing = store.getByName(r.projectId, c.element.name);
        if (existing) {
            if (specLocatorKey("web", existing.locator) !== specLocatorKey("web", c.element.locator)) throw new HttpError(409, `The object repository already has "${existing.name}" with a different locator. Choose another name.`);
        } else {
            try {
                store.create(r.projectId, c.element);
            } catch (e) {
                if (e instanceof NameTakenError) throw new HttpError(409, e.message);
                throw e;
            }
        }
        return service.setRef(rid, stepIndex(index), c.element.name);
    });

    // ── save as a normal web test, then validate it with a real run ───────────────
    app.post("/api/recordings/:rid/save", async (req, reply) => {
        const { rid } = req.params as { rid: string };
        const body = SaveBody.parse(req.body);
        let r = rec(rid);
        if (r.status === "saved") throw new HttpError(409, "This recording is already saved as a test.");
        if (r.status === "failed" || r.status === "starting") throw new HttpError(409, r.error ?? "This recording can't be saved. Start a new one.");
        // Nothing to save leaves a running session as it is; otherwise saving ends it (the browser is closed first).
        if (!r.canSave) throw new HttpError(409, "There is nothing to save yet: click through the application first.");
        if (r.status === "recording") {
            await service.stop(rid);
            // A recording on an agent ends when the agent confirms: wait (bounded) so the steps saved are the final ones.
            if (r.runner?.kind === "agent") await service.settle(rid, recorderOptions.remote?.settleMs ?? 6000);
            r = rec(rid);
            if (r.status === "recording") throw new HttpError(409, `${r.runner?.kind === "agent" ? r.runner.name : "The recorder"} has not confirmed the stop yet. Try saving again in a moment.`);
        }
        const foreign = foreignOrigins(r.steps, r.startUrl);
        if (foreign.length) throw new HttpError(422, `This recording opens another site (${foreign[0]}). A test can only open pages of the site it tests: delete that step, or record the part on the other site as its own test.`);
        const built = buildRecordedSpec({ title: body.title, ...(body.category ? { category: body.category } : {}), startUrl: r.startUrl, steps: r.steps, recordedAt: r.startedAt });
        if (built.problems.length) throw new HttpError(422, built.problems[0]!);

        const origin = new URL(r.startUrl).origin;
        const latestUrl = repo.getLatestApplicationPublic(r.projectId)?.url as string | undefined;
        let latestOrigin: string | undefined;
        try {
            latestOrigin = latestUrl ? new URL(latestUrl).origin : undefined;
        } catch {
            latestOrigin = undefined;
        }
        // The project's own application keeps its sign-in details; only another site gets a new application.
        const newApplication = latestOrigin !== origin;
        let validate = true;
        let note: string | undefined;
        try {
            await ctx.assertNoActiveJob(r.projectId);
        } catch (e) {
            if (!(e instanceof HttpError) || e.status !== 409) throw e;
            validate = false;
            note = `${e.message}. The test is saved and shows "Not validated"; run it when the other job has finished.`;
        }
        const res = await app.inject({
            method: "POST",
            url: `/api/projects/${r.projectId}/specs`,
            headers: callerCredentials(req),
            payload: { specs: [built.spec], validate, ...(newApplication ? { baseUrl: origin } : {}) },
        });
        const out = (res.body ? JSON.parse(res.body) : {}) as { error?: string; details?: Array<{ issues?: Array<{ message?: string }> }>; jobId?: string | null; tests?: Array<{ id: string; testId: string }>; notRun?: string };
        if (res.statusCode >= 400 || !out.tests?.[0]) {
            const detail = out.details?.[0]?.issues?.[0]?.message;
            throw new HttpError(res.statusCode === 400 ? 422 : res.statusCode >= 400 ? res.statusCode : 500, `${out.error ?? "The test could not be saved"}${detail ? `: ${detail}` : ""}`);
        }
        const test = out.tests[0];
        service.markSaved(rid, test.id);
        if (newApplication && r.steps.some((s) => s.secret)) note = `${note ? `${note} ` : ""}This recording signs in with a stand-in for the password. Save the project's sign-in details so the test can run.`;
        return reply.code(201).send({ testId: test.id, testKey: test.testId, jobId: out.jobId ?? null, ...(note ?? out.notRun ? { note: note ?? out.notRun } : {}) });
    });
}
