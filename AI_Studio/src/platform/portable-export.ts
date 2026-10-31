/**
 * What makes a downloaded test project run on the tester's own computer, whatever Node.js, npm, browsers and packages it happens to have:
 * a package.json that pins the exact versions the tests were written and run with, a lockfile for exactly those versions, the Node.js
 * version they need (.nvmrc and engines), a playwright.config with the projects the tests need, a README with three steps and a .gitignore,
 * so the folder can go straight into a Git repository. Used by the project download (server.ts) and the one-test download
 * (routes/portable.ts). See docs/features/portable-code-tests.md.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { cutLockfile, LockCutError, nodeFloor, compareVersions, type Lockfile } from "../engine/portable/lockfile.js";
import { OLDEST_PLAYWRIGHT } from "../engine/portable/playwright-apis.js";

/** One script as it goes into the download. */
export interface ExportScript {
    /** Its path inside the download (see exportPath). */
    path: string;
    framework: string;
    content: string;
}

const PHONE = new Set(["taqwright", "taqwright-ios"]);
export const isPhoneFramework = (framework: string): boolean => PHONE.has(framework);

/**
 * Where a script goes in the download. Browser, API and desktop tests run with Playwright from ./tests; phone tests run with Taqwright
 * (Appium) from ./phone-tests/<android|ios>, so `npx playwright test` never picks them up.
 */
export function exportPath(framework: string, folder: string, filename: string): string {
    if (framework === "taqwright-ios") return `phone-tests/ios/${folder}/${filename}`;
    if (framework === "taqwright") return `phone-tests/android/${folder}/${filename}`;
    return `tests/${folder}/${filename}`;
}

// ── the platform's own lockfile ────────────────────────────────────────────

const LOCK_PATH = fileURLToPath(new URL("../../package-lock.json", import.meta.url));
let cachedLock: { at: string; lock: Lockfile | undefined } | undefined;

/** The platform's package-lock.json (read once). Undefined when this installation has none (then downloads carry no lockfile, and say so). */
export function platformLock(at = LOCK_PATH): Lockfile | undefined {
    if (cachedLock?.at === at) return cachedLock.lock;
    let lock: Lockfile | undefined;
    try {
        lock = JSON.parse(fs.readFileSync(at, "utf8")) as Lockfile;
    } catch {
        lock = undefined;
    }
    cachedLock = { at, lock };
    return lock;
}

