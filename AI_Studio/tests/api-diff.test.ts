/** OpenAPI diff: each kind of change is classified as breaking or not, and identical specs differ in nothing. */
import { describe, expect, it } from "vitest";
import { diffOpenApi, renderDiffMarkdown } from "../src/engine/contracts/diff.js";

const user = (extra: Record<string, unknown> = {}, required = ["id", "email"]) => ({
    type: "object",
    required,
    properties: { id: { type: "integer" }, email: { type: "string" }, role: { type: "string", enum: ["user", "admin"] }, ...extra },
});

const api = (over: Record<string, any> = {}) => ({
    openapi: "3.0.0",
    paths: {
        "/users": {
            get: {
                parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
                responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "array", items: user() } } } } },
            },
            post: {
                requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["email"], properties: { email: { type: "string" }, name: { type: "string" } } } } } },
                responses: { "201": { description: "created" } },
            },
        },
        "/users/{id}": {
            get: { parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }], responses: { "200": { description: "ok", content: { "application/json": { schema: user() } } }, "404": { description: "nf" } } },
        },
    },
    ...over,
});

const messages = (d: ReturnType<typeof diffOpenApi>) => ({ breaking: d.breaking.map((c) => `${c.operation}: ${c.message}`), other: d.nonBreaking.map((c) => `${c.operation}: ${c.message}`) });
const mutate = (fn: (doc: any) => void) => {
    const doc = api();
    fn(doc);
    return diffOpenApi(api(), doc);
};

