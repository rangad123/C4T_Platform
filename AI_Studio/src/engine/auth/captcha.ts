/**
 * Captchas: recognised, never solved.
 *
 * A captcha exists to stop automated browsers, so the honest thing for a tester is to say "this page has one" and stop that path,
 * instead of reporting a confusing failure (or worse, trying to get past it). Three common kinds are recognised: Google reCAPTCHA,
 * hCaptcha and Cloudflare Turnstile, by a widget a person can see (never by a script or hidden frame that merely loaded: ad and
 * analytics scripts load reCAPTCHA frames on pages with no captcha). Exploration stops following links from such a page, the sign-in step
 * says so, and a failed run whose page showed one is reported with the same plain sentence (the evidence of a failed run records what
 * `CAPTCHA_PROBE_SOURCE` saw; see captcha-run.ts).
 */
import type { Page } from "playwright";

/** Every captcha message starts with this, so the UI, the CLI and tests can recognise it. */
export const CAPTCHA_FINDING_START = "This page has a captcha";

export type CaptchaKind = "reCAPTCHA" | "hCaptcha" | "Turnstile";

/** The one sentence a person reads, whatever found the captcha. */
export function captchaMessage(kind?: CaptchaKind, where?: string): string {
    return `${CAPTCHA_FINDING_START}${kind ? ` (${kind})` : ""}${where ? ` at ${where}` : ""}; use a saved session or ask the site to turn it off for tests.`;
}

/**
 * The captcha a person can see on the page now, or null. Plain JavaScript run inside the page (by `detectCaptcha`, and by the evidence
 * helper every web script carries when a test fails), so both judge the same way. Only a widget that is really shown counts: a visible
 * `.g-recaptcha` / `.h-captcha` / `.cf-turnstile` box or a widget or challenge frame of real size. A frame an ad or analytics script
 * loads (reCAPTCHA's hidden 0x0 "aframe", an off-screen challenge frame) is not a captcha on the page. No backticks or dollar-brace:
 * the evidence helper is a template literal.
 */
export const CAPTCHA_PROBE_SOURCE = String.raw`function captchaProbe() {
    var kinds = [
        ["reCAPTCHA", ".g-recaptcha, iframe[src*='/recaptcha/api2/anchor'], iframe[src*='/recaptcha/enterprise/anchor'], iframe[src*='/recaptcha/api2/bframe'], iframe[src*='/recaptcha/enterprise/bframe']"],
        ["hCaptcha", ".h-captcha, iframe[src*='hcaptcha.com/captcha'], iframe[src*='newassets.hcaptcha.com']"],
        ["Turnstile", ".cf-turnstile, iframe[src*='challenges.cloudflare.com']"]
    ];
    for (var k = 0; k < kinds.length; k++) {
        var els = document.querySelectorAll(kinds[k][1]);
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            var r = el.getBoundingClientRect();
            if (r.width < 30 || r.height < 30 || r.right <= 0 || r.bottom <= 0) continue;
            if (el.checkVisibility ? !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : getComputedStyle(el).visibility === "hidden") continue;
            var form = el.closest("form");
            var name = form ? (form.getAttribute("name") || form.id || form.getAttribute("action") || "") : "";
            return { kind: kinds[k][0], w: Math.round(r.width), h: Math.round(r.height), inForm: !!form, form: String(name).slice(0, 60), path: String(location.pathname).slice(0, 200) };
        }
    }
    return null;
}`;

/** What the probe reports. */
export interface CaptchaSeen {
    kind: CaptchaKind;
    w: number;
    h: number;
    inForm: boolean;
    form?: string;
    path: string;
}

/** Frames a widget loads: such a frame counts only when its element is shown at a real size (a frame inside another page's shadow root). */
const FRAMES: ReadonlyArray<{ kind: CaptchaKind; frame: RegExp }> = [
    { kind: "reCAPTCHA", frame: /\/recaptcha\/(api2|enterprise)\/(anchor|bframe)/i },
    { kind: "hCaptcha", frame: /(^|\.)hcaptcha\.com\/captcha/i },
    { kind: "Turnstile", frame: /challenges\.cloudflare\.com\//i },
];

/** Which captcha (if any) the page shows now. Reads the page only; never clicks anything. */
export async function detectCaptcha(page: Page): Promise<CaptchaKind | undefined> {
    const seen = (await page.evaluate(`(${CAPTCHA_PROBE_SOURCE})()`).catch(() => null)) as CaptchaSeen | null;
    if (seen) return seen.kind;
    for (const f of page.frames()) {
        const hit = FRAMES.find((m) => m.frame.test(f.url().replace(/^https?:\/\//, "")));
        if (!hit) continue;
        const el = await f.frameElement().catch(() => null);
        const box = el && (await el.isVisible().catch(() => false)) ? await el.boundingBox().catch(() => null) : null;
        if (box && box.width >= 30 && box.height >= 30) return hit.kind;
    }
    return undefined;
}

/** The captcha sentence for what the probe saw: the kind, the page, and where on it (so a person can check). */
export function captchaSeenMessage(seen: CaptchaSeen): string {
    const where = seen.inForm ? `inside ${seen.form ? `the form "${seen.form}"` : "a form"}` : "on the page";
    return `${captchaMessage(seen.kind, seen.path)} Seen: a visible ${seen.kind} widget (${seen.w}×${seen.h}) ${where}.`;
}
