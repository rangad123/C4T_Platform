/**
 * Which screen opens the app: the launcher activity of a package, resolved ON THE PHONE, for the phone's current user.
 *
 * Why the platform resolves it itself: Appium's `mobile: activateApp` (what Taqwright's `launchApp` calls) asks `cmd package resolve-activity --brief <pkg>`
 * WITHOUT the launcher category and without a user, and gives up with "Unable to resolve the launchable activity ... No activity found" when that prints
 * no class name. On a phone with parallel apps (a second user such as OnePlus "MultiApp" 999) the same question can also answer with the system chooser
 * `android/com.android.internal.app.ResolverActivity`. Exploration opened such apps with `monkey`, so the explorer could open LinkedIn and the tests could not.
 *
 * Order (each answer trimmed of \r and spaces: adb on Windows ends lines with \r\n, and a name with a \r in it resolves nothing):
 *   1. `cmd package resolve-activity --brief --user <current> -c android.intent.category.LAUNCHER <pkg>`: the component on its own line;
 *      the chooser is never accepted;
 *   2. `dumpsys package <pkg>`: the MAIN activity filtered with the LAUNCHER category (parser ported from appium-adb, see below);
 *   3. last resort: `monkey -p <pkg> -c android.intent.category.LAUNCHER 1`, then the activity that came to the front (`dumpsys window`).
 *
 * Every call is one of the closed adb lists (adb.ts, setup-commands.ts): the current user and the package list of one user are read-only calls of the
 * ready check, `dumpsys package` is a preparation call, `monkey` and `dumpsys window` are the device session's own.
 */
import type { Adb } from "./adb.js";
import { isComponent } from "../quality/startup.js";
import { activityFromWindowDump } from "./uiautomator.js";

const SAFE_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const LAUNCHER = "android.intent.category.LAUNCHER";
const MAIN = "android.intent.action.MAIN";
/** What a phone with two launchable copies (or a work profile) answers instead of the app. Never started. */
export const RESOLVER_ACTIVITY = "android/com.android.internal.app.ResolverActivity";

/** One adb call (after `-s <serial>`), its text. Tests pass recorded answers; production uses `launcherCall(adb)`. */
export type LauncherCall = (args: string[]) => Promise<string>;

export interface LaunchResolution {
    /** `package/activity`, for example `com.linkedin.android/.authenticator.LaunchActivity`. Absent when the app cannot be opened. */
    component?: string;
    /** The activity part of the component (what Appium's `appActivity` takes). */
    activity?: string;
    /** The Android user it was resolved for (0 unless the phone's current user is another one). */
    user: number;
    /** Which way found it. */
    via?: "resolve-activity" | "dumpsys" | "monkey";
    /** Plain words when the app cannot be opened; never a test verdict. */
    problem?: string;
    /** Notes worth telling a person (the chooser was refused, the app is also installed for another user). */
    notes: string[];
}

export const LAUNCH_WORDS = {
    notInstalledForUser: (pkg: string, user: number) => `The app ${pkg} is not installed for the phone's current user (user ${user}). Install it for that user, or switch the phone to the user that has it.`,
    chooser: "The phone answered with the \"Open with\" chooser instead of the app (two copies of the app may be installed, for example a parallel app), so the chooser was not used.",
    none: (pkg: string) => `The phone found no screen that opens ${pkg} for its current user. Open the app once by hand on the phone, then try again.`,
    badPackage: "The app's package name is not usable.",
} as const;

/** Text from adb with Windows line ends and stray spaces taken off every line; empty lines dropped. */
export function adbLines(text: string): string[] {
    return String(text ?? "")
        .split(/\r?\n|\r/)
        .map((l) => l.replace(/[\r\u0000]/g, "").trim())
        .filter(Boolean);
}

/** `am get-current-user` prints the user id; anything else (an old phone, an error) means user 0. */
export function currentUserFrom(text: string): number {
    const first = adbLines(text)[0] ?? "";
    return /^\d{1,6}$/.test(first) ? Number(first) : 0;
}

