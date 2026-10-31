/**
 * UXP item 3: honest summary numbers. One pass-rate rule (passed / tests that produced a verdict in that run), and every place
 * that shows it says what it is made of. The audit's contradiction is rebuilt here: the last run passed 3 of 3, while 2 other tests
 * could not be validated and are not part of that run. No browser, no network: the platform's own data and routes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { describeRun, passRate } from "../src/engine/summary/pass-rate.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { gatherReport, renderReportHtml } from "../src/platform/reports/project-report.js";
import { buildServer } from "../src/platform/server.js";
import { addTest, seedProject, seedRun } from "./fixtures/dashboard-seed.js";

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dir: string;
let projectId: string;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-ux-numbers-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir }));
    server = await buildServer(platform);
    // The audit's picture: an older run left two tests unvalidated; the latest run covered only the three that were fine.
    const seed = seedProject(platform, "Numbers shop");
    projectId = seed.projectId;
    for (const k of ["a", "b", "c", "d", "e"]) addTest(platform, seed, k);
    await seedRun(platform, seed, { a: "pass", b: "pass", c: "pass", d: "fail", e: "fail" }, { daysAgo: 2 });
    await seedRun(platform, seed, { a: "pass", b: "pass", c: "pass" }, { daysAgo: 1 });
});

afterAll(async () => {
    await server?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const get = async (url: string) => {
    const res = await server.inject({ method: "GET", url });
    return { status: res.statusCode, body: res.body && /^[{[]/.test(res.body) ? JSON.parse(res.body) : res.body } as { status: number; body: any };
};

describe("one rule, one sentence", () => {
    it("the rate is passed over the tests that produced a verdict, one decimal, null when none did", () => {
        expect(passRate(17, 17)).toBe(100);
        expect(passRate(2, 3)).toBe(66.7);
        expect(passRate(0, 0)).toBeNull();
    });

    it("the sentence names the denominator and what is left out", () => {
        expect(describeRun({ passed: 17, findings: 0, failed: 0 }).sentence).toBe("17 of 17 tests that ran passed.");
        expect(describeRun({ passed: 15, findings: 1, failed: 1 }).sentence).toBe("15 of 17 tests that ran passed, 1 found a problem and 1 could not be run.");
        expect(describeRun({ passed: 1, findings: 0, failed: 0 }).sentence).toBe("1 of 1 test that ran passed.");
        expect(describeRun({ passed: 0, findings: 0, failed: 0 }).sentence).toBe("No test produced a result in that run.");
        const f = describeRun({ passed: 17, findings: 0, failed: 0 }, { total: 23, couldNotValidate: 6, needsAttention: 0, unreliable: 16 });
        expect(f.others).toBe("6 other tests did not take part in that run. Across all 23 tests right now, 6 could not be run, 16 are unreliable.");
        // Nothing to add when the run covered everything and nothing else is wrong.
        expect(describeRun({ passed: 5, findings: 0, failed: 0 }, { total: 5, couldNotValidate: 0, needsAttention: 0 }).others).toBe("");
    });
});

describe("every place that shows the number says the same thing", () => {
    const SENTENCE = "3 of 3 tests that ran passed.";
    const OTHERS = "2 other tests did not take part in that run. Across all 5 tests right now, 2 could not be run.";

    it("the dashboard", async () => {
        const d = (await get("/api/dashboard")).body;
        const p = d.projects.find((x: any) => x.id === projectId);
        expect(p.latestRun).toMatchObject({ passRate: 100, total: 3, validated: 3, sentence: SENTENCE, others: OTHERS });
        expect(p.tests).toMatchObject({ total: 5, validated: 3, couldNotValidate: 2 });
    });

    it("the release sign-off, and its printed report", async () => {
        const made = await server.inject({ method: "POST", url: `/api/projects/${projectId}/releases`, payload: { name: "Release 1" } });
        expect(made.statusCode).toBe(201);
        const rid = JSON.parse(made.body).id as string;
        const v = (await get(`/api/projects/${projectId}/releases/${rid}`)).body;
        expect(v.automated.latestRun).toMatchObject({ passRate: 100, sentence: SENTENCE, others: OTHERS });
        const html = (await get(`/api/projects/${projectId}/releases/${rid}/report`)).body as string;
        expect(html).toContain(`Last run: ${SENTENCE} ${OTHERS}`);
        expect(html).not.toMatch(/Last run: 100% passed/);
    });

    it("the project report says what its percentage is a share of, and what it leaves out", async () => {
        const seed = seedProject(platform, "Report shop");
        for (const k of ["a", "b", "c"]) addTest(platform, seed, k);
        await seedRun(platform, seed, { a: "pass", b: "fail" });
        const d = (await gatherReport(platform.repo, platform.store, seed.projectId))!;
        expect(d).toMatchObject({ passRate: 50, ran: 2 });
        const html = renderReportHtml(d);
        expect(html).toContain("passed, of the 2 tests with a result");
        expect(html).toContain("The pass rate counts only tests that have a result");
        expect(html).toContain("1 test has not been run yet and is left out.");
    });

    it("the run summary and the API agree with the rule", async () => {
        const jobs = (await get(`/api/projects/${projectId}/runs/${platform.repo.listJobs(projectId)[0]!.id}/summary`)).body;
        expect(jobs).toMatchObject({ total: 3, validated: 3, passRate: 100 });
        const older = (await get(`/api/projects/${projectId}/runs/${platform.repo.listJobs(projectId)[1]!.id}/summary`)).body;
        expect(older).toMatchObject({ total: 5, validated: 3, failed: 2, passRate: 60 });
    });
});
