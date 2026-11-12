/**
 * Browser lifecycle for discovery and authoring.
 *
 * From autospec (MIT, Copyright (c) 2024 Zach Blume, src/browser.ts): isolated contexts per task,
 * `ariaSnapshot()` as the page representation, same-host navigation guard. The guard is stricter
 * here: cross-host *document* navigations are aborted at the network layer (context.route)
 * instead of being stopped after they start. Each session watches its page's API traffic (./network.ts).
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { GuardProxy, privateTargetsBlocked } from "./guard-proxy.js";
import { NetworkInterceptor } from "./network.js";

export interface SessionOptions {
    /** The application's origin; document navigations to other hosts are blocked. */
    startUrl: string;
    allowedHosts?: string[];
    headless?: boolean;
    storageState?: Awaited<ReturnType<BrowserContext["storageState"]>>;
    recordVideoDir?: string;
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
        }).catch(async (e: unknown) => {
            await guard?.close().catch(() => undefined);
            throw e;
        });
        context.setDefaultTimeout(8_000);
        context.setDefaultNavigationTimeout(30_000);

        await context.route("**/*", (route) => {
            try {
                if (shouldBlockNavigation(route.request(), allowed)) return route.abort("blockedbyclient").catch(() => undefined);
                return route.continue().catch(() => undefined);
            } catch {
                // A handler that throws would be an uncaught exception in the platform process: let the request through (the page stays inside the allowed hosts for the pages that matter) and carry on.
                return route.continue().catch(() => undefined);
            }
        });

        const page = await context.newPage();
        const session = new BrowserSession(browser, context, page, host, guard);
        session.network.attach(page);
        return session;
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