describe("diffOpenApi", () => {
    it("finds no change between identical descriptions", () => {
        expect(diffOpenApi(api(), api())).toEqual({ breaking: [], nonBreaking: [] });
    });

    it("treats differently named path parameters as the same endpoint", () => {
        const d = mutate((doc) => {
            doc.paths["/users/{userId}"] = { get: { ...doc.paths["/users/{id}"].get, parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }] } };
            delete doc.paths["/users/{id}"];
        });
        expect(d).toEqual({ breaking: [], nonBreaking: [] });
    });

    it("operation removed / added", () => {
        const removed = mutate((doc) => delete doc.paths["/users/{id}"]);
        expect(messages(removed).breaking).toEqual(["GET /users/{}: this operation was removed"]);
        const added = mutate((doc) => (doc.paths["/health"] = { get: { responses: { "200": { description: "ok" } } } }));
        expect(messages(added)).toEqual({ breaking: [], other: ["GET /health: new operation"] });
    });

    it("response field removed, retyped, no longer guaranteed (breaking) / added (not)", () => {
        const item = (doc: any) => doc.paths["/users"].get.responses["200"].content["application/json"].schema.items;
        expect(messages(mutate((doc) => delete item(doc).properties.email)).breaking).toEqual(["GET /users: response field [].email was removed"]);
        expect(messages(mutate((doc) => (item(doc).properties.id = { type: "string" }))).breaking).toEqual(["GET /users: response [].id changed type from integer to string"]);
        expect(messages(mutate((doc) => (item(doc).required = ["id"]))).breaking).toEqual(["GET /users: response field [].email is no longer always present"]);
        const added = mutate((doc) => (item(doc).properties.avatar = { type: "string" }));
        expect(added.breaking).toEqual([]);
        expect(messages(added).other).toEqual(["GET /users: new response field [].avatar"]);
    });

    it("response enum widened is breaking, narrowed is not", () => {
        const item = (doc: any) => doc.paths["/users"].get.responses["200"].content["application/json"].schema.items.properties.role;
        expect(messages(mutate((doc) => (item(doc).enum = ["user", "admin", "owner"]))).breaking[0]).toMatch(/can now also be owner/);
        const narrowed = mutate((doc) => (item(doc).enum = ["user"]));
        expect(narrowed.breaking).toEqual([]);
        expect(narrowed.nonBreaking[0]!.message).toMatch(/can no longer be admin/);
    });

    it("request side: new required field/param, removed param, now-required, narrowed enum", () => {
        const body = (doc: any) => doc.paths["/users"].post.requestBody.content["application/json"].schema;
        expect(messages(mutate((doc) => { body(doc).properties.age = { type: "integer" }; body(doc).required.push("age"); })).breaking).toEqual(["POST /users: new required request field age"]);
        expect(messages(mutate((doc) => (body(doc).required = ["email", "name"]))).breaking).toEqual(["POST /users: request field name is now required"]);
        expect(messages(mutate((doc) => delete body(doc).properties.name)).breaking).toEqual([]); // dropping an input is harmless to clients
        expect(messages(mutate((doc) => doc.paths["/users"].get.parameters.push({ name: "sort", in: "query", required: true, schema: { type: "string" } }))).breaking).toEqual(['GET /users: new required query parameter "sort"']);
        expect(messages(mutate((doc) => doc.paths["/users"].get.parameters.push({ name: "sort", in: "query", schema: { type: "string" } }))).other).toEqual(['GET /users: new optional query parameter "sort"']);
        expect(messages(mutate((doc) => (doc.paths["/users"].get.parameters = []))).breaking).toEqual(['GET /users: query parameter "limit" was removed']);
        expect(messages(mutate((doc) => (doc.paths["/users"].get.parameters[0].required = true))).breaking).toEqual(['GET /users: query parameter "limit" is now required']);
    });

    it("success status removed is breaking; error status removed is not", () => {
        expect(messages(mutate((doc) => delete doc.paths["/users"].post.responses["201"])).breaking).toEqual(["POST /users: success response 201 is no longer documented"]);
        const nf = mutate((doc) => delete doc.paths["/users/{id}"].get.responses["404"]);
        expect(nf.breaking).toEqual([]);
        expect(nf.nonBreaking).toHaveLength(1);
    });

    it("authentication newly required is breaking", () => {
        expect(messages(mutate((doc) => (doc.paths["/users"].get.security = [{ bearer: [] }]))).breaking).toEqual(["GET /users: authentication is now required"]);
        const loosened = diffOpenApi(mutateDoc((d) => (d.paths["/users"].get.security = [{ bearer: [] }])), api());
        expect(loosened.breaking).toEqual([]);
        expect(loosened.nonBreaking[0]!.message).toMatch(/no longer required/);
    });

    it("understands Swagger 2 bodies and references", () => {
        const swagger = (extra: Record<string, unknown> = {}) => ({
            swagger: "2.0",
            definitions: { Pet: { type: "object", required: ["name"], properties: { name: { type: "string" }, ...extra } } },
            paths: { "/pets": { post: { parameters: [{ name: "body", in: "body", required: true, schema: { $ref: "#/definitions/Pet" } }], responses: { "200": { description: "ok", schema: { $ref: "#/definitions/Pet" } } } } } },
        });
        const d = diffOpenApi(swagger(), swagger({ tag: { type: "string" } }));
        expect(d.breaking).toEqual([]);
        expect(d.nonBreaking.map((c) => c.message).sort()).toEqual(["new request field tag", "new response field tag"]);
        expect(diffOpenApi(swagger({ tag: { type: "string" } }), swagger()).breaking.map((c) => c.message)).toEqual(["response field tag was removed"]);
    });

    it("renders readable Markdown", () => {
        const md = renderDiffMarkdown(mutate((doc) => delete doc.paths["/users/{id}"]));
        expect(md).toContain("### Breaking changes (1)");
        expect(md).toContain("`GET /users/{}`: this operation was removed");
        expect(md).toContain("### Other changes\n\nNone.");
    });
});

function mutateDoc(fn: (d: any) => void) {
    const d = api();
    fn(d);
    return d;
}

// ── CLI and API ──────────────────────────────────────────────────────────────
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

