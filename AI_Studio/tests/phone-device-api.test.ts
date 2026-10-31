/**
 * Round 24, DEVICE, really executed against the platform in-process and the FAKE adb (tests/fixtures/fake-adb.mjs: a mock phone, no adb server,
 * no emulator, never the real phone plugged into this computer):
 *  - the phone settings API (where phone tests run, how thorough, already signed in), kept by the Mobile app settings and refused with a clean start;
 *  - "Is this phone ready?" on a fake OnePlus with a parallel-apps user, animations off and back, keep the screen on and back, a OnePlus that refuses;
 *  - the sign-in pause: an exploration waits, the job page answers (Continue / go on), nobody answers in time, a stop while waiting;
 *  - signing in on the fake phone's shop app from the test account through the real device session.
 * No browser. Run under the lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/phone-device-api.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { openLocalDeviceSession } from "../src/engine/mobile/device/session.js";
import { signInOnPhone } from "../src/engine/mobile/explore/signin.js";
import { ROUTE_ROLES } from "../src/platform/auth/roles.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { ANSWER_KIND, jobPersonGate, openQuestion, WAITING_KIND } from "../src/platform/phone-person-gate.js";
import { recordExploredOn } from "../src/platform/phone-settings-store.js";
import { buildServer } from "../src/platform/server.js";
import { phoneReadyLines } from "../src/agent/phone-ready-lines.js";

const FAKE_ADB = path.join(REPO_ROOT, "tests/fixtures/fake-adb.mjs");
const PKG = "com.example.shop";

let tmp: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
const saved: Record<string, string | undefined> = {};
const setEnv = (e: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(e)) {
        if (!(k in saved)) saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
};
let n = 0;
/** A fresh mock phone: a OnePlus by default, on USB (never an emulator here). */
const freshPhone = (extra: Record<string, string | undefined> = {}) => {
    n++;
    setEnv({ AITP_FAKE_STATE: path.join(tmp, `state-${n}.json`), AITP_FAKE_ADB_LOG: path.join(tmp, `adb-${n}.log`), AITP_FAKE_DEVICES: "phone", AITP_FAKE_MAKER: "oneplus", AITP_FAKE_ANDROID: "15", AITP_FAKE_FAULTS: "", ...extra });
    return { state: process.env.AITP_FAKE_STATE!, log: process.env.AITP_FAKE_ADB_LOG! };
};
const phoneState = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const adbCalls = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as string[]).filter((_, i, a) => !(a[0] === "-s" && i < 2)).join(" ")) : []);

beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-phone-device-"));
    // Never the real Android tools of this computer (a real phone may be plugged in): only the fake adb.
    setEnv({ TAQWRIGHT_HOME: path.join(tmp, "no-taqwright"), ANDROID_HOME: "", AITP_ADB_PATH: FAKE_ADB, AITP_FAKE_APP: "shop", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", LLM_API_KEY: "" });
    platform = bootstrap(loadConfig({ DATA_DIR: path.join(tmp, "data"), LLM_PROVIDER: "anthropic", CONCURRENCY: "1", SECRET_KEY: "test-secret-key-0123456789" }));
    server = await buildServer(platform);
}, 60_000);

