/**
 * How a generated phone test starts, and what it does about system dialogs while it runs: the text the Taqwright generator puts into every phone script
 * (generators/taqwright.ts), and the run configuration's own start for scripts written before it (mobile-runner.ts, `LAUNCH_APP_PATCH`).
 *
 * Start: never `mobile.launchApp` / `mobile: activateApp` (Appium resolves the activity itself, without the launcher category or a user, and fails with
 * "Unable to resolve the launchable activity" on some phones). The runner resolves the launcher activity on the phone before the run (launcher.ts) and
 * hands it over as MOBILE_APP_COMPONENT (and the Android user as MOBILE_APP_USER); the test starts exactly that component with `mobile: startActivity`
 * (stop first, wait until it has drawn). A copy of the script run elsewhere without those variables falls back to stopping and opening the app the
 * standard way.
 *
 * System dialogs (looked at every 1.5 s between the test's own commands): a permission question that is still there after the test had its chance to
 * answer it is answered the project's way (MOBILE_PERMISSION_ANSWER: allow, the default, or deny); "isn't responding" gets one Wait, and if it comes
 * back the test fails (the freeze itself is reported from the phone's log); a crash dialog is closed and the test fails (the crash is reported from the
 * log); another app in front is sent back once by bringing the app under test forward. The home screen is left alone (a test may press Home).
 *
 * Nothing here contains a secret or a value of the project: only environment variable names.
 */

/** Ids of the system's dialog buttons (AOSP; Google and OEM builds keep them). */
export const DIALOG_IDS = {
    allow: ["permission_allow_foreground_only_button", "permission_allow_button", "permission_allow_one_time_button"],
    deny: ["permission_deny_and_dont_ask_again_button", "permission_deny_button"],
    anrWait: "aerr_wait",
    close: "aerr_close",
} as const;

/** The import the hooks need (a type only), placed under the script's own import of Taqwright. */
export const PHONE_START_IMPORT = `import type { Mobile } from "@taqwright/taqwright";`;