/** The packages a set of scripts needs, each at the exact version the platform has installed (and runs them with). */
export function pinsFor(scripts: readonly ExportScript[], lock: Lockfile | undefined): { pins: Record<string, string>; missing: string[] } {
    const names = ["@playwright/test"];
    if (scripts.some((s) => /from\s+["']@axe-core\/playwright["']/.test(s.content))) names.push("@axe-core/playwright");
    if (scripts.some((s) => isPhoneFramework(s.framework))) names.push("@taqwright/taqwright");
    const pins: Record<string, string> = {};
    const missing: string[] = [];
    for (const n of names) {
        const v = lock?.packages?.[`node_modules/${n}`]?.version;
        if (v) pins[n] = v;
        else missing.push(n);
    }
    return { pins, missing };
}

// ── the files ──────────────────────────────────────────────────────────────

/** A package name npm accepts, from a project name. */
export function packageName(projectName: string): string {
    // Accents come off ("Démo" -> "demo") before anything else is replaced.
    const s = projectName
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
    return `${s || "exported"}-tests`;
}

/**
 * The Playwright configuration: the settings the platform itself runs the tests with (time limits, the 1280 x 800 Chrome window,
 * evidence kept only for failures, baselines under tests/__baselines__), one browser project, and on Windows a project for desktop tests.
 */
export function playwrightConfig(o: { desktopFiles: readonly string[] }): string {
    const desktop = o.desktopFiles.map((f) => JSON.stringify(f.replace(/^tests\//, "")));
    const ignore = desktop.length ? `\n            testIgnore: [${desktop.join(", ")}],` : "";
    const desktopProject = desktop.length
        ? `\n        // Windows desktop tests start a Windows program: they only run on Windows.\n        ...(process.platform === "win32" ? [{ name: "windows-desktop", testMatch: [${desktop.join(", ")}] }] : []),`
        : "";
    return `import { defineConfig, devices } from "@playwright/test";

// The settings the platform runs these tests with. Change them freely: this folder is yours now.
export default defineConfig({
    testDir: "./tests",
    timeout: 60_000,
    expect: { timeout: 8_000 },
    retries: 0,
    fullyParallel: true,
    // A list for people, JUnit XML for CI systems.
    reporter: [["list"], ["junit", { outputFile: "results/junit.xml" }]],
    // Approved screenshots for "looks the same" checks go here (the platform keeps its own; the first run here saves new ones).
    snapshotPathTemplate: "{testDir}/__baselines__/{arg}{ext}",
    use: {
        screenshot: "only-on-failure",
        trace: "retain-on-failure",
        video: "retain-on-failure",
        actionTimeout: 10_000,
        navigationTimeout: 30_000,
    },
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },${ignore}
        },${desktopProject}
    ],
});
`;
}

/** The Taqwright configuration for phone tests (an Android emulator or phone, an iOS simulator on a Mac), set through environment variables. */
export function taqwrightConfig(o: { android: boolean; ios: boolean }): string {
    const projects: string[] = [];
    if (o.android)
        projects.push(`        {
            name: "android",
            testDir: "./phone-tests/android",
            use: {
                platform: Platform.ANDROID,
                device: { provider: "emulator", name: process.env.MOBILE_AVD ?? "", ...(process.env.MOBILE_UDID ? { udid: process.env.MOBILE_UDID } : {}) },
                ...(process.env.MOBILE_APK_PATH ? { buildPath: process.env.MOBILE_APK_PATH } : {}),
                ...(process.env.MOBILE_APP_PACKAGE ? { appBundleId: process.env.MOBILE_APP_PACKAGE } : {}),
                appium: { autoStart: true },
                video: "on-failure",
                trace: "on-failure",
                expectTimeout: 15000,
            },
        },`);
    if (o.ios)
        projects.push(`        {
            name: "ios",
            testDir: "./phone-tests/ios",
            use: {
                platform: Platform.IOS,
                device: { provider: "emulator", name: process.env.MOBILE_SIMULATOR ?? "", ...(process.env.MOBILE_UDID ? { udid: process.env.MOBILE_UDID } : {}) },
                ...(process.env.MOBILE_APP_PACKAGE ? { appBundleId: process.env.MOBILE_APP_PACKAGE } : {}),
                appium: { autoStart: true },
                video: "on-failure",
                trace: "on-failure",
                expectTimeout: 15000,
            },
        },`);
    return `import { defineConfig, Platform } from "@taqwright/taqwright";

// Phone tests. Which emulator, simulator or phone and which app: see "Phone tests" in README.md.
export default defineConfig({
    timeout: 180_000,
    workers: 1,
    retries: 0,
    reporter: [["list"]],
    projects: [
${projects.join("\n")}
    ],
});
`;
}

/** What the environment variables the scripts read are for (the README lists only the ones the scripts really read). */
const ENV_WORDS: Record<string, string> = {
    BASE_URL: "The address of the site under test. Without it, the address the tests were made for.",
    API_BASE_URL: "The address of the API, when it is not the site's own.",
    TEST_USERNAME: "The test account's user name.",
    TEST_PASSWORD: "The test account's password.",
    TEST_TOTP_SECRET: "The test account's one-time code secret (two-step sign-in).",
    API_TOKEN: "The API token, sent as a bearer token to the API's own address only.",
    API_AUTH_HEADER: "Another sign-in header for the API, as Name: value.",
    MOBILE_APP_PACKAGE: "The phone app's package name (Android) or bundle id (iOS).",
    MOBILE_APK_PATH: "The Android app file to install (optional).",
    MOBILE_AVD: "The Android emulator to start (its name).",
    MOBILE_SIMULATOR: "The iOS simulator to use (its name).",
    MOBILE_UDID: "A specific phone or simulator, by its id (optional).",
    DESKTOP_ALLOWED_APPS: "Windows programs desktop tests may start (desktop tests only).",
};

/** Environment variable names a script reads, in order of first use. Platform-internal ones (AITP_*) are left out: they are optional here. */
export function envNames(scripts: readonly ExportScript[]): string[] {
    const out = new Set<string>();
    for (const s of scripts) for (const m of s.content.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)\b/g)) if (!m[1]!.startsWith("AITP_") && m[1] !== "SYSTEMROOT") out.add(m[1]!);
    return [...out];
}

export interface PortableOptions {
    projectName: string;
    scripts: readonly ExportScript[];
    /** One test only (the test download): changes the README's wording. */
    single?: { title: string; testId: string };
    /** The platform's lockfile; by default the one next to the platform's package.json. */
    lock?: Lockfile | undefined;
}

export interface PortableResult {
    files: Record<string, string>;
    pins: Record<string, string>;
    /** Node.js the download needs, at least (from the pinned packages' own requirements). */
    node: string;
    /** Plain sentences about what could not be done (also written into the README). */
    notes: string[];
}

/** The files that make a download run anywhere (package.json, lockfile, Node.js version, configs, README, .gitignore). */
export function portableFiles(o: PortableOptions): PortableResult {
    const lock = "lock" in o ? o.lock : platformLock();
    const { pins, missing } = pinsFor(o.scripts, lock);
    const name = packageName(o.projectName);
    const notes: string[] = [];
    if (missing.length) notes.push(`The platform could not tell which version of ${missing.join(" and ")} it uses, so ${missing.length === 1 ? "it is" : "they are"} not pinned: add ${missing.length === 1 ? "it" : "them"} with npm install -D.`);
    let lockText: string | undefined;
    let floor: [number, number, number] = [20, 0, 0];
    if (lock && Object.keys(pins).length) {
        try {
            const cut = cutLockfile(lock, pins, { name, version: "1.0.0" });
            lockText = `${JSON.stringify(cut, null, 2)}\n`;
            const needed = nodeFloor(Object.entries(cut.packages).filter(([k]) => k !== "").map(([, e]) => e));
            if (compareVersions(needed, floor) > 0) floor = needed;
        } catch (e) {
            if (!(e instanceof LockCutError)) throw e;
            notes.push(`No lockfile is included (${e.message}). Use npm install instead of npm ci.`);
        }
    } else notes.push("No lockfile is included: this installation of the platform has no package-lock.json. Use npm install instead of npm ci.");
    // The load check's helper uses process.getBuiltinModule (Node.js 20.16 and newer).
    if (o.scripts.some((s) => s.content.includes("process.getBuiltinModule")) && compareVersions(floor, [20, 16, 0]) < 0) floor = [20, 16, 0];
    const node = floor.join(".");

    const phone = o.scripts.filter((s) => isPhoneFramework(s.framework));
    const android = phone.some((s) => s.framework === "taqwright");
    const ios = phone.some((s) => s.framework === "taqwright-ios");
    const playwrightScripts = o.scripts.filter((s) => !isPhoneFramework(s.framework));
    const desktopFiles = o.scripts.filter((s) => s.framework === "windows-uia").map((s) => s.path);

    const pkg = {
        name,
        version: "1.0.0",
        private: true,
        description: o.single ? `${o.single.testId}: ${o.single.title} (downloaded from the AI Testing Platform)` : `Tests of ${o.projectName}, downloaded from the AI Testing Platform`,
        scripts: { test: "playwright test", ...(phone.length ? { "test:phone": "taqwright test --config taqwright.config.ts" } : {}) },
        engines: { node: `>=${node}` },
        devDependencies: pins,
    };
    const files: Record<string, string> = {
        "package.json": `${JSON.stringify(pkg, null, 2)}\n`,
        ".nvmrc": `${floor[0]}\n`,
        ".gitignore": "node_modules/\ntest-results/\nplaywright-report/\nblob-report/\nresults/junit.xml\n",
        "playwright.config.ts": playwrightConfig({ desktopFiles }),
    };
    if (lockText) files["package-lock.json"] = lockText;
    if (phone.length) files["taqwright.config.ts"] = taqwrightConfig({ android, ios });
    files["README.md"] = readme({ ...o, pins, node, lockfile: Boolean(lockText), notes, env: envNames(o.scripts), playwrightCount: playwrightScripts.length, phoneCount: phone.length, desktop: desktopFiles.length > 0, emails: o.scripts.some((s) => s.content.includes("AITP_MAIL_DIR")) });
    return { files, pins, node, notes };
}

function readme(r: PortableOptions & { pins: Record<string, string>; node: string; lockfile: boolean; notes: string[]; env: string[]; playwrightCount: number; phoneCount: number; desktop: boolean; emails: boolean }): string {
    const pw = r.pins["@playwright/test"];
    const install = r.lockfile ? "npm ci" : "npm install";
    const one = Boolean(r.single) || r.playwrightCount + r.phoneCount === 1;
    const nodeWords = r.node.replace(/.0.0$/, "");
    const what = r.single ? `the test ${r.single.testId}, "${r.single.title}"` : `${r.playwrightCount + r.phoneCount} test${r.playwrightCount + r.phoneCount === 1 ? "" : "s"} of ${r.projectName}`;
    const lines: string[] = [];
    lines.push(`# ${r.single ? `${r.single.testId}: ${r.single.title}` : `Tests of ${r.projectName}`}`, "");
    lines.push(`This folder holds ${what}, downloaded from the AI Testing Platform, with everything needed to run ${one ? "it" : "them"} on your own computer or in your CI.`, "");
    lines.push("## Run the tests", "");
    lines.push(`You need Node.js ${nodeWords} or newer (the version in .nvmrc works; \`nvm use\` picks it). Nothing else has to be installed first.`, "");
    lines.push("```", install, "npx playwright install", "npx playwright test", "```", "");
    lines.push(`1. \`${install}\` installs exactly the package versions listed in package.json${r.lockfile ? " and package-lock.json" : ""}, into this folder only.`);
    lines.push("2. `npx playwright install` downloads the browsers that version of Playwright needs (`npx playwright install chromium` downloads only the one these tests use). On Linux, add `--with-deps` once to install the system libraries the browser needs.");
    lines.push("3. `npx playwright test` runs the tests. `npx playwright show-report` shows the results; JUnit XML for CI is written to results/junit.xml.", "");
    if (r.env.length) {
        lines.push("## Settings", "");
        lines.push("The tests read these environment variables. Sign-in details are never in the files: set them yourself, and keep them out of Git.", "");
        for (const n of r.env) lines.push(`- \`${n}\`: ${ENV_WORDS[n] ?? (n.startsWith("TEST_ENV_") ? "A value of the environment the tests were made for." : /^TEST_[A-Z0-9_]+_(USERNAME|PASSWORD|TOTP_SECRET|API_TOKEN)$/.test(n) ? "A named test account's sign-in detail." : "Read by the tests.")}`);
        lines.push("", "For example: `BASE_URL=https://staging.example.com npx playwright test` (macOS, Linux), `$env:BASE_URL=\"https://staging.example.com\"; npx playwright test` (PowerShell), or `set \"BASE_URL=https://staging.example.com\" && npx playwright test` (Command Prompt).", "");
    }
    lines.push("## Versions", "");
    lines.push(`These tests were written for and run with ${Object.entries(r.pins).map(([n, v]) => `${n} ${v}`).join(", ") || "Playwright"}. ${r.lockfile ? `package.json pins ${Object.keys(r.pins).length === 1 ? "that exact version" : "those exact versions"} and package-lock.json pins everything they need, so every computer gets the same ones.` : "package.json pins those exact versions."}`, "");
    lines.push(`Tests the platform made from steps work with Playwright ${OLDEST_PLAYWRIGHT} or newer: to use another version, \`npm install -D @playwright/test@<version>\`, then \`npx playwright install\` again. Code tests (written by hand) may use anything of the version they were written with${pw ? ` (${pw})` : ""}.`, "");
    if (r.phoneCount) {
        lines.push("## Phone tests", "");
        lines.push(`Phone tests are in phone-tests/ and run with Taqwright (Appium), not with \`npx playwright test\`. They need Node.js ${r.node} or newer, an Android emulator or phone (Android SDK) or, for iOS, a Mac with Xcode and a simulator, and the app installed or its file. Then: \`npm run test:phone\`, with \`MOBILE_AVD\` (or \`MOBILE_SIMULATOR\`), \`MOBILE_APP_PACKAGE\` and optionally \`MOBILE_APK_PATH\` and \`MOBILE_UDID\` set.`, "");
    }
    if (r.desktop) lines.push("## Windows desktop tests", "", "Desktop tests start a Windows program and only run on Windows (the windows-desktop project). The program must be installed where the test expects it.", "");
    if (r.emails) lines.push("## Email steps", "", "Steps that read an email (a code or a link) read the platform's test mailbox. Outside the platform they fail with a plain message: run those tests on the platform or on a runner.", "");
    lines.push("## What else is in this folder", "");
    lines.push("- playwright.config.ts: the settings the platform runs the tests with (time limits, browser window, evidence only for failures).");
    if (!r.single) lines.push("- manifest.json, specs/: what each test is and the steps it was made from (import them into another project with Import).");
    lines.push("- .gitignore: so the folder can go into Git as it is (installed packages and results stay out).", "");
    for (const n of r.notes) lines.push(`Note: ${n}`, "");
    return lines.join("\n");
}
