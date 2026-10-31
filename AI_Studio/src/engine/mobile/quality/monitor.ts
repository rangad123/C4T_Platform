/**
 * Watches the app under test on one phone: crashes and freezes from the phone's log since a mark, a measured cold start, the screen density.
 * Used by the local device session (exploration) and by the mobile runner (test runs). Every call goes through the closed adb wrapper
 * (device/adb.ts): fixed argument lists, the configured package only, nothing that changes the phone except stopping and starting THE app.
 *
 * A phone that cannot be read this way (an old Android without the crash buffer, a broken link) never fails the exploration or the run: the
 * monitor says once, in plain words, what is not checked.
 */
import type { Adb } from "../device/adb.js";
import { crashesIn, formatMark, parseLogLines } from "./logcat.js";
import { launcherFromResolve, parseStartOutput } from "./startup.js";
import type { AppCrash, StartupMeasure } from "./types.js";

export const LOG_UNREADABLE = "The phone's crash log could not be read, so crashes and freezes are not checked on this phone.";
export const START_UNMEASURED = "The start-up time could not be measured on this phone";

export class AppMonitor {
    private mark: number | undefined;
    private seenAtMark = new Set<string>();
    /** Set when the log cannot be read: crashes are not checked, and this says why. */
    unavailable: string | undefined;

    constructor(
        private readonly adb: Adb,
        readonly appPackage: string,
        private readonly secrets: readonly string[] = [],
    ) {}

    /** Takes the mark: entries logged from now on are this run's. False (and `unavailable` set) when the log cannot be read. */
    async start(): Promise<boolean> {
        try {
            const text = await this.adb.logcat("1");
            const lines = parseLogLines(text);
            const last = lines[lines.length - 1];
            this.mark = last ? last.at : 0;
            this.seenAtMark = new Set(lines.filter((l) => l.at === this.mark).map((l) => l.raw));
            this.unavailable = undefined;
            return true;
        } catch {
            this.unavailable = LOG_UNREADABLE;
            return false;
        }
    }

    get started(): boolean {
        return this.mark !== undefined;
    }

    /** Crashes and freezes of the app logged since the mark (or since the last call). An unreadable log gives none and sets `unavailable`. */
    async crashes(): Promise<AppCrash[]> {
        if (this.mark === undefined) return [];
        let text: string;
        try {
            text = await this.adb.logcat(formatMark(this.mark));
        } catch {
            this.unavailable = LOG_UNREADABLE;
            return [];
        }
        const found = crashesIn(text, this.appPackage, { after: this.mark, seenAtMark: this.seenAtMark, secrets: this.secrets });
        const lines = parseLogLines(text);
        const newest = lines.reduce((m, l) => Math.max(m, l.at), this.mark);
        if (newest > this.mark) {
            this.mark = newest;
            this.seenAtMark = new Set();
        }
        for (const l of lines) if (l.at === this.mark) this.seenAtMark.add(l.raw);
        return found;
    }

    /** Stops the app and starts it cold, as Android measures it. The app is left on its first screen. */
    async coldStart(): Promise<{ measure?: StartupMeasure; problem?: string }> {
        try {
            const component = launcherFromResolve(await this.adb.resolveLauncher(this.appPackage), this.appPackage);
            if (!component) return { problem: `${START_UNMEASURED}: the app's first screen (its launcher activity) was not found.` };
            const measure = parseStartOutput(await this.adb.startAndWait(component));
            return measure ? { measure } : { problem: `${START_UNMEASURED}: Android did not report a start-up time.` };
        } catch (e) {
            return { problem: `${START_UNMEASURED}: ${e instanceof Error ? e.message : "the phone did not answer"}` };
        }
    }

    async densityDpi(): Promise<number | undefined> {
        try {
            return await this.adb.densityDpi();
        } catch {
            return undefined;
        }
    }

    /** The phone's clock minus this computer's, in ms (to place a logged crash among the tests of a run), or undefined. */
    async clockOffsetMs(): Promise<number | undefined> {
        try {
            const before = Date.now();
            const s = await this.adb.deviceSeconds();
            if (s === undefined) return undefined;
            return s * 1000 - (before + Date.now()) / 2;
        } catch {
            return undefined;
        }
    }
}
