/**
 * Enrollment codes (docs/features/runner-personal.md): the website makes a one-time code for "this person's computer" or for a team runner,
 * a download carries it (runner.enroll) or the person types it into a command, and the runner trades it once for its own credential.
 * The code lives only in the panel's state: never in storage, the address bar or the console.
 */
import { api } from "../../api.js";
import type { EnrollScope } from "../agents/kit.js";

/** POST /api/runners/enroll → the code (shown once) and when it stops working; `id` names its record. */
export interface Enrollment {
    id?: string;
    code: string;
    expiresAt: string;
}

/** GET /api/runners/enrollments/:id: whether the runner has traded the code yet, and the runner it became (when the person may see it). */
export interface EnrollmentState {
    id: string;
    status: "waiting" | "used" | "expired";
    expiresAt: string;
    runnerId: string | null;
    runner?: { id: string; name: string; status: string };
}

/** A code works for 30 minutes, once. */
export const CODE_LIFE_MS = 30 * 60_000;

export function makeEnrollment(scope: EnrollScope, label: string): Promise<Enrollment> {
    const body = scope.kind === "personal" ? { kind: "personal", label } : { kind: "team", label, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}), projectIds: scope.projectIds };
    return api<Enrollment>("/runners/enroll", { method: "POST", body });
}

/** "14:32", in the person's own clock. */
export const clockTime = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** How long the code still works, in whole minutes (rounded up), or that it has expired. */
export function codeLife(expiresAt: string, now = Date.now()): { expired: boolean; minutes: number; text: string } {
    const left = Date.parse(expiresAt) - now;
    if (!Number.isFinite(left) || left <= 0) return { expired: true, minutes: 0, text: "This code has expired. Make a new one." };
    const minutes = Math.max(1, Math.ceil(left / 60_000));
    return { expired: false, minutes, text: `The code works once, until ${clockTime(expiresAt)} (${minutes === 1 ? "1 more minute" : `${minutes} more minutes`}).` };
}

/** The command for a developer's checkout of AI Studio (after npm install): it enrolls with the code, keeps the credential and starts. */
export function enrollCommand(origin: string, code: string): string {
    return `node bin/ai-test-agent.mjs --url ${origin} --enroll ${code}`;
}

/**
 * Which runner is the one that just enrolled: a runner the list did not have before the code was made, preferring the name the person typed.
 * Enrollment makes a new runner, so anything already listed is never it.
 */
export function findEnrolled<T extends { id: string; name: string; status: string }>(runners: T[], opts: { before: ReadonlySet<string>; name: string }): T | null {
    const fresh = runners.filter((r) => !opts.before.has(r.id) && (r.status === "online" || r.status === "busy"));
    const wanted = opts.name.trim().toLowerCase();
    return fresh.find((r) => r.name.trim().toLowerCase() === wanted) ?? fresh[0] ?? null;
}
