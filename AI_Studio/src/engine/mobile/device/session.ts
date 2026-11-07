/**
 * The device session on THIS computer: one open conversation with a phone or emulator, through adb.
 *
 *  - finds the device (a connected phone or emulator, else the project's emulator, started through the platform's own emulator helper and stopped only if
 *    this session started it), installs the APK when one is given, starts the app under test;
 *  - `snapshot` reads the screen (UI Automator) and, when asked, takes a picture with every password field covered;
 *  - `act` performs ONE action named by an element of the last snapshot, after the checks in actions.ts, then waits for the screen to settle and returns it.
 *
 * What it never does: take coordinates from the AI, run any command other than the closed list in adb.ts, start any app but the configured one, uninstall
 * anything (except, when asked with removeInstalledApp, the app it installed itself on a real phone, once it closes), change a setting, grant or revoke a permission except by tapping the visible dialog like a person, or return a password. Failures of the phone or
 * the link are thrown as DeviceSessionError (never a verdict about the app); a refused or failed action is returned as `{ ok: false, error }`.
 */
import fs from "node:fs";
import { ensureEmulator, withDeviceLock, type EmulatorHandle } from "../emulator.js";
import { listAvds } from "../toolchain.js";
import { Adb, AdbError, MESSAGES, type AdbDevice } from "./adb.js";
import { REFUSALS, parseAction, planAction, sameElement, type Credentials, type Plan } from "./actions.js";
import { DeviceSessionError } from "./errors.js";
import { screenshotJpeg } from "./image.js";
import type { ActResult, DeviceAction, DeviceSession, OpenDeviceOptions, ScreenElement, ScreenSnapshot } from "./types.js";
import { activityFromWindowDump, isLockedFromWindowDump, keyboardFromInputDump, parseHierarchy, SCREEN_UNREADABLE } from "./uiautomator.js";
import { Uia2Source } from "./uia2-source.js";
import { adbKeyboardSelected, encodeForAdbKeyboard } from "../state/unicode.js";
import { AppMonitor } from "../quality/monitor.js";
import type { AppHealth } from "./types.js";

/** A person's own computer whose owner did not allow their connected phone (round 39): said instead of using it. */
export const NO_REAL_PHONE = "This computer's owner has not allowed their connected phone to be used. Set up an emulator on it, or its owner can turn on “Use my connected phone” on the Runners page.";
export const SESSION_DEFAULTS = { maxActions: 200, maxMinutes: 20 } as const;
/** The most actions one session may be given (R24: a Thorough exploration, with room for going back and starting again). */
export const MAX_SESSION_ACTIONS = 1500;
export const SCREEN_NEVER_SETTLES = "The phone's screen could not be read because it never settles (a video or a live feed keeps changing it). Pause the video or open a quieter screen, then try again.";
const IDLE_ERROR = /could not get idle state|ERROR: null root node/i;
/** Tests can fix the local port forwarded to the UiAutomator2 server. */
const uia2Port = (env: NodeJS.ProcessEnv | undefined): number | undefined => {
    const n = Number(env?.AITP_UIA2_PORT ?? "");
    return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : undefined;
};

/**
 * The app's own activities named in the activity resolver table of `dumpsys package <pkg>` (the activities with intent filters), short names,
 * unique. The line format ("<hash> com.example.shop/.MainActivity filter <hash>") is the one appium-adb's dumpsys parsing reads (Apache-2.0);
 * the code is ours.
 */
export function activitiesFromPackageDump(text: string, pkg: string): string[] {
    const out = new Set<string>();
    const component = new RegExp(`(?:^|\\s)${pkg.replace(/\./g, "\\.")}/([A-Za-z0-9_.$]+)`, "g");
    let inActivities = false;
    for (const raw of text.split(/\r?\n/)) {
        const head = /^(\S[\w ]*):\s*$/.exec(raw.trimEnd());
        if (head) inActivities = /^Activity Resolver Table$/.test(head[1]!);
        if (!inActivities) continue;
        for (const m of raw.matchAll(component)) {
            const name = m[1]!.startsWith(".") ? m[1]!.slice(1) : m[1]!.split(".").pop()!;
            if (name && out.size < 500) out.add(name);
        }
    }
    return [...out];
}
/** How long the screen must stay the same to count as settled, how often it is looked at, and the longest wait. */
export const SETTLE = { stableMs: 400, pollMs: 150, maxMs: 3000 } as const;

