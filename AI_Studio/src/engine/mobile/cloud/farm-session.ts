/**
 * The AI explorer's phone on a device farm: MX-A's DeviceSession contract (device/types.ts), backed by an Appium session instead of adb.
 *
 * The safety rules are the local session's own, reused rather than copied: every action is checked by `parseAction` / `planAction` against the LAST
 * snapshot (numbers, never coordinates from the AI), the element must still be on a fresh screen before anything is done, password fields accept only the
 * placeholder and the real value is typed here and never returned, text from the app is parsed by the same scanner (`parseHierarchy`), and the picture
 * has every password field covered before it leaves this module. Only the configured app is started or stopped. `kind` is "agent": the phone is not on
 * this computer (the contract has no third kind, and nothing reads it).
 */
import { DeviceSessionError } from "../device/errors.js";
import { MESSAGES } from "../device/adb.js";
import { REFUSALS, parseAction, planAction, sameElement, type Plan } from "../device/actions.js";
import { screenshotJpeg } from "../device/image.js";
import { SESSION_DEFAULTS, SETTLE } from "../device/session.js";
import type { ActResult, DeviceAction, DeviceSession, OpenDeviceOptions, ScreenElement, ScreenSnapshot } from "../device/types.js";
import { parseHierarchy, SCREEN_UNREADABLE } from "../device/uiautomator.js";
import { deviceLabel, uploadFarmApp } from "./farm-runner.js";
import { capabilitiesFor, connectionProblem, endpointsFor, PROVIDERS } from "./providers.js";
import type { FarmRunPlan } from "./types.js";
import { WdSession, WebDriverError, type WebDriverOptions } from "./webdriver.js";

const MIN_SCRUBBED = 4;

/**
 * Appium's page source names each element by its class (`<android.widget.Button …>`) where `uiautomator dump` writes `<node class="…">`. The attributes
 * are the same, so renaming the tags (opening and closing alike) is all the shared parser needs. Text inside attributes is escaped XML and is not touched.
 */
export function appiumSourceToDump(xml: string): string {
    return xml.replace(/<(\/?)([A-Za-z_][\w.$-]*)(?=[\s/>])/g, (m, slash: string, name: string) => (name === "hierarchy" || name === "node" ? m : `<${slash}node`));
}

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

const toSessionError = (e: unknown): DeviceSessionError => (e instanceof DeviceSessionError ? e : new DeviceSessionError(e instanceof WebDriverError ? e.message : MESSAGES.failed));

export async function openFarmDeviceSession(opts: OpenDeviceOptions, plan: FarmRunPlan, x: { fetchImpl?: typeof fetch } = {}): Promise<DeviceSession> {
    const conn = plan.connection;
    const problem = connectionProblem(conn);
    if (problem) throw new DeviceSessionError(problem);
    if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(opts.appPackage ?? "")) throw new DeviceSessionError("The app to explore needs an Android application id such as com.example.app.");
    const ep = endpointsFor(conn);
    const info = PROVIDERS[conn.provider];
    let appRef: string | undefined;
    try {
        if (info.uploadsApp) appRef = await uploadFarmApp({ plan, target: { appPackage: opts.appPackage, ...(opts.apkPath ? { apkPath: opts.apkPath } : {}) }, ...(x.fetchImpl ? { fetchImpl: x.fetchImpl } : {}) }, ep, opts.signal);
    } catch (e) {
        throw new DeviceSessionError(e instanceof Error ? e.message : String(e));
    }
    const device = conn.devices[0]!;
    const wd: WebDriverOptions = { hub: ep.hub, conn, ...(opts.signal ? { signal: opts.signal } : {}), ...(x.fetchImpl ? { fetchImpl: x.fetchImpl } : {}) };
    let s: WdSession;
    try {
        s = await WdSession.create(wd, capabilitiesFor(conn, device, { ...(appRef ? { appRef } : {}), appPackage: opts.appPackage, name: `AI exploration of ${opts.appPackage}`, build: "AI Testing Platform exploration" }));
    } catch (e) {
        throw toSessionError(e);
    }
    const session = new FarmSession(s, `${deviceLabel(device)} on ${info.label}`, opts);
    try {
        await session.start();
    } catch (e) {
        await session.close();
        throw toSessionError(e);
    }
    opts.log?.(`Opened ${opts.appPackage} on ${session.deviceName}`);
    return session;
}

