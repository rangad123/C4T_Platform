/**
 * Phase 4 T22b: a project's database checks setting (routes/db-probe.ts, db-probe-store.ts, migration slot 70). Off by default; on needs
 * the probe's address and its token; the token is encrypted at rest with the platform's SecretBox and never returned (only whether one
 * is saved); leaving the token out keeps it; an empty address removes the setting; an address that is not https:// (or http:// on
 * loopback) is refused. A run gets a probe only while the setting is on. Against the real platform with app.inject; no browser, no port.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DbProbeStore } from "../src/platform/db-probe-store.js";
import { SecretBox } from "../src/platform/secrets.js";
import { buildServer } from "../src/platform/server.js";

const SECRET = "db-probe-settings-secret-0123456789";
const TOKEN = "probe-token-sentinel-0123456789abcdef";
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
let pid = "";

const call = async (method: "GET" | "PUT", body?: unknown) => {
    const r = await app.inject({ method, url: `/api/projects/${pid}/db-probe`, headers: { "x-requested-with": "ai-studio" }, ...(body === undefined ? {} : { payload: body as Record<string, unknown> }) });
    return { status: r.statusCode, body: r.json() as Record<string, unknown>, text: r.body };
};

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-probe-settings-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: SECRET, HOST: "127.0.0.1", PORT: "0", WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false" }));
    app = await buildServer(platform);
    pid = (await app.inject({ method: "POST", url: "/api/projects", headers: { "x-requested-with": "ai-studio" }, payload: { name: "Probe shop", platforms: ["web"], testingModes: ["agent"] } })).json().id;
});

afterAll(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("the Database checks setting", () => {
    it("is off by default, and a run gets no probe", async () => {
        expect(await call("GET")).toMatchObject({ status: 200, body: { enabled: false, url: "", tokenSaved: false } });
        expect(await new DbProbeStore(platform.sql, new SecretBox(dir, SECRET)).probeFor(pid)).toBeUndefined();
    });

    it("refuses to switch on without an address and a token, and refuses an address that is not https://", async () => {
        expect((await call("PUT", { enabled: true, url: "https://probe.example.com" })).status).toBe(400);
        expect((await call("PUT", { enabled: true, url: "", token: TOKEN })).status).toBe(400);
        const plain = await call("PUT", { enabled: true, url: "http://probe.example.com", token: TOKEN });
        expect(plain.status).toBe(400);
        expect(plain.body.error ?? plain.body.message).toMatch(/https:\/\//);
        expect((await call("PUT", { enabled: true, url: "https://probe.example.com", token: "short" })).status).toBe(400);
        expect((await call("PUT", { enabled: true, url: "https://probe.example.com", token: TOKEN, sql: "x" })).status).toBe(400);
        expect((await call("GET")).body).toEqual({ enabled: false, url: "", tokenSaved: false });
    });

    it("saves the token encrypted, never returns it, and keeps it when it is left out", async () => {
        const on = await call("PUT", { enabled: true, url: "https://probe.example.com", token: TOKEN });
        expect(on).toMatchObject({ status: 200, body: { enabled: true, url: "https://probe.example.com", tokenSaved: true } });
        expect(on.text).not.toContain(TOKEN);
        expect((await call("GET")).text).not.toContain(TOKEN);
        // At rest: no copy of the token in the row; the SecretBox opens it.
        const row = await platform.sql.get<Record<string, unknown>>("SELECT * FROM project_db_probes WHERE project_id = ?", pid);
        expect(JSON.stringify(row)).not.toContain(TOKEN);
        expect(new SecretBox(dir, SECRET).decrypt(String(row!.token_enc))).toBe(TOKEN);
        // Nor in the activity log.
        expect(JSON.stringify(await platform.sql.all("SELECT * FROM activity"))).not.toContain(TOKEN);
        expect(await new DbProbeStore(platform.sql, new SecretBox(dir, SECRET)).probeFor(pid)).toBeDefined();

        expect((await call("PUT", { enabled: false, url: "https://probe.example.com" })).body).toEqual({ enabled: false, url: "https://probe.example.com", tokenSaved: true });
        expect(await new DbProbeStore(platform.sql, new SecretBox(dir, SECRET)).probeFor(pid)).toBeUndefined();
        expect((await call("PUT", { enabled: true, url: "https://probe.example.com" })).body).toMatchObject({ enabled: true, tokenSaved: true });
        expect(new SecretBox(dir, SECRET).decrypt(String((await platform.sql.get<{ token_enc: string }>("SELECT token_enc FROM project_db_probes WHERE project_id = ?", pid))!.token_enc))).toBe(TOKEN);
    });

    it("an empty address removes the setting, token and all", async () => {
        expect((await call("PUT", { enabled: false, url: "" })).body).toEqual({ enabled: false, url: "", tokenSaved: false });
        expect(await platform.sql.get("SELECT * FROM project_db_probes WHERE project_id = ?", pid)).toBeUndefined();
    });
});
