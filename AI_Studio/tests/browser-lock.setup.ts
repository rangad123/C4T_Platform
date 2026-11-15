/**
 * The machine-wide browser lock (scripts/lock.mjs), enforced for every test file (`setupFiles` in vitest.config.ts and
 * vitest.fast.config.ts), so a plain `npx vitest run a b c` or a shell loop over files cannot run browsers at the same time as another
 * run on this machine, from this checkout or another.
 *
 * 1. A file outside the fast tier (vitest.fast.config.ts: the files that start no browser) waits for the "browser" lock before it is
 *    loaded, holds it while it runs and gives it back at the end. A run that already holds it (scripts/with-lock.mjs, the test-tier
 *    runner) goes straight on. In CI each job is one process, so the lock is free and nothing waits.
 *    It also reads web/dist of this checkout: it registers as a reader of the checkout's "dist" guard (shared with other test files),
 *    so a web build of this checkout waits until it is done instead of replacing web/dist under it (and it waits for a build under way).
 * 2. Starting a browser (Playwright's launch, launchPersistentContext, launchServer) in the test process without the lock is refused
 *    with a plain sentence. The fast config clears AITP_LOCK_HELD, so a fast-tier file can never start one in-process.
 */
import path from "node:path";
import { afterAll, expect } from "vitest";
// @ts-expect-error plain JavaScript script (no type declarations)
import { acquireDist, acquireLock, heldWith, isHeld } from "../scripts/lock.mjs";
// @ts-expect-error plain JavaScript script (no type declarations)
import { fastFiles, ROOT } from "../scripts/test-tiers.mjs";
import { guardBrowserLaunch } from "./fixtures/browser-launch-guard.js";

guardBrowserLaunch();

// A worker that runs several files gives back a lock an earlier file kept (one whose afterAll never ran, e.g. it failed to load).
const slot = globalThis as { aitpBrowserLockRelease?: () => void };
slot.aitpBrowserLockRelease?.();
slot.aitpBrowserLockRelease = undefined;

const testPath = expect.getState().testPath ?? "";
const file = path.relative(ROOT as string, testPath).replace(/\\/g, "/");
const needsLock = !(fastFiles() as string[]).includes(file);

if (needsLock) {
    const before = process.env.AITP_LOCK_HELD;
    const log = (s: string) => console.error(`${s} (${file})`);
    // Order: browser, then the dist guard (scripts/lock.mjs ORDER).
    let browser: ((() => void) & { token: string }) | undefined;
    if (!isHeld("browser")) {
        browser = (await acquireLock("browser", { label: `vitest ${file}`, log })) as (() => void) & { token: string };
        // Servers and builds this file starts see the lock as held, the same as under scripts/with-lock.mjs.
        process.env.AITP_LOCK_HELD = heldWith("browser", browser.token);
    }
    let dist: (() => void) & { token: string };
    try {
        dist = (await acquireDist("read", { label: `vitest ${file}`, log })) as (() => void) & { token: string };
    } catch (e) {
        browser?.();
        throw e;
    }
    process.env.AITP_LOCK_HELD = heldWith("dist", dist.token);
    slot.aitpBrowserLockRelease = () => {
        if (before === undefined) delete process.env.AITP_LOCK_HELD;
        else process.env.AITP_LOCK_HELD = before;
        dist();
        browser?.();
    };
    afterAll(() => {
        slot.aitpBrowserLockRelease?.();
        slot.aitpBrowserLockRelease = undefined;
    });
}
