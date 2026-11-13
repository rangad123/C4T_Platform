import { z } from "zod";
import { getAgentServices } from "../agent-services.js";
import { ownerIdOfActor, makerIdOfActor } from "../agent-store.js";
import { SEVERITIES } from "../../engine/validation/severity.js";
import { ALERT_EVENTS, API_DRIFT_EVENT, type AlertChannel } from "../alerts.js";
import { assertSmtpHostAllowed, fromInput, mergeSmtp, NO_MAIL_SERVER_MESSAGE, publicSmtp, Recipients, serverSmtp, SmtpInput, SmtpPatch } from "../alert-email.js";
import { ENV_NAME } from "../../engine/environments/env.js";
import { PRODUCTION_CONFIRM_MESSAGE } from "../environment-run.js";
import { findEnvironment, scheduleEnvironment, setScheduleEnvironment } from "../environments-store.js";
import { HttpError } from "../http-error.js";
import { assertAllowedTarget } from "../net-guard.js";
import { getScheduleServices } from "../schedule-services.js";
import { sharedOrigin, sharedRowMessage } from "../shared-integrations.js";
import { NEW_PASSWORD_NEEDED } from "./shared-integrations.js";
import { CadenceSchema, describeCadence, SCHEDULE_KINDS, type Schedule } from "../schedule-store.js";
import { RunbookOverlapError, getRunbookServices } from "../runbook-runner.js";
import { runsCanStartHere, suiteStoreFor } from "../suite-run.js";
import { currentActor } from "../auth/actor.js";
import { isRunbookStart, OverlapError, runnableTestIds } from "../scheduler.js";
import { detectFlaky, getRunSummary, trendsFor } from "../trends.js";
import type { RouteCtx } from "./types.js";

const MAX_SCHEDULES = 10;
/** EXECUTION_MODE=runners: an "Explore again" schedule would fail at every fire (exploring needs a browser on the server). */
const MAX_CHANNELS = 10;

const KIND_LABEL = { validate: "Re-run all tests", generate: "Analyze again" } as const;
const CHANNEL_LABEL = { webhook: "Webhook", slack: "Slack", teams: "Teams" } as const;

const ScheduleBody = z.object({
    name: z.string().trim().min(1).max(80).optional(),
    kind: z.enum(SCHEDULE_KINDS),
    cadence: CadenceSchema,
    enabled: z.boolean().default(true),
    /** Failing tests are re-run this many times straight away to tell flaky tests from real failures (re-run schedules). */
    retryFailures: z.number().int().min(0).max(3).default(1),
    /** Run against this named environment instead of the project's own address (re-run schedules only). A production one needs confirmProduction. */
    environment: z.string().regex(ENV_NAME).nullable().optional(),
    confirmProduction: z.boolean().optional(),
    /** Start a run of this runbook instead of a plain job (see routes/runbooks.ts). */
    runbookId: z.string().min(1).max(64).nullable().optional(),
    /** Run this test suite (its tests, order and settings) instead of every test (see routes/suites.ts). */
    suiteId: z.string().min(1).max(64).nullable().optional(),
});
const SchedulePatch = z
    .object({ name: z.string().trim().min(1).max(80), kind: z.enum(SCHEDULE_KINDS), cadence: CadenceSchema, enabled: z.boolean(), retryFailures: z.number().int().min(0).max(3), environment: z.string().regex(ENV_NAME).nullable(), confirmProduction: z.boolean(), runbookId: z.string().min(1).max(64).nullable(), suiteId: z.string().min(1).max(64).nullable() })
    .partial()
    .strict();

