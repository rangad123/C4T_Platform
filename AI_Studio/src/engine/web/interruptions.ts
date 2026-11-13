/**
 * What gets in a test's way and how it is answered, the same way in the exploring and authoring sessions (../discovery/browser.ts),
 * the live interpreter and the rendered script (../generators/playwright.ts):
 *   - cookie / consent banners and the overlays the project's notes name ("close the newsletter popup") are closed by
 *     `page.addLocatorHandler` before each action (consent: "Reject" / "Necessary only" first);
 *   - alert / confirm / prompt dialogs are answered by an armed `dialog` step, else dismissed (never accepted while exploring);
 *   - a download step clicks, waits for the file and checks its name and that it is not empty;
 *   - upload steps may use a generated small file (`generated-sample.<ext>`) instead of one of the project's files.
 */
import type { Download, Locator, Page } from "playwright";
import type { SiteNote } from "../memory/notes.js";

// ── consent banners and named overlays ─────────────────────────────────

/** Consent buttons that refuse (preferred) or accept. Only phrases that mean consent: a plain "Decline" or "Accept" may be the app's own button. */
export const CONSENT_REJECT = ["Reject all", "Reject all cookies", "Reject cookies", "Reject optional cookies", "Decline all", "Decline cookies", "Deny all", "Necessary only", "Only necessary", "Necessary cookies only", "Only necessary cookies", "Use necessary cookies only", "Accept only necessary", "Accept necessary cookies", "Allow necessary cookies only"];
export const CONSENT_ACCEPT = ["Accept all", "Accept all cookies", "Accept cookies", "Allow all", "Allow all cookies", "Allow cookies", "Got it"];
/** The buttons of common consent tools (OneTrust, Cookiebot, Didomi, Usercentrics, Osano / cookieconsent, Google Funding Choices). */
export const CMP_REJECT = ["#onetrust-reject-all-handler", "#CybotCookiebotDialogBodyButtonDecline", "#didomi-notice-disagree-button", '[data-testid="uc-deny-all-button"]', ".cc-deny", ".fc-cta-do-not-consent"];
export const CMP_ACCEPT = ["#onetrust-accept-btn-handler", "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", "#didomi-notice-agree-button", '[data-testid="uc-accept-all-button"]', ".cc-allow", ".cc-dismiss", ".fc-cta-consent"];
/** What an overlay named in a note is, on the page. */
const OVERLAY_BOXES = '[role="dialog"], dialog, [aria-modal="true"], [class*="modal" i], [id*="modal" i], [class*="popup" i], [id*="popup" i], [class*="overlay" i]';
const CLOSE_NAMES = ["Close", "No thanks", "No, thanks", "Not now", "Maybe later", "Dismiss", "Skip", "×", "✕", "X"];

/** An overlay a note asks to close: text it contains, and the button that closes it when the note quotes one. */
export interface OverlayRule {
    phrase: string;
    button?: string;
}

