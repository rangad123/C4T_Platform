/**
 * The runner gets Google's Android phone tools (adb) itself when a phone needs them (see docs/features/phone-setup-simple.md and
 * ../engine/mobile/platform-tools.ts).
 *
 * The setting (AITP_PHONE_TOOLS, or `phoneTools` in the kit's runner.json; the environment beats the file):
 *   auto  the runner fetches the tools when a phone session arrives and this computer has no adb (default for a runner started from a downloaded kit);
 *   now   the same, and it also fetches them right away at start (what the installers' "Get the Android phone tools now" choice writes);
 *   off   never (default for a runner started from a repository checkout: a developer's own Android SDK is left alone).
 *
 * Only when nothing else gives adb (AITP_ADB_PATH, Taqwright's toolchain, ANDROID_HOME) are the runner's own tools used: then ANDROID_HOME in the
 * runner's environment points at its own `phone-tools` folder, so everything that looks for adb (the capability probe, the phone session, Taqwright)
 * finds them, and nothing on the computer outside the runner's folder changes. A download that fails is tried again at most 3 times an hour.
 */
import path from "node:path";
import { adbPath } from "../engine/mobile/toolchain.js";
import { fetchPlatformTools, installedPhoneTools, phoneToolsHost, PhoneToolsError, USB_DEBUGGING_STEPS, type InstalledPhoneTools } from "../engine/mobile/platform-tools.js";
import type { Logger } from "./log.js";

export type PhoneToolsPolicy = "auto" | "now" | "off";
export const PHONE_TOOLS_POLICIES: readonly PhoneToolsPolicy[] = ["auto", "now", "off"];
export const isPhoneToolsPolicy = (v: string): v is PhoneToolsPolicy => (PHONE_TOOLS_POLICIES as readonly string[]).includes(v);

/** What the capabilities say about the runner's own phone tools (additive protocol field; never a path). */
export interface PhoneToolsReport {
    state: "ready" | "can-fetch" | "fetching" | "failed" | "off" | "unsupported";
    version?: string;
    note?: string;
}

/** At most this many download attempts in an hour, and none sooner than this after a failure. */
export const PHONE_TOOLS_RETRY = { perHour: 3, afterFailureMs: 2 * 60_000 } as const;

export interface PhoneToolsSetupOptions {
    policy?: PhoneToolsPolicy;
    /** The runner's environment: ANDROID_HOME is set here when the runner's own tools are used. */
    env: NodeJS.ProcessEnv;
    log: Logger;
    /** The runner's work folder; the tools live in `<workDir>/phone-tools`. */
    workDir: string;
    platform?: NodeJS.Platform;
    arch?: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
    /** Called when what the runner can offer changed (the tools arrived, or a download failed), so capabilities are sent again. */
    onChange?: () => void;
}

/** The policy from the environment, else the default for this kind of runner. */
export function phoneToolsPolicy(env: NodeJS.ProcessEnv, fromKit: boolean): PhoneToolsPolicy {
    const raw = (env.AITP_PHONE_TOOLS ?? "").trim().toLowerCase();
    if (isPhoneToolsPolicy(raw)) return raw;
    return fromKit ? "auto" : "off";
}

export class PhoneToolsSetup {
    readonly dir: string;
    readonly policy: PhoneToolsPolicy;
    private readonly platform: NodeJS.Platform;
    private readonly now: () => number;
    private installed?: InstalledPhoneTools;
    private pending?: Promise<InstalledPhoneTools | undefined>;
    private failure?: { at: number; reason: string };
    private attempts: number[] = [];

    constructor(private readonly o: PhoneToolsSetupOptions) {
        this.dir = path.join(o.workDir, "phone-tools");
        this.policy = o.policy ?? "off";
        this.platform = o.platform ?? process.platform;
        this.now = o.now ?? Date.now;
    }

    /** Another adb is there (Taqwright's, ANDROID_HOME's, AITP_ADB_PATH): the runner's own tools are not needed. */
    private otherAdb(): boolean {
        const found = adbPath(this.o.env);
        return Boolean(found) && !(this.installed && path.resolve(found!) === path.resolve(this.installed.adb));
    }

