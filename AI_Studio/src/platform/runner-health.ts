/**
 * The runners as machines: who may see and manage each one, and what the Runners pages and the Dashboard show about their health.
 * Reads only; the rows live in agent-store.ts. A runner here is one registration (a token); what it reported about itself comes from the
 * machine that connected with that token most recently.
 *
 * What another project's people must not learn stays out: work and failures of a project the person cannot reach have no name and no error text.
 */
import { accessControlOf, actorOf } from "./auth/access.js";
import { currentActor, permissionsOf, sideOf, type Actor } from "./auth/actor.js";
import { HttpError } from "./http-error.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ProjectScope } from "./auth/project-scope.js";
import type { AgentRecord, AgentStore, AgentTokenRecord, DeviceReservation, HealthTask } from "./agent-store.js";
import { isSharedToken, MAX_PERSONAL_RUNNERS, MAX_RUNNERS_PER_ORGANIZATION, ONLINE_MS, runnerMayServe } from "./agent-store.js";
import { isDeviceAdapter } from "./agent-device.js";
import { isRecordAdapter } from "./agent-record.js";

export const CANNOT_MANAGE_RUNNER = "You can't change this runner. Managing a runner needs “manage runners”, and a customer manages only their organisation's runners.";
export const RUNNER_NOT_FOUND = "Runner not found";
export const OTHER_ORGANIZATION_RUNNER = "This runner belongs to another organisation, so it can't serve this project.";
export const RUNNER_RETIRED = "This runner is retired. Register a new one.";

export { MAX_RUNNERS_PER_ORGANIZATION };
export const RUNNER_CAP_REACHED = `This organisation has ${MAX_RUNNERS_PER_ORGANIZATION} runners already, the most it can have. Retire one first.`;

/**
 * Before any new runner token is made, from wherever (the Runners page, a project's token list, a runner kit download): the same rule as the
 * Runners page, and room under the cap. A task offer carries the project's credentials, so a token is never for someone who may not see them.
 */
export function assertMayAddRunner(app: FastifyInstance, req: FastifyRequest, store: Pick<AgentStore, "countLiveRunnersOf">, organizationId: string | null): void {
    const actor = actorOf(req) ?? currentActor();
    if (!canManageRunner(accessControlOf(app).projects, actor, organizationId)) throw new HttpError(403, CANNOT_MANAGE_RUNNER);
    if (store.countLiveRunnersOf(organizationId) >= MAX_RUNNERS_PER_ORGANIZATION) throw new HttpError(409, RUNNER_CAP_REACHED);
}

export const CANNOT_MANAGE_PERSONAL = "Only the person whose computer this is can change it.";
export const PERSONAL_CAP_REACHED = `You have added ${MAX_PERSONAL_RUNNERS} computers already, the most one person can have. Retire one on the Runners page first.`;
export const CANNOT_ADD_PERSONAL = "Adding your own computer needs permission to run tests in at least one project.";
export const PERSONAL_NOT_GRANTED = "A person's own computer runs only the runs its owner starts. It is not given to projects.";

/** Crowd4Test admins, and on a server without Crowd4Test sign-in its owners (people holding platform settings). */
export function isPlatformAdmin(actor: Actor): boolean {
    const side = sideOf(actor);
    return side === "admin" || (side === "local" && permissionsOf(actor).has("ai_studio.platform.settings"));
}

/** A person's own computer is changed (renamed, switched, retired) by that person; platform admins may rename and retire it (its switches stay the owner's, routes/runners.ts). */
export const canManagePersonal = (actor: Actor, t: Pick<AgentTokenRecord, "ownerId">): boolean => (actor.kind === "user" && Boolean(actor.id) && actor.id === t.ownerId) || isPlatformAdmin(actor);

/** May this person change this runner? A personal runner: its owner (and platform admins); a team runner: canManageRunner. */
export const canManage = (scope: Pick<ProjectScope, "allowed">, actor: Actor, t: Pick<AgentTokenRecord, "kind" | "ownerId" | "organizationId">): boolean =>
    t.kind === "personal" ? canManagePersonal(actor, t) : canManageRunner(scope, actor, t.organizationId);

