/**
 * The screenshot a `looksRight` step sends to the AI reviewer (src/engine/vision/capture.ts) leaves out the test tool's own captions:
 * Playwright's screencast overlays (the test-title box a recorded video shows) are drawn into the page, and a reviewer judged one as the
 * application's own box covering the navigation. Real Chromium, no model.
 */
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { VISION_HELPER_SOURCE } from "../src/engine/vision/capture.js";

type Capture = (page: Page, info: unknown, index: number, expected: string, scope: unknown) => Promise<void>;
const visionCapture = new Function(`${VISION_HELPER_SOURCE}\nreturn visionCapture;`)() as Capture;

let browser: Browser;
beforeAll(async () => {
    browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
    await browser?.close();
});

/** Dark pixels in the top band of an image (where the caption sits), decoded by the page itself. */
const darkPixels = (page: Page, image: Buffer, type: string) =>
    page.evaluate(
        async ({ b64, type }) => {
            const img = new Image();
            img.src = `data:${type};base64,${b64}`;
            await img.decode();
            const c = document.createElement("canvas");
            c.width = img.width;
            c.height = img.height;
            const x = c.getContext("2d")!;
            x.drawImage(img, 0, 0);
            const d = x.getImageData(0, 0, c.width, 120).data;
            let n = 0;
            for (let i = 0; i < d.length; i += 4) if (d[i]! < 128 && d[i + 1]! < 128 && d[i + 2]! < 128) n++;
            return n;
        },
        { b64: image.toString("base64"), type },
    );

it("hides the tool's overlay for the reviewer's screenshot only, and shows it again after", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
    await page.setContent(`<body style="margin:0;background:#fff"><nav style="padding:8px;color:#fff">Home</nav></body>`);
    await page.screencast.showOverlay(`<div style="position:fixed;left:0;top:0;padding:16px;background:#333;color:#fff;font:16px monospace">WEB-107.spec.ts › Cart looks right</div>`);
    expect(await darkPixels(page, await page.screenshot({ type: "png" }), "image/png")).toBeGreaterThan(1000);

    const attached: Array<{ name: string; body: Buffer | string }> = [];
    const info = { attach: async (name: string, o: { body: Buffer | string }) => void attached.push({ name, body: o.body }), annotations: [] as unknown[] };
    await visionCapture(page, info, 1, "the cart looks right", undefined);

    const shot = attached.find((a) => a.name === "vision-shot-1")!;
    expect(shot).toBeDefined();
    expect(await darkPixels(page, shot.body as Buffer, "image/jpeg")).toBe(0);
    // The caption is back for the rest of the test (a recorded video keeps it).
    expect(await darkPixels(page, await page.screenshot({ type: "png" }), "image/png")).toBeGreaterThan(1000);
    await page.close();
}, 60_000);
