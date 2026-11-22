/**
 * The quality history's confirmed bugs (Phase 6 X2, dashboard.ts projectQuality) count moves to Confirmed, not the notes the engine
 * writes on a finding that stays Confirmed (a fix claimed, "still reproduces"). Found by the PR bench's G7. Real platform, no browser.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { findingFingerprint } from "../src/engine/explore/finding.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { projectQuality } from "../src/platform/dashboard.js";

let platform: Platform;
let dir = "";
beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-quality-confirm-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "quality-confirm-secret-key-0123456789", SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
});
afterAll(() => {
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("the quality history's confirmations", () => {
    it("are moves to Confirmed: a note on a Confirmed finding is not one, a confirmation after a reopen is", async () => {
        const projectId = String(platform.repo.createProject({ name: "History shop" }).id);
        const store = new CandidateFindingStore(platform.sql);
        const finding = {
            objective: { id: "obj-1", kind: "rule" as const, source: "4.1" },
            actions: { stepCount: 1 },
            expected: { text: "The total is right.", source: "4.1" },
            observed: "It is not.",
            evidence: { screenshots: [], requests: [], console: [] },
            capture: "captured" as const,
            independence: "independent" as const,
            confidence: "high" as const,
            fingerprint: findingFingerprint({ source: "4.1", expected: "The total is right.", scenario: "s" }),
            modelVersion: null,
            replays: [{ label: "Replay 1", outcome: "failed" as const, failedStep: 1, summary: "Stopped at the total check" }],
        };
        const { finding: f } = await store.upsert({ projectId, finding });
        const high = { confidence: { confidence: "high", factors: [] } as never };
        await store.transition(projectId, f.id, { to: "verification_pending", by: "engine" });
        await store.transition(projectId, f.id, { to: "reproduced", by: "engine", set: high });
        await store.transition(projectId, f.id, { to: "confirmed", by: "engine" });
        // The engine's notes on a Confirmed finding: it stays Confirmed.
        await store.note(projectId, f.id, { by: "engine", reason: "Fix claimed by pull request #7: it is checked on the fixed build." });
        await store.note(projectId, f.id, { by: "engine", reason: "Fix claimed — still reproduces." });
        await store.transition(projectId, f.id, { to: "fixed", by: "engine", reason: "Fixed: it passed in 3 of 3 attempts." });
        await store.transition(projectId, f.id, { to: "verification_pending", by: "engine", reason: "Reopened: the bug came back." });
        await store.transition(projectId, f.id, { to: "reproduced", by: "engine", set: high });
        await store.transition(projectId, f.id, { to: "confirmed", by: "engine" });
        const h = (await projectQuality(platform, projectId)).history;
        expect(h.discovery.confirmed).toBe(2);
        expect(h.regressions).toEqual({ reopened: 1, findings: 1 });
    });
});
