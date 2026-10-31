/**
 * Breadth-first, same-origin crawler producing PageModels.
 *
 * Each page is read as an accessibility snapshot (autospec's page representation, ./browser.ts) plus
 * its forms, links and controls (./snapshot.ts), while ./network.ts records the API calls it makes.
 * Only same-origin links are followed.
 *
 * Single-page apps: hash routes (#/inbox, #!/item/3) count as distinct pages; URL changes made by the
 * app itself (redirects, history.pushState after a click) are captured from `framenavigated`; a few
 * href-less navigation controls are probed by clicking; and a client-side route that 404s when loaded
 * directly is reached again by replaying the click from the page it was found on.
 *
 * Safety: never follows or clicks destructive-looking links/controls (logout, delete, pay...).
 */
import type { Frame, Page } from "playwright";
import type { EngineContext } from "../context.js";
import { throwIfAborted } from "../context.js";
import { activityLine } from "../frames/activity.js";
import type { ComponentModel, FormModel, PageModel, PageType, NavigationEdge } from "../understanding/app-model.js";
import { ariaSnapshot, settle, type BrowserSession } from "./browser.js";
import { captureSnapshot, type FormSnapshot } from "./snapshot.js";
import { readFrameElements } from "../web/frame-elements.js";
import { captchaMessage, detectCaptcha } from "../auth/captcha.js";

export interface CrawlOptions {
    startUrl: string;
    maxPages: number;
    maxDepth: number;
    /** Max pages sharing the same URL pattern (e.g. /product/{id}) so catalogues don't eat the budget. */
    maxPerPattern: number;
    screenshotsDir?: string;
    /** Path prefixes to restrict the crawl to (testing scope). */
    includePaths?: string[];
    /**
     * Extra starting points, e.g. where login landed. Apps that keep showing the login form at "/"
     * even when signed in (and never link to the app from it) are otherwise unreachable.
     */
    seedUrls?: string[];
}

export interface CrawlResult {
    pages: PageModel[];
    navigation: NavigationEdge[];
    skipped: number;
}

const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|map|woff2?|ttf|eot|pdf|zip|gz|tar|mp4|webm|mp3|xml|json|txt|csv|xlsx?|docx?)(\?|$)/i;
const DANGEROUS = /(log-?out|sign-?out|signoff|delete|remove|destroy|unsubscribe|deactivate|cancel-account|\/pay\b|checkout\/confirm|purchase)/i;

/** Fragments that look like client-side routes (#/active, #!/item/3); plain anchors (#top) do not. */
const HASH_ROUTE = /^#!?\//;

/** The route part of a fragment, normalised: "" for anchors and for the root routes "#/" and "#!/". */
function routeHash(hash: string): string {
    if (!HASH_ROUTE.test(hash)) return "";
    const h = hash.replace(/\/+$/, "");
    return h === "#" || h === "#!" ? "" : h;
}

export function normalizeUrl(raw: string, base: string): string | null {
    try {
        const u = new URL(raw, base);
        if (!/^https?:$/.test(u.protocol)) return null;
        // Hash routes are separate views in hash-routed SPAs; in-page anchors are the same page.
        u.hash = routeHash(u.hash);
        if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
        return u.toString();
    } catch {
        return null;
    }
}

const idSegment = (s: string) => (/^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(s) || /^[0-9a-f]{24}$/i.test(s) ? "{id}" : s);

/** Pattern key: numeric/uuid path (and hash-route) segments → {id}; query reduced to param names. */
export function urlPattern(url: string): string {
    const u = new URL(url);
    const path = u.pathname.split("/").map(idSegment).join("/");
    const params = [...u.searchParams.keys()].sort().join("&");
    const route = routeHash(u.hash).split("?")[0]!.split("/").map(idSegment).join("/");
    return `${path}${params ? "?" + params : ""}${route}`;
}

/** Path shown for a page: path + query, plus the hash route when there is one. */
function pagePath(url: string): string {
    const u = new URL(url);
    return u.pathname + u.search + routeHash(u.hash);
}

/**
 * Whether a response is really an error page. The HTTP status alone is not enough: single-page apps on
 * static hosts are often served through the host's 404 fallback (saucedemo.com serves its working
 * product page with status 404), so a 4xx/5xx counts only if the content also looks like an error.
 */
