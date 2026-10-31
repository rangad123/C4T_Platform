/**
 * "Sign in once yourself": a browser opens on the application's sign-in page, the person signs in by hand (single sign-on, Google or
 * Microsoft sign-in, a captcha, an emailed code: whatever the site asks), and on "I'm signed in" the browser's storage state is taken
 * and the browser closed. Nothing the person types is read: the platform only keeps the cookies and storage the site set.
 *
 * Sign-in popups (an OAuth window that opens over the page) are followed: they belong to the same browser context, so whatever they set
 * is in the saved state, and the status shows that a sign-in window is open. Like the recorder (../recorder/session.ts), the browser is
 * the platform's own Chromium in a fresh context, its process id is kept so only that process is ever ended, every page the main window
 * opens is checked by the address guard before the browser connects, and the session ends on its own after a time.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { pidAlive } from "../recorder/session.js";
import { detectCaptcha } from "./captcha.js";
import type { StorageState } from "./storage-state.js";
import { parseStorageState } from "./storage-state.js";

export type CaptureStatus = "starting" | "open" | "saved" | "cancelled" | "failed";

export interface CaptureState {
    status: CaptureStatus;
    startUrl: string;
    /** Where the main window is now (address only, no query string: it can hold codes). */
    currentUrl?: string;
    /** A sign-in window (popup) is open right now. */
    popupOpen: boolean;
    /** How many sign-in windows opened during this session. */
    popups: number;
    /** The page shows a captcha: the person solves it; it is never touched by the platform. */
    captcha?: string;
    headed: boolean;
    startedAt: string;
    endedAt?: string;
    error?: string;
}

export interface CaptureOptions {
    startUrl: string;
    headed: boolean;
    /** Address guard for every document the main window or a popup opens (default: none). */
    guard?: (url: string) => Promise<void>;
    launch?: (headless: boolean) => Promise<Browser>;
    /** Ends the session on its own (default 15 minutes). */
    totalMs?: number;
}

export const CAPTURE_TOTAL_MS = 15 * 60_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const shortUrl = (u: string) => {
    try {
        const x = new URL(u);
        return `${x.origin}${x.pathname}`;
    } catch {
        return "";
    }
};

export class SignInCapture {
    private s: CaptureState;
    private browser?: Browser;
    private context?: BrowserContext;
    private page?: Page;
    private pid?: number;
    private timer?: NodeJS.Timeout;
    private ending?: Promise<void>;

    constructor(private readonly o: CaptureOptions) {
        this.s = { status: "starting", startUrl: o.startUrl, popupOpen: false, popups: 0, headed: o.headed, startedAt: new Date().toISOString() };
    }

    state(): CaptureState {
        return { ...this.s };
    }

    /** The page the person is on (tests drive it as the person would). */
    mainPage(): Page | undefined {
        return this.page;
    }

    browserPid(): number | undefined {
        return this.pid;
    }

    /** Opens the browser in the background; progress shows in `state()`. */
    start(): void {
        void this.boot().catch((e) => this.finish("failed", `The browser could not be opened: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200)}`));
    }

    private async boot(): Promise<void> {
        if (this.o.guard) await this.o.guard(this.o.startUrl);
        const browser = await (this.o.launch ?? ((headless) => chromium.launch({ headless })))(!this.o.headed);
        this.browser = browser;
        browser.on("disconnected", () => void this.finish("failed", "The browser was closed before the sign-in was saved."));
        try {
            const cdp = await browser.newBrowserCDPSession();
            const info = (await cdp.send("SystemInfo.getProcessInfo")) as { processInfo: Array<{ type: string; id: number }> };
            this.pid = info.processInfo.find((p) => p.type === "browser")?.id;
            await cdp.detach().catch(() => undefined);
        } catch {
            /* the pid is a safety net only */
        }
        if (this.s.status !== "starting") return void (await this.closeBrowser());
        // A fresh context: nothing from earlier sessions, no downloads, no permissions granted.
        const context = await browser.newContext({ viewport: this.o.headed ? null : { width: 1280, height: 800 }, acceptDownloads: false, permissions: [] });
        this.context = context;
        if (this.o.guard) {
            const guard = this.o.guard;
            await context.route("**/*", async (route) => {
                const req = route.request();
                if (!req.isNavigationRequest()) return route.continue().catch(() => undefined);
                try {
                    await guard(req.url());
                    return route.continue().catch(() => undefined);
                } catch {
                    return route.abort("blockedbyclient").catch(() => undefined);
                }
            });
        }
        // Sign-in windows: followed (they share the context, so what they set is saved), and shown in the status.
        context.on("page", (p) => {
            if (!this.page || p === this.page) return;
            this.s.popups++;
            this.s.popupOpen = true;
            p.on("close", () => {
                this.s.popupOpen = context.pages().some((x) => x !== this.page && !x.isClosed());
            });
        });
        const page = await context.newPage();
        this.page = page;
        page.on("framenavigated", (f) => {
            if (f === page.mainFrame()) {
                this.s.currentUrl = shortUrl(f.url());
                void detectCaptcha(page).then((c) => (this.s.captcha = c)).catch(() => undefined);
            }
        });
        page.on("close", () => void this.finish("failed", "The sign-in window was closed before the sign-in was saved."));
        this.timer = setTimeout(() => void this.finish("cancelled", "The sign-in was not saved within 15 minutes, so the browser was closed."), this.o.totalMs ?? CAPTURE_TOTAL_MS);
        await page.goto(this.o.startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
        if (this.s.status === "starting") this.s.status = "open";
    }

    /** "I'm signed in": takes the storage state and the main window's address (the page the "Still signed in?" check opens), then closes. */
    async save(): Promise<{ state: StorageState; checkUrl: string }> {
        if (this.s.status !== "open" || !this.context || !this.page) throw new Error(this.s.status === "starting" ? "The browser is still opening." : "This sign-in session has ended.");
        const raw = await this.context.storageState();
        const checkUrl = this.page.url();
        const state = parseStorageState(raw);
        await this.finish("saved");
        return { state, checkUrl };
    }

    async cancel(): Promise<void> {
        await this.finish("cancelled");
    }

    private finish(status: CaptureStatus, error?: string): Promise<void> {
        if (this.ending) return this.ending;
        if (this.s.status === "saved" || this.s.status === "cancelled" || this.s.status === "failed") return Promise.resolve();
        this.s.status = status;
        if (error) this.s.error = error;
        this.s.endedAt = new Date().toISOString();
        this.s.popupOpen = false;
        clearTimeout(this.timer);
        this.ending = this.closeBrowser();
        return this.ending;
    }

    private async closeBrowser(): Promise<void> {
        const b = this.browser;
        this.browser = undefined;
        this.context = undefined;
        this.page = undefined;
        if (b) {
            b.removeAllListeners("disconnected");
            await Promise.race([b.close().catch(() => undefined), sleep(8_000)]);
        }
        if (this.pid) {
            // Only the process this session started, by its own id.
            for (let i = 0; i < 20 && pidAlive(this.pid); i++) {
                if (i === 5) {
                    try {
                        process.kill(this.pid);
                    } catch {
                        /* gone */
                    }
                }
                await sleep(100);
            }
        }
    }

    /** Waits until the browser is gone (after save, cancel or a failure). */
    async ended(): Promise<void> {
        await this.ending;
    }
}
