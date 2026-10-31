/**
 * Reading the screen through the UiAutomator2 server that Appium already installed on the phone (R24), for screens `uiautomator dump`
 * cannot read: a feed or a video that never goes idle makes the dump fail with "could not get idle state". The server can be told not to
 * wait for idle (`waitForIdleTimeout: 0`), and its page source is the same tree the written tests later search, so a locator chosen from it
 * is one the test finds.
 *
 * What it does, all through the closed adb list (adb.ts allowedServerCommand, only on an Adb made with forServerSource()):
 *   forward one free local port to the server's port 6790 on the phone, start the server's instrumentation in its one fixed form, wait for
 *   GET /status, open a session, set waitForIdleTimeout to 0, then read GET /session/:id/source as often as needed. Closing deletes the
 *   session, kills exactly the process it started, force-stops the two server packages (so a test run that follows starts its own server
 *   cleanly) and removes the forward.
 * What it never does: install anything (when the two packages are not on the phone it is simply not used), or run while a test run uses the
 * phone: the device session holds the device lock (emulator.ts withDeviceLock) for its whole life, and test runs take the same lock.
 *
 * The protocol (W3C WebDriver over HTTP, the server at the root path, answers `{ sessionId, value }`) follows appium-uiautomator2-driver
 * (Apache-2.0); no code of it is copied.
 */
import type { ChildProcess } from "node:child_process";
import net from "node:net";
import { Adb, UIA2_SERVER_PACKAGE, UIA2_TEST_PACKAGE } from "./adb.js";

export interface Uia2Options {
    /** The local port to forward (tests); default: a free one. */
    port?: number;
    /** How long the server may take to start (default 20 s). */
    startMs?: number;
    signal?: AbortSignal;
    log?: (line: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A free local port, from the system. */
async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const port = (srv.address() as net.AddressInfo).port;
            srv.close(() => resolve(port));
        });
    });
}

/** A source of the screen description from the UiAutomator2 server. `open` returns undefined when it cannot be used on this phone. */
export class Uia2Source {
    private closed = false;

    private constructor(
        private readonly adb: Adb,
        private readonly port: number,
        private readonly child: ChildProcess,
        private readonly session: string,
        private readonly signal: AbortSignal | undefined,
    ) {}

    /** Is the server installed on the phone (both packages)? The list is read and searched here. */
    static async installed(dev: Adb): Promise<boolean> {
        return (await dev.hasPackage(UIA2_SERVER_PACKAGE).catch(() => false)) && (await dev.hasPackage(UIA2_TEST_PACKAGE).catch(() => false));
    }

    static async open(dev: Adb, o: Uia2Options = {}): Promise<Uia2Source | undefined> {
        const log = o.log ?? (() => undefined);
        if (!(await Uia2Source.installed(dev))) return undefined;
        const adb = dev.forServerSource();
        const port = o.port ?? (await freePort());
        const base = `http://127.0.0.1:${port}`;
        let child: ChildProcess | undefined;
        let exited = false;
        const cleanup = async () => {
            if (child && child.exitCode === null && !child.killed) child.kill();
            await adb.forceStop(UIA2_SERVER_PACKAGE).catch(() => undefined);
            await adb.forceStop(UIA2_TEST_PACKAGE).catch(() => undefined);
            await adb.forwardServer(port, true).catch(() => undefined);
        };
        try {
            await adb.forwardServer(port);
            child = adb.spawnServer();
            if (!child) {
                await cleanup();
                return undefined;
            }
            child.once("exit", () => (exited = true));
            child.once("error", () => (exited = true));
            const end = Date.now() + (o.startMs ?? 20_000);
            let up = false;
            while (Date.now() < end && !exited && !o.signal?.aborted) {
                up = await call(base, "GET", "/status", undefined, 1500).then((r) => r.ok, () => false);
                if (up) break;
                await sleep(400);
            }
            if (!up) {
                await cleanup();
                return undefined;
            }
            const created = await call(base, "POST", "/session", { capabilities: { firstMatch: [{}], alwaysMatch: {} } }, 15_000);
            const id = typeof created.body?.sessionId === "string" ? created.body.sessionId : typeof created.body?.value?.sessionId === "string" ? created.body.value.sessionId : "";
            if (!created.ok || !/^[A-Za-z0-9-]{1,80}$/.test(id)) {
                await cleanup();
                return undefined;
            }
            // Do not wait for the screen to go idle (the reason this source is used), and keep every view (the tree the tests search).
            await call(base, "POST", `/session/${id}/appium/settings`, { settings: { waitForIdleTimeout: 0, ignoreUnimportantViews: false } }, 10_000).catch(() => undefined);
            log("Reading the screen through the UiAutomator2 server on the phone (the screen never settles for a plain dump)");
            return new Uia2Source(adb, port, child, id, o.signal);
        } catch {
            await cleanup();
            return undefined;
        }
    }

    /** The screen description (the same kind of XML as `uiautomator dump`, with class names as tag names). Throws when it cannot be read. */
    async source(): Promise<string> {
        if (this.closed) throw new Error("closed");
        const r = await call(`http://127.0.0.1:${this.port}`, "GET", `/session/${this.session}/source`, undefined, 20_000, this.signal);
        if (!r.ok || typeof r.body?.value !== "string") throw new Error("The UiAutomator2 server did not return the screen.");
        return r.body.value;
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        await call(`http://127.0.0.1:${this.port}`, "DELETE", `/session/${this.session}`, undefined, 3000).catch(() => undefined);
        if (this.child.exitCode === null && !this.child.killed) this.child.kill();
        await this.adb.forceStop(UIA2_SERVER_PACKAGE).catch(() => undefined);
        await this.adb.forceStop(UIA2_TEST_PACKAGE).catch(() => undefined);
        await this.adb.forwardServer(this.port, true).catch(() => undefined);
    }
}

/** One HTTP call to the forwarded port (this computer only), with a time limit; the body is JSON or nothing. */
async function call(base: string, method: "GET" | "POST" | "DELETE", path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; body: any }> {
    const t = AbortSignal.timeout(timeoutMs);
    const res = await fetch(`${base}${path}`, {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json; charset=utf-8" } } : {}),
        signal: signal ? AbortSignal.any([t, signal]) : t,
    });
    const text = await res.text();
    if (text.length > 4 * 1024 * 1024) return { ok: false, body: undefined };
    let parsed: any;
    try {
        parsed = text ? JSON.parse(text) : undefined;
    } catch {
        parsed = undefined;
    }
    return { ok: res.ok, body: parsed };
}
