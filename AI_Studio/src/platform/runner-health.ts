/**
 * One runner per person (round 45, docs/features/runner-settings.md): who may have a runner, who may change one, and the views of
 * GET /api/me/runner and the admins' list GET /api/admin/runners. Reads only; the rows live in agent-store.ts. A runner here is one person's
 * credential; what it reported about itself comes from the computer that connected with it most recently.
 */
import { permissionsOf, sideOf, type Actor } from "./auth/actor.js";
import type { ProjectScope } from "./auth/project-scope.js";
import type { AgentRecord, AgentStore, AgentTokenRecord } from "./agent-store.js";
import { ONLINE_MS } from "./agent-store.js";
import { redactCredentials } from "../engine/net/company-network.js";

export const RUNNER_NOT_FOUND = "Runner not found";
export const RUNNER_RETIRED = "This runner was removed. Set up your runner again in Settings.";
export const CANNOT_HAVE_RUNNER = "Setting up a runner needs permission to run tests in at least one project.";
export const KEY_CANNOT_HAVE_RUNNER = "Sign in with your own account to set up your runner.";

/** Crowd4Test admins, and on a server without Crowd4Test sign-in its owners (people holding platform settings). */
export function isPlatformAdmin(actor: Actor): boolean {
    const side = sideOf(actor);
    return side === "admin" || (side === "local" && permissionsOf(actor).has("ai_studio.platform.settings"));
}

/** A person's runner is changed (renamed, switched, removed) by that person; platform admins may remove it (its switches stay the owner's). */
export const canManagePersonal = (actor: Actor, t: Pick<AgentTokenRecord, "ownerId">): boolean => (actor.kind === "user" && Boolean(actor.id) && actor.id === t.ownerId) || isPlatformAdmin(actor);

/** May this actor see every person's runner (GET /api/admin/runners) and remove one? Platform admins, and people who manage runners everywhere. */
export function seesEveryRunner(scope: Pick<ProjectScope, "allowed">, actor: Actor): boolean {
    if (actor.kind !== "user") return false;
    if (isPlatformAdmin(actor)) return true;
    if (!permissionsOf(actor).has("ai_studio.runners.manage")) return false;
    const side = sideOf(actor);
    return side !== "customer" && side !== "tester" && scope.allowed(actor) === null;
}

/**
 * May this person have a runner? Anyone signed in as a person who may run tests in at least one project they can open, Crowd4Test
 * testers included; on an open server, the open server itself (it acts as one person). The shared access key is no person.
 */
export function mayHaveRunner(scope: Pick<ProjectScope, "allowed" | "permissionsIn">, actor: Actor): boolean {
    if (actor.kind === "open") return true;
    if (actor.kind !== "user" || !actor.id) return false;
    if (!permissionsOf(actor).has("ai_studio.tests.run")) return false;
    const here = scope.allowed(actor);
    if (here === null) return true;
    for (const projectId of here.keys()) if (scope.permissionsIn(actor, projectId)?.has("ai_studio.tests.run")) return true;
    return false;
}

export type RunnerState = "online" | "busy" | "offline";

/** One sentence about how the runner reaches the platform: its last network problem, else its proxy. Never a sign-in. */
export function networkSentence(a: AgentRecord | undefined): string | undefined {
    const n = a?.capabilities.network;
    if (!n) return undefined;
    if (n.problem) return redactCredentials(n.problem);
    if (n.proxy) return `It connects through the proxy ${n.proxy}${n.proxyTests ? ", and tests go through it too" : ""}.`;
    return undefined;
}

/** The state of a person's runner from its latest computer: busy while a task of it runs. */
export function runnerState(store: Pick<AgentStore, "runningCount">, latest: AgentRecord | undefined, now: number): RunnerState {
    if (!latest || now - latest.lastSeenMs > ONLINE_MS) return "offline";
    return store.runningCount(latest.id) > 0 ? "busy" : "online";
}

/** The check report as shown (lines masked once more in case a sign-in slipped into one). */
export function checkView(a: AgentRecord | undefined) {
    const c = a?.capabilities.check;
    return c ? { at: c.at, items: c.items.map((i) => ({ ...i, title: redactCredentials(i.title), ...(i.fix ? { fix: redactCredentials(i.fix) } : {}) })) } : undefined;
}

/** The name builder A's download route uses (routes/runner-kits.ts): the same rule as mayHaveRunner. */
export const canAddPersonal = mayHaveRunner;