/** `pm list packages --user N`: undefined when the answer is not a package list at all (then it says nothing about the app). */
export function installedFrom(text: string, pkg: string): boolean | undefined {
    const ls = adbLines(text);
    if (!ls.some((l) => l.startsWith("package:"))) return undefined;
    return ls.some((l) => l === `package:${pkg}`);
}

/** The component of THIS package on its own line of `cmd package resolve-activity --brief`, or what it said instead. */
export function componentFromResolve(text: string, pkg: string): { component?: string; chooser?: boolean } {
    const ls = adbLines(text);
    const own = ls.find((l) => isComponent(l) && l.slice(0, l.indexOf("/")) === pkg);
    if (own) return { component: own };
    return ls.some((l) => l === RESOLVER_ACTIVITY || /\/com\.android\.internal\.app\.ResolverActivity$/.test(l)) ? { chooser: true } : {};
}

// ── dumpsys package parsing ─────────────────────────────────────────────────
// Ported from appium-adb (https://github.com/appium/appium-adb, lib/tools/app-commands.ts: parseLaunchableActivityNames and matchComponentName),
// Copyright JS Foundation and other contributors, licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
// Changes: TypeScript without lodash/@appium/support, \r tolerated on every line.

/** some.package/some.package.Activity */
export function matchComponentName(classString: string | undefined): boolean {
    return typeof classString === "string" && /^[\p{L}0-9./_$]+$/u.test(classString);
}

/**
 * The launchable activities in `dumpsys package` output: each block under an `android.intent.action.MAIN:` line, preferring the one whose category is
 * LAUNCHER (then that one alone is returned). Old Android versions list no category; then every MAIN activity is returned.
 */
export function parseLaunchableActivityNames(dumpsys: string): string[] {
    const mainActivityNameRe = new RegExp(`^\\s*${MAIN.replace(/\./g, "\\.")}:$`);
    const categoryNameRe = /^\s*Category:\s+"([a-zA-Z0-9._/-]+)"$/;
    const blocks: string[][] = [];
    let blockStartIndent: number | null = null;
    let block: string[] = [];
    for (const line of String(dumpsys ?? "").split("\n").map((x) => x.replace(/\r$/, "").trimEnd())) {
        const currentIndent = line.length - line.trimStart().length;
        if (mainActivityNameRe.test(line)) {
            blockStartIndent = currentIndent;
            if (block.length) {
                blocks.push(block);
                block = [];
            }
            continue;
        }
        if (blockStartIndent === null) continue;
        if (currentIndent > blockStartIndent) block.push(line);
        else {
            if (block.length) {
                blocks.push(block);
                block = [];
            }
            blockStartIndent = null;
        }
    }
    if (block.length) blocks.push(block);
    const result: string[] = [];
    for (const item of blocks) {
        let hasCategory = false;
        let isLauncherCategory = false;
        for (const line of item) {
            const match = categoryNameRe.exec(line);
            if (!match) continue;
            hasCategory = true;
            isLauncherCategory = match[1] === LAUNCHER;
            break;
        }
        // On older Android versions the category name might not be listed, so every match is taken instead.
        if (hasCategory && !isLauncherCategory) continue;
        for (const activityNameStr of item.map((x) => x.trim()).filter(Boolean)) {
            const fqActivityName = activityNameStr.split(/\s+/)[1];
            if (!matchComponentName(fqActivityName)) continue;
            if (isLauncherCategory) return [fqActivityName!];
            result.push(fqActivityName!);
        }
    }
    return result;
}
// ── end of the appium-adb port ──────────────────────────────────────────────

/** The first launchable component of `pkg` in `dumpsys package`, written as `pkg/activity`. */
export function componentFromDumpsys(text: string, pkg: string): string | undefined {
    for (const name of parseLaunchableActivityNames(text)) {
        const c = name.includes("/") ? name : `${pkg}/${name}`;
        if (isComponent(c) && c.slice(0, c.indexOf("/")) === pkg) return c;
    }
    return undefined;
}

