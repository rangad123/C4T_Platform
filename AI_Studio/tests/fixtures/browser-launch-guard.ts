/**
 * Refuse to start a browser in a test process that does not hold the "browser" lock (see tests/browser-lock.setup.ts).
 * Playwright's chromium, firefox and webkit share one BrowserType class (also behind `playwright` and `@playwright/test`), so wrapping
 * its launch methods once covers every in-process launch in this worker. Connecting to a browser started elsewhere is not wrapped.
 */
import { chromium } from "playwright-core";
// @ts-expect-error plain JavaScript script (no type declarations)
import { isHeld } from "../../scripts/lock.mjs";

export const LAUNCH_METHODS = ["launch", "launchPersistentContext", "launchServer"] as const;
export const UNLOCKED_LAUNCH_MESSAGE =
    "This test tried to start a browser without the browser lock. Run it with `node scripts/with-lock.mjs browser -- npx vitest run <file>`, " +
    "and do not list a file that starts a browser in vitest.fast.config.ts.";

const MARK = Symbol.for("aitp.browserLaunchGuard");
type Proto = Record<string, unknown> & { [MARK]?: Record<string, (...a: unknown[]) => unknown> };

/** Wrap the launch methods (once per process). Returns a function that puts the originals back (for the guard's own test). */
export function guardBrowserLaunch(): () => void {
    const proto = Object.getPrototypeOf(chromium) as Proto;
    if (!proto[MARK]) {
        const originals: Record<string, (...a: unknown[]) => unknown> = {};
        for (const m of LAUNCH_METHODS) {
            const original = proto[m] as (...a: unknown[]) => unknown;
            originals[m] = original;
            proto[m] = function (this: unknown, ...args: unknown[]) {
                if (!isHeld("browser")) return Promise.reject(new Error(UNLOCKED_LAUNCH_MESSAGE));
                return original.apply(this, args);
            };
        }
        proto[MARK] = originals;
    }
    return () => {
        const originals = proto[MARK];
        if (!originals) return;
        for (const m of LAUNCH_METHODS) proto[m] = originals[m];
        delete proto[MARK];
    };
}