describe("ai-test api-diff", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-apidiff-"));
    const write = (name: string, doc: unknown) => {
        const f = path.join(dir, name);
        fs.writeFileSync(f, JSON.stringify(doc));
        return f;
    };
    const run = (...args: string[]) => spawnSync(process.execPath, [path.join(REPO_ROOT, "bin/ai-test.mjs"), "api-diff", ...args], { encoding: "utf8", cwd: dir });
    const v1 = write("v1.json", api());
    const same = write("same.json", api());
    const additive = write("additive.json", mutateDoc((d) => (d.paths["/health"] = { get: { responses: { "200": { description: "ok" } } } })));
    const breaking = write("breaking.json", mutateDoc((d) => delete d.paths["/users/{id}"]));

    it("exits 0 when nothing breaks and 1 when something does", () => {
        expect(run(v1, same).status).toBe(0);
        const ok = run(v1, additive);
        expect(ok.status).toBe(0);
        expect(ok.stdout).toContain("0 breaking, 1 other");
        const bad = run(v1, breaking);
        expect(bad.status).toBe(1);
        expect(bad.stdout).toContain("BREAKING  GET /users/{}: this operation was removed");
        expect(bad.stderr).toContain("gate failed");
    });

    it("--fail-on any fails on additive changes; none never fails", () => {
        expect(run(v1, additive, "--fail-on", "any").status).toBe(1);
        expect(run(v1, breaking, "--fail-on", "none").status).toBe(0);
    });

    it("writes JSON and Markdown reports", () => {
        run(v1, breaking, "--json", "out/report.json", "--markdown", "out/report.md");
        expect(JSON.parse(fs.readFileSync(path.join(dir, "out/report.json"), "utf8")).breaking).toHaveLength(1);
        expect(fs.readFileSync(path.join(dir, "out/report.md"), "utf8")).toContain("### Breaking changes (1)");
    });

    it("exits 2 on usage and infrastructure problems", () => {
        expect(run().status).toBe(2);
        expect(run(v1).status).toBe(2);
        expect(run(v1, path.join(dir, "missing.json")).stderr).toContain("File not found");
        const junk = path.join(dir, "junk.json");
        fs.writeFileSync(junk, "not an api description at all: [");
        expect(run(v1, junk).status).toBe(2);
        expect(run(v1, same, "--fail-on", "sometimes").stderr).toContain("--fail-on must be");
        expect(run(v1, same, "--bogus", "x").stderr).toContain("Unknown option");
    });
});

describe("POST /api/projects/:id/api-diff", () => {
    it("compares documents, and refuses bad input and (when enabled) private addresses", async () => {
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-apidiff-api-"));
        const platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic" }));
        const server = await buildServer(platform);
        try {
            const call = async (url: string, payload: unknown) => {
                const r = await server.inject({ method: "POST", url, payload: payload as never });
                return { status: r.statusCode, body: r.json() as any };
            };
            const { id } = (await call("/api/projects", { name: "diff" })).body;
            const ok = await call(`/api/projects/${id}/api-diff`, { old: api(), new: JSON.stringify(mutateDoc((d) => delete d.paths["/users/{id}"])) });
            expect(ok.status).toBe(200);
            expect(ok.body.summary).toEqual({ breaking: 1, nonBreaking: 0 });
            expect(ok.body.markdown).toContain("this operation was removed");

            expect((await call(`/api/projects/${id}/api-diff`, { old: "not openapi: [", new: api() })).status).toBe(422);
            expect((await call(`/api/projects/${id}/api-diff`, { old: api() })).status).toBe(400);
            expect((await call(`/api/projects/nope/api-diff`, { old: api(), new: api() })).status).toBe(404);

            process.env.BLOCK_PRIVATE_TARGETS = "true";
            const blocked = await call(`/api/projects/${id}/api-diff`, { old: "http://127.0.0.1:9/openapi.json", new: api() });
            expect(blocked.status).toBe(400);
            expect(blocked.body.error).toMatch(/private/i);
        } finally {
            delete process.env.BLOCK_PRIVATE_TARGETS;
            await server.close();
            platform.db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
