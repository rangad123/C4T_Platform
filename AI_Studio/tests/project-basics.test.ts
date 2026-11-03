/**
 * Round 37, project basics: a typed name (never made from the address), one platform and one testing mode per project (older
 * projects keep the several they have), the app by platform (web address, .apk or Google Play link, .ipa or App Store link), and
 * the project list in pages with search and folder filter. No AI and no outside calls.
 */
import { zipSync } from "fflate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { permissionRuleFor } from "../src/platform/auth/roles.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { Db } from "../src/platform/db.js";
import { APP_STORE_LINK_PROBLEM, appStoreLink, ipaKey, NOT_AN_IPA, PLAY_LINK_PROBLEM, playStoreLink } from "../src/platform/project-app.js";
import { ONE_PLATFORM, ONE_TESTING_MODE } from "../src/platform/project-setup.js";
import { buildServer } from "../src/platform/server.js";

type App = Awaited<ReturnType<typeof buildServer>>;
const KEY = "basics-owner-key-5c1f90";
let dir: string;
let platform: Platform;
let app: App;

const call = (method: string, url: string, payload?: unknown) =>
    app
        .inject({ method: method as "GET", url, headers: { "x-api-key": KEY }, ...(payload !== undefined ? { payload: payload as object } : {}) })
        .then((r) => ({ status: r.statusCode, body: r.body && /^[[{]/.test(r.body) ? JSON.parse(r.body) : r.body }));
const upload = (url: string, data: Buffer, type = "application/octet-stream") =>
    app.inject({ method: "POST", url, headers: { "x-api-key": KEY, "content-type": type }, payload: data }).then((r) => ({ status: r.statusCode, body: JSON.parse(r.body) }));
const make = async (body: Record<string, unknown>) => {
    const r = await call("POST", "/api/projects", body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
};
const ipa = (entries: Record<string, string>) => Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, new TextEncoder().encode(v)])), { level: 0 }));

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-basics-"));
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", API_KEY: KEY, SECRET_KEY: "basics-test-secret-key-0123456789" }));
    app = await buildServer(platform);
    await app.ready();
}, 60_000);

