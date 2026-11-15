/**
 * Which sign-in a run types, without a browser: a test that types the project's sign-in while the run has none fails with where to
 * enter it (spec/sign-in-needed.ts, environments/run.ts), and an environment run uses the environment's own sign-in, else the
 * project's only when the environment uses the project's accounts, is not production and is exactly the project application's origin
 * (environment-run.ts), with that sign-in on the mask list.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { missingSignIn, signInFieldsUsed } from "../src/engine/spec/sign-in-needed.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { runEnvironmentJob } from "../src/engine/environments/run.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { environmentStore, prepareEnvironmentRun } from "../src/platform/environment-run.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";

const fill = (value: string) => ({ action: "fill", locator: { by: "label", value: "Email" }, value });
const spec = (steps: unknown[], testData?: Record<string, string>) => TestSpecSchema.parse({ testId: "WEB-001", title: "Sign in", kind: "web", category: "Auth", priority: "high", steps: [{ action: "navigate", url: "/" }, ...steps], ...(testData ? { testData } : {}) });

describe("a test that types the project's sign-in", () => {
    it("names what it uses: steps, test data and a code test's variables; named accounts are not the project's sign-in", () => {
        expect([...signInFieldsUsed({ spec: spec([fill("{{credentials.username}}"), fill("{{ credentials.password }}")]) })].sort()).toEqual(["password", "username"]);
        expect([...signInFieldsUsed({ spec: spec([fill("{{who}}")], { who: "{{credentials.totp}}" }) })]).toEqual(["totp"]);
        expect([...signInFieldsUsed({ spec: spec([fill("{{credentials.admin.password}}"), fill("hello")]) })]).toEqual([]);
        const code = "await page.fill('#u', process.env.TEST_USERNAME!); await page.fill('#p', process.env.TEST_PASSWORD!); // TEST_ADMIN_PASSWORD";
        expect([...signInFieldsUsed({ spec: spec([]), custom: { content: code } })].sort()).toEqual(["password", "username"]);
    });

    it("fails with where to enter it when the run has none, and only then", () => {
        const t = { spec: spec([fill("{{credentials.username}}"), fill("{{credentials.password}}")]) };
        expect(missingSignIn("WEB-001", t, undefined)).toBe("WEB-001 signs in with the project's sign-in, and no user name and password are saved for this run, so it was not run. Enter the sign-in in Project settings → Sign-in, then run it again.");
        expect(missingSignIn("WEB-001", t, { username: "qa", password: "pw" })).toBeUndefined();
        const totp = { spec: spec([fill("{{credentials.totp}}")]) };
        expect(missingSignIn("WEB-001", totp, { username: "qa", password: "pw" })).toMatch(/no authenticator secret is saved/);
        expect(missingSignIn("WEB-001", { spec: spec([fill("plain")]) }, undefined)).toBeUndefined();
        // A user name saved without a password: the run hands the test no sign-in, and the sentence names the password.
        expect(missingSignIn("WEB-001", { spec: spec([fill("{{credentials.username}}")]) }, { username: "qa" })).toMatch(/^WEB-001 signs in with the project's sign-in, and no password is saved for this run/);
    });

    it("an environment run fails such a test with where to enter it and never runs it", async () => {
        const recorded: Array<{ status: string; reason?: string }> = [];
        const sink = { phase: async () => undefined, counters: async () => undefined, recordEnvironment: async (_h: unknown, _s: unknown, r: { status: string; reason?: string }) => void recorded.push(r) };
        const executor = { remote: false, execute: async () => { throw new Error("must not run"); } };
        const ctx = { emit: () => undefined, config: { scratchDir: os.tmpdir(), HEADLESS: true, CONCURRENCY: 1 } };
        const t = { handle: { id: "t1", testId: "WEB-001" }, spec: spec([fill("{{credentials.username}}"), fill("{{credentials.password}}")]) };
        const summary = await runEnvironmentJob(ctx as never, { target: { name: "staging", production: false, baseUrl: "https://staging.shop.example/", credentials: { username: "stage" }, vars: {} }, render: { baseUrl: "https://shop.example" }, executor: executor as never, signInWhere: "HERE" }, [t as never], sink as never);
        expect(recorded).toEqual([{ environment: "staging", status: "failed", reason: "WEB-001 signs in with the project's sign-in, and no password is saved for this run, so it was not run. Enter the sign-in in HERE, then run it again." }]);
        expect(summary.testsFailedValidation).toBe(1);
    });
});

describe("the sign-in of an environment run", () => {
    let platform: Platform;
    let dataDir = "";
    beforeAll(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sign-in-run-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", SECRET_KEY: "sign-in-run-unit-secret-0123456789" }));
    });
    afterAll(() => {
        platform?.db.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    const PROJECT = { username: "qa@shop.example", password: "Proj3ct-Pw-91aa", totpSecret: "JBSWY3DPEHPK3PXP" };
    const prepare = async (env: { baseUrl: string; useProjectAccounts?: boolean; production?: boolean; own?: { username: string; password: string } }, appUrl = "https://shop.example/") => {
        const { repo } = platform;
        const projectId = String(repo.createProject({ name: `Env ${Math.random()}` }).id);
        const appId = repo.createApplication(projectId, appUrl, { ...DEFAULT_JOB_OPTIONS }, PROJECT);
        const store = environmentStore(repo, platform.config);
        const e = store.create(projectId, { name: "staging", baseUrl: env.baseUrl, production: env.production ?? false, useProjectAccounts: env.useProjectAccounts ?? true, variables: {} });
        if (env.own) store.patchSecrets(e, env.own);
        const job = await repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "environment", environment: "staging", testIds: [], ...(env.production ? { confirmProduction: true } : {}) } as never);
        const app = repo.getApplication(appId)!;
        const prepared = await prepareEnvironmentRun(repo, platform.config, job, app, []);
        repo.setJobStatus(job.id, "FAILED", "test over");
        return prepared;
    };
    const borrowed = (r: Awaited<ReturnType<typeof prepare>>) => r.request.target.credentials?.password === PROJECT.password;

    it("uses the environment's own sign-in when it has one", async () => {
        const r = await prepare({ baseUrl: "https://shop.example/", own: { username: "stage", password: "Stag1ng-Pw-0c" } });
        expect(r.request.target.credentials).toMatchObject({ username: "stage", password: "Stag1ng-Pw-0c" });
    });

    it("else the project's sign-in on exactly the project's origin with the project's accounts on, and masks it", async () => {
        const r = await prepare({ baseUrl: "https://shop.example/eu/" });
        expect(r.request.target.credentials).toMatchObject(PROJECT);
        expect(r.secrets).toEqual(expect.arrayContaining([PROJECT.password, PROJECT.totpSecret]));
        expect(r.request.signInWhere).toBe("the environment “staging” (Environments), or in Project settings → Sign-in");
    });

    it("never sends the project's sign-in to another origin: a shared host's neighbour, another host of the site, another port or scheme", async () => {
        const cases: Array<[string, string]> = [
            ["https://myshop.vercel.app/", "https://attacker.vercel.app/"],
            ["https://myshop.herokuapp.com/", "https://attacker.herokuapp.com/"],
            ["https://myshop.github.io/", "https://attacker.github.io/"],
            ["https://myshop.azurewebsites.net/", "https://attacker.azurewebsites.net/"],
            ["https://shop.example/", "https://staging.shop.example/"],
            ["https://shop.example/", "https://shop.example:8443/"],
            ["https://shop.example/", "http://shop.example/"],
            ["http://127.0.0.1:9793/", "http://127.0.0.1:9794/"],
        ];
        for (const [appUrl, envUrl] of cases) {
            const r = await prepare({ baseUrl: envUrl }, appUrl);
            expect(borrowed(r), `${appUrl} -> ${envUrl}`).toBe(false);
            expect(r.request.signInWhere).toBe("the settings of the environment “staging” (Environments): the project's sign-in is not sent to an address other than the project's own");
        }
    });

    it("never sends it when the project's accounts are off, or to a production environment", async () => {
        const off = await prepare({ baseUrl: "https://shop.example/", useProjectAccounts: false });
        expect(borrowed(off)).toBe(false);
        expect(off.request.signInWhere).toBe("the environment “staging” (Environments), or in Project settings → Sign-in with “Use the project's accounts” on");
        const production = await prepare({ baseUrl: "https://shop.example/", production: true });
        expect(borrowed(production)).toBe(false);
        expect(production.request.signInWhere).toBe("the settings of the environment “staging” (Environments): the project's sign-in is not sent to a production environment");
    });
});
