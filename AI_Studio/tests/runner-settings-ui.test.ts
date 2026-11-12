/**
 * Your runner in Settings (round 45, docs/features/runner-settings.md), in a real browser against the real built UI (web/dist) and a
 * real platform underneath: one runner per person, set up once in Settings. The states (not set up, waiting for the computer,
 * connected, offline, needs an update), the download (`POST /api/me/runner/download` with exactly `{ os, arch }`, the code never on
 * the page), the server's refusal sentences shown as they are, the switches, rename, Remove this computer, Update now, and the
 * admins' list of everyone's runners. Also the pure rules behind the download step.
 *
 * Most tests stand in for the `/api/me/runner*` and `/api/admin/runners*` routes with browser routes shaped like the contract, so
 * every state can be driven; the last part takes the stand-ins away and uses the real routes, with a fake agent speaking the real
 * protocol (open mode: the server acts as one person, who may do everything). A sign-in inside the runner's check or proxy never
 * reaches the page.
 *
 * Requires web/dist (build inside the web-build lock):
 *   node scripts/with-lock.mjs web-build -- node node_modules/vite/bin/vite.js build web
 *   TAQWRIGHT_HOME=/nonexistent-taqwright node scripts/with-lock.mjs browser -- npx vitest run tests/runner-settings-ui.test.ts
 * Ports: platform 8781.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect as pwExpect } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { OPEN_OWNER_ID } from "../src/platform/agent-store.js";
import { defaultCaps, FakeAgent, viaFetch } from "./fixtures/fake-agent.js";
import { guessSystem, startSteps, systemAvailable, type RunnerMine } from "../web/src/features/runners/my-runner.js";
import { offlineSteps } from "../web/src/features/runners/runners.js";
import { resolveAlias } from "../web/src/lib/aliases.js";

const PORT = 8781;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET_CODE = "aite_ONETIMECODE0123456789abcdefghijklmnopqrstu";

describe("the rules (no browser)", () => {
    it("guesses the system and processor from the browser", () => {
        expect(guessSystem({ platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" })).toEqual({ os: "windows", arch: "x64" });
        expect(guessSystem({ platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" })).toEqual({ os: "mac", arch: "arm64" });
        expect(guessSystem({ platform: "Linux aarch64", userAgent: "Mozilla/5.0 (X11; Linux aarch64)" })).toEqual({ os: "linux", arch: "arm64" });
        expect(guessSystem({ platform: "", userAgent: "" })).toEqual({ os: "windows", arch: "x64" });
    });

    it("reads which systems can be downloaded, with the server's reason", () => {
        const info = { available: true, systems: [{ os: "windows" as const, arch: "x64" as const, available: true, kind: "installer" as const }, { os: "mac" as const, arch: "x64" as const, available: false, reason: "The Mac app for Intel is not built here." }] };
        expect(systemAvailable(info, "windows", "x64")).toEqual({ ok: true });
        expect(systemAvailable(info, "mac", "x64")).toEqual({ ok: false, reason: "The Mac app for Intel is not built here." });
        expect(systemAvailable(info, "linux", "x64").ok).toBe(false);
        expect(systemAvailable({ available: false, reason: "Not built." }, "windows")).toEqual({ ok: false, reason: "Not built." });
        expect(systemAvailable(undefined, "linux").ok).toBe(true);
    });

    it("says what to do on each system, and how to bring a runner back", () => {
        expect(startSteps("windows").steps.join(" ")).toContain("AITestingRunnerSetup.exe");
        // Round 49: the Windows download is the setup program itself.
        expect(startSteps("windows").steps.join(" ")).not.toMatch(/Unzip/);
        expect(startSteps("mac").steps.join(" ")).toContain("AI Testing Runner");
        expect(startSteps("linux").command).toBe("sh ai-testing-runner.sh");
        expect(startSteps("linux").steps.join(" ")).not.toMatch(/Unzip/);
        expect(startSteps("mac").steps.join(" ")).toContain("Open the download, then open “AI Testing Runner”");
        expect(startSteps("mac").steps.join(" ")).toContain("Open Anyway");
        expect(startSteps("windows", "files").steps.join(" ")).toContain("start-runner.cmd");
        expect(offlineSteps("windows")[0]).toContain("notification area");
    });

    it("sends every old runner link to Your runner in Settings", () => {
        const q = (s = "") => new URLSearchParams(s);
        expect(resolveAlias(["runners"], q())).toBe("#/settings#runner");
        expect(resolveAlias(["runners", "tok-1"], q())).toBe("#/settings#runner");
        expect(resolveAlias(["runners"], q("add=computer"))).toBe("#/settings#runner");
        expect(resolveAlias(["settings"], q("section=runners"))).toBe("#/settings#runner");
        expect(resolveAlias(["projects", "p1", "runners"], q())).toBe("#/settings#runner");
        expect(resolveAlias(["projects", "p1", "settings"], q("section=runners"))).toBe("#/settings#runner");
        expect(resolveAlias(["projects", "p1", "setup"], q("section=runners"))).toBe("#/settings#runner");
        expect(resolveAlias(["settings"], q())).toBeNull();
    });
});

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;
let browser: Browser;
let page: Page;
const consoleErrors: string[] = [];

const runnerOf = (over: Partial<RunnerMine> = {}): RunnerMine => ({
    id: "tok-mine",
    name: "Office laptop",
    status: "online",
    lastSeenAt: new Date().toISOString(),
    os: "win32",
    arch: "x64",
    hostname: "PRIYA-LT",
    version: "2.1.0",
    switches: { codeScripts: true, privateTargets: false, realPhone: false },
    network: "Connects directly, no proxy.",
    ...over,
});

const fake = {
    mine: null as RunnerMine | null,
    info: { available: true, platformUrl: "https://tests.example.com", urlOk: true, nodeMin: 24, mayDownload: true, systems: [] as Array<Record<string, unknown>> } as Record<string, unknown>,
    infoStatus: 200,
    download: { status: 200, error: "" },
    enrollment: "waiting" as "waiting" | "connected" | "expired" | "used",
    admin: null as null | Array<Record<string, unknown>>,
    canSeeEveryone: undefined as boolean | undefined,
    /** Permissions the page is told the person has (null: as the platform answers, open mode: everything). */
    permissions: null as string[] | null,
};
const adminCalls: string[] = [];
const calls: Array<{ method: string; path: string; body: unknown }> = [];