const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
/** The longest a secret shorter than this is not scrubbed from text (it would shred every word); the field-type rule still protects it. */
const MIN_SCRUBBED = 4;

const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        const t = setTimeout(done, ms);
        function done() {
            clearTimeout(t);
            signal?.removeEventListener("abort", done);
            resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
    });

/** The device lock, held for as long as a session is open: one user of the emulator at a time (tests that run on the device wait for it). */
function holdDeviceLock(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        let acquired = false;
        const onAbort = () => {
            if (!acquired) reject(new DeviceSessionError(MESSAGES.aborted));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        void withDeviceLock(async () => {
            acquired = true;
            signal?.removeEventListener("abort", onAbort);
            if (signal?.aborted) {
                release();
                return reject(new DeviceSessionError(MESSAGES.aborted));
            }
            resolve(release);
            await held;
        });
    });
}

function toSessionError(e: unknown): DeviceSessionError {
    if (e instanceof DeviceSessionError) return e;
    if (e instanceof AdbError) return new DeviceSessionError(e.message);
    return new DeviceSessionError(MESSAGES.failed);
}

const scrubAll = (text: string, secrets: readonly string[]): string => {
    let out = text;
    for (const s of secrets) if (s.length >= MIN_SCRUBBED) out = out.split(s).join("[hidden]");
    return out;
};