/** The activity part of a component: `.Main` of `com.app/.Main`. */
export const activityOf = (component: string): string => component.slice(component.indexOf("/") + 1);

/** The calls the resolver makes, on an Adb allowed the ready check's read-only list and the preparation list (`dumpsys package`). */
export function launcherCall(adb: Adb): LauncherCall {
    const a = adb.forReadiness().forPreparation();
    return (args) => a.setupCall(args, 20_000);
}

export interface ResolveOptions {
    /** The user to resolve for; unset: the phone's current user (`am get-current-user`). */
    user?: number;
    /** Allow the last resort (`monkey` starts the app). Default true. */
    allowMonkey?: boolean;
}

/**
 * Resolves the launcher activity of `pkg` on the phone behind `adb` (an Adb, or a call function in tests). Never throws for an answer the phone gives;
 * a phone that cannot be reached at all throws the adb error (the caller says it in words).
 */
export async function resolveLauncher(adb: Adb | LauncherCall, pkgIn: string, opts: ResolveOptions = {}): Promise<LaunchResolution> {
    const call: LauncherCall = typeof adb === "function" ? adb : launcherCall(adb);
    const pkg = String(pkgIn ?? "").replace(/[\r\n]/g, "").trim();
    const notes: string[] = [];
    if (!SAFE_PACKAGE.test(pkg)) return { user: opts.user ?? 0, problem: LAUNCH_WORDS.badPackage, notes };
    const user = opts.user ?? currentUserFrom(await call(["shell", "am", "get-current-user"]).catch(() => ""));
    const found = (component: string, via: LaunchResolution["via"]): LaunchResolution => ({ component, activity: activityOf(component), user, via, notes });

    // Installed for this user at all? (A parallel copy in user 999 alone does not count: tests run as the current user.)
    const installed = installedFrom(await call(["shell", "pm", "list", "packages", "--user", String(user)]).catch(() => ""), pkg);
    if (installed === false) return { user, problem: LAUNCH_WORDS.notInstalledForUser(pkg, user), notes };

    // 1. resolve-activity with the launcher category, for this user.
    const r = componentFromResolve(await call(["shell", "cmd", "package", "resolve-activity", "--brief", "--user", String(user), "-c", LAUNCHER, pkg]).catch(() => ""), pkg);
    if (r.component) return found(r.component, "resolve-activity");
    if (r.chooser) notes.push(LAUNCH_WORDS.chooser);

    // 2. dumpsys package: MAIN + LAUNCHER (an activity-alias launcher is listed here too).
    const d = componentFromDumpsys(await call(["shell", "dumpsys", "package", pkg]).catch(() => ""), pkg);
    if (d) return found(d, "dumpsys");

    // 3. monkey starts the launcher the way a tap on the icon does; the activity in front then names it.
    if (opts.allowMonkey !== false) {
        const out = await call(["shell", "monkey", "-p", pkg, "-c", LAUNCHER, "1"]).catch(() => "monkey aborted");
        if (!/monkey aborted|No activities found/i.test(out)) {
            for (let i = 0; i < 6; i++) {
                const front = activityFromWindowDump((await call(["shell", "dumpsys", "window"]).catch(() => "")).replace(/\r/g, ""));
                if (front && front.package === pkg) {
                    // The window dump names the full class; written back as pkg/.Rest when it lives under the package (how am start writes it).
                    const component = `${pkg}/${front.activity.startsWith(`${pkg}.`) ? front.activity.slice(pkg.length) : front.activity}`;
                    if (isComponent(component)) return found(component, "monkey");
                }
                await new Promise((res) => setTimeout(res, 500));
            }
        }
    }
    return { user, problem: notes.length ? `${LAUNCH_WORDS.chooser} ${LAUNCH_WORDS.none(pkg)}` : LAUNCH_WORDS.none(pkg), notes };
}
