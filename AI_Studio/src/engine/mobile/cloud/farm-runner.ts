/**
 * Runs phone test scripts on a device farm (BrowserStack, Sauce Labs, LambdaTest or any Appium server).
 *
 * Same contract as the local runner (mobile-runner.ts): a test passes only when every one of its steps really ran and held on a phone of the farm; a run
 * that cannot happen (no account, no app, no phone free, the farm not answering) is an error result, never a pass.
 *
 * How: the app's .apk is uploaded once per run (cloud providers), every test gets its own session (its own video on the provider), starts from the app's
 * first screen (stop, then open, as the Taqwright script's beforeEach does), and its steps are read from the rendered script (script-reader.ts) and
 * performed through the WebDriver client, with the same locator rules as Taqwright. Up to `parallel` sessions run at once. With `matrix`, every test runs
 * on every picked phone and its result says how it went on each.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mapLimit } from "../../context.js";
import { scrollPlan } from "../device/actions.js";
import type { MobileTarget } from "../target.js";
import type { ScriptInput, ScriptRun, StepResult } from "../../validation/runner.js";
import { authHeader, capabilitiesFor, connectionProblem, endpointsFor, PROVIDERS, scrubSecrets, sessionLink, statusRequest, uploadRequest, type ProviderEndpoints } from "./providers.js";
import { evaluate, evaluateData, readFarmScript, ScriptReadError, type FarmLocator, type FarmOp, type ReadScript } from "./script-reader.js";
import type { FarmDevice, FarmRunPlan, FarmSessionRecord } from "./types.js";
import { wdRequest, WdSession, WebDriverError, type Strategy, type WebDriverOptions } from "./webdriver.js";

/** The account's secrets and the test account's password never travel in a message from here. */
function scrubAll(text: string, conn: Parameters<typeof scrubSecrets>[1], vars: Record<string, string>): string {
    const pw = vars.TEST_PASSWORD ?? "";
    const out = scrubSecrets(text, conn);
    return pw.length >= 4 ? out.split(pw).join("[hidden]") : out;
}

export interface FarmRunEnv {
    plan: FarmRunPlan;
    /** The project's app: `apkPath` is uploaded to cloud providers; `appPackage` is the app every test starts. */
    target: MobileTarget;
    /** The project's test account, typed for {{credentials.*}} steps. Sent to the farm's phone only. */
    credentials?: { username: string; password: string };
    log?: (message: string) => void;
    /** Every session, as it ends (the platform keeps them with their links). */
    onSession?: (r: FarmSessionRecord) => void;
    fetchImpl?: typeof fetch;
    /** How long a step waits for its element (Taqwright's expectTimeout: 15 s). */
    expectTimeoutMs?: number;
    /** Name of this run on the provider's dashboard. */
    buildName?: string;
}

export interface FarmRunOptions {
    signal?: AbortSignal;
    /** Per-test time limit (project setting); unset: 180 s, as on a local phone. */
    testTimeoutMs?: number;
}

const errorRun = (testId: string, error: string): ScriptRun => ({ testId, status: "error", durationMs: 0, error, failedStepIndex: -1, steps: [], artifacts: [], responses: [] });

export const deviceLabel = (d: FarmDevice): string => (d.osVersion ? `${d.name} (Android ${d.osVersion})` : d.name);