export async function openLocalDeviceSession(opts: OpenDeviceOptions): Promise<DeviceSession> {
    const env = opts.env ?? process.env;
    const log = opts.log ?? (() => undefined);
    if (!PACKAGE.test(opts.appPackage ?? "")) throw new DeviceSessionError("The app to explore needs an Android application id such as com.example.app.");
    if (opts.apkPath !== undefined && (!/\.apk$/i.test(opts.apkPath) || !fs.existsSync(opts.apkPath))) throw new DeviceSessionError("The app file was not found on this computer.");
    const secrets = [opts.credentials?.password ?? ""].filter((s) => s.length > 0);
    const base = Adb.locate({ env, ...(opts.signal ? { signal: opts.signal } : {}), secrets });
    if (!base) throw new DeviceSessionError(MESSAGES.notInstalled);

    const release = await holdDeviceLock(opts.signal);
    let emulator: EmulatorHandle | undefined;
    let closed = false;
    /** A real phone this session installed the app on (removeInstalledApp): it is removed again when the session closes. */
    let removeFrom: string | undefined;
    const closeAll = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        try {
            if (removeFrom) {
                log("Removing the app this session installed");
                await base.forSerial(removeFrom).forCleanup().uninstall(opts.appPackage).catch(() => undefined);
            }
            if (emulator?.started) {
                log("Stopping the emulator this session started");
                await emulator.stop();
            }
        } catch {
            /* the emulator helper has already tried by id and by process; nothing more to do here */
        } finally {
            release();
        }
    };

    try {
        // ── the device ──
        let devices: AdbDevice[];
        try {
            devices = await base.devices();
        } catch (e) {
            throw toSessionError(e);
        }
        let chosen: AdbDevice | undefined;
        if (opts.serial) {
            chosen = devices.find((d) => d.serial === opts.serial);
            if (!chosen) throw new DeviceSessionError(MESSAGES.noDevice);
            if (opts.noRealPhone && !chosen.emulator) throw new DeviceSessionError(NO_REAL_PHONE);
        } else if (opts.emulatorOnly || opts.noRealPhone) {
            // The project asked to run on an emulator: use a running one, else fall through to start an AVD (never the connected phone).
            chosen = devices.find((d) => d.state === "device" && d.emulator);
        } else {
            // A ready real phone before an emulator (R24): the phone the person plugged in is the one they mean.
            chosen = devices.find((d) => d.state === "device" && !d.emulator) ?? devices.find((d) => d.state === "device");
        }
        if (chosen && chosen.state !== "device") throw new DeviceSessionError(chosen.state === "unauthorized" ? MESSAGES.unauthorized : MESSAGES.offline);
        if (!chosen) {
            const avd = opts.avd ?? (opts.emulatorOnly || opts.noRealPhone || devices.length === 0 ? listAvds(env)[0] : undefined);
            if (!avd && opts.noRealPhone && devices.some((d) => !d.emulator)) throw new DeviceSessionError(NO_REAL_PHONE);
            if (!avd) {
                const blocked = devices.find((d) => d.state === "unauthorized");
                throw new DeviceSessionError(blocked ? MESSAGES.unauthorized : devices.length ? MESSAGES.offline : MESSAGES.noDevice);
            }
            log(`Starting the emulator ${avd}`);
            try {
                emulator = await ensureEmulator(avd, { env, ...(opts.signal ? { signal: opts.signal } : {}), log });
            } catch (e) {
                throw new DeviceSessionError(e instanceof Error && e.message ? e.message.split("\n")[0]!.slice(0, 300) : "The emulator could not be started.");
            }
            chosen = { serial: emulator.serial, state: "device", emulator: true };
        }
        const dev = base.forSerial(chosen.serial);

        // ── the phone ──
        const windowDump = () => dev.windowDump().catch((e) => Promise.reject(toSessionError(e)));
        if (chosen.emulator && isLockedFromWindowDump(await windowDump())) {
            // A freshly booted emulator shows its default swipe-only keyguard. Wake it and dismiss it. `wm dismiss-keyguard` cannot unlock a
            // real phone's secured lock (it only shows the PIN prompt), which stays a plain "unlock it" refusal below.
            await dev.keys("KEYCODE_WAKEUP").catch(() => undefined);
            await dev.dismissKeyguard().catch(() => undefined);
            await dev.keys("KEYCODE_MENU").catch(() => undefined);
            await dev.swipe(540, 1600, 540, 400, 300).catch(() => undefined);
            await new Promise((r) => setTimeout(r, 800));
        }
        if (isLockedFromWindowDump(await windowDump())) throw new DeviceSessionError(MESSAGES.locked);
        if (opts.apkPath) {
            // On a real phone of a person's own computer: was the app there before? If not, it is removed again when the session closes.
            const hadIt = opts.removeInstalledApp && !chosen.emulator ? await dev.hasPackage(opts.appPackage).catch(() => true) : true;
            log("Installing the app");
            await dev.install(opts.apkPath).catch((e) => Promise.reject(toSessionError(e)));
            if (!hadIt) removeFrom = chosen.serial;
        } else if (!(await dev.hasPackage(opts.appPackage).catch((e) => Promise.reject(toSessionError(e))))) {
            throw new DeviceSessionError(`The app ${opts.appPackage} is not installed on this phone, and no app file was given.`);
        }
        const model = await dev.prop("ro.product.model").catch(() => "");
        const deviceName = `${model.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 40) || "Android device"} (${chosen.serial})`;

        const cleanModel = model.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 60);
        const session = new LocalSession(dev, deviceName, opts, secrets, closeAll, { serial: chosen.serial, emulator: chosen.emulator, ...(cleanModel ? { model: cleanModel } : {}) });
        // Phone quality checks (mobile/quality): the crash log is marked before the app starts, so a crash on start is this session's.
        const monitor = new AppMonitor(dev, opts.appPackage, secrets);
        await monitor.start();
        session.attachHealth(monitor);
        await session.start();
        log(`Opened ${opts.appPackage} on ${deviceName}`);
        return session;
    } catch (e) {
        await closeAll();
        throw toSessionError(e);
    }
}

class LocalSession implements DeviceSession {
    readonly kind = "local" as const;
    private last: ScreenSnapshot | undefined;
    private actions = 0;
    private readonly startedAt = Date.now();
    private chain: Promise<unknown> = Promise.resolve();
    private ended = false;
    private readonly maxActions: number;
    private readonly maxMs: number;
    private readonly creds: Credentials | undefined;
    /** The phone's current keyboard is ADBKeyboard: text beyond ASCII can be typed (state/unicode.ts). Looked at once, when the session starts. */
    private unicode = false;

    constructor(
        private readonly dev: Adb,
        readonly deviceName: string,
        private readonly opts: OpenDeviceOptions,
        private readonly secrets: string[],
        private readonly closeAll: () => Promise<void>,
        who: { serial: string; emulator: boolean; model?: string } = { serial: "", emulator: false },
    ) {
        this.serial = who.serial || undefined;
        this.emulator = who.emulator;
        this.model = who.model;
        // R24: a Thorough exploration takes up to 1,200 actions and an hour (explore/types.ts depthLimits).
        this.maxActions = Math.max(1, Math.min(MAX_SESSION_ACTIONS, opts.maxActions ?? SESSION_DEFAULTS.maxActions));
        this.maxMs = Math.max(1, Math.min(120, opts.maxMinutes ?? SESSION_DEFAULTS.maxMinutes)) * 60_000;
        this.creds = opts.credentials;
        // A stop from outside ends the session: the adb call in flight is killed and the emulator this session started is stopped.
        opts.signal?.addEventListener("abort", () => void this.close(), { once: true });
    }

