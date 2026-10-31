/**
 * Captchas: recognised, never solved.
 *
 * A captcha exists to stop automated browsers, so the honest thing for a tester is to say "this page has one" and stop that path,
 * instead of reporting a confusing failure (or worse, trying to get past it). Three common kinds are recognised: Google reCAPTCHA,
 * hCaptcha and Cloudflare Turnstile, by the frames they load, the elements their snippets put in the page, or the requests they make.
 * Exploration stops following links from such a page, the sign-in step says so, and a failed run whose page loaded one is reported with
 * the same plain sentence (see `captchaFromRequests`, used by the validator on the run's failure evidence).
 */
import type { Page } from "playwright";

/** Every captcha message starts with this, so the UI, the CLI and tests can recognise it. */
export const CAPTCHA_FINDING_START = "This page has a captcha";

export type CaptchaKind = "reCAPTCHA" | "hCaptcha" | "Turnstile";

/** The one sentence a person reads, whatever found the captcha. */
export function captchaMessage(kind?: CaptchaKind, where?: string): string {
    return `${CAPTCHA_FINDING_START}${kind ? ` (${kind})` : ""}${where ? ` at ${where}` : ""}; use a saved session or ask the site to turn it off for tests.`;
}

/** Elements each widget's snippet puts in the page, and the frames it loads (matched on the frame's title or address). */
const MARKERS: ReadonlyArray<{ kind: CaptchaKind; selector: string; frame: RegExp }> = [
    { kind: "reCAPTCHA", selector: '.g-recaptcha, iframe[title*="recaptcha" i], iframe[src*="/recaptcha/"]', frame: /\/recaptcha\/(api|enterprise)/i },
    { kind: "hCaptcha", selector: '.h-captcha, iframe[title*="hcaptcha" i], iframe[src*="hcaptcha.com"]', frame: /(^|\.)hcaptcha\.com\//i },
    { kind: "Turnstile", selector: '.cf-turnstile, iframe[title*="cloudflare security challenge" i], iframe[src*="challenges.cloudflare.com"]', frame: /challenges\.cloudflare\.com\/|\/cdn-cgi\/challenge-platform\//i },
];

/** Which captcha (if any) the page shows now. Reads the page only; never clicks anything. */
export async function detectCaptcha(page: Page): Promise<CaptchaKind | undefined> {
    for (const m of MARKERS) {
        if ((await page.locator(m.selector).count().catch(() => 0)) > 0) return m.kind;
    }
    for (const f of page.frames()) {
        const url = f.url();
        const hit = MARKERS.find((m) => m.frame.test(url.replace(/^https?:\/\//, "")));
        if (hit) return hit.kind;
    }
    return undefined;
}

/**
 * Which captcha a page loaded, judged from the requests a run made (host is absent for the application's own address). Used on the
 * failure evidence of a run: a test that failed on a page that loaded a captcha is reported as such.
 */
export function captchaFromRequests(requests: ReadonlyArray<{ host?: string; path: string }>): CaptchaKind | undefined {
    for (const r of requests) {
        const host = (r.host ?? "").toLowerCase();
        const p = r.path.toLowerCase();
        if (/^\/recaptcha\/(api|api2|enterprise)/.test(p) && (host === "" || /(^|\.)google\.com$|(^|\.)recaptcha\.net$|(^|\.)gstatic\.com$/.test(host))) return "reCAPTCHA";
        if (/(^|\.)hcaptcha\.com$/.test(host)) return "hCaptcha";
        if (host === "challenges.cloudflare.com" || p.startsWith("/cdn-cgi/challenge-platform/")) return "Turnstile";
    }
    return undefined;
}