/** "close the newsletter popup", "dismiss the chat widget with 'Not now'": the overlays the notes name (at most 5). */
export function overlayRules(notes: readonly SiteNote[] | undefined): OverlayRule[] {
    const out: OverlayRule[] = [];
    for (const n of notes ?? []) {
        const m = /\b(?:close|dismiss|hide|skip)\s+(?:the\s+|any\s+|a\s+)?(.{2,40}?)\s*(?:popup|pop-up|modal|banner|overlay|dialog|widget|window)s?\b/i.exec(n.text);
        if (!m) continue;
        const phrase = m[1]!.replace(/["“”'‘’]/g, "").trim();
        if (phrase.length < 2) continue;
        const quoted = /["“']([^"”']{1,40})["”']/.exec(n.text.slice(m.index + m[0].length))?.[1]?.trim();
        out.push({ phrase, ...(quoted ? { button: quoted } : {}) });
    }
    return out.slice(0, 5);
}

const esc = (s: string) => s.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
const anyOf = (list: readonly string[]) => new RegExp(`^\\s*(?:${list.map(esc).join("|")})\\s*$`, "i");
const clickable = (scope: Page | Locator, name: RegExp | string) => scope.getByRole("button", { name }).or(scope.getByRole("link", { name }));

/** Consent banners and the notes' overlays are closed before each action on this page. */
export async function installOverlayHandlers(page: Page, rules: readonly OverlayRule[] = []): Promise<void> {
    const reject = clickable(page, anyOf(CONSENT_REJECT)).or(page.locator(CMP_REJECT.join(", ")));
    const accept = clickable(page, anyOf(CONSENT_ACCEPT)).or(page.locator(CMP_ACCEPT.join(", ")));
    await page
        .addLocatorHandler(reject.or(accept).filter({ visible: true }).first(), async () => {
            const refuse = reject.filter({ visible: true }).first();
            await ((await refuse.count()) ? refuse : accept.filter({ visible: true }).first()).click({ timeout: 2_000 }).catch(() => undefined);
        }, { noWaitAfter: true })
        .catch(() => undefined);
    for (const rule of rules) {
        const box = page.locator(OVERLAY_BOXES).filter({ hasText: new RegExp(esc(rule.phrase), "i"), visible: true }).first();
        const close = rule.button ? clickable(box, rule.button) : clickable(box, anyOf(CLOSE_NAMES)).or(box.locator('[aria-label*="close" i], [aria-label*="dismiss" i]'));
        await page.addLocatorHandler(box, async () => void (await close.first().click({ timeout: 2_000 }).catch(() => undefined)), { noWaitAfter: true }).catch(() => undefined);
    }
}

/** The same handlers in a rendered script (kept in step with installOverlayHandlers; tests/finish-flows.test.ts runs both). */
export function overlayHelperSource(rules: readonly OverlayRule[]): string {
    return String.raw`/** Cookie / consent banners (declined where the banner allows it) and the overlays the project's notes name are closed before each action. */
const CONSENT_DECLINE: string[] = ${JSON.stringify(CONSENT_REJECT)};
const CONSENT_AGREE: string[] = ${JSON.stringify(CONSENT_ACCEPT)};
const CMP_DECLINE: string[] = ${JSON.stringify(CMP_REJECT)};
const CMP_AGREE: string[] = ${JSON.stringify(CMP_ACCEPT)};
const OVERLAY_RULES: Array<{ phrase: string; button?: string }> = ${JSON.stringify(rules)};
async function installOverlayHandlers(page: import("@playwright/test").Page): Promise<void> {
    const esc = (s: string) => s.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
    const anyOf = (list: string[]) => new RegExp("^\\s*(?:" + list.map(esc).join("|") + ")\\s*$", "i");
    const clickable = (scope: import("@playwright/test").Page | import("@playwright/test").Locator, name: RegExp | string) => scope.getByRole("button", { name }).or(scope.getByRole("link", { name }));
    // Written for Playwright 1.42 (the oldest the scripts run on): visibility by the "visible=true" selector, and no handler options.
    const shown = (l: import("@playwright/test").Locator) => l.locator("visible=true").first();
    const decline = clickable(page, anyOf(CONSENT_DECLINE)).or(page.locator(CMP_DECLINE.join(", ")));
    const agree = clickable(page, anyOf(CONSENT_AGREE)).or(page.locator(CMP_AGREE.join(", ")));
    await page.addLocatorHandler(shown(decline.or(agree)), async () => {
        const no = shown(decline);
        await ((await no.count()) ? no : shown(agree)).click({ timeout: 2_000 }).catch(() => undefined);
    });
    for (const rule of OVERLAY_RULES) {
        const box = shown(page.locator(${JSON.stringify(OVERLAY_BOXES)}).filter({ hasText: new RegExp(esc(rule.phrase), "i") }));
        const close = rule.button ? clickable(box, rule.button) : clickable(box, anyOf(${JSON.stringify(CLOSE_NAMES)})).or(box.locator('[aria-label*="close" i], [aria-label*="dismiss" i]'));
        await page.addLocatorHandler(box, async () => void (await close.first().click({ timeout: 2_000 }).catch(() => undefined)));
    }
}
`;
}

// ── dialogs ────────────────────────────────────────────────────────────

export type DialogStep = { response: "accept" | "dismiss"; promptText?: string; message?: string };

/** The dialog check after the step that should open it: an error message, or undefined when the dialog appeared and says what it should. */
export function dialogProblem(message: string | undefined, expected: string | undefined): string | undefined {
    if (message === undefined) return "No dialog appeared. The step before this one prepares an answer for a dialog this step should open.";
    if (expected && !message.toLowerCase().includes(expected.toLowerCase())) return `The dialog said "${message}", not "${expected}"`;
    return undefined;
}

export const DIALOG_HELPER_SOURCE = String.raw`/** A dialog step: the next alert, confirm or prompt on this page is answered this way; the message is checked after the step that opens it. */
function armDialog(page: import("@playwright/test").Page, response: "accept" | "dismiss", promptText?: string): Promise<string> {
    return new Promise((resolve) => page.once("dialog", (dialog) => {
        resolve(dialog.message());
        void (response === "accept" ? dialog.accept(promptText) : dialog.dismiss()).catch(() => undefined);
    }));
}
async function dialogShown(shown: Promise<string> | undefined, expected: string): Promise<void> {
    if (!shown) return;
    const message = await Promise.race([shown, new Promise<undefined>((r) => setTimeout(() => r(undefined), 10_000))]);
    if (message === undefined) throw new Error("No dialog appeared. The step before this one prepares an answer for a dialog this step should open.");
    if (expected && !message.toLowerCase().includes(expected.toLowerCase())) throw new Error("The dialog said \"" + message + "\", not \"" + expected + "\"");
}
`;

// ── downloads ──────────────────────────────────────────────────────────

/** A finished download: undefined when it is fine, else what is wrong (the name does not match, or the file is empty). */
export async function downloadProblem(download: Download, expected: string | undefined): Promise<string | undefined> {
    const name = download.suggestedFilename();
    if (expected && !name.toLowerCase().includes(expected.toLowerCase())) return `The download is named "${name}", not like "${expected}"`;
    for await (const chunk of await download.createReadStream()) if ((chunk as Buffer).length) return undefined;
    return `The download "${name}" is empty`;
}

export const DOWNLOAD_HELPER_SOURCE = String.raw`/** A download step: click, wait for the file, check its name and that it is not empty. */
async function downloadChecked(page: import("@playwright/test").Page, target: import("@playwright/test").Locator, expected: string): Promise<void> {
    const started = page.waitForEvent("download");
    await target.click();
    const download = await started;
    const name = download.suggestedFilename();
    if (expected && !name.toLowerCase().includes(expected.toLowerCase())) throw new Error("The download is named \"" + name + "\", not like \"" + expected + "\"");
    for await (const chunk of await download.createReadStream()) if (chunk.length) return;
    throw new Error("The download \"" + name + "\" is empty");
}
`;

// ── generated upload files ─────────────────────────────────────────────

/** Small valid files of common types, made by the platform: an upload never takes a person's own files. */
const SAMPLES: Record<string, { mimeType: string; base64: string }> = {
    png: { mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
    jpg: { mimeType: "image/jpeg", base64: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJ+AD//Z" },
    gif: { mimeType: "image/gif", base64: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" },
    pdf: { mimeType: "application/pdf", base64: Buffer.from("%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 72 72]/Parent 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n").toString("base64") },
    txt: { mimeType: "text/plain", base64: Buffer.from("Sample file made for a test.\n").toString("base64") },
    csv: { mimeType: "text/csv", base64: Buffer.from("name,value\nsample,1\n").toString("base64") },
    json: { mimeType: "application/json", base64: Buffer.from('{"sample":true}\n').toString("base64") },
};
export const SAMPLE_TYPES = Object.keys(SAMPLES) as Array<keyof typeof SAMPLES>;
const SAMPLE_NAME = /^generated-sample\.([a-z]+)$/;
export const sampleName = (type: string): string => `generated-sample.${type}`;
export const isGeneratedSample = (name: string): boolean => SAMPLE_NAME.test(name) && SAMPLE_NAME.exec(name)![1]! in SAMPLES;

/** The generated file of this name (undefined for any other name). */
export function generatedSample(name: string): { name: string; mimeType: string; buffer: Buffer } | undefined {
    const ext = SAMPLE_NAME.exec(name)?.[1];
    const s = ext ? SAMPLES[ext] : undefined;
    return s ? { name, mimeType: s.mimeType, buffer: Buffer.from(s.base64, "base64") } : undefined;
}

/** The sample type a file field's `accept` attribute asks for ("image/*,.pdf" → png); plain text when it accepts anything. */
export function sampleTypeFor(accept: string | null | undefined): string {
    for (const raw of (accept ?? "").toLowerCase().split(",")) {
        const t = raw.trim();
        if (!t) continue;
        if (t === "image/png" || t === ".png" || t === "image/*") return "png";
        if (t === "image/jpeg" || t === ".jpg" || t === ".jpeg") return "jpg";
        if (t === "image/gif" || t === ".gif") return "gif";
        if (t === "application/pdf" || t === ".pdf") return "pdf";
        if (t === "text/csv" || t === ".csv") return "csv";
        if (t === "application/json" || t === ".json") return "json";
        if (t === "text/plain" || t === ".txt" || t === "text/*") return "txt";
    }
    return "txt";
}

/** The generated files as a script carries them (only when a test uploads one). */
export const SAMPLES_SOURCE = `const GENERATED_SAMPLES: Record<string, { mimeType: string; base64: string }> = ${JSON.stringify(SAMPLES)};\n`;
