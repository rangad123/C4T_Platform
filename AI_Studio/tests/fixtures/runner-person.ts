/**
 * Round 45 helpers for tests that start a real runner from a real download: one runner per person, set up from Settings.
 *  - personToken: a person (an owner) with their own API token, made in the platform's user store (no sign-in page needed).
 *  - downloadRunner: POST /api/me/runner/download as that person, the way Settings, Your runner does.
 *  - splitStampedExe: the one-file Windows download taken apart (program, kit zip, format).
 *  - splitLinuxScript: the one-file Linux download taken apart (the sh header, and each file of its gzip tar with its mode), read here
 *    without the server's writer so the format is checked independently.
 *  - splitMacPkg: the one-file Mac download (round 55, an installer package) taken apart with scripts/mac-pkg-read.mjs, which checks every
 *    checksum: its package files, Scripts' files, and each file of the shared kit.zip as "kit.zip/<name>", with modes.
 *  - myRunner / retireMyRunner: GET /api/me/runner and POST /api/me/runner/retire ("Remove this computer").
 *  - enrollByHand: trade a download's runner.enroll at /api/agent/enroll the way the runner does, and keep the credential in this computer's
 *    store for that folder with the install id in runner.machine (exactly what the runner leaves behind), for tests that need a working
 *    credential before any runner starts (the check).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { unzipSync } from "fflate";
import { MACHINE_ID_FILE, saveCredential } from "../../src/agent/credential-store.js";
// @ts-expect-error plain JavaScript reader (no type declarations)
import { readMacPkg } from "../../scripts/mac-pkg-read.mjs";
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

/** A one-file Windows download (round 49) taken apart: the program, the kit zip after it, and the footer's format (runner-installer.ts buildInstallerExe). Undefined without the footer. */
export function splitStampedExe(b: Uint8Array): { program: Buffer; payload: Buffer; format: number } | undefined {
    const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
    if (buf.length < 16 || buf.toString("latin1", buf.length - 8) !== "AITP-KIT") return undefined;
    const len = buf.readUInt32LE(buf.length - 16);
    return { program: buf.subarray(0, buf.length - 16 - len), payload: buf.subarray(buf.length - 16 - len, buf.length - 16), format: buf.readUInt32LE(buf.length - 12) };
}

export function splitLinuxScript(b: Uint8Array): { header: string; files: Record<string, Buffer>; modes: Record<string, number> } | undefined {
    const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
    const m = /^AITP_SKIP=(\d+)$/m.exec(buf.subarray(0, 64 * 1024).toString("latin1"));
    if (!buf.subarray(0, 10).toString("latin1").startsWith("#!/bin/sh") || !m) return undefined;
    const start = Number(m[1]) - 1;
    const tar = zlib.gunzipSync(buf.subarray(start));
    const files: Record<string, Buffer> = {};
    const modes: Record<string, number> = {};
    const field = (h: Buffer, at: number, len: number) => h.subarray(at, at + len).toString("utf8").replace(/\0.*$/s, "");
    let pax: string | undefined;
    for (let at = 0; at + 512 <= tar.length; ) {
        const h = tar.subarray(at, at + 512);
        if (h.every((x) => x === 0)) break;
        const size = parseInt(field(h, 124, 12), 8);
        const type = field(h, 156, 1) || "0";
        const data = tar.subarray(at + 512, at + 512 + size);
        at += 512 + Math.ceil(size / 512) * 512;
        if (type === "x") {
            pax = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"))?.[1];
            continue;
        }
        const prefix = field(h, 345, 155);
        const name = pax ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
        pax = undefined;
        files[name] = Buffer.from(data);
        modes[name] = parseInt(field(h, 100, 8), 8);
    }
    return { header: buf.subarray(0, start).toString("utf8"), files, modes };
}

/** A Mac package download taken apart; undefined when it is not a xar archive. */
export function splitMacPkg(b: Uint8Array): { files: Record<string, Buffer>; modes: Record<string, number>; distribution: string } | undefined {
    const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
    if (buf.toString("latin1", 0, 4) !== "xar!") return undefined;
    const pkg = readMacPkg(buf) as { distribution: string; packageInfo: string; toc: string; scripts: Record<string, { mode: number; data: Buffer }> };
    const files: Record<string, Buffer> = { Distribution: Buffer.from(pkg.distribution), PackageInfo: Buffer.from(pkg.packageInfo), TOC: Buffer.from(pkg.toc) };
    const modes: Record<string, number> = {};
    for (const [name, e] of Object.entries(pkg.scripts)) {
        if (name === ".") continue;
        files[name] = e.data;
        modes[name] = e.mode & 0o777;
    }
    for (const [name, data] of Object.entries(unzipSync(new Uint8Array(pkg.scripts["kit.zip"]!.data)))) files[`kit.zip/${name}`] = Buffer.from(data);
    return { files, modes, distribution: pkg.distribution };
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
