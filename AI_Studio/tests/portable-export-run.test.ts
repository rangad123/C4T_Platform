/**
 * A downloaded project really runs on its own (docs/features/portable-code-tests.md): scripts/portable-check.mjs starts the platform on a
 * new data folder and the sample app, makes the sample project (five tests from steps, a code test with a shared helper), downloads it
 * through the platform's route, unpacks it into a folder with a space and brackets in its name, links this checkout's node_modules
 * instead of `npm ci` (no internet in tests) and runs the download's own playwright.config.ts with the Playwright installed here.
 * The oldest and the newest Playwright on Linux, Windows and macOS: the portable-exports job of .github/workflows/runner-matrix.yml.
 *
 * Starts the platform and a browser: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/portable-export-run.test.ts
 * Ports: 6962 (platform), 6963 (sample app).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript script (no type declarations)
import { EXPECTED_TESTS, renderReport, runCheck } from "../scripts/portable-check.mjs";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

describe("a downloaded project, run like a tester runs it", () => {
    it("exports the sample project and every test passes with the download's own config and the Playwright installed here", async () => {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-portable-run-"));
        const report = await runCheck({ port: 6962, out, linkNodeModules: true, exportOnly: false, keep: false, installDeps: false });
        const text = renderReport(report);
        expect(report.verdict, text).toBe("passed");
        expect(report.results).toEqual({ passed: EXPECTED_TESTS, failed: 0, skipped: 0, failures: [] });
        expect(report.playwright).toBe(JSON.parse(fs.readFileSync(path.join(REPO, "node_modules", "@playwright", "test", "package.json"), "utf8")).version);
        expect(report.steps.map((s: { name: string }) => s.name)).toContain("Check the download carries what a tester needs");
        expect(text).toContain("unpacked with");
        // the platform's access key never reaches the report or the logs
        for (const f of fs.readdirSync(out)) expect(fs.readFileSync(path.join(out, f), "utf8"), f).not.toMatch(/portable-[0-9a-f]{36}/);
        // only the link was removed: this checkout's packages are still there
        expect(fs.existsSync(path.join(REPO, "node_modules", "@playwright", "test", "package.json"))).toBe(true);
        fs.rmSync(out, { recursive: true, force: true });
    }, 600_000);
});
