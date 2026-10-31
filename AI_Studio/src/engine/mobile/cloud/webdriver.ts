/**
 * A small W3C WebDriver (Appium remote) client: only the commands the device-farm runner and the farm device session use, over `fetch`.
 *
 * Why not Taqwright here: Taqwright 1.1 targets BrowserStack and LambdaTest through fixed addresses of its own, has no Sauce Labs and no "any server"
 * mode (its local-device mode needs adb on this computer). One client for every farm keeps the behaviour the same everywhere and lets the tests drive
 * it against a local fake server. What it never does: send the account to another address than the hub it was made for, put credentials in a URL,
 * or pass a provider's raw answer on without removing the account's secrets.
 */
import { authHeader, scrubSecrets } from "./providers.js";
import type { FarmConnection } from "./types.js";

export const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

/** Limits of one request: a session can wait for a free phone, other commands are quick. Answers are capped in size. */
export const WD_LIMITS = { newSessionMs: 300_000, commandMs: 60_000, maxAnswerBytes: 8 * 1024 * 1024 } as const;

export class WebDriverError extends Error {
    constructor(
        message: string,
        /** The W3C error code ("no such element", "invalid session id"...), or "http" / "network". */
        readonly code: string,
        readonly status: number,
    ) {
        super(message);
    }
}

export type Strategy = "id" | "accessibility id" | "xpath" | "class name" | "-android uiautomator";

export interface WebDriverOptions {
    hub: string;
    conn: Pick<FarmConnection, "username" | "accessKey">;
    signal?: AbortSignal;
    /** Tests replace fetch; production uses the global one. */
    fetchImpl?: typeof fetch;
}

/** One request to the hub. Exposed so the runner can make the provider's REST calls with the same error handling. */
export async function wdRequest<T = unknown>(o: WebDriverOptions, method: string, url: string, body?: unknown, timeoutMs: number = WD_LIMITS.commandMs): Promise<T> {
    const f = o.fetchImpl ?? fetch;
    const auth = authHeader(o.conn);
    const signals = [AbortSignal.timeout(timeoutMs), ...(o.signal ? [o.signal] : [])];
    let res: Response;
    try {
        res = await f(url, {
            method,
            headers: { "content-type": "application/json; charset=utf-8", accept: "application/json", ...(auth ? { authorization: auth } : {}) },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.any(signals),
            redirect: "error",
        });
    } catch (e) {
        if (o.signal?.aborted) throw new WebDriverError("The run was stopped.", "aborted", 0);
        const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        throw new WebDriverError(timedOut ? `The device farm did not answer within ${Math.round(timeoutMs / 1000)} s.` : "The device farm could not be reached.", "network", 0);
    }
    const text = await readCapped(res);
    let json: unknown;
    try {
        json = text ? JSON.parse(text) : {};
    } catch {
        json = undefined;
    }
    const value = json && typeof json === "object" && "value" in json ? (json as { value: unknown }).value : json;
    if (!res.ok || (value && typeof value === "object" && "error" in (value as object) && typeof (value as { error: unknown }).error === "string")) {
        const v = (value ?? {}) as { error?: string; message?: string };
        const code = typeof v.error === "string" ? v.error : "http";
        const raw = typeof v.message === "string" ? v.message : res.status === 401 || res.status === 403 ? "" : text.slice(0, 200);
        throw new WebDriverError(plainError(res.status, code, scrubSecrets(firstLine(raw), o.conn)), code, res.status);
    }
    return value as T;
}

async function readCapped(res: Response): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > WD_LIMITS.maxAnswerBytes) {
            await reader.cancel().catch(() => undefined);
            throw new WebDriverError("The device farm sent an answer that is too large.", "http", res.status);
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}

const firstLine = (s: string) => s.split(/\r?\n/)[0]!.replace(/[^\x20-\x7e -￿]/g, "").slice(0, 300);

function plainError(status: number, code: string, message: string): string {
    if (status === 401 || status === 403) return "The device farm refused the sign-in details. Check the user name and access key.";
    if (code === "no such element") return message || "The element was not found.";
    if (code === "invalid session id") return "The session on the device farm ended.";
    if (code === "session not created") return `The device farm could not start a phone session${message ? `: ${message}` : "."}`;
    return message ? `The device farm answered: ${message}` : `The device farm answered with an error (HTTP ${status}).`;
}

/** An open Appium session on a farm. Commands are the W3C ones plus a few `mobile:` scripts the UiAutomator2 driver offers. */
export class WdSession {
    private constructor(
        private readonly o: WebDriverOptions,
        readonly id: string,
    ) {}

