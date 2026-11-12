/**
 * Round 45, who a run belongs to (no HTTP): the open server acts as one person (OPEN_OWNER_ID) and its runner takes its runs only while the
 * server is open; schedules made before their creator was recorded are attributed from Activity only where that is certain; a deploy
 * trigger token keeps its creator, and its runs are theirs.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskOffer } from "../src/agent-protocol/schema.js";
import { loadConfig } from "../src/config.js";
import { getAgentServices, KEY_HAS_NO_RUNNER, ownerOfNewJob, RUNBOOK_STARTER_UNKNOWN, SCHEDULE_HAS_NO_OWNER } from "../src/platform/agent-services.js";
import { customPolicyFor } from "../src/platform/custom-policy.js";
import { buildServer } from "../src/platform/server.js";
import { writeHeartbeat } from "../src/platform/ops/heartbeat.js";
import { jobOwnerId, OPEN_OWNER_ID } from "../src/platform/agent-store.js";
import { runAs, type Actor } from "../src/platform/auth/actor.js";
import { seesEveryRunner } from "../src/platform/runner-health.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import type { JobOptions } from "../src/platform/repo.js";
import { ScheduleStore } from "../src/platform/schedule-store.js";
import { SecretBox } from "../src/platform/secrets.js";
import { TriggerStore } from "../src/platform/trigger-store.js";
import { getRunbookServices } from "../src/platform/runbook-runner.js";
import { getScheduleServices } from "../src/platform/schedule-services.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { RunbookDefinition } from "../src/engine/runbook/schema.js";
import { defaultCaps } from "./fixtures/fake-agent.js";

let platform: Platform;
let tmp = "";
let projectId = "";
const svc = () => getAgentServices(platform);
const base = { maxPages: 1, maxDepth: 1, maxScenarios: 1, targets: ["web"], allowMutatingApiTests: false, mode: "validate", testIds: [] } as unknown as JobOptions;

beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-owner-"));
    platform = bootstrap(loadConfig({ DATA_DIR: tmp, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", SECRET_KEY: "owner-unit-secret-key-0123456789abc" }));
    projectId = platform.repo.createProject({ name: "Open shop" }).id as string;
    platform.db.run("INSERT INTO applications (id, project_id, url, origin, config_json, created_at) VALUES (?,?,?,?,?,?)", "app-1", projectId, "https://app.example", "https://app.example", "{}", new Date().toISOString());
    svc().store.setRunner(projectId, { runOn: "agent", agentId: null });
});

afterAll(() => {
    platform?.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe("who a run belongs to", () => {
    it("jobOwnerId: a person, the open server, a schedule's or a trigger's creator; the shared key is nobody", () => {
        expect(jobOwnerId({ startedBy: { kind: "user", id: "u1" } })).toBe("u1");
        expect(jobOwnerId({ startedBy: { kind: "open", id: null } })).toBe(OPEN_OWNER_ID);
        expect(jobOwnerId({ startedBy: { kind: "schedule", id: "s", ownerId: "u2" } })).toBe("u2");
        expect(jobOwnerId({ startedBy: { kind: "trigger", id: "t", ownerId: "u3" } })).toBe("u3");
        expect(jobOwnerId({ startedBy: { kind: "key", id: null } })).toBeNull();
        expect(runAs({ kind: "open", name: "Open access", role: "owner" }, () => ownerOfNewJob(base))).toBe(OPEN_OWNER_ID);
        expect(runAs({ kind: "key", name: "Access key", role: "owner" }, () => ownerOfNewJob(base))).toBeNull();
    });

    it("the open server's runner takes the open server's runs, and stops once the server has accounts", () => {
        const { record } = svc().store.createPersonalToken({ ownerId: OPEN_OWNER_ID, label: "Open PC", createdBy: "test" });
        const agent = svc().store.upsertAgent(record, { name: "open-pc", version: "1", capabilities: defaultCaps({ runnerSwitches: true }), concurrency: 1 });
        expect(runAs({ kind: "open", name: "Open access", role: "owner" }, () => svc().assertJobAllowed(projectId, { ...base }))).toBeUndefined();
        const queue = () => {
            const jobId = randomUUID();
            const t = new Date().toISOString();
            platform.db.run("INSERT INTO generation_jobs (id, project_id, application_id, status, options_json, progress_json, counters_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", jobId, projectId, "app-1", "VALIDATING", JSON.stringify({ ...base, startedBy: { kind: "open", id: null } }), "{}", "{}", t, t);
            const taskId = randomUUID();
            const offer = TaskOffer.parse({ taskId, jobId, adapterId: "playwright", leaseSeconds: 60, workers: 1, scripts: [{ testId: "t1", filename: "t1.spec.ts", content: "//" }], env: { baseUrl: "https://app.example", headless: true } });
            svc().store.enqueue({ id: taskId, projectId, jobId, adapterId: "playwright", payloadEnc: svc().encrypt(offer), files: [] });
            return taskId;
        };
        const first = queue();
        expect(platform.db.get<{ owner_id: string }>("SELECT owner_id FROM agent_tasks WHERE id = ?", first)!.owner_id).toBe(OPEN_OWNER_ID);
        expect(svc().store.claimFor(first, { id: agent.id, tokenId: record.id }, 60_000)?.id).toBe(first);
        // A person's account now exists: the server is no longer open, so the open runner takes nothing more.
        platform.db.run("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)", "u-first", "first@people.example", "First", new Date().toISOString(), "owner", "active");
        expect(svc().store.claimFor(queue(), { id: agent.id, tokenId: record.id }, 60_000)).toBeUndefined();
        platform.db.run("DELETE FROM users WHERE id = 'u-first'");
    });

    it("a schedule with no creator is attributed from Activity only where certain", () => {
        const store = new ScheduleStore(platform.db);
        platform.db.run("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)", "u-ann", "ann@people.example", "Ann", new Date().toISOString(), "editor", "active");
        const cadence = { type: "daily", time: "02:00" } as const;
        const edited = store.create({ projectId, name: "Edited", kind: "validate", cadence, createdBy: null });
        const lone = store.create({ projectId: platform.repo.createProject({ name: "Lone" }).id as string, name: "Lone", kind: "validate", cadence, createdBy: null });
        const keyEdited = store.create({ projectId, name: "Key edited", kind: "validate", cadence, createdBy: null });
        const add = (o: { kind: string; id: string | null; action: string; path: string | null; project: string | null; at?: string }) =>
            platform.db.run("INSERT INTO activity (at, actor_kind, actor_id, actor_name, action, path, project_id, status) VALUES (?,?,?,?,?,?,?,?)", o.at ?? new Date().toISOString(), o.kind, o.id, "x", o.action, o.path, o.project, 200);
        add({ kind: "user", id: "u-ann", action: "PATCH /api/projects/:id/schedules/:sid", path: `/api/projects/${projectId}/schedules/${edited.id}`, project: projectId });
        add({ kind: "user", id: "u-ann", action: "POST /api/projects/:id/schedules", path: `/api/projects/${lone.projectId}/schedules`, project: lone.projectId, at: lone.createdAt });
        add({ kind: "user", id: "u-ann", action: "PATCH /api/projects/:id/schedules/:sid", path: `/api/projects/${projectId}/schedules/${keyEdited.id}`, project: projectId });
        add({ kind: "key", id: null, action: "PATCH /api/projects/:id/schedules/:sid", path: `/api/projects/${projectId}/schedules/${keyEdited.id}`, project: projectId });
        expect(store.backfillOwners()).toBe(2);
        expect(store.get(edited.id)!.createdBy).toBe("u-ann");
        expect(store.get(lone.id)!.createdBy).toBe("u-ann");
        // The latest change was by the shared key: not certain, so it stays without an owner (refused at its next fire).
        expect(store.get(keyEdited.id)!.createdBy).toBeNull();
        expect(store.backfillOwners()).toBe(0);
    });

    it("a deploy trigger token keeps its creator (migration 55)", () => {
        const triggers = new TriggerStore(platform.db, new SecretBox(tmp, "owner-unit-secret-key-0123456789abc"));
        const { record } = triggers.create(projectId, { label: "CI", createdBy: "u-ann" });
        expect(triggers.get(record.id)!.createdBy).toBe("u-ann");
        expect(triggers.create(projectId, {}).record.createdBy).toBeNull();
    });

    it("Run now on an open server belongs to the open server (not refused as having no owner)", async () => {
        // Open again: the people an earlier test added no longer count (an account with no role is no person here).
        platform.db.run("UPDATE users SET role = NULL");
        const app = await buildServer(platform);
        try {
            const spec = { title: "Health answers", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/health" }, { action: "assertResponse", check: "status", expected: 200 }] };
            const pid = JSON.parse((await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Run now open" } })).body).id as string;
            expect((await app.inject({ method: "POST", url: `/api/projects/${pid}/specs`, payload: { baseUrl: "https://app.example", validate: false, specs: [spec] } })).statusCode).toBe(202);
            const made = JSON.parse((await app.inject({ method: "POST", url: `/api/projects/${pid}/schedules`, payload: { kind: "validate", cadence: { type: "daily", time: "03:00" } } })).body);
            expect(made.createdBy ?? new ScheduleStore(platform.db).get(made.id)!.createdBy).toBe(OPEN_OWNER_ID);
            writeHeartbeat(platform.db);
            const run = await app.inject({ method: "POST", url: `/api/projects/${pid}/schedules/${made.id}/run` });
            expect(run.statusCode, run.body).toBe(202);
            expect(platform.repo.getJob(JSON.parse(run.body).jobId)!.options.startedBy).toMatchObject({ kind: "schedule", ownerId: OPEN_OWNER_ID });
            platform.db.run("UPDATE generation_jobs SET status = 'COMPLETED' WHERE project_id = ?", pid);
        } finally {
            await app.close();
        }
    });

    it("code scripts follow the owner's switch on their runner as it last reported, online or not", () => {
        const owner = "code-owner";
        platform.db.run("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)", owner, "code@people.example", "Coder", new Date().toISOString(), "owner", "active");
        try {
            const { record } = svc().store.createPersonalToken({ ownerId: owner, label: "Off PC", createdBy: "test" });
            const agent = svc().store.upsertAgent(record, { name: "off-pc", version: "1", capabilities: defaultCaps({ runnerSwitches: true }), concurrency: 1 });
            platform.db.run("UPDATE agents SET last_seen_ms = 0 WHERE id = ?", agent.id);
            expect(customPolicyFor(platform, projectId, owner)).toEqual({ allowed: true });
            svc().store.setTokenSwitches(record.id, { allowCodeScripts: false });
            const off = customPolicyFor(platform, projectId, owner);
            expect(off.allowed).toBe(false);
            expect(!off.allowed && off.message).toMatch(/code scripts are switched off on your runner/);
        } finally {
            platform.db.run("DELETE FROM users WHERE id = ?", owner);
        }
    });

    it("refusal sentences name a person by name only, never by email", () => {
        platform.db.run("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)", "u-mail", "secret.person@people.example", null, new Date().toISOString(), "editor", "active");
        try {
            expect(svc().ownerName("u-mail")).toBe("The owner");
            platform.db.run("UPDATE users SET name = 'Asha' WHERE id = 'u-mail'");
            expect(svc().ownerName("u-mail")).toBe("Asha");
        } finally {
            platform.db.run("DELETE FROM users WHERE id = 'u-mail'");
        }
    });

    it("nobody's run is refused with its own sentence: the shared key's runbook, a runbook resumed after a restart, the open server's schedule once it is no longer open", () => {
        const refusal = (o: Partial<JobOptions>) => {
            try {
                svc().assertJobAllowed(projectId, { ...base, ...o } as JobOptions);
                return "";
            } catch (e) {
                return (e as Error).message;
            }
        };
        expect(refusal({ startedBy: { kind: "key", id: null }, runbookRunId: "rb-1" })).toBe(KEY_HAS_NO_RUNNER);
        expect(refusal({ runbookRunId: "rb-2" })).toBe(RUNBOOK_STARTER_UNKNOWN);
        platform.db.run("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)", "u-later", "later@people.example", "Later", new Date().toISOString(), "owner", "active");
        try {
            expect(refusal({ startedBy: { kind: "schedule", id: "s-open", ownerId: OPEN_OWNER_ID } })).toBe(SCHEDULE_HAS_NO_OWNER);
        } finally {
            platform.db.run("DELETE FROM users WHERE id = 'u-later'");
        }
    });

    it("schedules and trigger tokens the open server made are attributed to it from Activity", () => {
        const at = new Date().toISOString();
        platform.db.run("INSERT INTO schedules (id, project_id, name, kind, cadence_json, enabled, retry_failures, next_run_at, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", "s-open-made", projectId, "Open made", "validate", JSON.stringify({ type: "daily", time: "04:00" }), 0, 1, null, null, at, at);
        platform.db.run("INSERT INTO activity (at, actor_kind, actor_id, actor_name, action, path, project_id, status) VALUES (?,?,?,?,?,?,?,?)", at, "open", null, "Open access", "PATCH /api/projects/:id/schedules/:sid", `/api/projects/${projectId}/schedules/s-open-made`, projectId, 200);
        expect(new ScheduleStore(platform.db).backfillOwners()).toBeGreaterThanOrEqual(1);
        expect(new ScheduleStore(platform.db).get("s-open-made")!.createdBy).toBe(OPEN_OWNER_ID);
        const other = platform.repo.createProject({ name: "Trigger open" }).id as string;
        const triggers = new TriggerStore(platform.db, new SecretBox(tmp, "owner-unit-secret-key-0123456789abc"));
        const { record } = triggers.create(other, { label: "CI" });
        platform.db.run("INSERT INTO activity (at, actor_kind, actor_id, actor_name, action, path, project_id, status) VALUES (?,?,?,?,?,?,?,?)", record.createdAt, "open", null, "Open access", "POST /api/projects/:id/triggers", `/api/projects/${other}/triggers`, other, 201);
        expect(triggers.backfillOwners()).toBe(1);
        expect(triggers.get(record.id)!.createdBy).toBe(OPEN_OWNER_ID);
    });

    it("a runbook linked to a schedule runs as the run's owner: the Run now clicker's runner, with their code tests (round 47)", async () => {
        const at = new Date().toISOString();
        for (const [id, name] of [["u-maker", "Maker"], ["u-clicker", "Clicker"]]) {
            platform.db.run("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)", id, `${id}@people.example`, name, at, "owner", "active");
            const { record } = svc().store.createPersonalToken({ ownerId: id, label: name, createdBy: "test" });
            svc().store.upsertAgent(record, { name: `${id}-pc`, version: "1", capabilities: defaultCaps({ runnerSwitches: true }), concurrency: 1 });
        }
        const pid = platform.repo.createProject({ name: "Runbook owner" }).id as string;
        platform.repo.createApplication(pid, "https://app.example", {});
        svc().store.setRunner(pid, { runOn: "agent", agentId: null });
        const spec = TestSpecSchema.parse({ testId: "API-001", title: "Health", kind: "api", category: "API", priority: "high", steps: [{ action: "request", method: "GET", path: "/health" }, { action: "assertResponse", check: "status", expected: 200 }] });
        const testId = platform.repo.insertTest({ projectId: pid, suiteId: platform.repo.getOrCreateSuite(pid, "API", "api"), jobId: null, spec, framework: "playwright-api", validationStatus: "VALIDATED" });
        platform.db.run("INSERT INTO custom_tests (test_case_id, project_id, origin, since) VALUES (?,?,?,?)", testId, pid, "written", at);
        const runbooks = getRunbookServices(platform);
        const rb = runbooks.store.create(pid, RunbookDefinition.parse({ version: 1, name: "Nightly", steps: [{ id: "tests", type: "run", title: "Run every test", scope: "all", retries: 0 }] }));
        const schedules = getScheduleServices(platform);
        const s = schedules.store.create({ projectId: pid, name: "Nightly", kind: "validate", cadence: { type: "daily", time: "03:00" }, createdBy: "u-maker" });
        runbooks.store.setScheduleLink(s.id, rb.id);
        writeHeartbeat(platform.db);
        const jobOf = async (runId: string) => {
            for (let i = 0; i < 200; i++) {
                const step = runbooks.store.runSteps(runId).find((x) => x.jobId);
                if (step) return platform.repo.getJob(step.jobId!)!;
                const run = runbooks.store.getRun(runId)!;
                if (run.status !== "running") throw new Error(`The run ended: ${run.reason}`);
                await new Promise((r) => setTimeout(r, 20));
            }
            throw new Error("no job");
        };
        const finish = async (runId: string, jobId: string) => {
            runbooks.cancel(runId);
            platform.db.run("UPDATE generation_jobs SET status = 'FAILED', error = 'Cancelled' WHERE id = ?", jobId);
            await runbooks.flush();
        };
        try {
            for (const [clicker, owner] of [["u-clicker", "u-clicker"], [undefined, "u-maker"]] as const) {
                const started = await schedules.runNow(s.id, clicker);
                if (!("runbookRunId" in started)) throw new Error("not a runbook start");
                const job = await jobOf(started.runbookRunId);
                expect(job.options.startedBy).toMatchObject({ kind: "schedule", id: s.id, ownerId: owner });
                expect(job.options.testIds).toEqual([testId]);
                await finish(started.runbookRunId, job.id);
            }
        } finally {
            platform.db.run("DELETE FROM users WHERE id IN ('u-maker', 'u-clicker')");
        }
    });
});

describe("who sees everyone's runners (one rule for GET /api/admin/runners and the page's canSeeEveryone)", () => {
    const everywhere = { allowed: () => null };
    const admin = (permissions: string[]) => ({ kind: "user" as const, id: "u1", name: "Ada", role: "owner" as const, side: "admin" as const, permissions: new Set(permissions) }) as unknown as Actor;
    it("needs the route's permission, a platform admin too", () => {
        expect(seesEveryRunner(everywhere, admin(["ai_studio.runners.manage"]))).toBe(true);
        expect(seesEveryRunner(everywhere, admin([]))).toBe(false);
        expect(seesEveryRunner(everywhere, { kind: "key", name: "Access key", role: "owner" } as Actor)).toBe(false);
    });
});