const HttpUrl = z
    .string()
    .trim()
    .url()
    .max(2000)
    .refine((u) => /^https?:\/\//i.test(u), "Use an http(s) address");
const Events = z.array(z.enum(ALERT_EVENTS)).min(1).max(ALERT_EVENTS.length).transform((e) => [...new Set(e)]);
const ChannelBody = z.object({
    kind: z.enum(["webhook", "slack", "teams"]),
    name: z.string().trim().min(1).max(80).optional(),
    url: HttpUrl,
    // The API-change alert is opt-in: a channel created before it existed (or without choosing) hears about runs only.
    events: Events.default(ALERT_EVENTS.filter((e) => e !== API_DRIFT_EVENT)),
    minSeverity: z.enum(SEVERITIES).nullable().optional(),
    enabled: z.boolean().default(true),
});
const ChannelPatch = z.object({ name: z.string().trim().min(1).max(80), url: HttpUrl, events: Events, minSeverity: z.enum(SEVERITIES).nullable(), enabled: z.boolean() }).partial().strict();
// Email channels: recipients instead of an address, and optionally a mail server of their own (the login is write-only).
const EmailBody = z.object({
    kind: z.literal("email"),
    name: z.string().trim().min(1).max(80).optional(),
    recipients: Recipients,
    smtp: SmtpInput.optional(),
    events: Events.default(ALERT_EVENTS.filter((e) => e !== API_DRIFT_EVENT)),
    minSeverity: z.enum(SEVERITIES).nullable().optional(),
    enabled: z.boolean().default(true),
});
const EmailPatch = z.object({ name: z.string().trim().min(1).max(80), recipients: Recipients, smtp: SmtpPatch.nullable(), events: Events, minSeverity: z.enum(SEVERITIES).nullable(), enabled: z.boolean() }).partial().strict();

const timezone = () => ({ name: Intl.DateTimeFormat().resolvedOptions().timeZone, utcOffsetMinutes: -new Date().getTimezoneOffset() });

const publicSchedule = (s: Schedule) => ({
    id: s.id,
    projectId: s.projectId,
    name: s.name,
    kind: s.kind,
    kindLabel: KIND_LABEL[s.kind],
    cadence: s.cadence,
    cadenceText: describeCadence(s.cadence),
    enabled: s.enabled,
    retryFailures: s.retryFailures,
    nextRunAt: s.nextRunAt === null ? null : new Date(s.nextRunAt).toISOString(),
    lastRunAt: s.lastRunAt,
    lastJobId: s.lastJobId,
    lastOutcome: s.lastOutcome,
    lastOutcomeAt: s.lastOutcomeAt,
    lastNote: s.lastNote,
    createdAt: s.createdAt,
});

/** Schedules, run trends, flaky tests and alert channels. */
export function registerScheduleRoutes(ctx: RouteCtx): void {
    const { app, p, repo, project } = ctx;
    const svc = getScheduleServices(p);

    const schedule = (projectId: string, id: string): Schedule => {
        const s = svc.store.get(id);
        if (!s || s.projectId !== projectId) throw new HttpError(404, "Schedule not found");
        return s;
    };
    const channel = (projectId: string, id: string): AlertChannel => {
        const c = svc.alertStore.get(id);
        if (!c || c.projectId !== projectId) throw new HttpError(404, "Alert channel not found");
        return c;
    };
    /** Refuse a schedule that could never run, with the reason in plain words (as its maker's runs: their runner, their code tests). */
    const assertRunnable = async (projectId: string, kind: Schedule["kind"]) => {
        if (!repo.getLatestApplicationPublic(projectId)) throw new HttpError(409, "This project has no application yet. Run an analysis first.");
        if (kind === "validate" && (await runnableTestIds(repo, projectId, "validate", ownerIdOfActor(currentActor()))).length === 0) throw new HttpError(409, "This project has no tests that can be run yet.");
    };
    /** The schedule's public shape plus the environment it runs against (kept by the environments feature). */
    const runbooks = getRunbookServices(p).store;
    const runbookOf = (sid: string) => {
        const rb = runbooks.get(runbooks.scheduleLink(sid) ?? "");
        return { runbookId: rb?.id ?? null, runbookName: rb?.name ?? null };
    };
    const checkRunbook = (projectId: string, runbookId: string) => {
        if (runbooks.get(runbookId)?.projectId !== projectId) throw new HttpError(404, "This project has no runbook with that id.");
    };
    const suites = suiteStoreFor(p);
    const suiteOf = async (sid: string) => {
        const su = await suites.get((await suites.scheduleLink(sid)) ?? "");
        return { suiteId: su?.id ?? null, suiteName: su?.name ?? null };
    };
    /** A schedule runs a suite of its own project, in place of "every test": not an analysis, not a runbook, not an environment of its own. */
    const checkSuite = async (projectId: string, suiteId: string, kind: Schedule["kind"], other: { runbookId?: string | null; environment?: string | null }) => {
        const su = await suites.get(suiteId);
        if (!su || su.projectId !== projectId) throw new HttpError(404, "This project has no suite with that id.");
        if (kind !== "validate") throw new HttpError(400, "Only a schedule that runs tests can run a suite.");
        if (other.runbookId) throw new HttpError(400, "A schedule runs either a run sequence or a suite, not both.");
        if (other.environment) throw new HttpError(400, "A suite runs against the environment in its own settings. Leave the schedule's environment empty.");
        if (!repo.getLatestApplicationPublic(projectId)) throw new HttpError(409, "This project has no application yet. Run an analysis first.");
        if (su.testCount === 0) throw new HttpError(409, `The suite “${su.name}” has no tests yet.`);
    };
    const agents = getAgentServices(p);
    /** Whose runner the schedule's runs go to, by name (never an email): "Runs on {ownerName}'s runner". */
    const ownerNameOf = (s: Schedule) => {
        const name = s.createdBy ? agents.personName(s.createdBy) : undefined;
        return name ? { ownerName: name } : {};
    };
    const pub = async (s: Schedule) => ({ ...publicSchedule(s), ...ownerNameOf(s), ...scheduleEnvironment(repo.db, s.id), ...runbookOf(s.id), ...(await suiteOf(s.id)) });
    /** An environment run needs an environment that exists, and a production one needs the owner's confirmation. */
    const checkScheduleEnvironment = (projectId: string, kind: Schedule["kind"], name: string, confirm: boolean | undefined) => {
        if (kind !== "validate") throw new HttpError(400, "Only “Re-run all tests” schedules can run against an environment.");
        const env = findEnvironment(repo.db, projectId, name);
        if (!env) throw new HttpError(404, `This project has no environment called “${name}”.`);
        if (env.production && !confirm) throw new HttpError(409, PRODUCTION_CONFIRM_MESSAGE(env.name), { requiresConfirmation: true });
    };
    const autoName = (s: { kind: Schedule["kind"]; cadence: Schedule["cadence"] }) => `${KIND_LABEL[s.kind]} · ${describeCadence(s.cadence).replace(/^Every /, "every ")}`;

    // ── schedules ──────────────────────────────────────────────────────────────
    app.get("/api/projects/:id/schedules", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        // Whether schedules really fire here: the scheduler is switched on AND something picks up their runs (a worker, or the dispatch worker
        // of EXECUTION_MODE=runners). `schedulesNote` says why not, in a sentence (null when they fire).
        const can = runsCanStartHere(p);
        const fire = p.config.SCHEDULER_ENABLED && can.ok;
        const schedulesNote = fire ? null : !p.config.SCHEDULER_ENABLED ? "Schedules are switched off on this server (SCHEDULER_ENABLED=false), so they do not start runs by themselves." : `Schedules do not start runs here right now. ${can.ok ? "" : can.reason}`.trim();
        return { serverTime: new Date().toISOString(), timezone: timezone(), schedulerEnabled: fire, schedulesFire: fire, schedulesNote, executionMode: p.config.EXECUTION_MODE, schedules: await Promise.all(svc.store.list(id).map(pub)) };
    });

    app.post("/api/projects/:id/schedules", async (req, reply) => {
        const { id } = req.params as { id: string };
        project(id);
        const body = ScheduleBody.parse(req.body);
        if (svc.store.list(id).length >= MAX_SCHEDULES) throw new HttpError(409, `A project can have up to ${MAX_SCHEDULES} schedules`);
        if (body.suiteId) await checkSuite(id, body.suiteId, body.kind, body);
        else await assertRunnable(id, body.kind);
        if (body.environment) checkScheduleEnvironment(id, body.kind, body.environment, body.confirmProduction);
        if (body.runbookId) checkRunbook(id, body.runbookId);
        // Who made it: a person's own runner may take the runs of that person's schedules (COMMON contract, scheduler.ts startedBy).
        const actor = currentActor();
        const created = svc.store.create({ projectId: id, name: body.name ?? autoName(body), kind: body.kind, cadence: body.cadence, enabled: body.enabled, retryFailures: body.retryFailures, createdBy: makerIdOfActor(actor) });
        if (body.environment) setScheduleEnvironment(repo.db, created.id, { environment: body.environment, confirmProduction: Boolean(body.confirmProduction) });
        if (body.runbookId) runbooks.setScheduleLink(created.id, body.runbookId);
        if (body.suiteId) await suites.setScheduleLink(created.id, body.suiteId);
        return reply.code(201).send(await pub(created));
    });

    app.patch("/api/projects/:id/schedules/:sid", async (req) => {
        const { id, sid } = req.params as { id: string; sid: string };
        project(id);
        const cur = schedule(id, sid);
        const patch = SchedulePatch.parse(req.body);
        const curSuite = await suites.scheduleLink(sid);
        const nextSuite = patch.suiteId === undefined ? curSuite : patch.suiteId;
        if (nextSuite && (patch.suiteId !== undefined || patch.kind || patch.runbookId || patch.environment)) {
            await checkSuite(id, nextSuite, patch.kind ?? cur.kind, { runbookId: patch.runbookId === undefined ? runbooks.scheduleLink(sid) : patch.runbookId, environment: patch.environment === undefined ? scheduleEnvironment(repo.db, sid).environment : patch.environment });
        } else if (patch.kind && patch.kind !== cur.kind) await assertRunnable(id, patch.kind);
        // A name made from the old settings follows them; a name the user typed stays.
        const wasAuto = cur.name === autoName(cur);
        const next = { kind: patch.kind ?? cur.kind, cadence: patch.cadence ?? cur.cadence };
        const renamed = patch.name === undefined && wasAuto && (patch.kind || patch.cadence) ? autoName(next) : patch.name;
        const { environment, confirmProduction, runbookId, suiteId, ...own } = patch;
        if (runbookId) checkRunbook(id, runbookId);
        const target = scheduleEnvironment(repo.db, sid);
        const nextEnv = environment === undefined ? target.environment : environment;
        const nextConfirm = nextEnv === target.environment && confirmProduction === undefined ? target.confirmProduction : Boolean(confirmProduction);
        if (nextEnv) checkScheduleEnvironment(id, patch.kind ?? cur.kind, nextEnv, nextConfirm);
        // The editor now owns its runs: from here on they go to the editor's own runner, never to the previous maker's.
        const editor = currentActor();
        const updated = svc.store.update(sid, { ...own, name: renamed, createdBy: makerIdOfActor(editor) })!;
        if (environment !== undefined || confirmProduction !== undefined) setScheduleEnvironment(repo.db, sid, { environment: nextEnv, confirmProduction: nextConfirm });
        if (runbookId !== undefined) runbooks.setScheduleLink(sid, runbookId);
        if (suiteId !== undefined) await suites.setScheduleLink(sid, suiteId);
        return await pub(updated);
    });

    app.delete("/api/projects/:id/schedules/:sid", async (req, reply) => {
        const { id, sid } = req.params as { id: string; sid: string };
        project(id);
        schedule(id, sid);
        svc.store.delete(sid);
        return reply.code(204).send();
    });

    app.post("/api/projects/:id/schedules/:sid/run", async (req, reply) => {
        const { id, sid } = req.params as { id: string; sid: string };
        project(id);
        schedule(id, sid);
        try {
            // "Run now" belongs to the person who clicks (the open server on an open one): their own runner takes it, never the maker's.
            const clicker = currentActor();
            const job = await svc.runNow(sid, ownerIdOfActor(clicker));
            if (isRunbookStart(job)) return reply.code(202).send({ runbookRunId: job.runbookRunId, runbook: job.runbookName });
            return reply.code(202).send({ jobId: job.id, status: job.status, job: ctx.publicJob(job) });
        } catch (e) {
            if (e instanceof RunbookOverlapError) throw new HttpError(409, `The runbook “${e.runbookName}” is still running for this project; wait for it to finish or cancel it`);
            if (e instanceof OverlapError) throw new HttpError(409, `Job ${e.activeJobId} is still ${e.activeStatus}; wait for it to finish or cancel it`);
            if (e instanceof HttpError) throw e;
            throw new HttpError(409, e instanceof Error ? e.message : "The run could not be started");
        }
    });

    // ── what the runs say ──────────────────────────────────────────────────────
    app.get("/api/projects/:id/trends", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
        return trendsFor(p.db, id, days);
    });

    app.get("/api/projects/:id/flaky", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        return { tests: detectFlaky(p.db, id) };
    });

    /** What changed in one finished run compared with what was known before it. */
    app.get("/api/projects/:id/runs/:jobId/summary", async (req) => {
        const { id, jobId } = req.params as { id: string; jobId: string };
        project(id);
        const s = getRunSummary(p.db, jobId);
        if (!s || s.projectId !== id) throw new HttpError(404, "No summary for this run");
        const { results: _results, ...rest } = s;
        return rest;
    });

    // ── alert channels ─────────────────────────────────────────────────────────
    app.get("/api/projects/:id/alert-channels", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        return svc.alertStore.list(id);
    });

    app.post("/api/projects/:id/alert-channels", async (req, reply) => {
        const { id } = req.params as { id: string };
        project(id);
        if ((req.body as { kind?: unknown } | null | undefined)?.kind === "email") {
            const mail = EmailBody.parse(req.body);
            if (svc.alertStore.list(id).length >= MAX_CHANNELS) throw new HttpError(409, `A project can have up to ${MAX_CHANNELS} alert channels`);
            // Mail goes out through the channel's own server, else the server-wide one; without either there is nowhere to send from.
            const smtp = mail.smtp ? fromInput(mail.smtp) : undefined;
            const effective = smtp ?? serverSmtp(p.config);
            if (!effective) throw new HttpError(422, NO_MAIL_SERVER_MESSAGE);
            await assertSmtpHostAllowed(effective.host);
            const more = mail.recipients.length - 1;
            const made = svc.alertStore.createEmail({ projectId: id, name: mail.name ?? `Email to ${mail.recipients[0]}${more > 0 ? ` and ${more} more` : ""}`, recipients: mail.recipients, smtp, events: mail.events, minSeverity: mail.minSeverity, enabled: mail.enabled });
            return reply.code(201).send(made);
        }
        const body = ChannelBody.parse(req.body);
        if (svc.alertStore.list(id).length >= MAX_CHANNELS) throw new HttpError(409, `A project can have up to ${MAX_CHANNELS} alert channels`);
        await assertAllowedTarget(body.url);
        const created = svc.alertStore.create({ projectId: id, kind: body.kind, name: body.name ?? `${CHANNEL_LABEL[body.kind]} · ${new URL(body.url).host}`, url: body.url, events: body.events, minSeverity: body.minSeverity, enabled: body.enabled });
        return reply.code(201).send(created);
    });

    app.patch("/api/projects/:id/alert-channels/:cid", async (req) => {
        const { id, cid } = req.params as { id: string; cid: string };
        project(id);
        const current = channel(id, cid);
        if (current.kind === "email") {
            const { recipients, smtp, ...own } = EmailPatch.parse(req.body);
            if (recipients !== undefined || smtp !== undefined) {
                // Check the settings the channel would end up with before saving anything.
                const cur = svc.alertStore.emailOf(cid);
                // The stored password is only sent to the server it was entered for: another host or port, or TLS turned off, needs it again.
                const was = cur.smtp;
                if (smtp && was?.password && smtp.password === undefined && smtp.username !== null) {
                    const moves = (smtp.host !== undefined && smtp.host.toLowerCase() !== (was.host ?? "").toLowerCase()) || (smtp.port !== undefined && smtp.port !== was.port) || (smtp.secure === false && was.secure);
                    if (moves) throw new HttpError(400, NEW_PASSWORD_NEEDED);
                }
                const merged = smtp === undefined ? cur.smtp : smtp === null ? undefined : mergeSmtp(cur.smtp, smtp);
                const effective = merged ?? serverSmtp(p.config);
                if (!effective) throw new HttpError(422, NO_MAIL_SERVER_MESSAGE);
                await assertSmtpHostAllowed(effective.host);
                svc.alertStore.updateEmail(cid, { recipients, smtp });
            }
            return svc.alertStore.update(cid, own)!;
        }
        const patch = ChannelPatch.parse(req.body);
        // A channel shared from Integrations keeps its name and address there; what it hears about stays this project's choice.
        const origin = sharedOrigin(p.db, cid);
        if (origin && (patch.url !== undefined || (patch.name !== undefined && patch.name !== current.name))) throw new HttpError(409, sharedRowMessage(origin.name), { code: "shared_integration", integrationId: origin.integrationId });
        if (patch.url) await assertAllowedTarget(patch.url);
        return svc.alertStore.update(cid, patch)!;
    });

    app.delete("/api/projects/:id/alert-channels/:cid", async (req, reply) => {
        const { id, cid } = req.params as { id: string; cid: string };
        project(id);
        channel(id, cid);
        const origin = sharedOrigin(p.db, cid);
        if (origin) throw new HttpError(409, sharedRowMessage(origin.name), { code: "shared_integration", integrationId: origin.integrationId });
        svc.alertStore.delete(cid);
        return reply.code(204).send();
    });

    /** Sends a harmless message and reports what the receiver really answered (always HTTP 200 here; see `ok`). */
    app.post("/api/projects/:id/alert-channels/:cid/test", async (req) => {
        const { id, cid } = req.params as { id: string; cid: string };
        const proj = project(id);
        const ch = channel(id, cid);
        const app_ = repo.getLatestApplicationPublic(id);
        const subject = svc.alerts.subject({ id, name: proj.name as string, url: (app_?.url as string | undefined) ?? null }, req.headers.host ? `${req.protocol}://${req.headers.host}` : undefined);
        const r = await svc.alerts.sendTest(ch, subject);
        return { ok: r.ok, httpStatus: r.status ?? null, attempts: r.attempts, error: r.error ?? null };
    });

    /** What the "add a channel" form needs to know: whether the server has mail settings of its own (never the login). */
    app.get("/api/projects/:id/alert-options", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        const server = serverSmtp(p.config);
        return { email: { serverMail: server ? publicSmtp(server) : null, maxRecipients: 10 } };
    });

    app.get("/api/projects/:id/alert-log", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(30) }).parse(req.query);
        return svc.alertStore.listLog(id, limit);
    });
}
