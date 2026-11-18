/**
 * Row 188: a candidate finding's screenshots (row 173: job artifacts of kind `screenshot`, small JPEGs, ids in evidence.screenshots) are
 * read through the existing GET /api/artifacts/:id. A person who may only look at the project gets the picture as a JPEG; a person
 * limited to another project gets the missing-artifact 404; nobody signed in gets 401. The older PNG screenshots keep image/png.
 * Fast tier: Fastify inject on a real database and object store, no browser.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";

type App = Awaited<ReturnType<typeof buildServer>>;
const KEY = "finding-shot-owner-key-7c2d40";
/** The first bytes of a JPEG (SOI + APP0 JFIF); the route serves what is stored, it does not decode it. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

let dir: string;
let platform: Platform;
let app: App;
const ids = { a: { project: "", shot: "", png: "" }, b: { project: "" } };
const tokens = { viewer: "", other: "" };

async function seedProject(name: string) {
    const { repo } = platform;
    const project = repo.createProject({ name }).id as string;
    const appId = repo.createApplication(project, "http://127.0.0.1:7131/", {});
    const job = (await repo.createJob(project, appId, { ...DEFAULT_JOB_OPTIONS })).id;
    return { project, job };
}

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-finding-shot-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", API_KEY: KEY, SECRET_KEY: "finding-shot-secret-0123456789" }));
    app = await buildServer(platform);
    await app.ready();
    const a = await seedProject("Alpha");
    const b = await seedProject("Bravo");
    // Stored the way RepoSink.saveImageArtifact stores a finding's picture.
    const rel = path.posix.join(a.project, "_artifacts", a.job, "WEB-001-finding-1.jpg");
    const saved = await platform.store.put(rel, JPEG, { contentType: "image/jpeg" });
    const shot = platform.repo.addArtifact({ projectId: a.project, jobId: a.job, kind: "screenshot", path: rel, size: saved.size });
    const pngSaved = await platform.store.put(`${a.project}/shot.png`, "png");
    const png = platform.repo.addArtifact({ projectId: a.project, jobId: a.job, kind: "screenshot", path: pngSaved.key, size: pngSaved.size });
    ids.a = { project: a.project, shot, png };
    ids.b = { project: b.project };
    const control = accessControlOf(app);
    const person = (email: string, projectId: string) => {
        const u = control.users.create({ email, name: email.split("@")[0]!, role: "viewer" });
        control.projects.store.set(u.id, { mode: "only", projects: [{ projectId, role: "viewer" }] });
        return control.users.createToken(u.id, { name: "t", role: "viewer" }).token;
    };
    tokens.viewer = person("vic@example.com", a.project);
    tokens.other = person("olga@example.com", b.project);
}, 60_000);
afterAll(async () => {
    await app?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe("a finding's screenshot", () => {
    it("a person who may only look at the project gets the picture as a JPEG", async () => {
        const r = await get(`/api/artifacts/${ids.a.shot}`, bearer(tokens.viewer));
        expect(r.statusCode).toBe(200);
        expect(r.headers["content-type"]).toBe("image/jpeg");
        // The browser keeps the stated type and never guesses another from the bytes (CP2 L-2).
        expect(r.headers["x-content-type-options"]).toBe("nosniff");
        expect(r.rawPayload.equals(JPEG)).toBe(true);
    });

    it("a person limited to another project gets the missing-artifact answer", async () => {
        const r = await get(`/api/artifacts/${ids.a.shot}`, bearer(tokens.other));
        expect(r.statusCode).toBe(404);
        expect(JSON.parse(r.body).error).toBe("Artifact not found");
    });

    it("nobody signed in gets 401", async () => {
        expect((await get(`/api/artifacts/${ids.a.shot}`)).statusCode).toBe(401);
    });

    it("an older screenshot stored as a PNG keeps image/png", async () => {
        const r = await get(`/api/artifacts/${ids.a.png}`, { "x-api-key": KEY });
        expect(r.statusCode).toBe(200);
        expect(r.headers["content-type"]).toBe("image/png");
        expect(r.headers["x-content-type-options"]).toBe("nosniff");
    });
});