    /** Added by PQ: what the phone reports about the app (crashes, a measured cold start, density). Calls take their turn with the actions. */
    health?: AppHealth;

    // ── added by EXPLORE (R24) ──
    readonly serial: string | undefined;
    readonly model: string | undefined;
    readonly emulator: boolean;
    get actionLimit(): number {
        return this.maxActions;
    }
    get minuteLimit(): number {
        return Math.round(this.maxMs / 60_000);
    }
    /** How the screen is read: the plain dump; after it failed, the compressed dump; then the installed UiAutomator2 server. Kept for the session. */
    private source: "plain" | "compressed" | "server" = "plain";
    private server: Uia2Source | undefined;
    private serverTried = false;

    /** The app's activities the phone lists (`dumpsys package`, read once through the preparation adb, read-only). */
    listedActivities(): Promise<string[] | undefined> {
        return this.guarded(async () => activitiesFromPackageDump(await this.dev.forPreparation().packageDump(this.opts.appPackage), this.opts.appPackage)).catch(() => undefined);
    }

    /**
     * The screen description. `uiautomator dump` fails with "could not get idle state" on screens that never settle (a feed, a video): it is
     * tried again once, then in its compressed form, then through the UiAutomator2 server already on the phone (uia2-source.ts, which does not
     * wait for idle). The first form that works is kept for the rest of the session.
     */
    private async dump(): Promise<string> {
        if (this.source === "server" && this.server) {
            try {
                return await this.server.source();
            } catch {
                this.source = "plain";
            }
        }
        const compressed = this.source === "compressed";
        const first = await this.tryDump(compressed);
        if (first.xml !== undefined) return first.xml;
        await sleep(300, this.signal);
        const again = await this.tryDump(compressed);
        if (again.xml !== undefined) return again.xml;
        if (!compressed) {
            const c = await this.tryDump(true);
            if (c.xml !== undefined) {
                this.source = "compressed";
                this.opts.log?.("The screen does not settle for a plain read; reading it in compressed form from now on");
                return c.xml;
            }
        }
        if (!this.serverTried && !this.signal?.aborted) {
            this.serverTried = true;
            const port = uia2Port(this.opts.env);
            this.server = await Uia2Source.open(this.dev, { ...(this.opts.signal ? { signal: this.opts.signal } : {}), ...(this.opts.log ? { log: this.opts.log } : {}), ...(port ? { port } : {}) });
        }
        if (this.server) {
            try {
                const xml = await this.server.source();
                this.source = "server";
                return xml;
            } catch {
                /* fall through to the error of the dump */
            }
        }
        throw again.error ?? new DeviceSessionError(SCREEN_NEVER_SETTLES);
    }

    private async tryDump(compressed: boolean): Promise<{ xml?: string; error?: unknown }> {
        try {
            const xml = await this.dev.uiDump(compressed);
            // Some versions print the error and end normally.
            if (IDLE_ERROR.test(xml) || !xml.includes("<hierarchy")) return { error: new DeviceSessionError(SCREEN_NEVER_SETTLES) };
            return { xml };
        } catch (e) {
            if (e instanceof AdbError && e.code === "failed") return { error: e };
            throw e;
        }
    }

    attachHealth(m: AppMonitor): void {
        this.health = {
            crashes: () => this.guarded(() => m.crashes()),
            coldStart: () =>
                this.guarded(async () => {
                    const r = await m.coldStart();
                    // The app was restarted: element numbers of the last snapshot no longer name anything.
                    this.last = undefined;
                    await this.settle();
                    return r;
                }),
            densityDpi: () => this.guarded(() => m.densityDpi()),
            get unavailable() {
                return m.unavailable;
            },
        };
    }

    async start(): Promise<void> {
        await this.guarded(async () => {
            this.unicode = adbKeyboardSelected(await this.dev.inputMethodDump().catch(() => ""));
            await this.dev.launch(this.opts.appPackage);
            await this.settle();
        });
    }