beforeAll(async () => {
    if (!fs.existsSync(path.join(REPO_ROOT, "web/dist/index.html"))) throw new Error("web/dist is missing: build the UI first (see the header of this file)");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-runner-settings-ui-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "runner-settings-ui-secret-0123456789", HOST: "127.0.0.1", PORT: String(PORT), WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    page = await context.newPage();
    page.on("console", (m) => {
        if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
        if (m.text().includes(SECRET_CODE)) consoleErrors.push("the one-time code reached the console");
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    const record = (route: Parameters<Parameters<Page["route"]>[1]>[0]) => {
        const req = route.request();
        let body: unknown = null;
        try {
            body = req.postDataJSON();
        } catch {
            body = req.postData();
        }
        calls.push({ method: req.method(), path: new URL(req.url()).pathname, body });
    };
    await page.route("**/api/me/runner", async (route) => {
        record(route);
        const m = route.request().method();
        if (m === "PATCH" && fake.mine) {
            const b = route.request().postDataJSON() as { name?: string; switches?: Partial<RunnerMine["switches"]> };
            fake.mine = { ...fake.mine, ...(b.name ? { name: b.name } : {}), switches: { ...fake.mine.switches, ...(b.switches ?? {}) } };
        }
        // canSeeEveryone: the server lets this person see every runner (a missing field means no).
        await route.fulfill({ json: { runner: fake.mine, ...(fake.canSeeEveryone === undefined ? {} : { canSeeEveryone: fake.canSeeEveryone }) } });
    });
    await page.route("**/api/me/runner/retire", async (route) => {
        record(route);
        fake.mine = null;
        await route.fulfill({ json: { ok: true } });
    });
    await page.route("**/api/me/runner/update", async (route) => {
        record(route);
        if (fake.mine?.update) fake.mine = { ...fake.mine, update: { ...fake.mine.update, requested: true } };
        await route.fulfill({ json: { ok: true } });
    });
    await page.route("**/api/me/runner/download/info", (route) => route.fulfill({ status: fake.infoStatus, json: fake.info }));
    await page.route("**/api/me/runner/download", async (route) => {
        record(route);
        if (fake.download.status !== 200) return route.fulfill({ status: fake.download.status, json: { error: fake.download.error } });
        await route.fulfill({
            status: 200,
            body: Buffer.from(`#!/bin/sh stand-in runner.enroll=${SECRET_CODE}`),
            headers: {
                "content-type": "application/x-sh",
                "content-disposition": 'attachment; filename="ai-testing-runner.sh"',
                "x-runner-enrollment-id": "enr-1",
                "x-runner-enrollment-expires": new Date(Date.now() + 30 * 60_000).toISOString(),
                "x-runner-kit-kind": "files",
            },
        });
    });
    await page.route("**/api/me/runner/enrollments/*", (route) => route.fulfill({ json: { status: fake.enrollment } }));
    await page.route("**/api/admin/runners", (route) => {
        adminCalls.push(route.request().method());
        return fake.admin ? route.fulfill({ json: { runners: fake.admin } }) : route.fulfill({ status: 403, json: { error: "Not allowed" } });
    });
    await page.route("**/api/auth/state", async (route) => {
        const res = await route.fetch();
        const json = await res.json();
        if (!fake.permissions) return route.fulfill({ response: res, json });
        await route.fulfill({ response: res, json: { ...json, me: { ...(json.me ?? { kind: "open", name: "Open access", role: "owner" }), permissions: fake.permissions } } });
    });
    await page.route("**/api/admin/runners/*/retire", async (route) => {
        record(route);
        const id = new URL(route.request().url()).pathname.split("/").at(-2);
        fake.admin = (fake.admin ?? []).filter((r) => r.id !== id);
        await route.fulfill({ json: { ok: true } });
    });
}, 120_000);

afterAll(async () => {
    await browser?.close();
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const section = () => page.getByTestId("your-runner");
const visit = async (hash = "#/settings#runner") => {
    await page.goto("about:blank");
    await page.goto(`${BASE}/${hash}`);
    await pwExpect(section()).toBeVisible({ timeout: 20_000 });
};
async function axeBoth() {
    for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(300);
        const result = await new AxeBuilder({ page }).include('[data-testid="your-runner"]').analyze();
        expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: null });
}

describe("not set up", () => {
    it("explains what a runner is and offers the download for this computer", async () => {
        fake.mine = null;
        await visit();
        await pwExpect(section()).toHaveAttribute("data-state", "not-set-up");
        await pwExpect(section()).toContainText("A runner is the program on your computer that runs your tests.");
        await pwExpect(section().getByText("Not set up", { exact: true })).toBeVisible();
        // One button for the computer the browser is on (headless Chromium here is Linux on an Intel or AMD processor); the choice is folded away.
        await pwExpect(section().getByRole("button", { name: "Download for Linux" })).toBeEnabled();
        await pwExpect(section().getByLabel("System")).toBeHidden();
        await section().getByText("For another computer?", { exact: true }).click();
        await pwExpect(section().getByLabel("System")).toHaveValue("linux");
        await pwExpect(section().getByLabel("Processor")).toHaveValue("x64");
        await axeBoth();
    }, 60_000);

    it("shows the server's refusal instead of the button when the person may not download", async () => {
        fake.info = { ...fake.info, mayDownload: false, refusal: "Sign in with your own account to set up your runner." };
        await visit();
        await pwExpect(section().getByTestId("runner-download-refused")).toHaveText("Sign in with your own account to set up your runner.");
        await pwExpect(section().getByRole("button", { name: /Download for/ })).toHaveCount(0);
        fake.info = { ...fake.info, mayDownload: true, refusal: undefined };
    }, 60_000);

    it("says when this server has no download for the system chosen, with its reason", async () => {
        fake.info = { ...fake.info, systems: [{ os: "linux", arch: "x64", available: true, kind: "files" }, { os: "mac", arch: "arm64", available: false, kind: "installer", reason: "The Mac app is not built on this server." }] };
        await visit();
        await section().getByText("For another computer?", { exact: true }).click();
        await section().getByLabel("System").selectOption("mac");
        await section().getByLabel("Processor").selectOption("arm64");
        await pwExpect(section()).toContainText("The Mac app is not built on this server.");
        await pwExpect(section().getByRole("button", { name: /Download for Mac/ })).toBeDisabled();
        fake.info = { ...fake.info, systems: [] };
    }, 60_000);

    it("shows a refused download's sentence as it is", async () => {
        fake.download = { status: 403, error: "Setting up a runner needs permission to run tests in at least one project." };
        await visit();
        await section().getByRole("button", { name: "Download for Linux" }).click();
        await pwExpect(section().getByTestId("runner-download-error")).toHaveText("Setting up a runner needs permission to run tests in at least one project.");
        fake.download = { status: 200, error: "" };
    }, 60_000);

    it("downloads with exactly the system and processor, then waits for the computer and shows it connected", async () => {
        calls.length = 0;
        fake.enrollment = "waiting";
        await visit();
        const saved = page.waitForEvent("download");
        await section().getByRole("button", { name: "Download for Linux" }).click();
        const dl = await saved;
        expect(dl.suggestedFilename()).toBe("ai-testing-runner.sh");
        const post = calls.find((c) => c.path === "/api/me/runner/download");
        expect(post?.method).toBe("POST");
        expect(post?.body).toEqual({ os: "linux", arch: "x64" });
        const waiting = section().getByTestId("runner-waiting");
        await pwExpect(waiting).toContainText("ai-testing-runner.sh");
        await pwExpect(waiting).toContainText("sh ai-testing-runner.sh");
        await pwExpect(waiting.getByTestId("runner-wait")).toContainText("Waiting for the computer to connect");
        // The steps say it once; the other cases and the computer check wait under Still blocked?
        await pwExpect(waiting.getByTestId("still-blocked")).toBeVisible();
        await pwExpect(waiting.getByText("check-computer.sh", { exact: false })).toBeHidden();
        await waiting.getByText("Still blocked?", { exact: true }).click();
        await pwExpect(waiting.getByText("sh ~/.local/share/ai-testing-runner/check-computer.sh", { exact: false })).toBeVisible();
        // The code inside the download never reaches the page.
        expect(await page.content()).not.toContain(SECRET_CODE);
        await axeBoth();

        fake.mine = runnerOf({ os: "linux", name: "priya-box", hostname: "priya-box" });
        fake.enrollment = "connected";
        await pwExpect(section().getByTestId("runner-details")).toBeVisible({ timeout: 15_000 });
        await pwExpect(section()).toHaveAttribute("data-state", "online");
    }, 60_000);

    it("an expired code offers to download again", async () => {
        fake.mine = null;
        fake.enrollment = "expired";
        await visit();
        await section().getByRole("button", { name: "Download for Linux" }).click();
        await pwExpect(section()).toContainText("The code in that download has expired", { timeout: 15_000 });
        await section().getByRole("button", { name: "Download again" }).click();
        await pwExpect(section().getByRole("button", { name: "Download for Linux" })).toBeVisible();
        fake.enrollment = "waiting";
    }, 60_000);
});

describe("connected", () => {
    it("shows the computer, the switches and the check, and changes a switch with only that field", async () => {
        fake.mine = runnerOf({ check: { at: new Date().toISOString(), items: [{ id: "node", status: "ok", title: "Node.js 24 found" }, { id: "chrome", status: "missing", title: "Google Chrome is not installed", fix: "Install Chrome, or let the runner download Chromium." }] } });
        calls.length = 0;
        await visit();
        // The header says the name and when it was last heard from; the rest waits under Details.
        await pwExpect(section().getByTestId("runner-head")).toContainText("Office laptop, last heard from");
        const facts = section().getByTestId("runner-facts");
        await pwExpect(facts).toBeHidden();
        await section().getByText("Details", { exact: true }).click();
        await pwExpect(facts).toBeVisible();
        await pwExpect(facts).toContainText("PRIYA-LT");
        await pwExpect(facts).toContainText("Windows");
        await pwExpect(facts).toContainText("2.1.0");
        await pwExpect(section().getByTestId("runner-network")).toHaveText("Connects directly, no proxy.");
        await pwExpect(section().getByTestId("agent-check")).toContainText("Google Chrome is not installed");
        const priv = section().getByRole("checkbox", { name: /Test private and local addresses/ });
        await pwExpect(section().getByRole("checkbox", { name: /Run code scripts/ })).toBeChecked();
        await pwExpect(priv).not.toBeChecked();
        await pwExpect(section().getByRole("checkbox", { name: /Use my connected phone/ })).not.toBeChecked();
        await priv.check();
        await pwExpect(section()).toContainText("Tests on your computer may now reach private and local addresses.");
        expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ switches: { privateTargets: true } });
        await pwExpect(priv).toBeChecked();
        await axeBoth();
    }, 60_000);

    it("links the run it is on, and renames", async () => {
        fake.mine = runnerOf({ status: "busy", currentRun: { jobId: "job-9", projectId: "p-1", title: "Nightly checks" } });
        calls.length = 0;
        await visit();
        await pwExpect(section().getByText("Busy", { exact: true })).toBeVisible();
        await pwExpect(section().getByTestId("runner-current").getByRole("link", { name: "Nightly checks" })).toHaveAttribute("href", "#/projects/p-1/runs/job-9");
        await section().getByRole("button", { name: "Rename" }).click();
        await section().getByLabel("New name for Office laptop").fill("Desk PC");
        await section().getByRole("button", { name: "Save name" }).click();
        await pwExpect(section()).toContainText("Your runner is now called “Desk PC”.");
        expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ name: "Desk PC" });
    }, 60_000);

    it("setting up a different computer says the old one goes, and Cancel goes back", async () => {
        fake.mine = runnerOf();
        await visit();
        await section().getByRole("button", { name: "Set up a different computer" }).click();
        await pwExpect(section()).toContainText("Setting up a different computer removes Office laptop as soon as the new one connects.");
        await section().getByRole("button", { name: "Cancel" }).click();
        await pwExpect(section().getByTestId("runner-details")).toBeVisible();
    }, 60_000);

    it("Remove this computer asks first, then retires it", async () => {
        fake.mine = runnerOf();
        calls.length = 0;
        await visit();
        await section().getByRole("button", { name: "Remove this computer" }).click();
        await pwExpect(section()).toContainText("Remove Office laptop?");
        await section().getByRole("button", { name: "Keep it" }).click();
        expect(calls.filter((c) => c.path === "/api/me/runner/retire")).toEqual([]);
        await section().getByRole("button", { name: "Remove this computer" }).click();
        await section().getByRole("button", { name: "Remove this computer" }).last().click();
        await pwExpect(section()).toHaveAttribute("data-state", "not-set-up", { timeout: 10_000 });
        expect(calls.filter((c) => c.path === "/api/me/runner/retire").map((c) => c.method)).toEqual(["POST"]);
    }, 60_000);
});

