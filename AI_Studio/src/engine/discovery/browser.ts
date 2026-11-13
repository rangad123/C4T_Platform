/**
 * Browser lifecycle for discovery and authoring.
 *
 * From autospec (MIT, Copyright (c) 2024 Zach Blume, src/browser.ts): isolated contexts per task,
 * `ariaSnapshot()` as the page representation, same-host navigation guard. The guard is stricter
 * here: cross-host *document* navigations are aborted at the network layer (context.route)
 * instead of being stopped after they start. Each session watches its page's API traffic (./network.ts).
 */
import { chromium, type Browser, type BrowserContext, type Dialog, type Page } from "playwright";
import type { SiteNote } from "../memory/notes.js";
import { installOverlayHandlers, overlayRules } from "../web/interruptions.js";
import { GuardProxy, privateTargetsBlocked } from "./guard-proxy.js";
import { NetworkInterceptor } from "./network.js";

export interface SessionOptions {
    /** The application's origin; document navigations to other hosts are blocked. */
    startUrl: string;
    allowedHosts?: string[];
    headless?: boolean;
    storageState?: Awaited<ReturnType<BrowserContext["storageState"]>>;
    recordVideoDir?: string;
    /**
     * The project's API credential (bearer token / "Name: value" header), added to the browser's own requests to these
     * origins only (the app and its configured API base), on the page's fetch/XHR calls. Never to any other host, and not to a redirect's next hop.
     */
    authHeaders?: { headers: Record<string, string>; origins: string[] };
    /** The project's notes: the overlays they name ("close the newsletter popup") are closed before each action, as consent banners are. */
    notes?: readonly SiteNote[];
}

/** What happened on the session's pages since it was last asked (see BrowserSession.takeEvents). */
export interface SessionEvents {
    /** Dialogs, each answered: dismissed unless a dialog step armed an answer for it. */
    dialogs: Array<{ type: string; message: string; answer: "accepted" | "dismissed"; /** A dialog step prepared the answer. */ armed: boolean }>;
    /** Pages (tabs, popups) opened after the first one. */
    opened: Page[];
    /** Console errors, page errors, and failed requests (HTTP 4xx / 5xx, network failures) to the application's own origin. */
    problems: string[];
    /** True when one of the problems is a server error (HTTP 5xx) from the application. */
    serverError: boolean;
    /** Downloads started (their suggested file names). */
    downloads: string[];
}

type Armed = { response: "accept" | "dismiss"; promptText?: string; seen: (message: string) => void };
const armedDialogs = new WeakMap<Page, Armed>();
const watchedPages = new WeakSet<Page>();
const answer = (d: Dialog, a: Armed | undefined) => {
    a?.seen(d.message());
    void (a?.response === "accept" ? d.accept(a.promptText) : d.dismiss()).catch(() => undefined);
};
/**
 * A dialog step: the next dialog on this page is answered this way instead of being dismissed; the promise gives its message. On a page
 * no session watches, a one-off listener does the same (Playwright dismisses dialogs nobody listens for).
 */
export function armDialog(page: Page, response: "accept" | "dismiss", promptText?: string): Promise<string> {
    return new Promise((seen) => {
        armedDialogs.set(page, { response, ...(promptText !== undefined ? { promptText } : {}), seen });
        if (!watchedPages.has(page)) {
            page.once("dialog", (d) => {
                const a = armedDialogs.get(page);
                armedDialogs.delete(page);
                answer(d, a);
            });
        }
    });
}

export class BrowserSession {
    readonly network = new NetworkInterceptor();
    private constructor(
        readonly browser: Browser,
        readonly context: BrowserContext,
        readonly page: Page,
        private readonly host: string,
        /** The address guard every request of this session goes through (BLOCK_PRIVATE_TARGETS on), else undefined. */
        readonly guard?: GuardProxy,
    ) {}

