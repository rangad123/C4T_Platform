/**
 * Round 45: the only runner there is, a person's own, for tests that need one. By default it belongs to the test's person (testPerson) or,
 * without one, to the open server (OPEN_OWNER_ID: a platform started without API_KEY and without accounts acts as one person, so every run
 * started there is that runner's). Private addresses are switched on (the stand-in applications of the tests listen on 127.0.0.1), and
 * code scripts on.
 */
import { getAgentServices } from "../../src/platform/agent-services.js";
import { OPEN_OWNER_ID } from "../../src/platform/agent-store.js";
import type { Platform } from "../../src/platform/bootstrap.js";
import { UserStore } from "../../src/platform/user-store.js";

let defaultOwner: string | undefined;

/** The owner personalRunner uses when none is named: the test's person, or the open server. */
export const runOwner = (): string => defaultOwner ?? OPEN_OWNER_ID;

/**
 * A person (an owner of this server) with a personal API token, for a test whose platform keeps its API_KEY: runs started with the server's
 * shared key have no owner (round 45), so the test acts as this person instead, and their runner takes the runs.
 */
export function testPerson(p: Platform, role: "owner" | "editor" | "viewer" = "owner"): { id: string; token: string } {
    const users = new UserStore(p.db);
    const id = users.create({ email: `runner-owner-${Math.random().toString(36).slice(2, 8)}@people.example`, name: "Runner owner", role }).id;
    defaultOwner = id;
    return { id, token: users.createToken(id, { name: "test", role }).token };
}

export function personalRunner(p: Platform, o: { ownerId?: string; label?: string; privateTargets?: boolean; codeScripts?: boolean; realPhone?: boolean; machineId?: string; replace?: boolean } = {}): { secret: string; id: string } {
    const store = getAgentServices(p).store;
    const ownerId = o.ownerId ?? runOwner();
    // As setting up a computer does: the person's earlier runner is retired (one runner per person).
    if (o.replace) store.retireOtherPersonal(ownerId, null);
    const { secret, record } = store.createPersonalToken({ ownerId, label: o.label ?? "Test runner", createdBy: "test", ...(o.machineId ? { machineId: o.machineId } : {}) });
    store.setTokenSwitches(record.id, { allowPrivateTargets: o.privateTargets ?? true, allowCodeScripts: o.codeScripts ?? true, allowRealPhone: o.realPhone ?? false });
    return { secret, id: record.id };
}