/**
 * May this person add their own computer? Anyone signed in as a person who may run tests in at least one project they can open, Crowd4Test
 * testers included (decision of round 39). The access key and open access are no person, so they add team runners only.
 */
export function canAddPersonal(scope: Pick<ProjectScope, "allowed" | "permissionsIn">, actor: Actor): boolean {
    if (actor.kind !== "user" || !actor.id) return false;
    if (!permissionsOf(actor).has("ai_studio.tests.run")) return false;
    const here = scope.allowed(actor);
    if (here === null) return true;
    for (const projectId of here.keys()) if (scope.permissionsIn(actor, projectId)?.has("ai_studio.tests.run")) return true;
    return false;
}

/** Registering, renaming, retiring and giving access: a customer in their own organisation; Crowd4Test staff and people with every project anywhere. */
export function canManageRunner(scope: Pick<ProjectScope, "allowed">, actor: Actor, organizationId: string | null): boolean {
    if (!permissionsOf(actor).has("ai_studio.runners.manage")) return false;
    const side = sideOf(actor);
    if (side === "customer") return Boolean(actor.organizationId) && organizationId === actor.organizationId;
    if (side === "tester") return false;
    if (side === "admin") return true;
    return scope.allowed(actor) === null;
}

/** A runner may serve a project of its own organisation; Crowd4Test's shared machines may serve any. */
export const mayServe = (runnerOrg: string | null, projectOrg: string | null): boolean => runnerOrg === null || runnerOrg === projectOrg;
/** The same, knowing the runner: a person's own computer is never given to projects; a runner made from a project of no organisation serves only it. */
export { runnerMayServe };

export type RunnerStatus = "online" | "busy" | "offline" | "not-connected" | "retired";

export interface Reach {
    actor: Actor;
    /** The projects the person may see; null: all of them. */
    visible: ReadonlyMap<string, unknown> | null;
    projects: Map<string, { name: string; organizationId: string | null }>;
    organizations: Map<string, string | null>;
    now: number;
    /** A person's name by their id (who owns a personal runner); absent: not shown. */
    personName?: (id: string) => string | null;
}

const reaches = (r: Reach, projectId: string) => (!r.visible || r.visible.has(projectId)) && r.projects.has(projectId);

/** Everyone with every project sees every runner; a customer sees their organisation's; anyone sees a runner serving a project they can reach. */
export function seesRunner(store: AgentStore, r: Reach, t: AgentTokenRecord): boolean {
    // A person's own computer: its owner and platform admins, nobody else (another person's runner is "not found").
    if (t.kind === "personal") return canManagePersonal(r.actor, t);
    if (sideOf(r.actor) === "customer" && r.actor.organizationId && t.organizationId === r.actor.organizationId) return true;
    if (sideOf(r.actor) !== "customer" && !r.visible) return true;
    return store.projectsOf(t.id).some((p) => reaches(r, p.projectId));
}

const device = (family: "android" | "ios", key: string, name: string, state: string, emulator: boolean) => ({ family, key, name, state, emulator });

/** What the machine reported: its phones, emulators and simulators. */
function devicesOf(a: AgentRecord | undefined) {
    const c = a?.capabilities;
    const android = (c?.android?.devices ?? []).map((d) => device("android", d.serial, d.model ?? d.serial, d.state, d.emulator));
    const avds = (c?.android?.avds ?? []).map((n) => device("android", `avd:${n}`, n, "available", true));
    const ios = (c?.ios?.simulators ?? []).map((n) => device("ios", n.replace(/\s*\([^)]*\)\s*$/, ""), n, "available", true));
    return [...android, ...avds, ...ios];
}

const kindOf = (adapterId: string) => (isRecordAdapter(adapterId) ? "Recording" : isDeviceAdapter(adapterId) ? "Phone session" : adapterId === "taqwright" ? "Phone tests" : adapterId === "taqwright-ios" ? "iOS tests" : adapterId === "windows-uia" ? "Windows desktop tests" : "Web and API tests");

