/**
 * The failure video no longer draws step titles (a strict style-src page refused the overlay's inline style). Step names must still reach
 * everything else: the run's step results (stored as they are in test_execution_steps), the live step events a runner sends, and the
 * run view's "Now:" line and screenshot captions built from those events. Real run path (runScripts) on a strict-CSP page, one failing test.
 *
 * Fixture port: 9542.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { runScripts, type LiveRunEvent } from "../src/engine/validation/runner.js";
import type { EventRow } from "../web/src/api.js";
import { currentLine, foldLiveRun } from "../web/src/features/runs/live-run.js";

const PORT = 9542;
const origin = `http://127.0.0.1:${PORT}`;
const CSP = "default-src 'self'; style-src 'self'; script-src 'self'";
let server: http.Server;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const h = { "Content-Security-Policy": CSP };
        if (req.url === "/favicon.ico") return res.writeHead(204, h).end();
        return res
            .writeHead(200, { ...h, "content-type": "text/html; charset=utf-8" })
            .end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Strict</title></head><body><main><h1>Strict page</h1><p role="status">Ready</p></main></body></html>');
    });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", () => r()));
}, 30_000);
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("step names on a strict style-src page, without the video's step captions", () => {
    it("keeps every step name in the step results, the live events and the run view", async () => {
        const spec = TestSpecSchema.parse({
            testId: "WEB-001",
            title: "The strict page says it is done",
            kind: "web",
            category: "Strict",
            steps: [
                { action: "navigate", url: "/" },
                { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Strict page", exact: true } },
                { action: "assert", check: "text", locator: { by: "role", role: "status" }, expected: "Done" },
            ],
        });
        const r = renderScript(spec, "playwright", { baseUrl: origin });
        const live: LiveRunEvent[] = [];
        const [run] = await runScripts(loadConfig({}).scratchDir, [{ testId: spec.testId, filename: r.filename, content: r.content }], { baseUrl: origin, headless: true }, { workers: 1, onLive: (e) => live.push(e) });

        expect(run!.status).toBe("failed");
        // No video is recorded (V9, owner 2026-11-24), so the step names must come from the step results and live events alone.
        expect(run!.artifacts.some((a) => a.kind === "video")).toBe(false);
        // Step results (what repo.recordExecution stores per step): one per step, each with its numbered name, the failing one included.
        expect(run!.steps.map((s) => s.index)).toEqual([0, 1, 2]);
        for (const s of run!.steps) expect(s.title).toMatch(new RegExp(`^${s.index + 1}\\.\\s+\\S`));
        expect(run!.steps[2]!.status).toBe("failed");

        // Live events carry the same names.
        const started = live.filter((e): e is Extract<LiveRunEvent, { type: "step_started" }> => e.type === "step_started");
        expect(started.map((e) => e.title)).toEqual(run!.steps.map((s) => s.title.replace(/ \(data row .*\)$/, "")));

        // The run view folds them into the "Now:" line (stored as runner_step events with the title).
        let id = 0;
        const rows: EventRow[] = started.map((e) => ({ id: ++id, stage: "validation", kind: "runner_step", level: "info", message: "", createdAt: new Date(Date.UTC(2026, 10, 14, 10, 0, id)).toISOString(), data: { testId: e.testId, index: e.index, title: e.title, state: "started" } }));
        const folded = foldLiveRun([{ id: ++id, stage: "validation", kind: "runner_test_started", level: "info", message: "", createdAt: new Date(Date.UTC(2026, 10, 14, 10, 0, 0)).toISOString(), data: { testId: "WEB-001", title: spec.title } }, ...rows]);
        expect(folded.current && currentLine(folded.current)).toBe(`${spec.title} (WEB-001), step 3: ${run!.steps[2]!.title}`);
    }, 180_000);
});