export async function runFarmScripts(scratchDir: string, scripts: ScriptInput[], env: FarmRunEnv, opts: FarmRunOptions = {}): Promise<ScriptRun[]> {
    if (scripts.length === 0) return [];
    if (opts.signal?.aborted) throw new Error("Job cancelled");
    const { connection: conn } = env.plan;
    const info = PROVIDERS[conn.provider];
    const problem = connectionProblem(conn);
    if (problem) return scripts.map((s) => errorRun(s.testId, `Not run on the device farm: ${problem}`));
    const log = env.log ?? (() => undefined);
    const ep = endpointsFor(conn);

    // Scripts the farm can run; the others get their reason now.
    const read = new Map<string, ReadScript>();
    const out: ScriptRun[] = scripts.map((s) => {
        if (s.custom) return errorRun(s.testId, "Code tests run only on a phone of this computer or a runner, not on a device farm.");
        try {
            read.set(s.testId, readFarmScript(s.content));
            return undefined as unknown as ScriptRun;
        } catch (e) {
            return errorRun(s.testId, e instanceof ScriptReadError ? e.message : "This test's script could not be read for the device farm.");
        }
    });
    const runnable = scripts.filter((s) => read.has(s.testId));
    if (runnable.length === 0) return out;

    let appRef: string | undefined;
    if (info.uploadsApp) {
        try {
            appRef = await uploadFarmApp(env, ep, opts.signal);
            log(`Uploaded the app to ${info.label}`);
        } catch (e) {
            const why = e instanceof Error ? e.message : String(e);
            runnable.forEach((s) => (out[scripts.indexOf(s)] = errorRun(s.testId, why)));
            return out;
        }
    } else if (!env.target.appPackage) {
        runnable.forEach((s) => (out[scripts.indexOf(s)] = errorRun(s.testId, "An Appium server needs the app's package name (Mobile app): the app must already be installed on its phone.")));
        return out;
    }

    const runDir = path.join(scratchDir, `farm-${Date.now()}-${randomUUID().slice(0, 8)}`);
    await fsp.mkdir(runDir, { recursive: true });
    const devices = env.plan.connection.devices;
    const work = env.plan.matrix ? runnable.flatMap((s) => devices.map((d, di) => ({ s, d, di }))) : runnable.map((s, i) => ({ s, d: devices[i % devices.length]!, di: i % devices.length }));
    const parallel = Math.max(1, Math.min(10, Math.floor(env.plan.parallel) || 1));
    log(`Running ${runnable.length} phone test${runnable.length === 1 ? "" : "s"} on ${info.label}${env.plan.matrix ? ` on ${devices.length} phone${devices.length === 1 ? "" : "s"} each` : ""}, ${parallel} at a time`);
    const vars: Record<string, string> = { TEST_USERNAME: env.credentials?.username ?? "", TEST_PASSWORD: env.credentials?.password ?? "" };
    const results = await mapLimit(work, parallel, async (w) =>
        runOne({ env, ep, appRef, runDir, read: read.get(w.s.testId)!, script: w.s, device: w.d, deviceIndex: w.di, vars, opts }),
    );

    for (const s of runnable) {
        const mine = work.map((w, i) => ({ w, r: results[i]! })).filter((x) => x.w.s === s);
        const runs = mine.map((x) => (x.r.ok ? x.r.value : { ...errorRun(s.testId, x.r.error instanceof Error ? x.r.error.message : "The device farm run failed."), device: deviceLabel(x.w.d) }));
        out[scripts.indexOf(s)] = env.plan.matrix && runs.length > 1 ? fold(s.testId, runs) : strip(runs[0]!);
    }
    return out;
}

type DeviceRun = ScriptRun & { device: string };
const strip = ({ device: _d, ...r }: DeviceRun): ScriptRun => r;

/** One result for a test that ran on several phones: passing only when it passed on every one; the first problem leads, every phone is listed. */
function fold(testId: string, runs: DeviceRun[]): ScriptRun {
    const word = (r: DeviceRun) => (r.status === "passed" ? "passed" : r.status === "failed" ? "failed" : r.status === "timedOut" ? "ran out of time" : "could not run");
    const summary = runs.map((r) => `${r.device}: ${word(r)}`).join("; ");
    const bad = runs.find((r) => r.status === "failed" || r.status === "timedOut") ?? runs.find((r) => r.status !== "passed");
    const durationMs = runs.reduce((a, r) => Math.max(a, r.durationMs), 0);
    const artifacts = runs.flatMap((r) => r.artifacts);
    if (!bad) return { testId, status: "passed", durationMs, failedStepIndex: -1, steps: runs[0]!.steps, artifacts, responses: [], notes: [`Passed on ${runs.length} phones. ${summary}.`, ...runs.flatMap((r) => r.notes ?? [])] };
    return { testId, status: bad.status, durationMs, error: `On ${bad.device}: ${bad.error ?? "the test did not pass"}\nAll phones: ${summary}.`, failedStepIndex: bad.failedStepIndex, steps: bad.steps, artifacts, responses: [] };
}

