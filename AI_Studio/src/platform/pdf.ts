import { chromium } from "playwright";
import { HttpError } from "./http-error.js";
import { allowServerBrowser } from "./runner-only.js";

/** A browser takes hundreds of megabytes, and this server is shared: two PDFs at a time, in the whole process. */
export const PDF_BROWSERS_MAX = 2;
export const PDF_BUSY = "Other PDFs are being made right now. Try again in a moment.";

let running = 0;

/** Runs `work` while fewer than PDF_BROWSERS_MAX are running; otherwise refuses at once (429) rather than start another browser. */
export async function withPdfSlot<T>(work: () => Promise<T>): Promise<T> {
    if (running >= PDF_BROWSERS_MAX) throw new HttpError(429, PDF_BUSY);
    running++;
    try {
        return await work();
    } finally {
        running--;
    }
}

/** HTML → PDF with the platform's own Chromium (A4, backgrounds on). The page is static: scripts are disabled. */
export function toPdf(html: string, headless: boolean): Promise<Buffer> {
    return withPdfSlot(async () => {
        // The one browser a runners-only server opens (runner-only.ts): the platform's own static page, scripts off, no one's address.
        const browser = await allowServerBrowser(() => chromium.launch({ headless }));
        try {
            const context = await browser.newContext({ javaScriptEnabled: false });
            const page = await context.newPage();
            await page.setContent(html, { waitUntil: "load" });
            return Buffer.from(await page.pdf({ format: "A4", printBackground: true, margin: { top: "16mm", bottom: "16mm", left: "14mm", right: "14mm" } }));
        } finally {
            await browser.close().catch(() => undefined);
        }
    });
}