    private get signal(): AbortSignal | undefined {
        return this.opts.signal;
    }

    /** Calls run one at a time, in order; a session that is over refuses; a failed phone or link ends as DeviceSessionError. */
    private guarded<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.chain.then(async () => {
            if (this.ended || this.signal?.aborted) throw new DeviceSessionError(this.signal?.aborted ? MESSAGES.aborted : "This session has ended.");
            if (Date.now() - this.startedAt > this.maxMs) {
                await this.close();
                throw new DeviceSessionError(`This session reached its time limit of ${Math.round(this.maxMs / 60_000)} minutes.`);
            }
            try {
                return await fn();
            } catch (e) {
                throw toSessionError(e);
            }
        });
        this.chain = run.catch(() => undefined);
        return run;
    }

    // ── looking ──

    /** Everything that can be known about the screen right now: the snapshot as it leaves this module, and the elements as read (for covering the picture). */
    private async read(xmlIn?: string): Promise<{ snap: ScreenSnapshot; raw: ScreenElement[] }> {
        let xml = xmlIn;
        let why = SCREEN_UNREADABLE;
        for (let attempt = 0; attempt < 2; attempt++) {
            if (xml === undefined) xml = await this.dump();
            const [win, ime] = await Promise.all([this.dev.windowDump().catch(() => ""), this.dev.inputMethodDump().catch(() => "")]);
            if (isLockedFromWindowDump(win)) throw new DeviceSessionError(MESSAGES.locked);
            const focus = activityFromWindowDump(win);
            const parsed = parseHierarchy(xml, { appPackage: this.opts.appPackage, keyboard: keyboardFromInputDump(ime) });
            if (parsed.ok) {
                let s = parsed.snapshot;
                // The activity belongs to the screen only when it is of the package that is in front.
                if (focus && focus.package === s.package) {
                    const again = parseHierarchy(xml, { appPackage: this.opts.appPackage, activity: focus.activity, keyboard: s.keyboard });
                    if (again.ok) s = again.snapshot;
                }
                const raw = s.elements as ScreenElement[];
                return { snap: this.scrubbed(s as ScreenSnapshot), raw };
            }
            // A screen that is changing can give half a document; one more look settles it.
            why = parsed.error;
            xml = undefined;
            await sleep(300, this.signal);
        }
        throw new DeviceSessionError(why);
    }

    /** Text that contains the password (a field whose "show password" is on) is hidden in what leaves this module. */
    private scrubbed(s: ScreenSnapshot): ScreenSnapshot {
        if (!this.secrets.some((x) => x.length >= MIN_SCRUBBED)) return s;
        return { ...s, elements: s.elements.map((e) => ({ ...e, text: scrubAll(e.text, this.secrets), desc: scrubAll(e.desc, this.secrets) })) };
    }

    /** Waits until the screen looks the same for 400 ms (at most 3 s), returning the last description of it. */
    private async settle(): Promise<string> {
        const end = Date.now() + SETTLE.maxMs;
        let xml = await this.dump();
        let print = this.quickPrint(xml);
        let since = Date.now();
        while (Date.now() < end && Date.now() - since < SETTLE.stableMs) {
            await sleep(SETTLE.pollMs, this.signal);
            if (this.signal?.aborted) break;
            const next = await this.dump();
            const nextPrint = this.quickPrint(next);
            if (nextPrint !== print) {
                print = nextPrint;
                since = Date.now();
            }
            xml = next;
        }
        return xml;
    }

    private quickPrint(xml: string): string {
        const p = parseHierarchy(xml, { appPackage: this.opts.appPackage });
        // The fingerprint with text: settled means nothing visible changes any more (the structural one ignores list content).
        return p.ok ? (p.snapshot.textFingerprint ?? p.snapshot.fingerprint) : `unreadable:${xml.length}`;
    }

    private async withPicture(snap: ScreenSnapshot, raw: ScreenElement[]): Promise<ScreenSnapshot> {
        try {
            const png = await this.dev.screencap();
            // Cover every password field, and every element whose text had to be scrubbed (a field showing the password).
            const covers = raw.flatMap((e, i) => (e.password || snap.elements[i]?.text !== e.text || snap.elements[i]?.desc !== e.desc ? [e.bounds] : []));
            const shot = screenshotJpeg(png, covers, { coverSpace: { width: snap.width, height: snap.height } });
            if (shot) return { ...snap, screenshot: shot.jpeg.toString("base64") };
        } catch (e) {
            if (e instanceof AdbError && e.code !== "failed") throw e;
        }
        return snap;
    }

    async snapshot(o: { screenshot?: boolean } = {}): Promise<ScreenSnapshot> {
        return this.guarded(async () => {
            const xml = await this.dump();
            return this.finish(xml, o.screenshot === true);
        });
    }

    /** Builds the snapshot from a screen description, remembers it as the one element numbers refer to, adds the picture when asked. */
    private async finish(xml: string, picture: boolean): Promise<ScreenSnapshot> {
        const { snap, raw } = await this.read(xml);
        this.last = snap;
        if (!picture) return structuredClone(snap);
        return structuredClone(await this.withPicture(snap, raw));
    }

    // ── doing ──

    async act(action: DeviceAction, o: { screenshot?: boolean } = {}): Promise<ActResult> {
        return this.guarded(async () => {
            if (this.actions >= this.maxActions) {
                await this.close();
                throw new DeviceSessionError(`This session reached its limit of ${this.maxActions} actions.`);
            }
            this.actions++;
            const checked = parseAction(action);
            if (!checked.ok) return { ok: false, error: checked.error };
            const planned = planAction(checked.action, this.last, this.creds, { unicode: this.unicode });
            if (!planned.ok) return { ok: false, error: planned.error };

            // The screen must still hold the element the number named: a list that moved on or a dialog that appeared makes the number stale.
            if (planned.element) {
                const xml = await this.dump();
                const fresh = this.freshElements(xml);
                if (!fresh.some((e) => sameElement(planned.element!, e))) {
                    const snap = await this.finish(xml, o.screenshot === true);
                    return { ok: false, error: REFUSALS.stale, snapshot: snap };
                }
            }

            try {
                await this.perform(planned.plan);
            } catch (e) {
                if (e instanceof AdbError && e.code === "failed") {
                    const snap = await this.finish(await this.dump(), o.screenshot === true).catch(() => undefined);
                    return { ok: false, error: e.message, ...(snap ? { snapshot: snap } : {}) };
                }
                throw e;
            }
            const xml = await this.settle();
            const snapshot = await this.finish(xml, o.screenshot === true);
            return { ok: true, snapshot };
        });
    }

    private freshElements(xml: string): ScreenElement[] {
        const p = parseHierarchy(xml, { appPackage: this.opts.appPackage });
        return p.ok ? this.scrubbed(p.snapshot as ScreenSnapshot).elements : [];
    }

    private async perform(plan: Plan): Promise<void> {
        const d = this.dev;
        switch (plan.kind) {
            case "tap":
                return d.tap(plan.x, plan.y);
            case "longPress":
                // A swipe that starts and ends at one point and lasts long enough is a long press.
                return d.swipe(plan.x, plan.y, plan.x, plan.y, 800);
            case "type": {
                await d.tap(plan.x, plan.y);
                await sleep(250, this.signal);
                if (plan.clearCount > 0) await d.keys("KEYCODE_MOVE_END", ...Array<string>(plan.clearCount).fill("KEYCODE_DEL"));
                if (plan.text.length > 0) await (plan.unicode ? d.typeWithAdbKeyboard(encodeForAdbKeyboard(plan.text)) : d.typeText(plan.text));
                return;
            }
            case "scroll":
                return d.swipe(plan.from[0], plan.from[1], plan.to[0], plan.to[1], 350);
            case "back":
                return d.keys("KEYCODE_BACK");
            case "hideKeyboard":
                // Back closes the keyboard when it is showing; when it is not, back would leave the screen, so it is only pressed after looking.
                if (keyboardFromInputDump(await d.inputMethodDump())) await d.keys("KEYCODE_BACK");
                return;
            case "launch":
                return d.launch(this.opts.appPackage);
            case "restart":
                await d.forceStop(this.opts.appPackage);
                return d.launch(this.opts.appPackage);
            case "wait":
                return sleep(plan.ms, this.signal);
        }
    }

    async close(): Promise<void> {
        if (this.ended) return;
        this.ended = true;
        this.last = undefined;
        // The UiAutomator2 server this session started is stopped, so a test run that follows starts its own.
        await this.server?.close().catch(() => undefined);
        await this.closeAll();
    }
}