/** Uploads the project's .apk to a cloud provider; returns the provider's reference to it (bs://…, storage:…, lt://…). Throws plain sentences. */
export async function uploadFarmApp(env: Pick<FarmRunEnv, "plan" | "target" | "fetchImpl">, ep: ProviderEndpoints, signal?: AbortSignal): Promise<string> {
    const conn = env.plan.connection;
    const label = PROVIDERS[conn.provider].label;
    const apk = env.target.apkPath;
    if (!apk) throw new Error(`${label} installs the app from its .apk. Upload the app's .apk under Mobile app first.`);
    if (!/\.apk$/i.test(apk) || !fs.existsSync(apk)) throw new Error(`The app's .apk was not found on the platform. Upload it again under Mobile app.`);
    const blob = await fs.openAsBlob(apk, { type: "application/vnd.android.package-archive" });
    const req = uploadRequest(conn, ep, blob, path.basename(apk).replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || "app.apk")!;
    const auth = authHeader(conn);
    let res: Response;
    try {
        res = await (env.fetchImpl ?? fetch)(req.url, { method: "POST", body: req.form, headers: auth ? { authorization: auth } : {}, redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(signal ? [signal] : [])]) });
    } catch {
        throw new Error(`The app could not be uploaded to ${label}: the farm could not be reached.`);
    }
    const text = (await res.text().catch(() => "")).slice(0, 20_000);
    if (res.status === 401 || res.status === 403) throw new Error(`${label} refused the sign-in details while uploading the app. Check the user name and access key.`);
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        body = undefined;
    }
    const ref = res.ok ? req.ref(body) : undefined;
    if (!ref) throw new Error(`The app could not be uploaded to ${label}${res.ok ? ": the answer had no app reference." : ` (HTTP ${res.status}).`}`);
    if (/[\s"'<>]/.test(ref)) throw new Error(`${label} gave an app reference the platform can't use.`);
    return ref;
}

interface OneRun {
    env: FarmRunEnv;
    ep: ProviderEndpoints;
    appRef: string | undefined;
    runDir: string;
    read: ReadScript;
    script: ScriptInput;
    device: FarmDevice;
    deviceIndex: number;
    vars: Record<string, string>;
    opts: FarmRunOptions;
}

async function runOne(o: OneRun): Promise<DeviceRun> {
    const conn = o.env.plan.connection;
    const info = PROVIDERS[conn.provider];
    const device = deviceLabel(o.device);
    const started = Date.now();
    const limitMs = o.opts.testTimeoutMs ?? 180_000;
    const ctl = new AbortController();
    const onParent = () => ctl.abort();
    o.opts.signal?.addEventListener("abort", onParent, { once: true });
    let timedOut = false;
    // The per-test limit covers the steps; getting a phone from the farm has its own (longer) limit in the client.
    let timer: NodeJS.Timeout | undefined;
    const wd: WebDriverOptions = { hub: o.ep.hub, conn, signal: ctl.signal, ...(o.env.fetchImpl ? { fetchImpl: o.env.fetchImpl } : {}) };
    const caps = capabilitiesFor(conn, o.device, { ...(o.appRef ? { appRef: o.appRef } : {}), ...(o.env.target.appPackage ? { appPackage: o.env.target.appPackage } : {}), name: `${o.script.testId}: ${o.read.title}`.slice(0, 120), build: o.env.buildName ?? "AI Testing Platform run" });
    let session: WdSession;
    try {
        session = await WdSession.create(wd, caps);
    } catch (e) {
        o.opts.signal?.removeEventListener("abort", onParent);
        const why = e instanceof WebDriverError ? e.message : "The device farm could not start a phone session.";
        return { ...errorRun(o.script.testId, `Not run on ${device} (${info.label}): ${why}`), device };
    }
    o.env.log?.(`${o.script.testId}: phone session started on ${device}`);
    const steps: StepResult[] = [];
    let failure: { index: number; error: string } | undefined;
    const unique = String(Date.now());
    const data = evaluateData(o.read, o.vars, unique);
    const runner = new StepRunner(session, o.env.target.appPackage, o.env.expectTimeoutMs ?? 15_000, ctl.signal);
    try {
        timer = setTimeout(() => {
            timedOut = true;
            ctl.abort();
        }, limitMs);
        await runner.startApp();
        for (let i = 0; i < o.read.steps.length; i++) {
            const step = o.read.steps[i]!;
            try {
                await runner.run(step.op, { vars: o.vars, data, unique });
                steps.push({ index: i, title: step.title, status: "passed" });
            } catch (e) {
                const msg = timedOut ? `The test ran longer than its time limit of ${Math.round(limitMs / 1000)} s.` : e instanceof Error ? scrubAll(e.message, conn, o.vars) : String(e);
                steps.push({ index: i, title: step.title, status: "failed", error: msg });
                failure = { index: i, error: msg };
                break;
            }
        }
    } catch (e) {
        failure = { index: -1, error: timedOut ? `The test ran longer than its time limit of ${Math.round(limitMs / 1000)} s.` : `The app could not be started on ${device}: ${e instanceof Error ? scrubAll(e.message, conn, o.vars) : String(e)}` };
    } finally {
        clearTimeout(timer);
        o.opts.signal?.removeEventListener("abort", onParent);
    }

    const artifacts: ScriptRun["artifacts"] = [];
    // Evidence for a failed run: the screen as it was. The session may already be gone, which must not hide the failure.
    if (failure && !o.opts.signal?.aborted) {
        try {
            const png = await session.detached().screenshot();
            if (png.length > 0 && png.length < 15 * 1024 * 1024) {
                const file = path.join(o.runDir, `${o.script.testId.replace(/[^A-Za-z0-9_-]/g, "_")}-${o.deviceIndex}.png`);
                await fsp.writeFile(file, png);
                artifacts.push({ kind: "screenshot", path: file });
            }
        } catch {
            /* no screenshot available */
        }
    }
    const passed = !failure;
    const status: ScriptRun["status"] = o.opts.signal?.aborted ? "error" : timedOut ? "timedOut" : passed ? "passed" : "failed";
    const link = sessionLink(conn, o.ep, session.id);
    // The provider's dashboard shows the verdict too (best effort: a failed report changes nothing about the result).
    const report = statusRequest(conn, o.ep, session.id, passed, failure?.error ?? "passed");
    if (report) await wdRequest({ ...wd, signal: undefined }, report.method, report.url, JSON.parse(report.body), 30_000).catch(() => o.env.log?.(`${o.script.testId}: the result could not be reported to ${info.label}`));
    await session.quit();
    o.env.onSession?.({ testId: o.script.testId, provider: conn.provider, device, sessionId: session.id, status: status === "passed" ? "passed" : status === "error" ? "error" : "failed", ...(link ? { link } : {}) });

    const where = `${info.label}, ${device}`;
    const linkLine = link ? ` Video and logs: ${link}` : "";
    if (o.opts.signal?.aborted) return { ...errorRun(o.script.testId, "The run was stopped."), steps, device };
    if (passed) return { testId: o.script.testId, status, durationMs: Date.now() - started, failedStepIndex: -1, steps, artifacts, responses: [], notes: [`Ran on ${where}.${linkLine}`], device };
    return { testId: o.script.testId, status, durationMs: Date.now() - started, error: `${failure!.error}\nRan on ${where}.${linkLine}`, failedStepIndex: failure!.index, steps, artifacts, responses: [], device };
}

// ── performing steps ───────────────────────────────────────────────────────

/** XPath has no escapes: a literal with both quote kinds is written as concat() (as Taqwright does). */
export function xpathLiteral(s: string): string {
    if (!s.includes("'")) return `'${s}'`;
    if (!s.includes('"')) return `"${s}"`;
    return `concat(${s
        .split("'")
        .map((p, i) => [...(i > 0 ? [`"'"`] : []), ...(p ? [`'${p}'`] : [])])
        .flat()
        .join(", ")})`;
}

const ROLE_CLASS: Record<string, string> = { button: "android.widget.Button", link: "android.widget.TextView", textbox: "android.widget.EditText", switch: "android.widget.Switch", image: "android.widget.ImageView", checkbox: "android.widget.CheckBox" };

/** Keys a phone test may press, as Android key codes. */
export const KEYCODES: Record<string, number> = { Enter: 66, Tab: 61, Backspace: 67, Escape: 111, Space: 62, " ": 62, ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22, Delete: 112, Home: 3, Back: 4 };

const OPPOSITE = { up: "down", down: "up", left: "right", right: "left" } as const;

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

export class StepRunner {
    constructor(
        private readonly s: WdSession,
        private readonly appPackage: string | undefined,
        private readonly waitMs: number,
        private readonly signal?: AbortSignal,
    ) {}

    /** Every test starts from the app's first screen: stop it if it runs, then open it (the script's beforeEach). */
    async startApp(): Promise<void> {
        if (!this.appPackage) return;
        await this.s.mobile("terminateApp", { appId: this.appPackage }).catch(() => undefined);
        await this.s.mobile("activateApp", { appId: this.appPackage });
    }

    describe(l: FarmLocator, ctx: EvalCtx): string {
        switch (l.by) {
            case "text":
                return `the text “${evaluate(l.value, ctx)}”`;
            case "label":
                return `the label “${evaluate(l.value, ctx)}”`;
            case "testId":
                return `the id “${evaluate(l.value, ctx)}”`;
            case "placeholder":
                return `the hint “${evaluate(l.value, ctx)}”`;
            case "role":
                return l.name ? `the ${l.role} “${evaluate(l.name, ctx)}”` : `a ${l.role}`;
            case "uiSelector":
                return `the element ${evaluate(l.value, ctx)}`;
            case "xpath":
                return `the element at ${evaluate(l.value, ctx)}`;
            case "nth":
                return `${this.describe(l.of, ctx)} (number ${l.n + 1})`;
            case "any":
                return this.describe(l.of[0]!, ctx);
        }
    }

    /** All elements a locator names right now (Taqwright's strategies). */
    async find(l: FarmLocator, ctx: EvalCtx): Promise<string[]> {
        const q = (using: Strategy, value: string) => this.s.findAll(using, value);
        switch (l.by) {
            case "text":
                return q("xpath", `//*[@text=${xpathLiteral(evaluate(l.value, ctx))}]`);
            case "label":
                return q("accessibility id", evaluate(l.value, ctx));
            case "testId":
                return q("id", evaluate(l.value, ctx));
            case "placeholder":
                return q("xpath", `//*[@hint=${xpathLiteral(evaluate(l.value, ctx))}]`);
            case "role": {
                const all = await q("class name", ROLE_CLASS[l.role.toLowerCase()] ?? l.role);
                if (!l.name) return all;
                const name = evaluate(l.name, ctx);
                const keep: string[] = [];
                for (const el of all.slice(0, 50)) {
                    const [text, desc] = await Promise.all([this.s.text(el).catch(() => ""), this.s.attribute(el, "content-desc").catch(() => null)]);
                    if (text === name || desc === name) keep.push(el);
                }
                return keep;
            }
            case "uiSelector":
                return q("-android uiautomator", evaluate(l.value, ctx));
            case "xpath":
                return q("xpath", evaluate(l.value, ctx));
            case "nth": {
                const one = (await this.find(l.of, ctx))[l.n];
                return one ? [one] : [];
            }
            case "any": {
                // Fallbacks in order, as the script's firstOf(): the main locator's matches first, then each fallback's new ones.
                const out: string[] = [];
                for (const each of l.of) for (const el of await this.find(each, ctx).catch(() => [])) if (!out.includes(el)) out.push(el);
                return out;
            }
        }
    }

    /** Waits (up to the step timeout) until `ok` holds, polling; returns the last value. */
    private async poll<T>(get: () => Promise<T>, ok: (v: T) => boolean): Promise<{ value: T; ok: boolean }> {
        const end = Date.now() + this.waitMs;
        let value = await get();
        while (!ok(value) && Date.now() < end && !this.signal?.aborted) {
            await sleep(300, this.signal);
            value = await get();
        }
        return { value, ok: ok(value) };
    }

    private async firstShown(l: FarmLocator, ctx: EvalCtx): Promise<string | undefined> {
        for (const el of (await this.find(l, ctx)).slice(0, 20)) if (await this.s.displayed(el).catch(() => false)) return el;
        return undefined;
    }

    private async element(l: FarmLocator, ctx: EvalCtx): Promise<string> {
        const r = await this.poll(() => this.firstShown(l, ctx), (v) => v !== undefined);
        if (!r.value) throw new Error(`Element not found: ${this.describe(l, ctx)} (waited ${Math.round(this.waitMs / 1000)} s)`);
        return r.value;
    }

    async run(op: FarmOp, ctx: EvalCtx): Promise<void> {
        if (this.signal?.aborted) throw new Error("The run was stopped.");
        const s = this.s;
        switch (op.op) {
            case "noop":
                return;
            case "deepLink":
                await s.mobile("deepLink", { url: evaluate(op.url, ctx), ...(this.appPackage ? { package: this.appPackage } : {}) });
                return;
            case "click":
                await s.click(await this.element(op.loc, ctx));
                return;
            case "fill": {
                const el = await this.element(op.loc, ctx);
                await s.clear(el);
                const text = evaluate(op.text, ctx);
                if (text) await s.sendKeys(el, text);
                return;
            }
            case "select": {
                await s.click(await this.element(op.loc, ctx));
                const choice = evaluate(op.text, ctx);
                await s.click(await this.element({ by: "text", value: [{ lit: choice }], exact: true }, ctx));
                return;
            }
            case "check": {
                const el = await this.element(op.loc, ctx);
                const now = (await s.attribute(el, "checked")) === "true";
                if (now !== op.checked) await s.click(el);
                return;
            }
            case "scrollIntoView": {
                // A list item said as a UiSelector (phone exploration): Android's UiScrollable scrolls to it first, as Taqwright does.
                const head = op.loc.by === "any" ? op.loc.of[0]! : op.loc;
                if (head.by === "uiSelector" && !(await this.firstShown(op.loc, ctx))) {
                    await s.findAll("-android uiautomator", `new UiScrollable(new UiSelector().scrollable(true).instance(0)).scrollIntoView(${evaluate(head.value, ctx)})`).catch(() => []);
                }
                for (let i = 0; i < 8; i++) {
                    if (await this.firstShown(op.loc, ctx)) return;
                    await this.swipe("down");
                }
                throw new Error(`Element not found after scrolling: ${this.describe(op.loc, ctx)}`);
            }
            case "back":
                await s.back();
                return;
            case "home":
                await s.mobile("pressKey", { keycode: 3 });
                return;
            case "scroll":
                // "scroll down" shows what is further down (the finger moves up); "swipe up" is that same finger move.
                await this.swipe(op.swipe ? OPPOSITE[op.direction] : op.direction);
                return;
            case "key": {
                const code = KEYCODES[op.key];
                if (code === undefined) throw new Error(`The key “${op.key}” can't be pressed on a device farm phone.`);
                await s.mobile("pressKey", { keycode: code });
                return;
            }
            case "wait":
                await sleep(Math.min(op.ms, 60_000), this.signal);
                return;
            case "expect": {
                if (op.check === "hidden") {
                    const r = await this.poll(() => this.firstShown(op.loc, ctx), (v) => v === undefined);
                    if (!r.ok) throw new Error(`Expected ${this.describe(op.loc, ctx)} to be hidden, but it is shown`);
                    return;
                }
                const el = await this.element(op.loc, ctx).catch(() => {
                    throw new Error(`Expected ${this.describe(op.loc, ctx)} to be ${op.check}, but it was not found (waited ${Math.round(this.waitMs / 1000)} s)`);
                });
                if (op.check === "visible") return;
                const want = op.check === "enabled";
                const r = await this.poll(() => s.enabled(el), (v) => v === want);
                if (!r.ok) throw new Error(`Expected ${this.describe(op.loc, ctx)} to be ${op.check}`);
                return;
            }
            case "expectText": {
                const expected = evaluate(op.expected, ctx);
                const el = await this.element(op.loc, ctx);
                const r = await this.poll(() => s.text(el), (v) => (op.check === "text" ? v.includes(expected) : v === expected));
                if (!r.ok) throw new Error(`Expected ${this.describe(op.loc, ctx)} to ${op.check === "text" ? "contain" : "have the value"} “${expected}”, but it shows “${r.value.slice(0, 120)}”`);
                return;
            }
            case "permission": {
                // The same answer as during exploration, only when the question shows: a phone that already answered goes straight on.
                const end = Date.now() + op.waitMs;
                let el = await this.firstShown(op.loc, ctx).catch(() => undefined);
                while (!el && Date.now() < end && !this.signal?.aborted) {
                    await sleep(500, this.signal);
                    el = await this.firstShown(op.loc, ctx).catch(() => undefined);
                }
                if (el) await s.click(el).catch(() => undefined);
                return;
            }
            case "expectCount": {
                const r = await this.poll(() => this.find(op.loc, ctx), (v) => v.length === op.count);
                if (!r.ok) throw new Error(`Expected ${op.count} of ${this.describe(op.loc, ctx)}, found ${r.value.length}`);
                return;
            }
        }
    }

    private async swipe(direction: "up" | "down" | "left" | "right"): Promise<void> {
        const { width, height } = await this.s.windowSize();
        const plan = scrollPlan([0, 0, width, height], direction);
        await this.s.gesture(plan.from, plan.to, 350);
        await sleep(300, this.signal);
    }
}

export interface EvalCtx {
    vars: Record<string, string>;
    data: Record<string, string>;
    unique: string;
}
