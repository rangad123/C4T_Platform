/**
 * The cover over secret fields in the pictures a finding and the Explorer view keep (frames/shoot.ts; CP3 N-6), checked on the pixels of
 * the JPEG itself: a password shown with a "show password" toggle (type=text, named only by its label), a PIN field and an API token
 * field (named only by name or id), and a one-time code inside a shadow root are all under the cover; an ordinary field beside them is
 * not. A real browser on a page set with setContent (no server, no AI).
 * Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/shot-secret-cover.test.ts
 */
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { MASK_ATTR, shootPage } from "../src/engine/frames/shoot.js";

type Box = { x: number; y: number; w: number; h: number };
const box = (i: number): Box => ({ x: 40, y: 60 + i * 110, w: 520, h: 80 });
const STYLE = (b: Box) => `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;font-size:56px;color:#000;background:#fff;border:0;box-sizing:border-box;margin:0;padding:0`;
const labelAt = (b: Box) => `position:absolute;left:${b.x + b.w + 20}px;top:${b.y}px`;

/** Each case: the field's own markup (it takes `style`), placed at box(i). */
const CASES: Array<{ name: string; html: (style: string, b: Box) => string; secret: boolean }> = [
    { name: "a revealed password named only by its label", secret: true, html: (s, b) => `<label for="rev" style="${labelAt(b)}">Password</label><input id="rev" type="text" value="Hunt3r!pw22" style="${s}">` },
    { name: "a password whose label wraps it", secret: true, html: (s, b) => `<label><span style="${labelAt(b)}">Choose a passphrase</span><input type="text" value="horse-battery-9" style="${s}"></label>` },
    { name: "a PIN named only by its name", secret: true, html: (s) => `<input name="pin" type="text" value="4821" style="${s}">` },
    { name: "a PIN in a longer name", secret: true, html: (s) => `<input name="card_pin" type="tel" value="9930" style="${s}">` },
    { name: "an API token named only by its name", secret: true, html: (s) => `<input name="api_token" type="text" value="tok-fake-12345" style="${s}">` },
    { name: "an API key named only by its id", secret: true, html: (s) => `<input id="apiKey" type="text" value="key-fake-778" style="${s}">` },
    { name: "an ordinary field", secret: false, html: (s, b) => `<label for="note" style="${labelAt(b)}">Note</label><input id="note" type="text" value="WWWWWWWWWW" style="${s}">` },
];
const SHADOW = CASES.length;
const PAGE = `<!doctype html><html lang="en"><head><title>Secrets</title></head><body style="margin:0;background:#fff;width:1280px;height:1100px">
${CASES.map((c, i) => c.html(STYLE(box(i)), box(i))).join("\n")}
<div id="host"></div>
<script>
const r = document.getElementById("host").attachShadow({ mode: "open" });
r.innerHTML = '<input name="otp" type="text" value="551177" style="${STYLE(box(SHADOW))}">';
</script></body></html>`;

let browser: Browser;
beforeAll(async () => {
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
});

/** The mean colour of a region of a JPEG and how far any pixel is from it, read in a browser page. */
async function look(jpeg: Uint8Array, r: Box) {
    const page = await browser.newPage();
    try {
        return await page.evaluate(
            async ([data, b]) => {
                const img = new Image();
                img.src = `data:image/jpeg;base64,${data}`;
                await img.decode();
                const c = document.createElement("canvas");
                c.width = img.naturalWidth;
                c.height = img.naturalHeight;
                const g = c.getContext("2d")!;
                g.drawImage(img, 0, 0);
                const d = g.getImageData(Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)).data;
                const n = d.length / 4;
                const mean = [0, 0, 0];
                for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) mean[k]! += d[i + k]! / n;
                let spread = 0;
                for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) spread = Math.max(spread, Math.abs(d[i + k]! - mean[k]!));
                return { width: img.naturalWidth, mean, spread };
            },
            [Buffer.from(jpeg).toString("base64"), r] as [string, Box],
        );
    } finally {
        await page.close();
    }
}

/** The cover drawn over a secret field (#475569), within JPEG noise. */
const covered = (m: { mean: number[]; spread: number }) => Math.abs(m.mean[0]! - 71) <= 25 && Math.abs(m.mean[1]! - 85) <= 25 && Math.abs(m.mean[2]! - 105) <= 25 && m.spread < 40;
const inner = (b: Box, scale: number): Box => ({ x: (b.x + 8) * scale, y: (b.y + 8) * scale, w: (b.w - 16) * scale, h: (b.h - 16) * scale });

async function shot(): Promise<{ page: Page; jpeg: Uint8Array; scale: number }> {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
    await page.setContent(PAGE);
    const s = await shootPage(page);
    expect(s).not.toBeNull();
    const { width } = await look(s!.jpeg, { x: 0, y: 0, w: 1, h: 1 });
    return { page, jpeg: s!.jpeg, scale: width / 1280 };
}

describe("a picture covers every secret field (CP3 N-6)", () => {
    it.each(CASES.map((c, i) => [c.name, i, c.secret] as const))("%s", async (_name, i, secret) => {
        const { page, jpeg, scale } = await shot();
        try {
            expect(covered(await look(jpeg, inner(box(i), scale)))).toBe(secret);
        } finally {
            await page.close();
        }
    }, 60_000);

    it("a one-time code inside a shadow root", async () => {
        const { page, jpeg, scale } = await shot();
        try {
            expect(covered(await look(jpeg, inner(box(SHADOW), scale)))).toBe(true);
            // The cover is off again afterwards, in the shadow root too: the page is as it was.
            const left = await page.evaluate((attr) => {
                const host = document.getElementById("host")!.shadowRoot!;
                return document.querySelectorAll(`[${attr}]`).length + host.querySelectorAll(`[${attr}]`).length + Array.from(host.querySelectorAll("input")).filter((e) => e.getAttribute("style")!.includes("transparent")).length;
            }, MASK_ATTR);
            expect(left).toBe(0);
        } finally {
            await page.close();
        }
    }, 60_000);
});