/** The agent as shown, without the serials of its phones when the viewer is limited. */
function withoutSerials<A>(a: A, limited: boolean): A {
    const android = (a as { capabilities?: { android?: { devices?: Array<Record<string, unknown>> } } }).capabilities?.android;
    if (!limited || !android?.devices) return a;
    const devices = android.devices.map(({ serial: _serial, ...rest }) => rest);
    const caps = (a as { capabilities: Record<string, unknown> }).capabilities;
    return { ...a, capabilities: { ...caps, android: { ...android, devices } } } as A;
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

export interface HealthInput {
    tasks: HealthTask[];
    reservations: DeviceReservation[];
}

export function healthInput(store: AgentStore): HealthInput {
    store.releaseDevices();
    return { tasks: store.tasksForHealth(), reservations: store.reservations() };
}

/** One runner as the lists show it. `publicAgent` is the machine's own report in the shape the project page uses. */
export function runnerView<A>(store: AgentStore, r: Reach, t: AgentTokenRecord, input: HealthInput, scope: Pick<ProjectScope, "allowed">, publicAgent: (a: AgentRecord & { online: boolean; activeTasks: number }) => A) {
    const machines = store.agentsOfToken(t.id);
    const latest = machines[0];
    const ids = new Set(machines.map((m) => m.id));
    const running = input.tasks.filter((x) => x.status === "running" && x.agentId && ids.has(x.agentId));
    const online = !t.revokedAt && !!latest && r.now - latest.lastSeenMs <= ONLINE_MS;
    const status: RunnerStatus = t.revokedAt ? "retired" : !latest ? "not-connected" : !online ? "offline" : running.length ? "busy" : "online";
    const access = store.projectsOf(t.id);
    const served = new Set(access.map((a) => a.projectId));
    // A shared runner (no organisation) serves many customers: someone who does not see every project sees only their own projects' queue and
    // waits there, and no device serials (a serial names a physical phone).
    const limited = isSharedToken(t) && r.visible !== null;
    const mine = (projectId: string) => !limited || reaches(r, projectId);
    const queued = input.tasks.filter((x) => x.status === "queued" && served.has(x.projectId) && mine(x.projectId));
    const waits = input.tasks.filter((x) => x.agentId && ids.has(x.agentId) && x.claimedMs && mine(x.projectId)).map((x) => x.claimedMs! - x.createdMs);
    const failed = input.tasks.filter((x) => x.status === "failed" && x.agentId && ids.has(x.agentId));
    const held = input.reservations.filter((x) => ids.has(x.agentId));
    const projectName = (id: string) => (reaches(r, id) ? (r.projects.get(id)?.name ?? null) : null);
    const heldBy = (family: string, key: string) => held.find((x) => x.family === family && (x.device === key || x.device === "*"));
    return {
        id: t.id,
        name: t.label ?? latest?.name ?? "Unnamed runner",
        machineName: latest?.name ?? null,
        hint: `aitg_…${t.hint}`,
        organizationId: t.organizationId,
        ownerName: t.kind === "personal" ? (t.ownerId && r.actor.id === t.ownerId ? "You" : ((t.ownerId && r.personName?.(t.ownerId)) ?? "A person")) : t.organizationId ? (r.organizations.get(t.organizationId) ?? "Your organisation") : t.projectId ? (projectName(t.projectId) ? `Project “${projectName(t.projectId)}”` : "One project") : "Crowd4Test (shared)",
        status,
        canManage: canManage(scope, r.actor, t),
        // Migration 51: whose it is, and what its switches allow (a team runner's private addresses are always allowed, as before).
        kind: t.kind,
        mine: t.kind === "personal" && r.actor.kind === "user" && Boolean(r.actor.id) && r.actor.id === t.ownerId,
        settings: {
            // A Crowd4Test shared runner never runs code scripts, whatever its start command says.
            codeScripts: t.kind === "personal" ? t.allowCodeScripts : !isSharedToken(t) && (t.allowCodeScripts || latest?.capabilities.customScripts === true),
            codeScriptsSwitch: t.kind === "personal" || t.organizationId !== null || t.projectId !== null,
            privateAddresses: t.allowPrivateTargets,
            privateAddressesSwitch: t.kind === "personal",
            realPhone: t.allowRealPhone,
            realPhoneSwitch: t.kind === "personal",
        },
        machine: latest ? { os: latest.os, osVersion: latest.osVersion ?? latest.capabilities.osVersion ?? null, arch: latest.arch, memoryMb: latest.capabilities.memoryMb ?? null, cpus: latest.capabilities.cpus ?? null, playwrightVersion: latest.capabilities.playwrightVersion ?? null, agentVersion: latest.version, bound: Boolean(t.machineId) } : null,
        createdAt: t.createdAt,
        retiredAt: t.revokedAt,
        lastSeenAt: iso(latest?.lastSeenMs),
        version: latest?.version ?? null,
        agent: latest ? withoutSerials(publicAgent({ ...latest, online, activeTasks: running.length }), limited) : null,
        devices: devicesOf(latest).map((d, i) => {
            const lock = heldBy(d.family, d.key);
            const shown = limited && d.family === "android" && !d.key.startsWith("avd:") ? { ...d, key: `device-${i + 1}`, name: d.name === d.key ? "Android phone" : d.name } : d;
            return { ...shown, heldBy: lock ? { projectName: projectName(lock.projectId), sinceAt: iso(lock.reservedMs) } : null };
        }),
        currentTasks: running.map((x) => ({ kind: kindOf(x.adapterId), projectId: reaches(r, x.projectId) ? x.projectId : null, jobId: reaches(r, x.projectId) ? (x.jobId ?? null) : null, projectName: projectName(x.projectId), startedAt: iso(x.claimedMs), done: x.done, total: x.total })),
        queue: { waiting: queued.length, oldestWaitMs: queued.length ? Math.max(...queued.map((x) => r.now - x.createdMs)) : 0, averageWaitMs: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : null },
        recentFailures: {
            count: failed.length,
            items: failed.slice(0, 5).map((x) => ({ at: iso(x.finishedMs), kind: kindOf(x.adapterId), projectName: projectName(x.projectId), error: reaches(r, x.projectId) ? x.error : null })),
        },
        projects: access.filter((a) => reaches(r, a.projectId)).map((a) => ({ id: a.projectId, name: r.projects.get(a.projectId)!.name, grantedBy: a.grantedBy, grantedAt: a.grantedAt })),
        otherProjects: access.filter((a) => !reaches(r, a.projectId) && r.projects.has(a.projectId)).length,
    };
}

export type RunnerView = ReturnType<typeof runnerView<unknown>>;

/** The Dashboard's summary of the runners a person may see. */
export function runnerSummary(views: RunnerView[], tasks: HealthTask[], r: Reach) {
    const live = views.filter((v) => v.status !== "retired");
    const count = (s: RunnerStatus) => live.filter((v) => v.status === s).length;
    const queued = tasks.filter((x) => x.status === "queued" && reaches(r, x.projectId));
    const waits = live.flatMap((v) => (v.queue.averageWaitMs === null ? [] : [v.queue.averageWaitMs]));
    const browsers = new Set<string>();
    for (const v of live) if (v.status === "online" || v.status === "busy") for (const b of ((v.agent as { capabilities?: { browsers?: string[] } } | null)?.capabilities?.browsers ?? [])) browsers.add(b);
    const devices = live.filter((v) => v.status === "online" || v.status === "busy").flatMap((v) => v.devices);
    return {
        total: live.length,
        online: count("online"),
        busy: count("busy"),
        offline: count("offline") + count("not-connected"),
        browsers: [...browsers].sort(),
        phones: devices.filter((d) => d.family === "android" && d.state === "device").length,
        simulators: devices.filter((d) => d.family === "ios").length,
        waiting: queued.length,
        oldestWaitMs: queued.length ? Math.max(...queued.map((x) => r.now - x.createdMs)) : 0,
        averageWaitMs: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : null,
        recentFailures: live.reduce((n, v) => n + v.recentFailures.count, 0),
    };
}
