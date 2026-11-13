/**
 * A browser test with generated data, run for real: the page's own requests create records in a local sample site, the script
 * writes down only those made with the run's tag, and the platform removes them afterwards through the site's delete endpoint.
 * A record whose kind has no delete endpoint is left and said with its tag.
 *
 * Browser-launching: node scripts/with-lock.mjs browser -- npx vitest run tests/testdata-web.test.ts
 * Ports: sample site 9271.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext, EngineEvent } from "../src/engine/context.js";
import { CleanupCollector, finishCleanup } from "../src/engine/cleanup/run.js";
import { playwrightGenerator } from "../src/engine/generators/playwright.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { createTestData, RUN_TAG_KEY } from "../src/engine/testdata/generate.js";
import { runScripts } from "../src/engine/validation/runner.js";

const PORT = 9271;
const BASE = `http://127.0.0.1:${PORT}`;
const courses = new Map<string, string>();
const notes = new Map<string, string>();
let next = 1;

const PAGE = `<!doctype html><html><body>
<form id="f"><label>Title <input id="title" name="title"></label><button type="submit">Save</button></form>
<button id="other">Save note without the tag</button><p id="out"></p>
<script>
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("title").value;
  const c = await post("/api/courses", { title });
  await post("/api/notes", { text: "about " + title });
  document.getElementById("out").textContent = "Saved " + c.id;
});
document.getElementById("other").addEventListener("click", async () => { await post("/api/courses", { title: "plain" }); });
</script></body></html>`;

let server: http.Server;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            const del = /^\/api\/courses\/([^/]+)$/.exec(req.url ?? "");
            if (req.method === "DELETE" && del) return void res.writeHead(courses.delete(decodeURIComponent(del[1]!)) ? 204 : 404).end();
            if (req.method === "POST" && (req.url === "/api/courses" || req.url === "/api/notes")) {
                const id = `r${next++}`;
                (req.url === "/api/courses" ? courses : notes).set(id, body);
                res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id }));
                return;
            }
            res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
        });
    });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
});
afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
});

describe("a browser test with generated data", () => {
    it("records the records it made with the tag, and cleanup removes them and names what was left", async () => {
        const data = createTestData({ seed: "web-1" });
        const title = data.value({ label: "Title" });
        const spec = TestSpecSchema.parse({
            testId: "WEB-901", title: "Create a course with generated data", kind: "web", category: "Courses", type: "functional", priority: "high",
            steps: [
                { action: "navigate", url: "/", description: "Open the form" },
                { action: "click", locator: { by: "css", value: "#other" }, description: "A save without the tag" },
                { action: "fill", locator: { by: "css", value: "#title" }, value: title, description: "Type the title" },
                { action: "click", locator: { by: "role", role: "button", value: "Save", exact: true }, description: "Save" },
                { action: "assert", check: "text", locator: { by: "css", value: "#out" }, expected: "Saved", description: "Saved" },
            ],
            expectedResults: ["Saved is shown"],
            testData: { [RUN_TAG_KEY]: data.tag },
        });
        const script = playwrightGenerator.render(spec, { baseUrl: BASE, deleteOps: ["/api/courses/{id}"] });
        expect(script.content).toContain(`const CLEANUP_TAG = "${data.tag}"`);

        const [run] = await runScripts(loadConfig({}).scratchDir, [{ testId: spec.testId, filename: script.filename, content: script.content }], { baseUrl: BASE, apiBaseUrl: BASE, headless: true, cleanup: "platform" }, { workers: 1 });
        expect(run!.status, run!.error).toBe("passed");
        const created = (run!.created ?? []).filter((l) => l.k === "created");
        // The untagged save is not written down; the tagged course and the tagged note are.
        expect(created.map((l) => l.path).sort()).toEqual(["/api/courses", "/api/notes"]);
        expect(created.every((l) => l.k === "created" && l.tag === data.tag)).toBe(true);
        expect(courses.size).toBe(2);

        const collector = new CleanupCollector(["/api/courses/{id}"]);
        collector.addRun(spec, run!);
        const events: EngineEvent[] = [];
        const ctx = { config: loadConfig({}), llm: {} as LlmClient, emit: (e: EngineEvent) => void events.push(e) } as EngineContext;
        const done = await finishCleanup(ctx, collector, { enabled: true, apiBaseUrl: BASE });
        expect([...courses.values()]).toEqual([JSON.stringify({ title: "plain" })]);
        expect(done.find((i) => i.path === "/api/courses")!.status).toBe("removed");
        expect(done.find((i) => i.path === "/api/notes")!.status).toBe("no-delete-operation");
        expect(events.at(-1)!.message).toContain(`1 record with tag ${data.tag} was left in the app.`);
    }, 120_000);

    it("a spec without generated data carries no recording", () => {
        const spec = TestSpecSchema.parse({ testId: "WEB-902", title: "Open", kind: "web", category: "x", type: "functional", priority: "low", steps: [{ action: "navigate", url: "/" }], expectedResults: ["Opens"] });
        expect(playwrightGenerator.render(spec, { baseUrl: BASE }).content).not.toContain("CLEANUP_TAG");
    });
});