export function looksLikeErrorPage(status: number, text: string, controlCount: number): boolean {
    if (status < 400) return false;
    return controlCount < 4 || /\b404\b|not found|forbidden|unauthori[sz]ed|internal server error|bad request|service unavailable/i.test(text.slice(0, 800));
}

function classifyPage(url: string, title: string, aria: string, forms: FormModel[], isError: boolean): PageType {
    if (isError) return "error";
    const u = new URL(url);
    const p = (u.pathname + routeHash(u.hash)).toLowerCase();
    const hay = `${p} ${title}`.toLowerCase();
    if (forms.some((f) => f.purpose === "login")) return "login";
    if (forms.some((f) => f.purpose === "signup")) return "register";
    if (forms.some((f) => f.purpose === "checkout") || /checkout|payment/.test(hay)) return "checkout";
    if (/cart|basket|bag/.test(hay)) return "cart";
    if (/dashboard|overview/.test(hay)) return "dashboard";
    if (/account|profile|settings/.test(hay)) return "account";
    // A search box in a header/footer is on nearly every page, so only the path/title says "search page".
    if (/search/.test(hay)) return "search";
    if (p === "/" || p === "") return "home";
    if (/\/(product|item|post|article|detail)s?\/[^/]+$/.test(p)) return "detail";
    if (/products?|items?|catalog|shop|list|blog|posts/.test(hay)) return "listing";
    if (forms.some((f) => f.purpose !== "search")) return "form";
    return "content";
}

function classifyForm(f: FormSnapshot): FormModel["purpose"] {
    const types = f.fields.map((x) => x.type);
    const text = f.fields.map((x) => `${x.name ?? ""} ${x.label ?? ""} ${x.placeholder ?? ""}`).join(" ").toLowerCase();
    const hasPw = types.includes("password");
    const pwCount = types.filter((t) => t === "password").length;
    if (hasPw && (pwCount > 1 || /confirm|repeat|signup|register|first.?name|last.?name/.test(text))) return "signup";
    if (hasPw) return "login";
    if (types.includes("search") || /search|query|\bq\b/.test(text)) return "search";
    if (/card|cvv|cvc|expir|billing|shipping|address|zip|postal/.test(text)) return "checkout";
    if (/message|subject|comment/.test(text)) return "contact";
    return "other";
}

function locatorHint(role: string, name: string): string {
    const n = JSON.stringify(name);
    if (["button", "link", "checkbox", "radio", "tab", "menuitem", "heading"].includes(role)) {
        return `getByRole(${JSON.stringify(role)}, { name: ${n} })`;
    }
    return `getByText(${n})`;
}

async function extractPage(page: Page, url: string, depth: number, status: number, loadMs: number): Promise<PageModel> {
    const snap = await captureSnapshot(page);
    const aria = await ariaSnapshot(page, 6_000);
    const headings = await page
        .evaluate(() =>
            Array.from(document.querySelectorAll("h1,h2,h3"))
                .slice(0, 12)
                .map((h) => (h as HTMLElement).innerText.trim())
                .filter(Boolean),
        )
        .catch(() => [] as string[]);

    const forms: FormModel[] = snap.forms.map((f) => ({
        id: f.id,
        action: f.action,
        method: f.method,
        fields: f.fields.map((x) => ({
            type: x.type,
            name: x.name,
            label: x.label,
            placeholder: x.placeholder,
            required: x.required,
        })),
        purpose: classifyForm(f),
    }));

    const components: ComponentModel[] = snap.interactiveElements.map((e) => {
        const role = e.role === "a" ? "link" : e.role === "input" ? "textbox" : e.role === "select" ? "combobox" : e.role;
        return { role, name: e.name, locatorHint: locatorHint(role, e.name) };
    });
    // Elements inside frames (a payment form, an embedded widget), with the frames a step needs to reach them; bounded (see web/frame-elements.ts).
    components.push(...(await readFrameElements(page).catch(() => [])));

    const origin = new URL(url).origin;
    const links = snap.links.filter((l) => {
        try {
            return new URL(l.href).origin === origin;
        } catch {
            return false;
        }
    });

    return {
        url: page.url(),
        path: pagePath(page.url()),
        title: snap.title,
        type: classifyPage(page.url(), snap.title, aria, forms, looksLikeErrorPage(status, snap.text, snap.interactiveElements.length)),
        depth,
        status,
        headings,
        forms,
        components,
        links,
        aria,
        text: snap.text,
        apiCalls: [],
        revealed: [],
        consoleErrors: [],
        loadMs,
    };
}

