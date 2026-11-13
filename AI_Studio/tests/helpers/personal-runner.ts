/**
 * Round 45: the only runner there is, a person's own, for tests that need one. By default it belongs to the test's person (testPerson) or,
 * without one, to the open server (OPEN_OWNER_ID: a platform started without API_KEY and without accounts acts as one person, so every run
 * started there is that runner's). Private addresses are switched on (the stand-in applications of the tests listen on 127.0.0.1), and
 * code scripts on.
 */
import { getAgentServices } from "../../src/platform/agent-services.js";
import { OPEN_OWNER_ID } from "../../src/platform/agent-store.js";
import type { Platform } from "../../src/platform/bootstrap.js";
import { randomUUID } from "node:crypto";
import { secretBoxOf } from "../../src/platform/ai-config.js";
import { UserStore } from "../../src/platform/user-store.js";

let defaultOwner: string | undefined;

/** The owner personalRunner uses when none is named: the test's person, or the open server. */
export const runOwner = (): string => defaultOwner ?? OPEN_OWNER_ID;

/**
 * A person (an owner of this server) with a personal API token, for a test whose platform keeps its API_KEY: runs started with the server's
 * shared key have no owner (round 45), so the test acts as this person instead, and their runner takes the runs. Since round 57 their AI work
 * uses their own chosen key, never the server's: they get a personal key with the server's own AI settings (the tests' scripted model).
 */
export function testPerson(p: Platform, role: "owner" | "editor" | "viewer" = "owner"): { id: string; token: string } {
    const users = new UserStore(p.db);
    const id = users.create({ email: `runner-owner-${Math.random().toString(36).slice(2, 8)}@people.example`, name: "Runner owner", role }).id;
    defaultOwner = id;
    const keyId = randomUUID();
    const now = new Date().toISOString();
    p.db.run(
        "INSERT INTO ai_configurations (id, owner_kind, owner_person_id, label, provider, model, base_url, key_enc, key_hint, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        keyId, "personal", id, "Test key", p.config.LLM_PROVIDER, p.config.LLM_MODEL ?? "test-model", p.config.LLM_BASE_URL ?? null, secretBoxOf(p.config).encrypt("test-person-key"), "-key", "working", "test", now, now,
    );
    p.db.run("INSERT INTO ai_key_choices (person_id, key_id, updated_at) VALUES (?,?,?)", id, keyId, now);
    return { id, token: users.createToken(id, { name: "test", role }).token };
}

export function personalRunner(p: Platform, o: { ownerId?: string; label?: string; privateTargets?: boolean; codeScripts?: boolean; realPhone?: boolean; machineId?: string; replace?: boolean } = {}): { secret: string; id: string } {
    const store = getAgentServices(p).store;
    const ownerId = o.ownerId ?? runOwner();
    // As setting up a computer does, it replaces the person's earlier runner (one runner per person).
    const { secret, record } = store.createPersonalToken({ ownerId, label: o.label ?? "Test runner", createdBy: "test", ...(o.machineId ? { machineId: o.machineId } : {}) });
    store.setTokenSwitches(record.id, { allowPrivateTargets: o.privateTargets ?? true, allowCodeScripts: o.codeScripts ?? true, allowRealPhone: o.realPhone ?? false });
    return { secret, id: record.id };
}