    static async create(o: WebDriverOptions, capabilities: Record<string, unknown>): Promise<WdSession> {
        const v = await wdRequest<{ sessionId?: string }>(o, "POST", `${o.hub}/session`, { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } }, WD_LIMITS.newSessionMs);
        const id = v && typeof v.sessionId === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(v.sessionId) ? v.sessionId : undefined;
        if (!id) throw new WebDriverError("The device farm did not start a session.", "session not created", 500);
        return new WdSession(o, id);
    }

    private url(p: string): string {
        return `${this.o.hub}/session/${encodeURIComponent(this.id)}${p}`;
    }
    private cmd<T = unknown>(method: string, p: string, body?: unknown): Promise<T> {
        return wdRequest<T>(this.o, method, this.url(p), body);
    }

    async findAll(using: Strategy, value: string): Promise<string[]> {
        const v = await this.cmd<unknown>("POST", "/elements", { using, value });
        if (!Array.isArray(v)) return [];
        return v.flatMap((e) => (e && typeof e === "object" && typeof (e as Record<string, unknown>)[ELEMENT_KEY] === "string" ? [(e as Record<string, string>)[ELEMENT_KEY]!] : [])).slice(0, 500);
    }
    click(el: string): Promise<unknown> {
        return this.cmd("POST", `/element/${encodeURIComponent(el)}/click`, {});
    }
    clear(el: string): Promise<unknown> {
        return this.cmd("POST", `/element/${encodeURIComponent(el)}/clear`, {});
    }
    sendKeys(el: string, text: string): Promise<unknown> {
        return this.cmd("POST", `/element/${encodeURIComponent(el)}/value`, { text, value: [...text] });
    }
    async text(el: string): Promise<string> {
        const v = await this.cmd<unknown>("GET", `/element/${encodeURIComponent(el)}/text`);
        return typeof v === "string" ? v : "";
    }
    async attribute(el: string, name: string): Promise<string | null> {
        const v = await this.cmd<unknown>("GET", `/element/${encodeURIComponent(el)}/attribute/${encodeURIComponent(name)}`);
        return v === null || v === undefined ? null : String(v);
    }
    async displayed(el: string): Promise<boolean> {
        return (await this.cmd<unknown>("GET", `/element/${encodeURIComponent(el)}/displayed`)) === true;
    }
    async enabled(el: string): Promise<boolean> {
        return (await this.cmd<unknown>("GET", `/element/${encodeURIComponent(el)}/enabled`)) === true;
    }
    async active(): Promise<string | undefined> {
        const v = await this.cmd<unknown>("GET", "/element/active").catch(() => undefined);
        return v && typeof v === "object" && typeof (v as Record<string, unknown>)[ELEMENT_KEY] === "string" ? (v as Record<string, string>)[ELEMENT_KEY] : undefined;
    }
    async source(): Promise<string> {
        const v = await this.cmd<unknown>("GET", "/source");
        return typeof v === "string" ? v : "";
    }
    /** The screen as PNG bytes. */
    async screenshot(): Promise<Buffer> {
        const v = await this.cmd<unknown>("GET", "/screenshot");
        return typeof v === "string" ? Buffer.from(v, "base64") : Buffer.alloc(0);
    }
    async windowSize(): Promise<{ width: number; height: number }> {
        const v: { width?: number; height?: number } = (await this.cmd<{ width?: number; height?: number }>("GET", "/window/rect").catch(() => ({}))) ?? {};
        return { width: Number(v.width) || 1080, height: Number(v.height) || 1920 };
    }
    back(): Promise<unknown> {
        return this.cmd("POST", "/back", {});
    }
    /** A touch at one point, or a drag from one point to another lasting `ms`. */
    gesture(from: [number, number], to: [number, number] = from, ms = 80): Promise<unknown> {
        const move = (p: [number, number], duration: number) => ({ type: "pointerMove", duration, origin: "viewport", x: Math.round(p[0]), y: Math.round(p[1]) });
        return this.cmd("POST", "/actions", {
            actions: [{ type: "pointer", id: "finger1", parameters: { pointerType: "touch" }, actions: [move(from, 0), { type: "pointerDown", button: 0 }, { type: "pause", duration: from === to ? ms : 0 }, move(to, from === to ? 0 : ms), { type: "pointerUp", button: 0 }] }],
        });
    }
    /** One of the UiAutomator2 driver's `mobile:` commands (activateApp, terminateApp, deepLink, pressKey, getCurrentPackage, isKeyboardShown). */
    mobile<T = unknown>(name: "activateApp" | "terminateApp" | "deepLink" | "pressKey" | "getCurrentPackage" | "getCurrentActivity" | "isKeyboardShown" | "hideKeyboard", args: Record<string, unknown> = {}): Promise<T> {
        return this.cmd<T>("POST", "/execute/sync", { script: `mobile: ${name}`, args: [args] });
    }
    /** The same session without the run's stop signal: the evidence and the clean-up of a stopped or timed-out test still happen. */
    detached(): WdSession {
        return new WdSession({ ...this.o, signal: undefined }, this.id);
    }
    /** Ends the session on the farm (also after a stop, so no phone is left held and billed). */
    async quit(): Promise<void> {
        await wdRequest({ ...this.o, signal: undefined }, "DELETE", this.url(""), undefined, 30_000).catch(() => undefined);
    }
}