/** The hooks every generated phone test has: start, watch, and evidence on failure. */
export function phoneStartHooks(): string {
    return `/** Opens the app on its first screen. The platform's runner resolves the screen that opens the app on the phone (MOBILE_APP_COMPONENT). */
async function startApp(mobile: Mobile): Promise<void> {
    const appId = process.env.MOBILE_APP_PACKAGE;
    // An APK-only run has no package to act on: Appium opened that app itself.
    if (!appId) return;
    const component = process.env.MOBILE_APP_COMPONENT;
    if (component) {
        const user = process.env.MOBILE_APP_USER;
        await mobile.raw.executeScript("mobile: startActivity", [{ component, action: "android.intent.action.MAIN", categories: "android.intent.category.LAUNCHER", flags: "0x10200000", stop: true, wait: true, ...(user ? { user } : {}) }]);
        return;
    }
    await mobile.terminateApp(appId).catch(() => undefined);
    await mobile.launchApp(appId);
}

/** Answers system dialogs while the test runs (see the platform's docs: phone test runs). stop() says what went wrong, if anything. */
function watchSystemDialogs(mobile: Mobile): { stop(): Promise<string | undefined> } {
    const appId = process.env.MOBILE_APP_PACKAGE ?? "";
    const component = process.env.MOBILE_APP_COMPONENT ?? "";
    const answer = process.env.MOBILE_PERMISSION_ANSWER === "deny" ? ${JSON.stringify(DIALOG_IDS.deny)} : ${JSON.stringify(DIALOG_IDS.allow)};
    const button = (ids: readonly string[]) => mobile.getByUiSelector(\`new UiSelector().resourceIdMatches(".*:id/(\${ids.join("|")})")\`);
    let problem: string | undefined;
    let waited = false;
    let broughtBack = false;
    let permissionSeen = 0;
    let busy: Promise<void> | undefined;
    const look = async (): Promise<void> => {
        const front = String((await mobile.raw.executeScript("mobile: getCurrentPackage", [{}]).catch(() => "")) ?? "");
        if (!front || front === appId) {
            permissionSeen = 0;
            return;
        }
        if (/permissioncontroller|packageinstaller/.test(front)) {
            // The test's own permission step answers first; a question still there on the next look is answered here.
            if (++permissionSeen < 2) return;
            permissionSeen = 0;
            if ((await button(answer).count()) > 0) await button(answer).nth(0).click({ timeout: 2000 }).catch(() => undefined);
            return;
        }
        if (front === "android" || front === "com.android.systemui") {
            if ((await button(["${DIALOG_IDS.anrWait}"]).count()) > 0) {
                if (!waited) {
                    waited = true;
                    await button(["${DIALOG_IDS.anrWait}"]).nth(0).click({ timeout: 2000 }).catch(() => undefined);
                    return;
                }
                problem ??= "The app stopped responding: Android showed that it isn't responding, the test waited once, and it happened again.";
                await button(["${DIALOG_IDS.close}"]).nth(0).click({ timeout: 2000 }).catch(() => undefined);
            } else if ((await button(["${DIALOG_IDS.close}"]).count()) > 0) {
                problem ??= "The app crashed: Android showed that it has stopped.";
                await button(["${DIALOG_IDS.close}"]).nth(0).click({ timeout: 2000 }).catch(() => undefined);
            }
            return;
        }
        // Another app came to the front (not the home screen, which a test may open on purpose): the app under test is brought back once.
        if (!broughtBack && component && !/launcher|\\.home$|nexuslauncher/i.test(front)) {
            broughtBack = true;
            await mobile.raw.executeScript("mobile: startActivity", [{ component, flags: "0x10200000", wait: true }]).catch(() => undefined);
        }
    };
    const timer = setInterval(() => {
        if (!busy) busy = look().catch(() => undefined).finally(() => (busy = undefined));
    }, 1500);
    return {
        async stop() {
            clearInterval(timer);
            await busy;
            return problem;
        },
    };
}

let watcher: { stop(): Promise<string | undefined> } | undefined;

test.beforeEach(async ({ mobile }) => {
    // Every test starts from the app's first screen, then system dialogs are watched while it runs.
    await startApp(mobile);
    watcher = watchSystemDialogs(mobile);
});

test.afterEach(async ({ mobile }, testInfo) => {
    const problem = await watcher?.stop();
    watcher = undefined;
    // Evidence for a failed run; the device may be unreachable by then, which must not mask the failure.
    if (testInfo.status !== testInfo.expectedStatus || problem) {
        try {
            await testInfo.attach("screenshot", { body: await mobile.screenshot(), contentType: "image/png" });
        } catch {
            /* no screenshot available */
        }
    }
    if (problem) throw new Error(problem);
});`;
}

/**
 * For scripts written before the start above (their beforeEach calls `mobile.launchApp(appId)`, which is `mobile: activateApp`): the run configuration
 * replaces Taqwright's `launchApp` for the app under test with the same explicit start, so those tests start without being explored or written again.
 * Any other app id, or a run without a resolved component, keeps Taqwright's own behaviour.
 */
export const LAUNCH_APP_PATCH = `// Scripts written before the platform resolved the launcher activity call mobile.launchApp (Appium's activateApp): start the resolved activity instead.
const launchComponent = process.env.MOBILE_APP_COMPONENT;
if (launchComponent && pkg) {
    const own = Mobile.prototype.launchApp;
    Mobile.prototype.launchApp = async function (this: Mobile, bundleId?: string, opts?: Parameters<Mobile["launchApp"]>[1]) {
        if (this.getPlatform() !== Platform.ANDROID || (bundleId ?? pkg) !== pkg) return own.call(this, bundleId, opts);
        const user = process.env.MOBILE_APP_USER;
        await this.raw.executeScript("mobile: startActivity", [{ component: launchComponent, action: "android.intent.action.MAIN", categories: "android.intent.category.LAUNCHER", flags: "0x10200000", stop: true, wait: true, ...(user ? { user } : {}) }]);
    };
}
`;
