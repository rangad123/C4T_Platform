/**
 * A stored secret is only sent where it was entered for. Secrets are write-only (no answer carries them), so a person who may change a
 * connection's settings but never saw its password must not be able to point the connection somewhere else, keep the stored password,
 * and have the platform send it there with the next check. The issue trackers, Sentry, AI configurations and shared integrations already
 * refuse that; these are the three connections that did not: an alert channel's own mail server, an Appium device farm, and the test
 * mailbox (IMAP). Ports 8600 and 8601 (two local SMTP servers: the one the password was entered for, and another one).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { getScheduleServices } from "../src/platform/schedule-services.js";
import { buildServer } from "../src/platform/server.js";
import { startFakeSmtp, type FakeSmtp } from "./fixtures/fake-smtp.js";

const ENTERED_PORT = 8600;
const OTHER_PORT = 8601;
const SMTP_USER = "follow-smtp-user";
const SMTP_PASS = "Follow-Smtp-Sentinel-5d1e";
const FARM_KEY = "follow-farm-access-key-8c2a";
const IMAP_PASS = "Follow-Imap-Sentinel-77f0";

let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let entered: FakeSmtp;
let other: FakeSmtp;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-secret-follows-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SCHEDULER_ENABLED: "false", SECRET_KEY: "test-secret-key-0123456789" }));
    getScheduleServices(platform, { delivery: { backoffMs: [5], timeoutMs: 2_000 } });
    server = await buildServer(platform);
    entered = await startFakeSmtp(ENTERED_PORT);
    other = await startFakeSmtp(OTHER_PORT);
}, 30_000);

afterAll(async () => {
    await entered?.close();
    await other?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, raw: res.body };
};
const newProject = (name: string) => {
    const project = platform.repo.createProject({ name });
    platform.repo.createApplication(project.id, "https://shop.example.test", { ...DEFAULT_JOB_OPTIONS });
    return project.id;
};

describe("an alert channel's own mail server", () => {
    it("needs the password again when the server changes, so the stored one never reaches another server", async () => {
        const id = newProject("Mail moves");
        const made = await call("POST", `/api/projects/${id}/alert-channels`, { kind: "email", recipients: ["qa@example.test"], smtp: { host: "127.0.0.1", port: ENTERED_PORT, from: "alerts@platform.test", username: SMTP_USER, password: SMTP_PASS } });
        expect(made.status).toBe(201);
        const url = `/api/projects/${id}/alert-channels/${made.body.id}`;

        // Another port (or host) without the password: refused, nothing changed.
        const moved = await call("PATCH", url, { smtp: { port: OTHER_PORT } });
        expect(moved.status).toBe(400);
        expect(moved.body.error).toMatch(/only sent where it was entered for/);
        const hostMoved = await call("PATCH", url, { smtp: { host: "localhost" } });
        expect(hostMoved.status).toBe(400);
        // Turning encryption off is a move too: the password would cross the network in the clear.
        expect((await call("PATCH", url, { smtp: { secure: true } })).status).toBe(200);
        expect((await call("PATCH", url, { smtp: { secure: false } })).status).toBe(400);

        const sent = await call("POST", `${url}/test`);
        expect(sent.status).toBe(200);
        expect(other.mails).toHaveLength(0);
        expect(other.commands.join("\n")).not.toContain(Buffer.from(`\u0000${SMTP_USER}\u0000${SMTP_PASS}`).toString("base64"));

        // The sender, the recipients or the user name alone keep the stored password; a new server with its password is fine.
        expect((await call("PATCH", url, { smtp: { from: "alerts2@platform.test" } })).status).toBe(200);
        expect((await call("PATCH", url, { smtp: { port: OTHER_PORT, secure: false, password: "a-new-password-1" } })).status).toBe(200);
        // A server that needs no login has no password to follow it.
        const open = await call("POST", `/api/projects/${id}/alert-channels`, { kind: "email", recipients: ["qa@example.test"], smtp: { host: "127.0.0.1", port: ENTERED_PORT, from: "alerts@platform.test" } });
        expect((await call("PATCH", `/api/projects/${id}/alert-channels/${open.body.id}`, { smtp: { port: OTHER_PORT } })).status).toBe(200);
    });
});

describe("an Appium device farm", () => {
    it("needs the access key again when the server's address moves to another site", async () => {
        const id = newProject("Farm moves");
        const made = await call("POST", `/api/projects/${id}/device-farms`, { provider: "appium", label: "Lab", hubUrl: "https://farm-a.example.test/wd/hub", devices: [{ name: "Pixel" }], username: "lab-user", accessKey: FARM_KEY });
        expect(made.status).toBe(201);
        const url = `/api/projects/${id}/device-farms/${made.body.id}`;

        const moved = await call("PUT", url, { hubUrl: "https://elsewhere.example.test/wd/hub" });
        expect(moved.status).toBe(400);
        expect(moved.body.error).toMatch(/only sent where it was entered for/);
        expect((await call("GET", `/api/projects/${id}/device-farms`)).body.farms[0].hubUrl).toBe("https://farm-a.example.test/wd/hub");

        // The same server under another path, a new name, or a new site with its key: fine.
        expect((await call("PUT", url, { hubUrl: "https://farm-a.example.test/other/hub" })).status).toBe(200);
        expect((await call("PUT", url, { label: "Lab 2" })).status).toBe(200);
        expect((await call("PUT", url, { hubUrl: "https://elsewhere.example.test/wd/hub", accessKey: "another-key-1" })).status).toBe(200);
    });
});

describe("the test mailbox (IMAP)", () => {
    it("needs the password again when the mail server changes", async () => {
        const id = newProject("Mailbox moves");
        const imap = { host: "imap.example.test", port: 993, tls: true, user: "qa@example.test" };
        expect((await call("PUT", `/api/projects/${id}/mailbox`, { kind: "imap", imap: { ...imap, password: IMAP_PASS } })).status).toBe(200);

        for (const change of [{ host: "imap.elsewhere.test" }, { port: 1993 }]) {
            const moved = await call("PUT", `/api/projects/${id}/mailbox`, { kind: "imap", imap: { ...imap, ...change } });
            expect(moved.status).toBe(400);
            expect(moved.body.error).toMatch(/only sent where it was entered for/);
        }
        // The same server with another folder keeps the stored password; a new server with its password is fine.
        expect((await call("PUT", `/api/projects/${id}/mailbox`, { kind: "imap", imap: { ...imap, mailbox: "Alerts" } })).status).toBe(200);
        expect((await call("PUT", `/api/projects/${id}/mailbox`, { kind: "imap", imap: { ...imap, host: "imap.elsewhere.test", password: "another-password-1" } })).status).toBe(200);
        // The stored config the next check would use is still for a server whose password was entered for it.
        const raw = JSON.stringify(platform.db.all("SELECT * FROM test_mailboxes"));
        expect(raw).not.toContain(IMAP_PASS);
    });
});