class FarmSession implements DeviceSession {
    readonly kind = "agent" as const;
    private last: ScreenSnapshot | undefined;
    private actions = 0;
    private readonly startedAt = Date.now();
    private chain: Promise<unknown> = Promise.resolve();
    private ended = false;
    private readonly maxActions: number;
    private readonly maxMs: number;
    private readonly secrets: string[];

    constructor(
        private readonly s: WdSession,
        readonly deviceName: string,
        private readonly opts: OpenDeviceOptions,
    ) {
        this.maxActions = Math.max(1, Math.min(500, opts.maxActions ?? SESSION_DEFAULTS.maxActions));
        this.maxMs = Math.max(1, Math.min(120, opts.maxMinutes ?? SESSION_DEFAULTS.maxMinutes)) * 60_000;
        this.secrets = [opts.credentials?.password ?? ""].filter((v) => v.length > 0);
        opts.signal?.addEventListener("abort", () => void this.close(), { once: true });
    }

    async start(): Promise<void> {
        await this.guarded(async () => {
            await this.s.mobile("activateApp", { appId: this.opts.appPackage });
            await this.settle();
        });
    }

    private guarded<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.chain.then(async () => {
            if (this.ended || this.opts.signal?.aborted) throw new DeviceSessionError(this.opts.signal?.aborted ? MESSAGES.aborted : "This session has ended.");
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

    private async dump(): Promise<string> {
        return appiumSourceToDump(await this.s.source());
    }

    private scrub(text: string): string {
        let out = text;
        for (const v of this.secrets) if (v.length >= MIN_SCRUBBED) out = out.split(v).join("[hidden]");
        return out;
    }

    private async read(xmlIn?: string): Promise<{ snap: ScreenSnapshot; raw: ScreenElement[] }> {
        let xml = xmlIn;
        let why = SCREEN_UNREADABLE;
        for (let attempt = 0; attempt < 2; attempt++) {
            if (xml === undefined) xml = await this.dump();
            const [keyboard, activity] = await Promise.all([this.s.mobile<unknown>("isKeyboardShown").then((v) => v === true, () => false), this.s.mobile<unknown>("getCurrentActivity").then((v) => (typeof v === "string" ? v : undefined), () => undefined)]);
            const parsed = parseHierarchy(xml, { appPackage: this.opts.appPackage, keyboard, ...(activity && /^[\w.$]{1,200}$/.test(activity) ? { activity: activity.startsWith(".") ? this.opts.appPackage + activity : activity } : {}) });
            if (parsed.ok) {
                const s = parsed.snapshot as ScreenSnapshot;
                const raw = s.elements;
                const snap = this.secrets.some((v) => v.length >= MIN_SCRUBBED) ? { ...s, elements: s.elements.map((e) => ({ ...e, text: this.scrub(e.text), desc: this.scrub(e.desc) })) } : s;
                return { snap, raw };
            }
            why = parsed.error;
            xml = undefined;
            await sleep(300, this.opts.signal);
        }
        throw new DeviceSessionError(why);
    }

    private quickPrint(xml: string): string {
        const p = parseHierarchy(xml, { appPackage: this.opts.appPackage });
        // The fingerprint with text: a screen has settled when nothing visible changes any more (the structural one ignores list content).
        return p.ok ? (p.snapshot.textFingerprint ?? p.snapshot.fingerprint) : `unreadable:${xml.length}`;
    }

    private async settle(): Promise<string> {
        const end = Date.now() + SETTLE.maxMs;
        let xml = await this.dump();
        let print = this.quickPrint(xml);
        let since = Date.now();
        while (Date.now() < end && Date.now() - since < SETTLE.stableMs) {
            await sleep(SETTLE.pollMs, this.opts.signal);
            if (this.opts.signal?.aborted) break;
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

    private async finish(xml: string, picture: boolean): Promise<ScreenSnapshot> {
        const { snap, raw } = await this.read(xml);
        this.last = snap;
        if (!picture) return structuredClone(snap);
        try {
            const png = await this.s.screenshot();
            const covers = raw.flatMap((e, i) => (e.password || snap.elements[i]?.text !== e.text || snap.elements[i]?.desc !== e.desc ? [e.bounds] : []));
            const shot = screenshotJpeg(png, covers, { coverSpace: { width: snap.width, height: snap.height } });
            if (shot) return structuredClone({ ...snap, screenshot: shot.jpeg.toString("base64") });
        } catch {
            /* no picture this time */
        }
        return structuredClone(snap);
    }

    snapshot(o: { screenshot?: boolean } = {}): Promise<ScreenSnapshot> {
        return this.guarded(async () => this.finish(await this.dump(), o.screenshot === true));
    }

    act(action: DeviceAction, o: { screenshot?: boolean } = {}): Promise<ActResult> {
        return this.guarded(async () => {
            if (this.actions >= this.maxActions) {
                await this.close();
                throw new DeviceSessionError(`This session reached its limit of ${this.maxActions} actions.`);
            }
            this.actions++;
            const checked = parseAction(action);
            if (!checked.ok) return { ok: false, error: checked.error };
            const planned = planAction(checked.action, this.last, this.opts.credentials);
            if (!planned.ok) return { ok: false, error: planned.error };
            if (planned.element) {
                const xml = await this.dump();
                const p = parseHierarchy(xml, { appPackage: this.opts.appPackage });
                const fresh = p.ok ? p.snapshot.elements.map((e) => ({ ...e, text: this.scrub(e.text), desc: this.scrub(e.desc) })) : [];
                if (!fresh.some((e) => sameElement(planned.element!, e))) return { ok: false, error: REFUSALS.stale, snapshot: await this.finish(xml, o.screenshot === true) };
            }
            try {
                await this.perform(planned.plan);
            } catch (e) {
                if (e instanceof WebDriverError && e.code !== "network" && e.code !== "invalid session id" && e.status !== 401 && e.status !== 403) {
                    const snap = await this.finish(await this.dump(), o.screenshot === true).catch(() => undefined);
                    return { ok: false, error: "The phone could not do that.", ...(snap ? { snapshot: snap } : {}) };
                }
                throw e;
            }
            return { ok: true, snapshot: await this.finish(await this.settle(), o.screenshot === true) };
        });
    }

    private async perform(plan: Plan): Promise<void> {
        const s = this.s;
        switch (plan.kind) {
            case "tap":
                await s.gesture([plan.x, plan.y]);
                return;
            case "longPress":
                await s.gesture([plan.x, plan.y], [plan.x, plan.y], 800);
                return;
            case "type": {
                await s.gesture([plan.x, plan.y]);
                await sleep(250, this.opts.signal);
                const el = await s.active();
                if (!el) throw new WebDriverError("The text field did not take the focus.", "no such element", 404);
                if (plan.clearCount > 0) await s.clear(el);
                if (plan.text.length > 0) await s.sendKeys(el, plan.text);
                return;
            }
            case "scroll":
                await s.gesture(plan.from, plan.to, 350);
                return;
            case "back":
                await s.back();
                return;
            case "hideKeyboard":
                if ((await s.mobile<unknown>("isKeyboardShown").catch(() => false)) === true) await s.back();
                return;
            case "launch":
                await s.mobile("activateApp", { appId: this.opts.appPackage });
                return;
            case "restart":
                await s.mobile("terminateApp", { appId: this.opts.appPackage }).catch(() => undefined);
                await s.mobile("activateApp", { appId: this.opts.appPackage });
                return;
            case "wait":
                await sleep(plan.ms, this.opts.signal);
                return;
        }
    }

    async close(): Promise<void> {
        if (this.ended) return;
        this.ended = true;
        this.last = undefined;
        await this.s.quit();
    }
}