afterAll(async () => {
    await app?.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("a project's name is typed", () => {
    it("is required and never made from the address", async () => {
        expect((await call("POST", "/api/projects", {})).status).toBe(400);
        expect(await call("POST", "/api/projects", { name: "   " })).toMatchObject({ status: 400 });
        const id = await make({ name: "  Gift shop  ", webUrl: "https://shop.example.com/" });
        expect((await call("GET", `/api/projects/${id}`)).body.name).toBe("Gift shop");
        // A taken name stays refused, also when an older page asks for a made-up one.
        expect(await call("POST", "/api/projects", { name: "gift shop", autoName: true })).toMatchObject({ status: 409 });
    });
});

describe("one platform and one testing mode", () => {
    it("refuses several on create and on update, and defaults to web and agent mode", async () => {
        expect(await call("POST", "/api/projects", { name: "Two platforms", platforms: ["web", "android"] })).toMatchObject({ status: 400, body: { error: ONE_PLATFORM } });
        expect(await call("POST", "/api/projects", { name: "Two modes", testingModes: ["agent", "code"] })).toMatchObject({ status: 400, body: { error: ONE_TESTING_MODE } });
        const plain = await call("POST", "/api/projects", { name: "Old client" });
        expect(plain.body).toMatchObject({ platforms: ["web"], testingModes: ["agent"], codeEngines: { web: "playwright" } });
        const phone = await make({ name: "Phone", platforms: ["android", "android"], testingModes: ["code"] });
        expect((await call("GET", `/api/projects/${phone}`)).body).toMatchObject({ platforms: ["android"], testingModes: ["code"], codeEngines: { mobile: "taqwright" } });
        expect(await call("PATCH", `/api/projects/${phone}`, { platforms: ["android", "ios"] })).toMatchObject({ status: 400, body: { error: ONE_PLATFORM } });
        expect(await call("PATCH", `/api/projects/${phone}`, { testingModes: ["code", "agent"] })).toMatchObject({ status: 400, body: { error: ONE_TESTING_MODE } });
        expect((await call("PATCH", `/api/projects/${phone}`, { platforms: ["ios"], testingModes: ["agent"] })).body).toMatchObject({ platforms: ["ios"], testingModes: ["agent"] });
    });

    it("keeps an older project's several platforms and modes until one of each is saved", async () => {
        const id = await make({ name: "From before" });
        // As production has them: made before round 37 with several of each.
        platform.repo.updateProject(id, { platforms: ["web", "android", "ios"], testingModes: ["agent", "code"] });
        expect((await call("GET", `/api/projects/${id}`)).body).toMatchObject({ platforms: ["web", "android", "ios"], testingModes: ["agent", "code"] });
        // A change that names neither leaves them as they are; nothing is narrowed behind the person's back.
        expect((await call("PATCH", `/api/projects/${id}`, { description: "Still both" })).body).toMatchObject({ platforms: ["web", "android", "ios"], testingModes: ["agent", "code"] });
        expect((await call("GET", "/api/projects")).body.find((p: { id: string }) => p.id === id)).toMatchObject({ platforms: ["web", "android", "ios"] });
        expect((await call("PATCH", `/api/projects/${id}`, { platforms: ["android"], testingModes: ["code"] })).body).toMatchObject({ platforms: ["android"], testingModes: ["code"] });
    });

    it("decides what agent mode needs: agent runs and the AI check", async () => {
        const code = await make({ name: "Code only", testingModes: ["code"] });
        expect((await call("GET", `/api/projects/${code}/setup-check`)).body.items.map((i: { key: string }) => i.key)).not.toContain("ai-model");
        expect((await call("POST", `/api/projects/${code}/agent-runs`, { objective: "Buy a gift" })).status).toBe(409);
        const agent = await make({ name: "Agent only", testingModes: ["agent"] });
        expect((await call("GET", `/api/projects/${agent}/setup-check`)).body.items.map((i: { key: string }) => i.key)).toContain("ai-model");
    });
});

describe("the app by platform", () => {
    it("saves a web address on create, refuses a bad one before anything is created", async () => {
        const before = (await call("GET", "/api/projects")).body.length;
        expect(await call("POST", "/api/projects", { name: "Bad address", webUrl: "ftp://shop.example.com" })).toMatchObject({ status: 400 });
        expect(await call("POST", "/api/projects", { name: "Bad address", webUrl: "https://user:pw@shop.example.com" })).toMatchObject({ status: 400 });
        expect((await call("GET", "/api/projects")).body.length).toBe(before);
        const id = await make({ name: "Web shop", webUrl: "https://web.example.com/start" });
        expect((await call("GET", `/api/projects/${id}/app-details`)).body).toMatchObject({ webUrl: "https://web.example.com/start", android: { apk: null, playStoreUrl: null }, ios: { ipa: null, appStoreUrl: null } });
        expect((await call("GET", `/api/projects/${id}`)).body.application.url).toBe("https://web.example.com/start");
        // Changed in Settings: a new address; the earlier one is replaced.
        expect((await call("PUT", `/api/projects/${id}/app-details`, { webUrl: "https://staging.example.com/" })).body.webUrl).toBe("https://staging.example.com/");
    });

    it("checks store links strictly and keeps them in one form", () => {
        expect(playStoreLink("https://play.google.com/store/apps/details?id=com.example.shop&hl=en")).toEqual({ url: "https://play.google.com/store/apps/details?id=com.example.shop", appPackage: "com.example.shop" });
        for (const bad of ["http://play.google.com/store/apps/details?id=com.example.shop", "https://play.google.com.evil.example/store/apps/details?id=com.a.b", "https://evil.example/store/apps/details?id=com.a.b", "https://play.google.com/store/apps/details?id=nodots", "https://play.google.com/store/apps/details", "javascript:alert(1)", "https://u:p@play.google.com/store/apps/details?id=com.a.b", "https://play.google.com:444/store/apps/details?id=com.a.b"])
            expect(playStoreLink(bad)).toEqual({ error: PLAY_LINK_PROBLEM });
        expect(appStoreLink("https://apps.apple.com/GB/app/gift-shop/id123456789?mt=8")).toEqual({ url: "https://apps.apple.com/gb/app/id123456789", appStoreId: "123456789" });
        // The name part is never kept, so nothing typed there is stored.
        expect(appStoreLink("https://apps.apple.com/app/%3Cscript%3E/id123456789")).toEqual({ url: "https://apps.apple.com/app/id123456789", appStoreId: "123456789" });
        expect(appStoreLink("https://apps.apple.com/app/id987654321")).toEqual({ url: "https://apps.apple.com/app/id987654321", appStoreId: "987654321" });
        for (const bad of ["https://itunes.apple.com/app/id123456789", "https://apps.apple.com/app/gift-shop", "http://apps.apple.com/app/id123456789", "https://apps.apple.com.evil.example/app/id123456789", "https://apps.apple.com/app/a/b/id123456789", "https://apps.apple.com/app/id12"])
            expect(appStoreLink(bad)).toEqual({ error: APP_STORE_LINK_PROBLEM });
    });

    it("saves a Google Play link (and its package) or refuses it in plain words", async () => {
        expect(await call("POST", "/api/projects", { name: "Bad link", platforms: ["android"], playStoreUrl: "https://evil.example/?id=com.a.b" })).toMatchObject({ status: 400, body: { error: PLAY_LINK_PROBLEM } });
        const id = await make({ name: "Android shop", platforms: ["android"], testingModes: ["agent"], playStoreUrl: "https://play.google.com/store/apps/details?id=com.example.gifts" });
        expect((await call("GET", `/api/projects/${id}/app-details`)).body.android).toEqual({ apk: null, appPackage: "com.example.gifts", playStoreUrl: "https://play.google.com/store/apps/details?id=com.example.gifts" });
        // A package already set is never replaced by a later link.
        await call("PUT", `/api/projects/${id}/app-details`, { playStoreUrl: "https://play.google.com/store/apps/details?id=com.other.app" });
        expect((await call("GET", `/api/projects/${id}/app-details`)).body.android).toMatchObject({ appPackage: "com.example.gifts", playStoreUrl: "https://play.google.com/store/apps/details?id=com.other.app" });
        expect((await call("PUT", `/api/projects/${id}/app-details`, { playStoreUrl: null })).body.android.playStoreUrl).toBeNull();
        expect(await call("PUT", `/api/projects/${id}/app-details`, { nonsense: true })).toMatchObject({ status: 400 });
    });

    it("stores an .apk through the Mobile app upload", async () => {
        const id = await make({ name: "Apk shop", platforms: ["android"] });
        const fakeApk = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40), Buffer.from("AndroidManifest.xml"), Buffer.alloc(60)]);
        expect((await upload(`/api/projects/${id}/mobile-app/apk?filename=shop.apk`, fakeApk, "application/vnd.android.package-archive")).status).toBe(200);
        expect((await call("GET", `/api/projects/${id}/app-details`)).body.android.apk).toBe("app.apk");
    });

    it("stores an .ipa only when it is one, never showing where", async () => {
        const id = await make({ name: "iPhone shop", platforms: ["ios"], testingModes: ["code"], appStoreUrl: "https://apps.apple.com/us/app/gift-shop/id123456789" });
        expect((await call("GET", `/api/projects/${id}/app-details`)).body.ios).toMatchObject({ appStoreUrl: "https://apps.apple.com/us/app/id123456789", ipa: null });
        expect(await upload(`/api/projects/${id}/app-details/ipa?filename=shop.ipa`, Buffer.from("just text, not an app at all, really not one".repeat(4)))).toMatchObject({ status: 400, body: { error: NOT_AN_IPA } });
        expect(await upload(`/api/projects/${id}/app-details/ipa?filename=shop.ipa`, ipa({ "readme.txt": "a zip, but not an app".repeat(10) }))).toMatchObject({ status: 400, body: { error: NOT_AN_IPA } });
        const good = ipa({ "Payload/Gift Shop.app/Info.plist": "<plist></plist>".repeat(10), "Payload/Gift Shop.app/GiftShop": "binary".repeat(20) });
        expect((await upload(`/api/projects/${id}/app-details/ipa?filename=shop.zip`, good)).status).toBe(400);
        const up = await upload(`/api/projects/${id}/app-details/ipa?filename=${encodeURIComponent("C:\\builds\\Gift Shop.ipa")}`, good);
        expect(up.status).toBe(200);
        expect(up.body.ios.ipa).toMatchObject({ name: "Gift Shop.ipa", bytes: good.length });
        expect(JSON.stringify(up.body)).not.toContain(dir.replaceAll("\\", "\\\\"));
        expect(await platform.store.exists(ipaKey(id))).toBe(true);
        expect((await call("PUT", `/api/projects/${id}/app-details`, { clearIpa: true })).body.ios.ipa).toBeNull();
        expect(await platform.store.exists(ipaKey(id))).toBe(false);
    });

    it("answers 404 for a project that is not there", async () => {
        expect((await call("GET", "/api/projects/nope/app-details")).status).toBe(404);
        expect((await call("PUT", "/api/projects/nope/app-details", { appStoreUrl: null })).status).toBe(404);
        expect((await upload("/api/projects/nope/app-details/ipa?filename=a.ipa", ipa({ "Payload/A.app/Info.plist": "x".repeat(200) }))).status).toBe(404);
    });

    it("classifies the new routes", () => {
        expect(permissionRuleFor("GET", "/api/projects/:id/app-details")).toBe("read");
        expect(permissionRuleFor("PUT", "/api/projects/:id/app-details")).toBe("ai_studio.project.settings");
        expect(permissionRuleFor("POST", "/api/projects/:id/app-details/ipa")).toBe("ai_studio.project.settings");
    });
});