    static async launch(browser: Browser, opts: SessionOptions): Promise<BrowserSession> {
        const host = new URL(opts.startUrl).host;
        const allowed = new Set([host, ...(opts.allowedHosts ?? [])]);
        // Private addresses: every request, frame and redirect hop goes through the guard (guard-proxy.ts). "<-loopback>" stops Chromium from
        // sending loopback addresses around the proxy.
        const guard = privateTargetsBlocked() ? await GuardProxy.start() : undefined;
        const context = await browser.newContext({
            ...(guard ? { proxy: { server: guard.address, bypass: "<-loopback>" } } : {}),
            viewport: { width: 1280, height: 800 },
            userAgent:
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 AITestingPlatform/0.1",
            storageState: opts.storageState,
            recordVideo: opts.recordVideoDir ? { dir: opts.recordVideoDir, size: { width: 1280, height: 800 } } : undefined,
            ignoreHTTPSErrors: false,
            // Routes (the bearer token, the address guard) must see every request: a service worker would answer some itself.
            serviceWorkers: "block",
        }).catch(async (e: unknown) => {
            await guard?.close().catch(() => undefined);
            throw e;
        });
        context.setDefaultTimeout(8_000);
        context.setDefaultNavigationTimeout(30_000);

        const auth = opts.authHeaders && Object.keys(opts.authHeaders.headers).length ? { headers: opts.authHeaders.headers, origins: new Set(opts.authHeaders.origins.map((o) => new URL(o).origin)) } : undefined;
        await context.route("**/*", (route) => {
            try {
                const req = route.request();
                if (shouldBlockNavigation(req, allowed)) return route.abort("blockedbyclient").catch(() => undefined);
                // The page's own API calls to the app / API base. Sent without following redirects: Chromium would re-send the header to a
                // redirect's next hop on any host, so the redirect goes back to the page and its next hop comes through here again.
                if (auth && (req.resourceType() === "fetch" || req.resourceType() === "xhr") && auth.origins.has(new URL(req.url()).origin)) {
                    return route
                        .fetch({ headers: { ...req.headers(), ...auth.headers }, maxRedirects: 0 })
                        .then((response) => route.fulfill({ response }))
                        .catch(() => route.abort("failed").catch(() => undefined));
                }
                return route.continue().catch(() => undefined);
            } catch {
                // A handler that throws would be an uncaught exception in the platform process: let the request through (the page stays inside the allowed hosts for the pages that matter) and carry on.
                return route.continue().catch(() => undefined);
            }
        });

        const rules = overlayRules(opts.notes);
        let session: BrowserSession | undefined;
        const early: Page[] = [];
        context.on("page", (p) => (session ? session.watch(p, rules) : early.push(p)));
        const page = await context.newPage();
        session = new BrowserSession(browser, context, page, host, guard);
        for (const p of early) await session.watch(p, rules);
        session.network.attach(page);
        return session;
    }

    private events: SessionEvents = { dialogs: [], opened: [], problems: [], serverError: false, downloads: [] };