afterAll(async () => {
    await server?.close();
    platform?.db.close();
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body.startsWith("{") || res.body.startsWith("[") ? JSON.parse(res.body) : res.body };
};
const newProject = async (name: string, mobile?: Record<string, unknown>) => {
    const id = (await call("POST", "/api/projects", { name })).body.id as string;
    if (mobile) {
        const r = await call("PUT", `/api/projects/${id}/mobile-app`, mobile);
        expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    return id;
};

describe("the phone settings API", () => {
    it("needs the phone app first", async () => {
        const id = await newProject("No app");
        const g = await call("GET", `/api/projects/${id}/phone-settings`);
        expect(g.status).toBe(200);
        expect(g.body).toMatchObject({ hasApp: false, depth: "standard", keepSignedIn: false, effective: { kind: "auto" } });
        const p = await call("PUT", `/api/projects/${id}/phone-settings`, { depth: "quick" });
        expect(p.status).toBe(409);
        expect(p.body.error).toMatch(/Add the phone app under Mobile app first/);
    });

    it("saves, explains and keeps the three settings; the Mobile app settings keep them too", async () => {
        const id = await newProject("Settings", { appPackage: PKG });
        const g = (await call("GET", `/api/projects/${id}/phone-settings`)).body;
        expect(g).toMatchObject({ hasApp: true, appPackage: PKG, runsOn: null, effective: { kind: "auto" }, depth: "standard", keepSignedIn: false, cleanStart: false, exploredOn: null, farm: { connections: [], chosen: null } });
        expect(g.sentence).toBe("Phone tests run on a connected phone that has the app, else on an emulator.");
        expect(g.depths.map((d: { id: string; screens: number }) => [d.id, d.screens])).toEqual([["quick", 40], ["standard", 150], ["thorough", 300]]);

        const p = await call("PUT", `/api/projects/${id}/phone-settings`, { runsOn: { kind: "phone", serial: "R58N20ABCDE", model: "CPH2467" }, depth: "thorough", keepSignedIn: true });
        expect(p.status, JSON.stringify(p.body)).toBe(200);
        expect(p.body).toMatchObject({ runsOn: { kind: "phone", serial: "R58N20ABCDE" }, effective: { kind: "phone" }, depth: "thorough", keepSignedIn: true, sentence: "Phone tests run on CPH2467 (R58N20ABCDE)." });
        // The project's answer shows them with the mobile app.
        expect((await call("GET", `/api/projects/${id}`)).body.mobile).toMatchObject({ appPackage: PKG, runsOn: { kind: "phone", serial: "R58N20ABCDE" }, depth: "thorough", keepSignedIn: true });

        // A save of the Mobile app that does not touch them keeps them; a clean start is refused while Already signed in is on.
        expect((await call("PUT", `/api/projects/${id}/mobile-app`, { startupBudgetMs: 4000 })).status).toBe(200);
        expect((await call("GET", `/api/projects/${id}/phone-settings`)).body).toMatchObject({ depth: "thorough", keepSignedIn: true });
        const clean = await call("PUT", `/api/projects/${id}/mobile-app`, { cleanStart: true });
        expect(clean.status).toBe(400);
        expect(clean.body.error).toBe("“Already signed in on this phone” keeps the app’s data, so “Start every test from a fresh install of the app’s data” has to be off. Turn one of them off.");

        // Back to the defaults: nothing stored.
        const back = await call("PUT", `/api/projects/${id}/phone-settings`, { runsOn: null, depth: null, keepSignedIn: null });
        expect(back.body).toMatchObject({ runsOn: null, depth: "standard", keepSignedIn: false });
        const mobile = (await call("GET", `/api/projects/${id}`)).body.mobile;
        expect(mobile).not.toHaveProperty("runsOn");
        expect(mobile).not.toHaveProperty("depth");
        expect(mobile).not.toHaveProperty("keepSignedIn");
    });

    it("the phone the AI explored on: refused before an exploration, the default after one on a real phone", async () => {
        const id = await newProject("Explored", { appPackage: PKG });
        const before = await call("PUT", `/api/projects/${id}/phone-settings`, { runsOn: { kind: "explored" } });
        expect(before.status).toBe(400);
        expect(before.body.error).toMatch(/has not explored this app on a device yet/);
        recordExploredOn(platform.repo, id, { serial: "R58N20ABCDE", model: "CPH2467", emulator: false });
        const g = (await call("GET", `/api/projects/${id}/phone-settings`)).body;
        expect(g).toMatchObject({ runsOn: null, effective: { kind: "explored" }, exploredOn: { serial: "R58N20ABCDE", model: "CPH2467", emulator: false } });
        expect(g.sentence).toBe("Phone tests run on the phone the AI explored on, CPH2467 (R58N20ABCDE).");
        expect((await call("PUT", `/api/projects/${id}/phone-settings`, { runsOn: { kind: "explored" } })).status).toBe(200);
    });

    it("refuses what it does not know, and a device farm that is not set up", async () => {
        const id = await newProject("Refusals", { appPackage: PKG });
        expect((await call("PUT", `/api/projects/${id}/phone-settings`, { depth: "endless" })).status).toBe(400);
        expect((await call("PUT", `/api/projects/${id}/phone-settings`, { runsOn: { kind: "phone", serial: "x; reboot" } })).status).toBe(400);
        expect((await call("PUT", `/api/projects/${id}/phone-settings`, { surprise: true })).status).toBe(400);
        const farm = await call("PUT", `/api/projects/${id}/phone-settings`, { runsOn: { kind: "farm" } });
        expect(farm.status).toBe(400);
        expect(farm.body.error).toMatch(/No device farm is set up for this project/);
        expect((await call("GET", `/api/projects/does-not-exist/phone-settings`)).status).toBe(404);
    });

    it("every new route has a role (viewer reads, editor changes)", () => {
        expect(ROUTE_ROLES["GET /api/projects/:id/phone-settings"]).toBe("viewer");
        expect(ROUTE_ROLES["PUT /api/projects/:id/phone-settings"]).toBe("editor");
        expect(ROUTE_ROLES["GET /api/projects/:id/phones"]).toBe("viewer");
        expect(ROUTE_ROLES["POST /api/projects/:id/phones/:serial/animations"]).toBe("editor");
        expect(ROUTE_ROLES["POST /api/projects/:id/phones/:serial/stay-awake"]).toBe("editor");
        expect(ROUTE_ROLES["GET /api/projects/:id/jobs/:jobId/phone-sign-in"]).toBe("viewer");
        expect(ROUTE_ROLES["POST /api/projects/:id/jobs/:jobId/phone-sign-in"]).toBe("editor");
    });
});

describe("Is this phone ready? on the fake phone", () => {
    it("a OnePlus with a parallel-apps user: checked read-only, explained, with the maker's tips", async () => {
        const p = freshPhone({ AITP_FAKE_FAULTS: "second-user" });
        const id = await newProject("Ready", { appPackage: PKG });
        const r = await call("GET", `/api/projects/${id}/phones`);
        expect(r.status).toBe(200);
        expect(r.body.available).toBe(true);
        expect(r.body.phones).toHaveLength(1);
        const phone = r.body.phones[0];
        expect(phone).toMatchObject({ serial: "R58M12ABCDE", emulator: false, model: "CPH2467", maker: "oneplus", androidVersion: "15", sdk: 35, state: "attention", launcher: `${PKG}/.MainActivity` });
        const ids = phone.checks.map((c: { id: string; status: string }) => `${c.id}:${c.status}`);
        expect(ids).toEqual(["authorized:ok", "android:ok", "screen:ok", "stay-awake:attention", "animations:attention", "battery:ok", "app:ok", "launcher:ok", "helper:info", "users:info"]);
        expect(phone.checks.find((c: { id: string }) => c.id === "users").title).toBe("This phone has another user: MultiApp (user 999)");
        expect(phone.tips.map((t: { title: string }) => t.title)).toEqual(["Turn on Disable permission monitoring", "Let the test helper run in the background"]);
        // Nothing was changed on the phone.
        expect(adbCalls(p.log).filter((c) => / put |pm clear|pm grant|monkey|am start/.test(c))).toEqual([]);
    });

    it("the app only in the parallel-apps user is not ready, in words", async () => {
        freshPhone({ AITP_FAKE_FAULTS: "clone-only" });
        const id = await newProject("Clone only", { appPackage: PKG });
        const phone = (await call("GET", `/api/projects/${id}/phones`)).body.phones[0];
        expect(phone.state).toBe("not-ready");
        expect(phone.checks.find((c: { id: string }) => c.id === "app")).toMatchObject({ status: "problem", title: `${PKG} is installed only for MultiApp (user 999), not for the phone’s main user` });
    });

    it("turns animations off for tests and back again, keeping the phone's own values", async () => {
        const p = freshPhone();
        const id = await newProject("Animations", { appPackage: PKG });
        const off = await call("POST", `/api/projects/${id}/phones/R58M12ABCDE/animations`, { off: true });
        expect(off.status, JSON.stringify(off.body)).toBe(200);
        expect(off.body.phone.checks.find((c: { id: string }) => c.id === "animations")).toMatchObject({ status: "ok", action: "animations-restore" });
        expect(phoneState(p.state).settings).toMatchObject({ window_animation_scale: "0", transition_animation_scale: "0", animator_duration_scale: "0" });
        const row = platform.repo.getLatestApplicationPublic(id)!;
        expect(row.config.mobile.phoneSetup.animations.R58M12ABCDE).toEqual({ window: "1.0", transition: "1.0", animator: "1.0" });
        // The project's public answer never shows the saved values.
        expect((await call("GET", `/api/projects/${id}`)).body.mobile).not.toHaveProperty("phoneSetup");

        const back = await call("POST", `/api/projects/${id}/phones/R58M12ABCDE/animations`, { off: false });
        expect(back.status).toBe(200);
        expect(phoneState(p.state).settings).toMatchObject({ window_animation_scale: "1.0", transition_animation_scale: "1.0", animator_duration_scale: "1.0" });
        expect(back.body.phone.checks.find((c: { id: string }) => c.id === "animations")).toMatchObject({ status: "attention", action: "animations-off" });
        expect(platform.repo.getLatestApplicationPublic(id)!.config.mobile.phoneSetup).toBeUndefined();
        expect(adbCalls(p.log).filter((c) => c.includes("settings put"))).toEqual([
            "shell settings put global window_animation_scale 0",
            "shell settings put global transition_animation_scale 0",
            "shell settings put global animator_duration_scale 0",
            "shell settings put global window_animation_scale 1.0",
            "shell settings put global transition_animation_scale 1.0",
            "shell settings put global animator_duration_scale 1.0",
        ]);
    });

    it("keeps the screen on while charging and back; a OnePlus that refuses says what to turn on", async () => {
        const p = freshPhone();
        const id = await newProject("Stay awake", { appPackage: PKG });
        expect((await call("POST", `/api/projects/${id}/phones/R58M12ABCDE/stay-awake`, { on: true })).status).toBe(200);
        expect(phoneState(p.state).settings.stay_on_while_plugged_in).toBe("3");
        expect((await call("POST", `/api/projects/${id}/phones/R58M12ABCDE/stay-awake`, { on: false })).status).toBe(200);
        expect(phoneState(p.state).settings.stay_on_while_plugged_in).toBe("0");

        freshPhone({ AITP_FAKE_FAULTS: "refuse-settings" });
        const refused = await call("POST", `/api/projects/${id}/phones/R58M12ABCDE/animations`, { off: true });
        expect(refused.status).toBe(409);
        expect(refused.body.error).toBe("The phone refused to turn animations off. Turn on Disable permission monitoring in Developer options (see the tips for this phone), then try again.");
        expect(platform.repo.getLatestApplicationPublic(id)!.config.mobile.phoneSetup).toBeUndefined();
    });

    it("refuses a phone that is not connected, and a serial that is not one", async () => {
        freshPhone();
        const id = await newProject("Unknown phone", { appPackage: PKG });
        expect((await call("POST", `/api/projects/${id}/phones/NOPE123/animations`, { off: true })).status).toBe(404);
        expect((await call("POST", `/api/projects/${id}/phones/${encodeURIComponent("a b")}/animations`, { off: true })).status).toBe(400);
    });

    it("the runner's check-computer prints a line per phone from the same check", async () => {
        freshPhone({ AITP_FAKE_FAULTS: "second-user" });
        const lines = await phoneReadyLines(process.env);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ id: "phone-ready", status: "optional", title: "Phone CPH2467 (R58M12ABCDE): the screen turns off while the phone charges" });
        expect(lines[0]!.fix).toContain("Also for this phone: Turn on Disable permission monitoring.");
        expect(await phoneReadyLines({ ...process.env, AITP_ADB_PATH: path.join(tmp, "no-adb") })).toEqual([]);
    });

    it("no phone connected: says so plainly", async () => {
        freshPhone({ AITP_FAKE_DEVICES: "none" });
        const id = await newProject("No phone", { appPackage: PKG });
        expect((await call("GET", `/api/projects/${id}/phones`)).body).toEqual({ available: true, reason: "No phone or emulator is connected to the computer that runs the platform.", phones: [] });
    });
});

