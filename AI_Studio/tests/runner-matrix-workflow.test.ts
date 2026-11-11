/**
 * The real-machine workflow (.github/workflows/runner-matrix.yml in this repository) cannot run here, so it is read and checked: it parses,
 * runs when the runner's code changes and on demand, every job has a time limit, the five machines are there (Windows Server 2022 and 2025,
 * macOS on Apple silicon and Intel, Linux), every machine installs the runner with the real installer unattended and runs the lifecycle
 * (start, online, a web and an API test, stop, start again, revoke, uninstall, nothing left), plus the plain and complete downloads; a
 * failed check does not hide the next ones, the report is uploaded even after a failure, actions are pinned and nothing secret is in it.
 * Also the runner tests in the main CI workflow (ai-studio-ci.yml) and the signing steps of the deploy workflow. See
 * docs/features/real-machine-checks.md. The branded-browser lookup of scripts/ui-browsers.mjs is checked below (file paths only).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
// @ts-expect-error plain JavaScript script (no type declarations)
import { BROWSERS, brandedPaths, installedAt, UI_FILES } from "../scripts/ui-browsers.mjs";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
// The workflows live at the repository root, one level above the platform's folder (AI_Studio/).
const WORKFLOWS = path.join(REPO, "..", ".github", "workflows");
const FILE = path.join(WORKFLOWS, "runner-matrix.yml");
const text = fs.readFileSync(FILE, "utf8");
const wf = YAML.parse(text) as any;

type Step = { name?: string; run?: string; uses?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string>; "continue-on-error"?: boolean | string };
const runs = (steps: Step[]) => steps.filter((s) => s.run).map((s) => s.run!.trim());
const PATHS = ["AI_Studio/src/agent/**", "AI_Studio/src/agent-protocol/**", "AI_Studio/installer/**", "AI_Studio/scripts/build-runner*", "AI_Studio/scripts/smoke-runner.mjs", ".github/workflows/runner-matrix.yml"];

describe("the real-machine workflow", () => {
    it("parses and runs on demand and on pushes and pull requests that touch the runner", () => {
        expect(wf.name).toBe("Runner on real machines");
        expect("workflow_dispatch" in wf.on).toBe(true);
        expect(wf.on.push.branches).toEqual(["main"]);
        for (const p of PATHS) {
            expect(wf.on.push.paths, p).toContain(p);
            expect(wf.on.pull_request.paths, p).toContain(p);
        }
        expect(wf.permissions).toEqual({ contents: "read" });
    });

    it("runs in the platform's folder with a time limit, and keeps going when one machine fails", () => {
        expect(Object.keys(wf.jobs)).toEqual(["smoke"]);
        const job = wf.jobs.smoke;
        expect(job.defaults?.run?.["working-directory"]).toBe("AI_Studio");
        expect(job["timeout-minutes"]).toBeGreaterThan(0);
        expect(job["timeout-minutes"]).toBeLessThanOrEqual(90);
        expect(job.strategy["fail-fast"]).toBe(false);
        expect(job.env.TAQWRIGHT_HOME).toBe("/nonexistent-taqwright");
    });

    it("covers Windows Server 2022 and 2025, macOS on Apple silicon and Intel, and Linux", () => {
        const legs = wf.jobs.smoke.strategy.matrix.include as Array<{ os: string; target: string; installer: boolean }>;
        expect(legs.map((l) => l.os)).toEqual(["windows-2022", "windows-2025", "macos-15", "macos-15-intel", "ubuntu-latest"]);
        expect(legs.map((l) => l.target)).toEqual(["win-x64", "win-x64", "mac-arm64", "mac-x64", "linux-x64"]);
        expect(legs.filter((l) => l.installer).map((l) => l.os)).toEqual(["windows-2022", "windows-2025", "macos-15", "macos-15-intel"]);
        expect(wf.jobs.smoke["runs-on"]).toBe("${{ matrix.os }}");
        // Honest about what the machines are.
        expect(text).toMatch(/not Windows 10 or 11 desktop/);
    });

    it("builds everything, then installs unattended with the lifecycle, and checks the plain and complete downloads too", () => {
        const steps = wf.jobs.smoke.steps as Step[];
        const r = runs(steps);
        expect(steps.find((s) => s.uses?.startsWith("actions/setup-node"))?.with?.["node-version"]).toBe(24);
        for (const cmd of ["npm ci", "npm run build:web", "npm run build:runner", "npm run build:installer", "npm run build:installer -- --skip-windows", "npx playwright install-deps chromium", "npm run build:runner -- --complete --targets ${{ matrix.target }}"]) expect(r, cmd).toContain(cmd);
        expect(r.some((x) => x.includes("sh scripts/build-runner-pkg.sh") && x.includes("sh scripts/make-dmg.sh"))).toBe(true);
        const smoke = steps.filter((s) => s.run?.startsWith("node scripts/smoke-runner.mjs"));
        expect(smoke.map((s) => s.run!.trim())).toEqual([
            "node scripts/smoke-runner.mjs --kit installer --lifecycle --port 6952 --out smoke-report/installer",
            "node scripts/smoke-runner.mjs --kit files --port 6950 --out smoke-report/files",
            "node scripts/smoke-runner.mjs --kit complete --no-node-on-path --port 6954 --out smoke-report/complete",
        ]);
        expect(smoke[0]!.if).toBe("matrix.installer");
        expect(smoke[1]!.if).toBe("success() || failure()");
        expect(smoke[2]!.if).toBe("success() || failure()");
        for (const s of steps.filter((x) => x.run?.startsWith("npm run build:installer"))) expect(s["continue-on-error"]).toBe(true);
        const upload = steps.find((s) => s.uses?.startsWith("actions/upload-artifact"))!;
        expect(upload.if).toBe("always()");
        expect(String(upload.with?.path)).toContain("AI_Studio/smoke-report/");
    });

    it("pins every action to a major version, uses only its own ports, and holds no secret", () => {
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
        expect(text).not.toMatch(/aitg_|aite_|x-api-key|API_KEY\s*[:=]/i);
    });
});

describe("the runner tests in the main CI workflow", () => {
    const ci = YAML.parse(fs.readFileSync(path.join(WORKFLOWS, "ai-studio-ci.yml"), "utf8")) as any;
    it("runs the runner tests that need no real machine, one file at a time (their fixed ports never meet)", () => {
        const steps = ci.jobs.quality.steps as Step[];
        const step = steps.find((s) => s.name === "Runner tests")!;
        expect(step).toBeDefined();
        expect(step.run).toContain("--no-file-parallelism");
        for (const f of ["agent-platform-unit", "runner-refused-unit", "runner-update-unit", "runner-installer-kit", "record-agent-unit", "live-session-fake-agent", "installer-mac-unit", "agent-program-unit", "agent-platform", "runner-stop-file-unit", "smoke-runner-unit", "runner-matrix-workflow", "credential-store-unit", "runner-protocol2-unit", "run-live-unit", "environment-accounts-unit", "approval-deps", "runner-sessions-personal", "runner-only-mode", "runner-enroll", "runner-personal", "runner-protocol2", "runner-address-guard", "runner-review-fixes", "trace-scrub-unit", "runner-resources-unit", "runner-untrusted-unit", "runner-access-isolation", "runner-trace-secrets", "runner-restart", "runner-handover", "runner-owner-unit"]) expect(step.run, f).toContain(`tests/${f}.test.ts`);
        expect(step.env?.TAQWRIGHT_HOME).toBe("/nonexistent-taqwright");
    });
});

describe("the deploy workflow's signing steps", () => {
    const text = fs.readFileSync(path.join(WORKFLOWS, "ai-studio-deploy.yml"), "utf8");
    const dep = YAML.parse(text) as any;
    it("signs the runner update in a job that installs no package, with the key from the secret only, and says so when the key is missing", () => {
        const job = dep.jobs["sign-runner-update"];
        expect(job.needs).toBe("runner-downloads");
        const r = runs(job.steps).join("\n");
        expect(r).not.toMatch(/npm (ci|install)/);
        expect(r).toContain("node AI_Studio/scripts/sign-runner-update.mjs --kit");
        expect(r).toMatch(/RUNNER_UPDATE_SIGNING_KEY is not set/);
        const sign = (job.steps as Step[]).find((s) => s.run?.includes("sign-runner-update.mjs"))!;
        expect(sign.env?.RUNNER_UPDATE_SIGNING_KEY).toBe("${{ secrets.RUNNER_UPDATE_SIGNING_KEY }}");
        // The deploy takes the signed downloads when there are any.
        expect(dep.jobs.deploy.needs).toEqual(["runner-downloads", "sign-runner-update"]);
    });

    it("signs the Windows program and the Mac package only when their secrets exist, and says so when they do not", () => {
        expect(text).toContain("WIN_CERT_PFX");
        expect(text).toContain("signtool");
        expect(text).toMatch(/WIN_CERT_PFX is not set/);
        for (const s of ["APPLE_DEVELOPER_ID_APPLICATION", "APPLE_DEVELOPER_ID_INSTALLER", "APPLE_TEAM_ID", "notarytool", "productsign"]) expect(text, s).toContain(s);
        expect(text).toMatch(/Apple signing secrets are not set/);
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