    private inFlight = 0;
    /**
     * After an action: a short pause for what it starts (a new tab, a fetch), then until the session's requests are answered (at most
     * `ms`). Playwright's "networkidle" cannot tell: once a page reached it, waiting for it returns at once.
     */
    async quiet(ms = 1_500): Promise<void> {
        const end = Date.now() + ms;
        await new Promise((r) => setTimeout(r, 250));
        while (this.inFlight > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    }

    /** What happened since the last call (dialogs answered, tabs opened, errors), then forgotten. */
    takeEvents(): SessionEvents {
        const e = this.events;
        this.events = { dialogs: [], opened: [], problems: [], serverError: false, downloads: [] };
        return e;
    }

    /** Every page of the session: dialogs are dismissed (never accepted unless a step armed it), overlays closed, problems noted. */
    private async watch(p: Page, rules: ReturnType<typeof overlayRules>): Promise<void> {
        if (watchedPages.has(p)) return;
        watchedPages.add(p);
        if (p !== this.page) this.events.opened.push(p);
        const problem = (text: string) => {
            if (this.events.problems.length < 20) this.events.problems.push(text.replace(/\s+/g, " ").slice(0, 300));
        };
        const own = (url: string) => {
            try {
                return new URL(url).host === this.host;
            } catch {
                return false;
            }
        };
        const where = (url: string) => {
            const u = new URL(url);
            return u.pathname + (u.search ? "?…" : "");
        };
        p.on("dialog", (d) => {
            const armed = armedDialogs.get(p);
            armedDialogs.delete(p);
            this.events.dialogs.push({ type: d.type(), message: d.message().slice(0, 300), answer: armed?.response === "accept" ? "accepted" : "dismissed", armed: !!armed });
            answer(d, armed);
        });
        p.on("request", () => void this.inFlight++);
        p.on("requestfinished", () => void (this.inFlight = Math.max(0, this.inFlight - 1)));
        p.on("console", (m) => void (m.type() === "error" && problem(`Console error: ${m.text()}`)));
        p.on("pageerror", (e) => problem(`Page error: ${e.message}`));
        p.on("response", (r) => {
            if (r.status() < 400 || !own(r.url())) return;
            if (r.status() >= 500) this.events.serverError = true;
            problem(`${r.request().method()} ${where(r.url())} answered HTTP ${r.status()}`);
        });
        p.on("requestfailed", (r) => {
            this.inFlight = Math.max(0, this.inFlight - 1);
            const why = r.failure()?.errorText ?? "";
            // Requests the guard stopped on purpose and requests a navigation cancelled are not the application's errors.
            if (own(r.url()) && !/BLOCKED_BY_CLIENT|ERR_ABORTED/i.test(why)) problem(`${r.method()} ${where(r.url())} failed: ${why}`);
        });
        p.on("download", (d) => void this.events.downloads.push(d.suggestedFilename()));
        await installOverlayHandlers(p, rules);
    }

    async close(): Promise<void> {
        await this.context.close().catch(() => undefined);
        await this.guard?.close().catch(() => undefined);
    }
}

/** The part of a Playwright request the allow-list needs (a test double can stand in). */
export interface NavigationRequestLike {
    isNavigationRequest(): boolean;
    url(): string;
    frame(): { page(): { mainFrame(): unknown } };
}

/**
 * Should this request be refused because it navigates the main page to a host that is not allowed?
 * Playwright throws from `frame()` for a navigation that was started before its frame exists (for example a request issued by a page
 * that is still being created). That used to escape the route handler and end the whole platform process. A navigation whose frame
 * cannot be told is treated as a main-frame navigation, so the host rule still applies (fail closed); it is never an error.
 */
export function shouldBlockNavigation(req: NavigationRequestLike, allowed: ReadonlySet<string>): boolean {
    if (!req.isNavigationRequest()) return false;
    let mainFrame = true;
    try {
        const frame = req.frame();
        mainFrame = frame === frame.page().mainFrame();
    } catch {
        /* frame not available yet: keep the safe default */
    }
    if (!mainFrame) return false;
    try {
        const u = new URL(req.url());
        if (u.protocol !== "http:" && u.protocol !== "https:") return false; /* about:blank and the like fall through */
        return !allowed.has(u.host);
    } catch {
        return false; /* not a URL at all */
    }
}

/** The installed Chrome or Edge an exploration opens instead of Playwright's Chromium (a runner's browser setting, round 51). Unset: Chromium. */
let chromiumChoice: { channel?: string; executablePath?: string } = {};
export function useChromium(choice: { channel?: string; executablePath?: string }): void {
    chromiumChoice = { ...(choice.channel ? { channel: choice.channel } : {}), ...(choice.executablePath ? { executablePath: choice.executablePath } : {}) };
}

export async function launchChromium(headless = true): Promise<Browser> {
    return chromium.launch({ headless, args: ["--no-sandbox", "--disable-setuid-sandbox"], ...chromiumChoice });
}

/** Accessibility-tree snapshot used as the LLM-facing page representation (autospec's approach). */
export async function ariaSnapshot(page: Page, maxChars = 12_000): Promise<string> {
    try {
        const snap = await page.locator("body").ariaSnapshot({ timeout: 5_000 });
        return snap.length > maxChars ? snap.slice(0, maxChars) + "\n…(truncated)" : snap;
    } catch {
        return "(accessibility snapshot unavailable)";
    }
}

/** Wait for the page to settle without hanging on long-polling pages. */
export async function settle(page: Page, ms = 4_000): Promise<void> {
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: ms }).catch(() => undefined);
}