describe("the sign-in pause on the job page", () => {
    const jobFor = async (name: string) => {
        const id = await newProject(name, { appPackage: PKG });
        const app = platform.repo.getLatestApplicationPublic(id)!;
        const job = await platform.repo.createJob(id, app.id as string, { targets: ["mobile"], planOnly: true } as never);
        return { id, jobId: job.id };
    };

    it("an exploration waits, the page sees the question, Continue answers it once", async () => {
        const { id, jobId } = await jobFor("Pause");
        expect((await call("GET", `/api/projects/${id}/jobs/${jobId}/phone-sign-in`)).body).toEqual({ open: null });
        expect((await call("POST", `/api/projects/${id}/jobs/${jobId}/phone-sign-in`, { choice: "continue" })).status).toBe(409);

        const gate = jobPersonGate(platform.repo, jobId, { pollMs: 20 });
        const waiting = gate.ask({ kind: "code", message: "Enter the code on the phone, then choose Continue.", timeoutMs: 60_000, screen: "Verify" });
        await new Promise((r) => setTimeout(r, 50));
        const open = (await call("GET", `/api/projects/${id}/jobs/${jobId}/phone-sign-in`)).body.open;
        expect(open).toMatchObject({ kind: "code", message: "Enter the code on the phone, then choose Continue.", screen: "Verify" });
        expect(Date.parse(open.deadline)).toBeGreaterThan(Date.now());
        // The job's events carry it for the page too.
        expect((await call("GET", `/api/test-generation/${jobId}/events`)).body.some((e: { kind: string }) => e.kind === WAITING_KIND)).toBe(true);

        const ans = await call("POST", `/api/projects/${id}/jobs/${jobId}/phone-sign-in`, { choice: "continue" });
        expect(ans.body).toEqual({ answered: "continue" });
        expect(await waiting).toBe("continue");
        expect((await call("POST", `/api/projects/${id}/jobs/${jobId}/phone-sign-in`, { choice: "skip" })).status).toBe(409);
        expect((await call("POST", `/api/projects/${id}/jobs/${jobId}/phone-sign-in`, { choice: "maybe" })).status).toBe(400);
    });

    it("go on without signing in; nobody answering in time; a stop while waiting; another project's job is not found", async () => {
        const { id, jobId } = await jobFor("Pause 2");
        const gate = jobPersonGate(platform.repo, jobId, { pollMs: 20 });
        const w1 = gate.ask({ kind: "captcha", message: "m", timeoutMs: 60_000 });
        await new Promise((r) => setTimeout(r, 50));
        await call("POST", `/api/projects/${id}/jobs/${jobId}/phone-sign-in`, { choice: "skip" });
        expect(await w1).toBe("skip");

        expect(await gate.ask({ kind: "code", message: "m", timeoutMs: 150 })).toBe("timeout");
        const evs = (await call("GET", `/api/test-generation/${jobId}/events`)).body as Array<{ kind: string; message: string }>;
        expect(evs.filter((e) => e.kind === ANSWER_KIND).map((e) => e.message).at(-1)).toBe("No one answered within 1 minute, so the AI goes on without signing in.");
        expect(openQuestion(platform.repo.db, jobId)).toBeUndefined();

        const stop = new AbortController();
        const w3 = gate.ask({ kind: "code", message: "m", timeoutMs: 60_000 }, stop.signal);
        setTimeout(() => stop.abort(), 50);
        expect(await w3).toBe("stopped");

        const other = await newProject("Other");
        expect((await call("GET", `/api/projects/${other}/jobs/${jobId}/phone-sign-in`)).status).toBe(404);
    });
});