describe("the project list in pages", () => {
    it("keeps the plain list without limit or offset, and pages, searches and filters with them", async () => {
        for (let i = 1; i <= 23; i++) await make({ name: `Paged ${String(i).padStart(2, "0")}`, ...(i % 5 === 0 ? { webUrl: `https://five-${i}.example.org/` } : {}) });
        const plain = (await call("GET", "/api/projects")).body;
        expect(Array.isArray(plain)).toBe(true);
        const first = (await call("GET", "/api/projects?limit=20")).body;
        expect(first).toMatchObject({ total: plain.length, limit: 20, offset: 0 });
        expect(first.projects).toHaveLength(20);
        expect(first.projects.map((p: { id: string }) => p.id)).toEqual(plain.slice(0, 20).map((p: { id: string }) => p.id));
        const second = (await call("GET", "/api/projects?limit=20&offset=20")).body;
        expect(second.projects.map((p: { id: string }) => p.id)).toEqual(plain.slice(20, 40).map((p: { id: string }) => p.id));
        const searched = (await call("GET", "/api/projects?q=paged&limit=20&offset=20")).body;
        expect(searched).toMatchObject({ total: 23, offset: 20 });
        expect(searched.projects).toHaveLength(3);
        // The address counts too.
        expect((await call("GET", "/api/projects?q=five-1&limit=20")).body).toMatchObject({ total: 2 });
        expect((await call("GET", "/api/projects?q=PAGED 0")).body).toHaveLength(9);
        // Folder filter: none of these is in a folder.
        expect((await call("GET", "/api/projects?folder=none&q=paged&limit=5")).body).toMatchObject({ total: 23 });
        expect((await call("GET", "/api/projects?folder=some-folder&limit=5")).body).toMatchObject({ total: 0, projects: [] });
        expect((await call("GET", "/api/projects?offset=1000")).body).toMatchObject({ total: plain.length, projects: [], limit: 20, offset: 1000 });
        for (const bad of ["limit=0", "limit=101", "limit=abc", "offset=-1"]) expect((await call("GET", `/api/projects?${bad}`)).status).toBe(400);
    });
});

describe("slot 47", () => {
    it("creates its table, and a database opened while it was reserved gets it", () => {
        const file = path.join(dir, "slot47.db");
        const db = new Db(file);
        expect(db.dialect.tableExists(db.raw, "project_app_details")).toBe(true);
        db.raw.exec("DROP TABLE project_app_details");
        db.raw.close();
        const again = new Db(file);
        expect(again.dialect.tableExists(again.raw, "project_app_details")).toBe(true);
        again.raw.close();
    });
});