    /** Point ANDROID_HOME at the runner's own tools, when they are there and nothing else gives adb. */
    private use(t: InstalledPhoneTools): void {
        this.installed = t;
        if (!adbPath(this.o.env)) this.o.env.ANDROID_HOME = t.home;
    }

    /** At start: use tools fetched earlier; with "now", fetch them in the background when this computer has no adb. */
    prepare(): void {
        if (this.policy === "off") return;
        const have = installedPhoneTools(this.dir, this.platform);
        if (have && !this.otherAdb()) {
            this.use(have);
            this.o.log.info(`Android phone tools: using the ones the runner fetched before (version ${have.version}).`);
            return;
        }
        if (this.policy === "now" && !this.otherAdb()) void this.ensure((line) => this.o.log.info(line));
    }

    /** One line about the phone tools, or nothing when another adb is used or the setting is off. */
    report(): PhoneToolsReport | undefined {
        if (this.policy === "off") return undefined;
        if (this.installed && path.resolve(adbPath(this.o.env) ?? "") === path.resolve(this.installed.adb)) return { state: "ready", version: this.installed.version };
        if (this.otherAdb()) return undefined;
        if (this.pending) return { state: "fetching", note: "Getting the Android phone tools from Google." };
        const host = phoneToolsHost(this.platform, this.o.arch ?? process.arch);
        if (!host.ok) return { state: "unsupported", note: host.reason.slice(0, 300) };
        if (this.failure && !this.mayTry()) return { state: "failed", note: `The Android phone tools could not be fetched: ${this.failure.reason}`.slice(0, 300) };
        return { state: "can-fetch", note: "The runner gets the Android phone tools from Google when a phone session arrives." };
    }

    private mayTry(): boolean {
        const t = this.now();
        this.attempts = this.attempts.filter((a) => t - a < 60 * 60_000);
        if (this.attempts.length >= PHONE_TOOLS_RETRY.perHour) return false;
        return !this.failure || t - this.failure.at >= PHONE_TOOLS_RETRY.afterFailureMs;
    }

    /**
     * Make sure adb is there, fetching the runner's own tools when allowed and needed. Answers "ready" (adb can be used now), or a plain reason why
     * not. Never throws. Several callers at once share one download.
     */
    async ensure(note: (line: string) => void, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }> {
        if (adbPath(this.o.env)) return { ok: true };
        if (this.policy === "off") return { ok: false, reason: "This computer has no Android phone tools (adb), and the runner is set not to fetch them (AITP_PHONE_TOOLS=off)." };
        if (!this.pending) {
            if (!this.mayTry()) return { ok: false, reason: `The Android phone tools could not be fetched a moment ago (${this.failure?.reason ?? "unknown problem"}). The runner tries again in a few minutes.` };
            this.attempts.push(this.now());
            note("This computer has no Android phone tools (adb). The runner gets them from Google (about 7 to 15 MB, into its own folder). By using them you accept Google's Android SDK license: https://developer.android.com/studio/terms");
            this.pending = fetchPlatformTools({ dir: this.dir, platform: this.platform, ...(this.o.arch ? { arch: this.o.arch } : {}), env: this.o.env, ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}), ...(signal ? { signal } : {}), onLine: note })
                .then((t) => {
                    this.failure = undefined;
                    this.use(t);
                    for (const [i, step] of USB_DEBUGGING_STEPS.entries()) note(`To use a phone on USB: ${i + 1}. ${step}`);
                    return t;
                })
                .catch((e: unknown) => {
                    const reason = e instanceof PhoneToolsError ? e.message : "an unexpected problem";
                    this.failure = { at: this.now(), reason };
                    this.o.log.warn(`The Android phone tools could not be fetched: ${reason}`);
                    return undefined;
                })
                .finally(() => {
                    this.pending = undefined;
                    this.o.onChange?.();
                });
            this.o.onChange?.();
        }
        const got = await this.pending;
        if (got && adbPath(this.o.env)) return { ok: true };
        return { ok: false, reason: `The Android phone tools could not be fetched: ${this.failure?.reason ?? "unknown problem"}` };
    }
}
