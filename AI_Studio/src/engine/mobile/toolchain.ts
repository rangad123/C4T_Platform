/**
 * Is there an Android toolchain this platform can run mobile tests on?
 *
 * Mobile tests are executed by Taqwright (Apache-2.0), which drives an emulator or device through Appium.
 * `npx @taqwright/taqwright install --with-avd` vendors everything it needs (JDK, SDK, Appium, an emulator image)
 * into Taqwright's own directory; an Android SDK the user already has on ANDROID_HOME works too.
 * Taqwright resolves its toolchain itself when it runs; this module only answers "can we run?" up front,
 * so tests stay PENDING with an explicit reason instead of failing for an environmental cause.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface MobileAvailability {
    available: boolean;
    /** Why not, in a form that can be shown to a user. */
    reason?: string;
    /** Android Virtual Devices found on this machine. */
    avds: string[];
    toolchain: "managed" | "system" | "none";
}

const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

/** Where `taqwright install` puts its toolchain (mirrors Taqwright's own path rules). */
export function taqwrightHome(env: NodeJS.ProcessEnv = process.env): string {
    if (env.TAQWRIGHT_HOME?.trim()) return path.resolve(env.TAQWRIGHT_HOME);
    const home = os.homedir();
    if (process.platform === "darwin") return path.join(home, "Library", "Caches", "taqwright");
    if (process.platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "taqwright");
    return path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "taqwright");
}

function managedSdk(env: NodeJS.ProcessEnv): string | undefined {
    try {
        const m = JSON.parse(fs.readFileSync(path.join(taqwrightHome(env), "manifest.json"), "utf8")) as { androidHome?: string; javaHome?: string };
        if (m.androidHome && m.javaHome && fs.existsSync(path.join(m.androidHome, "platform-tools", exe("adb"))) && fs.existsSync(path.join(m.javaHome, "bin", exe("java")))) return m.androidHome;
    } catch {
        /* not installed */
    }
    return undefined;
}

export function listAvds(env: NodeJS.ProcessEnv = process.env): string[] {
    const dir = env.ANDROID_AVD_HOME || path.join(os.homedir(), ".android", "avd");
    try {
        return fs.readdirSync(dir).filter((f) => f.endsWith(".ini")).map((f) => f.slice(0, -4)).sort();
    } catch {
        return [];
    }
}

export function mobileAvailability(env: NodeJS.ProcessEnv = process.env): MobileAvailability {
    const avds = listAvds(env);
    const managed = managedSdk(env);
    const sdk = managed ?? (env.ANDROID_HOME && fs.existsSync(path.join(env.ANDROID_HOME, "platform-tools", exe("adb"))) ? env.ANDROID_HOME : undefined);
    if (!sdk) {
        return { available: false, avds, toolchain: "none", reason: "No Android toolchain found. Run `npx @taqwright/taqwright install --with-avd` on the machine that runs the platform." };
    }
    const toolchain = managed ? "managed" : "system";
    if (avds.length === 0) {
        return { available: false, avds, toolchain, reason: "The Android toolchain is installed but no emulator exists. Run `npx @taqwright/taqwright install --with-avd` or create one in Android Studio." };
    }
    return { available: true, avds, toolchain };
}

/** The Android SDK in use: Taqwright's managed one, else ANDROID_HOME. */
export function androidSdk(env: NodeJS.ProcessEnv = process.env): string | undefined {
    return managedSdk(env) ?? (env.ANDROID_HOME?.trim() || undefined);
}

/**
 * `adb` from whichever toolchain is in use. `AITP_ADB_PATH` (set by the operator or by a test) replaces it: the platform's own tests point it at a stand-in
 * written in Node (tests/fixtures/fake-adb.mjs) so no emulator, phone or adb server is ever needed. Unset: today's behaviour.
 */
export function adbPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const seam = env.AITP_ADB_PATH?.trim();
    if (seam) return fs.existsSync(seam) ? path.resolve(seam) : undefined;
    const sdk = androidSdk(env);
    if (!sdk) return undefined;
    const p = path.join(sdk, "platform-tools", exe("adb"));
    return fs.existsSync(p) ? p : undefined;
}

/**
 * How to start a program for `execFile` / `spawn`: a Node script (the stand-in tools of the tests) is run by this Node, anything else is run as it is.
 * Never goes through a shell, so no argument is ever interpreted.
 */
export function commandFor(file: string, args: string[]): { file: string; args: string[] } {
    return /\.(mjs|cjs|js)$/i.test(file) ? { file: process.execPath, args: [file, ...args] } : { file, args };
}