const SAFE_TOGGLE = '[aria-haspopup]:visible, [aria-expanded="false"]:visible, [role="tab"]:visible, summary:visible';
const UNSAFE_NAME = /delete|remove|pay|buy|order|submit|confirm|log\s?out|sign\s?out|send|publish|save|reset|clear all|unsubscribe/i;

/** Click a few non-destructive toggles (menus, tabs, accordions, disclosure) and record what appears. */
async function exploreSafeInteractions(page: Page, pageUrl: string): Promise<string[]> {
    const revealed = new Set<string>();
    const toggles = page.locator(SAFE_TOGGLE);
    const count = Math.min(await toggles.count().catch(() => 0), 4);
    for (let i = 0; i < count; i++) {
        try {
            const el = toggles.nth(i);
            const name = ((await el.getAttribute("aria-label")) ?? (await el.innerText({ timeout: 1000 }))).trim();
            if (UNSAFE_NAME.test(name)) continue;
            const before = await ariaSnapshot(page, 6_000);
            await el.click({ timeout: 2_000 });
            await page.waitForTimeout(250);
            if (page.url() !== pageUrl) {
                await page.goBack().catch(() => undefined);
                continue;
            }
            const after = await ariaSnapshot(page, 6_000);
            const beforeLines = new Set(before.split("\n").map((l) => l.trim()));
            for (const line of after.split("\n").map((l) => l.trim())) {
                if (line && !beforeLines.has(line) && revealed.size < 15) revealed.add(`${name || "toggle"} → ${line}`.slice(0, 160));
            }
            await page.keyboard.press("Escape").catch(() => undefined);
        } catch {
            /* interaction not possible; move on */
        }
    }
    return [...revealed];
}

/**
 * Controls that may navigate without an href a crawler can read (router.push in an onClick).
 * Kept to navigation-ish places so arbitrary action buttons in page content are never probed.
 */
const ROUTE_CANDIDATES = [
    "a:not([href])",
    'a[href="#"]',
    'a[href^="javascript:"]',
    '[role="link"]:not([href])',
    '[role="menuitem"]:not([href])',
    "[data-href]",
    "[data-route]",
    "[routerlink]",
    "nav button",
    '[role="navigation"] button',
    "header button",
].join(", ");
const PROBES_PER_PAGE = 6;
const PROBES_PER_CRAWL = 40;

/** Where a URL was found, so a client-only route can be reached again by clicking instead of loading. */
interface ClickPath {
    parent: string;
    /** For links: the anchor's resolved href. */
    href?: string;
    /** For probed controls: their accessible name. */
    name?: string;
}

/** Tag the current document so a later check can tell a client-side route change from a document load. */
async function markDocument(page: Page): Promise<void> {
    await page.evaluate(() => ((window as unknown as { __aitpDoc?: boolean }).__aitpDoc = true)).catch(() => undefined);
}

async function sameDocument(page: Page): Promise<boolean> {
    return page.evaluate(() => (window as unknown as { __aitpDoc?: boolean }).__aitpDoc === true).catch(() => false);
}

/** Load a URL and return its HTTP status. */
async function load(page: Page, url: string): Promise<number> {
    let resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    // A hash-only change is a same-document navigation with no response: reload so the view starts
    // clean (no state left from the previous route) and we get a real status.
    if (!resp) resp = await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await settle(page);
    return resp?.status() ?? 0;
}

/**
 * Click (safe, href-less) navigation controls and report the same-origin URLs they lead to.
 * `probed` is shared across the crawl so a nav bar repeated on every view is only probed once.
 */