describe("signing in on the fake phone's shop app", () => {
    it("fills the sign-in screen from the test account through the real device session, and the app is signed in", async () => {
        const p = freshPhone({ AITP_FAKE_DEVICES: "phone", AITP_FAKE_USER: "tester", AITP_FAKE_PASSWORD: "Fake-Pass-1234" });
        const session = await openLocalDeviceSession({ appPackage: PKG, credentials: { username: "tester", password: "Fake-Pass-1234" } });
        try {
            let snap = await session.snapshot();
            // The shop asks about notifications on its first start.
            const deny = snap.outsideApp ? snap.elements.find((e) => e.text === "Don't allow") : undefined;
            if (deny) snap = (await session.act({ kind: "tap", index: deny.index })).snapshot!;
            const signIn = snap.elements.find((e) => e.id === "signin_button")!;
            snap = (await session.act({ kind: "tap", index: signIn.index })).snapshot!;
            const r = await signInOnPhone({ session, snap, details: { username: true, password: true } });
            expect(r.status, r.message).toBe("signed-in");
            expect(r.snapshot.elements.some((e) => e.text === "Hello, tester")).toBe(true);
            expect(phoneState(p.state).app.loggedIn).toBe(true);
            // Placeholders in what is returned; the password never.
            expect(JSON.stringify(r)).not.toContain("Fake-Pass-1234");
            expect(r.steps.map((s) => s.label)).toEqual(["Typed the user name into “Username”", "Typed the password into “password field”", "Closed the keyboard", "Tapped “Log in”"]);
            // It never tapped Log out (it is on the signed-in home screen now).
            expect(adbCalls(p.log).length).toBeGreaterThan(0);
        } finally {
            await session.close();
        }
    }, 60_000);
});
