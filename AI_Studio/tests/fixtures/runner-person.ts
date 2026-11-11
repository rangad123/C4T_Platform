/**
 * Round 45 helpers for tests that start a real runner from a real download: one runner per person, set up from Settings.
 *  - personToken: a person (an owner) with their own API token, made in the platform's user store (no sign-in page needed).
 *  - downloadRunner: POST /api/me/runner/download as that person, the way Settings, Your runner does.
 *  - myRunner / retireMyRunner: GET /api/me/runner and POST /api/me/runner/retire ("Remove this computer").
 *  - enrollByHand: trade a download's runner.enroll at /api/agent/enroll the way the runner does, and keep the credential in this computer's
 *    store for that folder with the install id in runner.machine (exactly what the runner leaves behind), for tests that need a working
 *    credential before any runner starts (the check).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MACHINE_ID_FILE, saveCredential } from "../../src/agent/credential-store.js";
import { accessControlOf } from "../../src/platform/auth/access.js";

export function personToken(app: object, email = "maya@people.example", name = "Maya"): { id: string; token: string } {
    const users = accessControlOf(app as never).users;
    const person = users.create({ email, name, role: "owner" });
    return { id: person.id, token: users.createToken(person.id, { name: "runner test", role: "owner" }).token };
}

export type Download = { status: number; headers: Headers; buf: Buffer; text: string };

export async function downloadRunner(base: string, token: string, os: "windows" | "mac" | "linux", arch: "x64" | "arm64" = "x64"): Promise<Download> {
    const res = await fetch(`${base}/api/me/runner/download`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ os, arch }) });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, buf, text: buf.toString("utf8") };
}

export type MyRunner = { id: string; name: string; status: string; update?: Record<string, unknown> & { state?: string }; check?: { at: string; items: Array<{ id: string; status: string; title: string }> }; version?: string };

export async function myRunner(base: string, token: string): Promise<MyRunner | null> {
    const res = await fetch(`${base}/api/me/runner`, { headers: { authorization: `Bearer ${token}` } });
    return ((await res.json()) as { runner: MyRunner | null }).runner;
}

/** The person's runner when it is connected (online or busy), else undefined. */
export async function myOnlineRunner(base: string, token: string): Promise<MyRunner | undefined> {
    const r = await myRunner(base, token);
    return r && (r.status === "online" || r.status === "busy") ? r : undefined;
}

export async function retireMyRunner(base: string, token: string): Promise<number> {
    return (await fetch(`${base}/api/me/runner/retire`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).status;
}

/** Switch on private addresses for the person's runner (off by default): needed when the application under test is on this computer. */
export async function allowPrivateAddresses(base: string, token: string): Promise<number> {
    return (await fetch(`${base}/api/me/runner`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ switches: { privateTargets: true } }) })).status;
}

/** Trade the folder's runner.enroll for the person's credential, as the runner would: kept in the store, the code file deleted. Returns the credential. */
export async function enrollByHand(base: string, dir: string, name = "test-computer"): Promise<string> {
    const code = fs.readFileSync(path.join(dir, "runner.enroll"), "utf8").trim();
    const machineId = randomUUID();
    const res = await fetch(`${base}/api/agent/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name, machineId }) });
    const body = (await res.json()) as { token?: string; error?: string };
    if (!res.ok || !body.token) throw new Error(`enroll failed (${res.status}): ${body.error ?? ""}`);
    fs.writeFileSync(path.join(dir, MACHINE_ID_FILE), `${machineId}\n`);
    await saveCredential(dir, body.token);
    fs.rmSync(path.join(dir, "runner.enroll"));
    return body.token;
}
