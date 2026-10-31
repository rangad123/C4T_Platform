/**
 * The real-machine workflow (.github/workflows/runner-matrix.yml) cannot run here, so it is read and checked: it parses, it runs when the
 * runner's code changes and on demand, every job has a time limit, the six kinds of machine are there, every machine runs the plain,
 * complete (no Node.js on the PATH) and, where one exists, installer smoke checks, a failed check does not hide the next ones, the report
 * is uploaded even after a failure, the browser job runs the platform's pages in every browser, actions are pinned, and nothing secret is
 * in it. Also the branded-browser lookup of scripts/ui-browsers.mjs (file paths only). See docs/features/real-machine-checks.md.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
// @ts-expect-error plain JavaScript script (no type declarations)
import { BROWSERS, brandedPaths, installedAt, UI_FILES } from "../scripts/ui-browsers.mjs";
import { OLDEST_PLAYWRIGHT } from "../src/engine/portable/playwright-apis.js";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
// The workflows live at the repository root, one level above the platform's folder (AI_Studio/).
const WORKFLOWS = path.join(REPO, "..", ".github", "workflows");
const FILE = path.join(WORKFLOWS, "runner-matrix.yml");
const text = fs.readFileSync(FILE, "utf8");
const wf = YAML.parse(text) as any;

type Step = { name?: string; run?: string; uses?: string; if?: string; with?: Record<string, unknown>; "continue-on-error"?: boolean };
const runs = (steps: Step[]) => steps.filter((s) => s.run).map((s) => s.run!.trim());

describe("the real-machine workflow", () => {
    it("parses and runs on pushes to main, on pull requests that touch the runner, and on demand", () => {
        expect(wf.name).toBe("Runner on real machines");
        expect(wf.on.push.branches).toEqual(["main"]);
        for (const p of ["AI_Studio/src/agent/**", "AI_Studio/installer/**", "AI_Studio/scripts/build-*", "AI_Studio/src/platform/runner-kit*", "AI_Studio/scripts/smoke-runner.mjs", ".github/workflows/runner-matrix.yml"]) expect(wf.on.pull_request.paths).toContain(p);
        expect("workflow_dispatch" in wf.on).toBe(true);
        expect(wf.permissions).toEqual({ contents: "read" });
    });

    it("runs every job's commands in the platform's folder (uploads name it, being relative to the repository root)", () => {
        for (const [name, job] of Object.entries(wf.jobs) as Array<[string, any]>) expect(job.defaults?.run?.["working-directory"], name).toBe("AI_Studio");
    });

    it("gives every job a time limit", () => {
        const jobs = Object.entries(wf.jobs) as Array<[string, any]>;
        expect(jobs.map(([id]) => id)).toEqual(["smoke", "ui-browsers", "portable-exports"]);
        for (const [id, job] of jobs) {
            expect(typeof job["timeout-minutes"], id).toBe("number");
            expect(job["timeout-minutes"], id).toBeGreaterThan(0);
            expect(job["timeout-minutes"], id).toBeLessThanOrEqual(90);
            expect(job.strategy["fail-fast"], id).toBe(false);
        }
    });

    it("runs the smoke check on Windows, macOS and Linux, on Intel/AMD and ARM", () => {
        const legs = wf.jobs.smoke.strategy.matrix.include as Array<{ os: string; target: string; installer: boolean }>;
        expect(legs.map((l) => l.os)).toEqual(["windows-latest", "windows-11-arm", "macos-latest", "macos-15-intel", "ubuntu-24.04", "ubuntu-24.04-arm"]);
        expect(legs.map((l) => l.target)).toEqual(["win-x64", "win-arm64", "mac-arm64", "mac-x64", "linux-x64", "linux-arm64"]);
        // The installer exists for Windows and macOS only.
        expect(legs.filter((l) => l.installer).map((l) => l.target)).toEqual(["win-x64", "win-arm64", "mac-arm64", "mac-x64"]);
        expect(wf.jobs.smoke["runs-on"]).toBe("${{ matrix.os }}");
    });

    it("prepares each machine the way the README and the build scripts say, then runs the three checks", () => {
        const steps = wf.jobs.smoke.steps as Step[];
        const r = runs(steps);
        expect(steps.find((s) => s.uses?.startsWith("actions/setup-node"))?.with?.["node-version"]).toBe(24);
        for (const cmd of ["npm ci", "npm run build:web", "npm run build:runner", "npm run build:installer", "npm run build:installer -- --skip-windows", "npx playwright install-deps chromium"]) expect(r, cmd).toContain(cmd);
        expect(r.some((x) => x.includes("npm run build:runner -- --complete --targets ${{ matrix.target }}"))).toBe(true);
        const smoke = steps.filter((s) => s.run?.startsWith("node scripts/smoke-runner.mjs"));
        expect(smoke.map((s) => s.run!.trim())).toEqual([
            "node scripts/smoke-runner.mjs --kit files --port 6950 --out smoke-report/files",
            "node scripts/smoke-runner.mjs --kit installer --port 6952 --out smoke-report/installer",
            "node scripts/smoke-runner.mjs --kit complete --no-node-on-path --port 6954 --out smoke-report/complete",
        ]);
        // A failed check does not hide the next one; the installer check only where an installer exists.
        expect(smoke[1]!.if).toBe("(success() || failure()) && matrix.installer");
        expect(smoke[2]!.if).toBe("success() || failure()");
        // Building the installer may fail on a machine without the compiler: the installer check then says skipped.
        for (const s of steps.filter((x) => x.run?.startsWith("npm run build:installer"))) expect(s["continue-on-error"]).toBe(true);
        const upload = steps.find((s) => s.uses?.startsWith("actions/upload-artifact"))!;
        expect(upload.if).toBe("always()");
        expect(upload.with).toMatchObject({ path: "AI_Studio/smoke-report/", name: "runner-smoke-${{ matrix.target }}" });
    });

    it("opens the platform's own pages in every browser on three systems", () => {
        const job = wf.jobs["ui-browsers"];
        expect((job.strategy.matrix.include as Array<{ os: string }>).map((l) => l.os)).toEqual(["ubuntu-24.04", "windows-latest", "macos-latest"]);
        const r = runs(job.steps);
        expect(r).toContain("npx playwright install --with-deps chromium firefox webkit");
        expect(r).toContain("npm run build:web");
        expect(r).toContain("npm run test:ui:browsers -- --report ui-report");
        expect((job.steps as Step[]).find((s) => s.uses?.startsWith("actions/upload-artifact"))?.if).toBe("always()");
        expect(JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).scripts["test:ui:browsers"]).toBe("node scripts/ui-browsers.mjs");
    });

    it("runs a downloaded project with the oldest supported and the pinned Playwright on Linux, Windows and macOS (portable-code-tests.md)", () => {
        const job = wf.jobs["portable-exports"];
        const legs = job.strategy.matrix.include as Array<{ os: string; playwright: string; node: number; id: string }>;
        expect(legs.map((l) => `${l.os} ${l.playwright} node${l.node}`)).toEqual([
            `ubuntu-22.04 ${OLDEST_PLAYWRIGHT} node20`,
            "ubuntu-24.04 pinned node24",
            `windows-latest ${OLDEST_PLAYWRIGHT} node20`,
            "windows-latest pinned node24",
            `macos-latest ${OLDEST_PLAYWRIGHT} node20`,
            "macos-latest pinned node24",
        ]);
        expect(new Set(legs.map((l) => l.id)).size).toBe(legs.length);
        const steps = job.steps as Step[];
        // The platform (Node.js 24) makes the download; then the Node.js of the leg runs it, from outside the checkout.
        const nodes = steps.filter((s) => s.uses?.startsWith("actions/setup-node")).map((s) => s.with?.["node-version"]);
        expect(nodes).toEqual([24, "${{ matrix.node }}"]);
        const r = runs(steps);
        expect(r[0]).toBe("npm ci");
        expect(r[1]).toBe('node scripts/portable-check.mjs --export-only --dir "$RUNNER_TEMP/portable export" --port 6956 --out portable-report/export');
        expect(r[2]).toContain('node scripts/portable-check.mjs --from "$RUNNER_TEMP/portable export" --port 6958 --out portable-report/run $extra');
        expect(r[2]).toContain('extra="--playwright ${{ matrix.playwright }}"');
        expect(r[2]).toContain('if [ "$RUNNER_OS" = "Linux" ]; then extra="$extra --install-deps"; fi');
        const upload = steps.find((s) => s.uses?.startsWith("actions/upload-artifact"))!;
        expect(upload.if).toBe("always()");
        expect(upload.with).toMatchObject({ path: "AI_Studio/portable-report/", name: "portable-exports-${{ matrix.id }}" });
        for (const p of ["AI_Studio/src/engine/generators/**", "AI_Studio/src/engine/portable/**", "AI_Studio/src/platform/portable-export.ts", "AI_Studio/scripts/portable-check.mjs"]) expect(wf.on.pull_request.paths).toContain(p);
    });

    it("pins every action to a major version, uses only the platform's own ports, and holds no secret", () => {
        const uses = [...text.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
        expect(uses.length).toBeGreaterThan(0);
        for (const u of uses) expect(u).toMatch(/^actions\/(checkout|setup-node|upload-artifact)@v\d+$/);
        const ports = [...text.matchAll(/--port (\d+)/g)].map((m) => Number(m[1]));
        for (const p of ports) {
            expect(p).toBeGreaterThanOrEqual(6950);
            expect(p + 1).toBeLessThanOrEqual(6969);
        }
        expect(new Set(ports.flatMap((p) => [p, p + 1])).size).toBe(ports.length * 2);
        expect(text).not.toMatch(/secrets\./);
        expect(text).not.toMatch(/GITHUB_TOKEN|pull_request_target/);
        expect(text).not.toMatch(/aitg_|x-api-key|API_KEY\s*[:=]/i);
        expect(text).not.toMatch(/\b4000\b/);
    });

    it("leaves the main CI workflow's jobs as they were", () => {
        const ci = YAML.parse(fs.readFileSync(path.join(WORKFLOWS, "ci.yml"), "utf8")) as any;
        expect(Object.keys(ci.jobs)).toEqual(["checks", "test"]);
    });
});

describe("the browsers the platform's pages are opened in", () => {
    it("lists the three engines and the two branded browsers, and the UI test files", () => {
        expect(BROWSERS.map((b: { id: string }) => b.id)).toEqual(["chromium", "firefox", "webkit", "chrome", "msedge"]);
        expect(UI_FILES).toEqual(["tests/ui-smoke.test.ts", "tests/ui-flows.test.ts"]);
        for (const f of UI_FILES) expect(fs.readFileSync(path.join(REPO, f), "utf8")).toContain("process.env.UI_CHANNEL ? { channel: process.env.UI_CHANNEL } : {}");
    });

    it("finds Chrome and Edge by their files at the usual install places, per system", () => {
        const env = { LOCALAPPDATA: "C:\\Users\\m\\AppData\\Local", PROGRAMFILES: "C:\\Program Files", "PROGRAMFILES(X86)": "C:\\Program Files (x86)" };
        expect(brandedPaths("msedge", "win32", env)).toEqual(["C:\\Users\\m\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"]);
        expect(brandedPaths("chrome", "darwin", {})).toEqual(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]);
        expect(brandedPaths("msedge", "linux", {})).toEqual(["/opt/microsoft/msedge/msedge"]);
        const at = installedAt("chrome", { platform: "win32", env, exists: (p: string) => p === "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" });
        expect(at).toBe("C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe");
        expect(installedAt("msedge", { platform: "linux", env: {}, exists: () => false })).toBeUndefined();
    });
});