describe("offline and updates", () => {
    it("an offline runner says how to bring it back on its system", async () => {
        fake.mine = runnerOf({ status: "offline", lastSeenAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
        await visit();
        const help = section().getByTestId("runner-offline-help");
        await pwExpect(help).toContainText("It runs only while its computer is on, signed in and online.");
        await pwExpect(help).toContainText(offlineSteps("windows")[0]!);
        await pwExpect(help).toContainText("Runs can’t start until it is back online. Schedules wait for it.");
    }, 60_000);

    it("a newer version offers Update now; one it cannot install says to download again", async () => {
        fake.mine = runnerOf({ update: { can: true, auto: false, latest: "2.2.0", outOfDate: true, requested: false, state: "idle" } });
        calls.length = 0;
        await visit();
        await pwExpect(section().getByTestId("agent-update-status")).toContainText("Version 2.2.0 is available.");
        await section().getByRole("button", { name: /Update Office laptop to version 2.2.0/ }).click();
        await pwExpect(section().getByRole("button", { name: "Update asked for Office laptop" })).toBeDisabled();
        expect(calls.filter((c) => c.path === "/api/me/runner/update").map((c) => c.method)).toEqual(["POST"]);

        fake.mine = runnerOf({ update: { can: true, auto: true, latest: "2.2.0", outOfDate: true, requested: false, state: "needs-manual" } });
        await visit();
        await pwExpect(section().getByTestId("agent-update-status")).toContainText("Download the runner again from Settings");
        await pwExpect(section().getByRole("button", { name: /Update Office laptop/ })).toHaveCount(0);

        // Nothing published to update from (the live site's unsigned download): no Update now, no promise that it updates itself.
        fake.mine = runnerOf({ update: { can: true, auto: true, latest: "2.2.0", outOfDate: true, requested: false, state: "idle", published: false, unpublished: "the runner download here is not signed." } });
        await visit();
        await pwExpect(section().getByTestId("agent-update-status")).toHaveText("Download the runner again from Settings to get version 2.2.0.");
        await pwExpect(section().getByRole("button", { name: /Update Office laptop/ })).toHaveCount(0);
        await pwExpect(section()).not.toContainText("It updates between tests");
    }, 60_000);
});

describe("everyone's runners (admins)", () => {
    it("lists every person's runner and removes one", async () => {
        fake.mine = runnerOf();
        fake.admin = [
            { id: "tok-mine", name: "Office laptop", status: "online", lastSeenAt: new Date().toISOString(), version: "2.1.0", ownerName: "Priya" },
            { id: "tok-ana", name: "Ana’s Mac", status: "offline", lastSeenAt: new Date(Date.now() - 86_400_000).toISOString(), version: "2.0.0", ownerName: "Ana" },
        ];
        fake.canSeeEveryone = true;
        calls.length = 0;
        await visit();
        // Its own section below Your runner, not inside it.
        await pwExpect(section().getByTestId("everyones-runners")).toHaveCount(0);
        const list = page.getByTestId("everyones-runners");
        await pwExpect(list.getByRole("heading", { name: "Everyone’s runners (2)" })).toBeVisible();
        await pwExpect(list).toContainText("Ana: Ana’s Mac");
        await pwExpect(list).toContainText("version 2.0.0");
        // Your own runner is removed from your own section, not from here.
        await pwExpect(list.getByRole("button", { name: /Remove Priya’s runner/ })).toHaveCount(0);
        await list.getByRole("button", { name: "Remove Ana’s runner Ana’s Mac…" }).click();
        await list.getByRole("button", { name: "Remove Ana’s runner Ana’s Mac", exact: true }).click();
        await pwExpect(list).toContainText("Ana’s runner Ana’s Mac was removed.");
        expect(calls.filter((c) => c.path === "/api/admin/runners/tok-ana/retire").map((c) => c.method)).toEqual(["POST"]);
        await axeBoth();
        fake.admin = null;
    }, 60_000);

    it("shows nothing when the list is refused", async () => {
        fake.admin = null;
        await visit();
        await pwExpect(page.getByTestId("everyones-runners")).toHaveCount(0);
    }, 60_000);

    it("is not shown, and never asked for, unless the server says canSeeEveryone (Manage runners alone is not enough)", async () => {
        fake.mine = runnerOf();
        fake.admin = [{ id: "tok-ana", name: "Ana’s Mac", status: "online", lastSeenAt: new Date().toISOString(), ownerName: "Ana" }];
        fake.permissions = ["ai_studio.access", "ai_studio.tests.run", "ai_studio.runners.manage"];
        for (const answer of [undefined, false] as const) {
            fake.canSeeEveryone = answer;
            adminCalls.length = 0;
            await visit();
            await pwExpect(section()).toHaveAttribute("data-state", "online");
            await page.waitForTimeout(1500);
            await pwExpect(page.getByTestId("everyones-runners")).toHaveCount(0);
            expect(adminCalls, String(answer)).toEqual([]);
        }
        fake.permissions = null;
        fake.canSeeEveryone = undefined;
        fake.admin = null;
    }, 60_000);
});

describe("the rest of Settings for someone who may run tests but not change the platform", () => {
    it("shows Your runner and the read-only AI model and Test formats cards, but not the platform-wide panels", async () => {
        fake.mine = runnerOf();
        fake.permissions = ["ai_studio.access", "ai_studio.tests.run"];
        await visit();
        await pwExpect(page.getByRole("heading", { name: "AI model", exact: true })).toBeVisible();
        await pwExpect(page.getByRole("heading", { name: "Test formats", exact: true })).toBeVisible();
        await pwExpect(page.getByTestId("mobile-tooling")).toHaveCount(0);
        await pwExpect(page.locator("aside.sidebar a.nav-item", { hasText: /^Settings$/ })).toBeVisible();
        fake.permissions = null;
    }, 60_000);
});

describe("the Dashboard card", () => {
    it("shows only while the runner is not set up or offline", async () => {
        const dashboard = async () => {
            await page.goto("about:blank");
            await page.goto(`${BASE}/#/dashboard`);
            await pwExpect(page.getByRole("heading", { name: "Dashboard", exact: true }).first()).toBeVisible({ timeout: 20_000 });
        };
        fake.mine = null;
        await dashboard();
        const card = page.getByTestId("dashboard-runner");
        await pwExpect(card.getByRole("link", { name: "Set up your runner" })).toHaveAttribute("href", "#/settings#runner");
        fake.mine = runnerOf({ status: "offline", lastSeenAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
        await dashboard();
        await pwExpect(card).toContainText("Office laptop: offline since");
        fake.mine = runnerOf();
        await dashboard();
        await page.waitForTimeout(1500); // the runner's answer has arrived by now
        await pwExpect(card).toHaveCount(0);
    }, 60_000);
});

describe("layout", () => {
    it("fits a phone without sideways scrolling", async () => {
        fake.mine = null;
        await page.setViewportSize({ width: 390, height: 844 });
        await visit();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        fake.mine = runnerOf();
        await visit();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        await page.setViewportSize({ width: 1280, height: 900 });
    }, 60_000);
});

describe("against the real routes", () => {
    const PASSWORD = "Settings-Ui-Pr0xy-Secret";
    it("shows the person's own runner, changes a switch and removes it, never showing a sign-in from its check or proxy", async () => {
        for (const glob of ["**/api/me/runner", "**/api/me/runner/retire", "**/api/me/runner/update", "**/api/me/runner/enrollments/*", "**/api/admin/runners", "**/api/admin/runners/*/retire"]) await page.unroute(glob);
        const store = getAgentServices(platform).store;
        const { secret } = store.createPersonalToken({ ownerId: OPEN_OWNER_ID, label: "Maya’s laptop", createdBy: OPEN_OWNER_ID });
        const check = {
            at: new Date(Date.now() - 60_000).toISOString(),
            items: [
                { id: "node", status: "ok", title: "Node.js v24.19.0, came with this download" },
                { id: "network", status: "ok", title: `Network: connects through the proxy http://maya:${PASSWORD}@proxy.corp.test:8080` },
                { id: "disk", status: "missing", title: "Only 0.4 GB free on the disk that holds the runner's folder", fix: "Free some space, then start the runner again." },
            ],
        };
        const network = { proxy: "proxy.corp.test:8080", proxySource: "env", problem: `proxy http://maya:${PASSWORD}@proxy.corp.test:8080 refused the connection`, problemAt: new Date().toISOString() };
        const agent = new FakeAgent(viaFetch(BASE), secret, { name: "MAYA-LT", capabilities: { ...defaultCaps({ os: "win32", browsers: ["chromium"] }), check, network } as never });
        const hi = await agent.hello();
        expect(hi.status, JSON.stringify(hi.json)).toBe(200);

        await visit();
        await pwExpect(section()).toHaveAttribute("data-state", "online", { timeout: 15_000 });
        await pwExpect(section().getByTestId("runner-head")).toContainText("Maya’s laptop");
        await pwExpect(section().getByTestId("agent-check")).toContainText("Only 0.4 GB free");
        expect(await section().innerText()).not.toContain(PASSWORD);
        await section().getByText("Details", { exact: true }).click();
        expect(await page.content()).not.toContain(PASSWORD);

        await section().getByRole("checkbox", { name: /Test private and local addresses/ }).check();
        await pwExpect(section()).toContainText("Tests on your computer may now reach private and local addresses.");
        const after = (await (await fetch(`${BASE}/api/me/runner`)).json()) as { runner: RunnerMine };
        expect(after.runner.switches).toEqual({ codeScripts: true, privateTargets: true, realPhone: false });

        await section().getByRole("button", { name: "Remove this computer" }).click();
        await section().getByRole("button", { name: "Remove this computer" }).last().click();
        await pwExpect(section()).toHaveAttribute("data-state", "not-set-up", { timeout: 10_000 });
        expect(((await (await fetch(`${BASE}/api/me/runner`)).json()) as { runner: unknown }).runner).toBeNull();
        // The removed credential can no longer connect.
        expect((await agent.hello()).status).not.toBe(200);
    }, 60_000);
});

describe("no page errors", () => {
    it("logged no errors in the browser console", () => {
        expect(consoleErrors.filter((e) => !/not allowed/i.test(e))).toEqual([]);
    });
});