async function probeClientRoutes(page: Page, pageUrl: string, probed: Set<string>): Promise<Array<{ url: string; name: string }>> {
    const out: Array<{ url: string; name: string }> = [];
    const cands = page.locator(ROUTE_CANDIDATES);
    const count = Math.min(await cands.count().catch(() => 0), 30);
    let tried = 0;
    for (let i = 0; i < count && tried < PROBES_PER_PAGE && probed.size < PROBES_PER_CRAWL; i++) {
        try {
            const el = cands.nth(i);
            const info = await el.evaluate(
                (e) => ({ name: (e.getAttribute("aria-label") ?? (e as HTMLElement).innerText ?? "").trim().slice(0, 80), inForm: !!e.closest("form") }),
                undefined,
                { timeout: 1_000 },
            );
            // Form buttons submit data; unnamed or destructive-sounding controls are never clicked.
            if (!info.name || info.inForm || UNSAFE_NAME.test(info.name) || probed.has(info.name)) continue;
            if (!(await el.isVisible())) continue;
            probed.add(info.name);
            tried++;
            await el.click({ timeout: 2_000 });
            await page.waitForTimeout(300);
            const now = page.url();
            if (normalizeUrl(now, pageUrl) !== normalizeUrl(pageUrl, pageUrl)) out.push({ url: now, name: info.name });
            if (now !== pageUrl) {
                await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
                if (page.url() !== pageUrl) await page.goto(pageUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
                await settle(page, 2_000);
            }
            await page.keyboard.press("Escape").catch(() => undefined);
        } catch {
            /* not clickable; move on */
        }
    }
    return out;
}

/**
 * Reach `target` by loading its parent and clicking the link/control it was found through. Only
 * succeeds when the click produces the URL *without* a document load, i.e. it is a client-side
 * route; returns the parent's status, or null.
 */
async function replayClickPath(page: Page, via: ClickPath, target: string): Promise<number | null> {
    try {
        const resp = await page.goto(via.parent, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await settle(page);
        const status = resp?.status() ?? 0;
        if (status >= 400) return null;
        await markDocument(page);
        const clicked = await page.evaluate(
            ({ href, name, sel }) => {
                const els = href
                    ? Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).filter((a) => a.href === href)
                    : Array.from(document.querySelectorAll<HTMLElement>(sel)).filter((e) => (e.getAttribute("aria-label") ?? e.innerText ?? "").trim().slice(0, 80) === name);
                els[0]?.click();
                return els.length > 0;
            },
            { href: via.href, name: via.name, sel: ROUTE_CANDIDATES },
        );
        if (!clicked) return null;
        for (let i = 0; i < 30 && normalizeUrl(page.url(), target) !== target; i++) await page.waitForTimeout(100);
        if (normalizeUrl(page.url(), target) !== target || !(await sameDocument(page))) return null;
        await settle(page, 2_000);
        return status;
    } catch {
        return null;
    }
}

export async function crawl(session: BrowserSession, ctx: EngineContext, opts: CrawlOptions): Promise<CrawlResult> {
    const { page } = session;
    const origin = new URL(opts.startUrl).origin;
    const queue: Array<{ url: string; depth: number; from?: string; label?: string; via?: ClickPath }> = [];
    const seen = new Set<string>();
    /** Normalised URLs actually rendered (after redirects), so a redirect target isn't recorded twice. */
    const visited = new Set<string>();
    const probed = new Set<string>();
    const patternCount = new Map<string, number>();
    const pages: PageModel[] = [];
    const navigation: NavigationEdge[] = [];
    let skipped = 0;

    const enqueue = (raw: string, depth: number, from?: string, label?: string, via?: ClickPath) => {
        const url = normalizeUrl(raw, opts.startUrl);
        if (!url || seen.has(url)) return;
        const u = new URL(url);
        if (u.origin !== origin) return;
        if (ASSET_EXT.test(u.pathname) || DANGEROUS.test(u.pathname + u.search + u.hash)) {
            skipped++;
            return;
        }
        if (opts.includePaths?.length && !opts.includePaths.some((p) => u.pathname.startsWith(p)) && depth > 0) {
            skipped++;
            return;
        }
        seen.add(url);
        queue.push({ url, depth, from, label, via });
    };

    enqueue(opts.startUrl, 0);
    for (const seed of opts.seedUrls ?? []) enqueue(seed, 0);
    await seedFromSitemap(session, origin, (u) => enqueue(u, 1));

    while (queue.length && pages.length < opts.maxPages) {
        throwIfAborted(ctx.signal);
        const next = queue.shift()!;
        const pat = urlPattern(next.url);
        if ((patternCount.get(pat) ?? 0) >= opts.maxPerPattern) {
            skipped++;
            continue;
        }

        const consoleErrors: string[] = [];
        const onConsole = (m: { type(): string; text(): string }) => {
            if (m.type() === "error" && consoleErrors.length < 5) consoleErrors.push(m.text().slice(0, 200));
        };
        // URLs the app moves to on its own while we are on this page (client-side redirects, pushState
        // after a toggle click) — these never appear as <a href>.
        const moved: string[] = [];
        const onNavigated = (f: Frame) => {
            if (f === page.mainFrame() && moved.length < 50) moved.push(f.url());
        };
        page.on("console", onConsole);
        page.on("framenavigated", onNavigated);
        session.network.setCurrentPage(next.url);

        try {
            const t0 = Date.now();
            let status = await load(page, next.url);
            if (status >= 400 && next.via) {
                // Typical SPA on a static host: the route only exists client-side, so click to it instead.
                const replayed = await replayClickPath(page, next.via, next.url);
                status = replayed ?? (await load(page, next.url));
            }
            const finalUrl = normalizeUrl(page.url(), opts.startUrl);
            if (finalUrl && finalUrl !== next.url) {
                if (visited.has(finalUrl)) {
                    skipped++;
                    continue;
                }
                seen.add(finalUrl);
                visited.add(finalUrl);
            }
            visited.add(next.url);
            // The Explorer view (only when someone watches): the page that just opened.
            await ctx.frames?.capture(page, { note: activityLine({ kind: "opened", url: page.url() }), phase: "exploring", pagesSeen: pages.length + 1 });

            const model = await extractPage(page, next.url, next.depth, status, Date.now() - t0);
            model.consoleErrors = consoleErrors;
            const pathname = new URL(page.url()).pathname;
            model.apiCalls = session.network
                .getDiscoveredEndpoints()
                .filter((e) => e.usedIn.includes(pathname))
                .map((e) => `${e.method} ${e.path}`);
            // A page with a captcha stops this path: nothing on it is tried and its links are not followed (hard sign-ins, ../auth/captcha.ts).
            const captcha = await detectCaptcha(page);
            if (captcha) ctx.emit({ stage: "discovery", kind: "captcha_found", level: "warn", message: captchaMessage(captcha, new URL(page.url()).pathname), data: { url: page.url(), captcha } });
            if (model.type !== "error" && !captcha) model.revealed = await exploreSafeInteractions(page, page.url());
            await ctx.frames?.capture(page, { note: activityLine({ kind: "read", links: model.links.length }), phase: "exploring", pagesSeen: pages.length + 1 });

            if (opts.screenshotsDir) {
                const file = `page-${pages.length + 1}.png`;
                await page
                    .screenshot({ path: `${opts.screenshotsDir}/${file}`, fullPage: false })
                    .then(() => (model.screenshot = file))
                    .catch(() => undefined);
            }

            patternCount.set(pat, (patternCount.get(pat) ?? 0) + 1);
            pages.push(model);
            if (next.from) navigation.push({ from: next.from, to: model.path, label: next.label ?? "" });
            ctx.emit({
                stage: "discovery",
                kind: "page_visited",
                message: `Visited ${model.path} (${model.type}, ${model.forms.length} forms, ${model.components.length} controls)`,
                data: { url: model.url, status, depth: next.depth, type: model.type },
            });

            if (next.depth < opts.maxDepth && !captcha) {
                const d = next.depth + 1;
                for (const l of model.links) enqueue(l.href, d, model.path, l.text, { parent: model.url, href: l.href });
                const routes = model.type !== "error" ? await probeClientRoutes(page, page.url(), probed) : [];
                for (const r of routes) enqueue(r.url, d, model.path, r.name, { parent: model.url, name: r.name });
                for (const u of moved) enqueue(u, d, model.path, "");
            }
        } catch (err) {
            skipped++;
            ctx.emit({
                stage: "discovery",
                kind: "page_failed",
                level: "warn",
                message: `Could not load ${next.url}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
            });
        } finally {
            page.off("console", onConsole);
            page.off("framenavigated", onNavigated);
        }
    }
    skipped += queue.length;
    return { pages, navigation, skipped };
}

/** Seed the queue from /sitemap.xml (same-origin, capped). */
async function seedFromSitemap(session: BrowserSession, origin: string, add: (u: string) => void): Promise<void> {
    try {
        const res = await session.context.request.get(`${origin}/sitemap.xml`, { timeout: 5_000 });
        if (!res.ok() || !(res.headers()["content-type"] ?? "").includes("xml")) return;
        const xml = await res.text();
        [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].slice(0, 15).forEach((m) => add(m[1]!));
    } catch {
        /* no sitemap */
    }
}
