/**
 * The Explorer view's camera, in a real Chromium: the picture is small (at most 640 px wide, 120 KB, a JPEG), secret fields are covered IN THE PICTURE
 * (checked by looking at its pixels) and the page is exactly as it was afterwards (marker gone, value kept, inline style restored), also for a page
 * inside a frame and for a field that holds a stored secret under any name. Nothing is taken when the sink is not asked.
 *
 * Needs no platform and no fixture server (pages are set directly). Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/explorer-view-camera.test.ts
 */
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFrameSink } from "../src/engine/frames/sink.js";
import { FRAME_LIMITS, MASK_ATTR, shootPage } from "../src/engine/frames/shoot.js";

let browser: Browser;
let page: Page;
let reader: Page;

const PASSWORD = "hunter2secret-ABC";
const STORED = "StoredSecretValue-77";
const COVER = [71, 85, 105]; // #475569

const FORM = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in to Shop</title>
<style>body{margin:0;font:20px sans-serif;background:#fff;color:#000} label{display:block;margin:12px 20px 0} input{display:block;margin:4px 20px;width:360px;height:44px;font-size:22px;border:2px solid #000;background:#fff;color:#000}</style></head>
<body><h1 style="margin:20px">Sign in</h1>
<label for="e">Email</label><input id="e" name="email" type="email" value="visible.person@example.test">
<label for="p">Password</label><input id="p" name="pw" type="password" value="${PASSWORD}" style="width:360px">
<label for="n">Nickname</label><input id="n" name="nickname" type="text" value="${STORED}">
<label for="o">Code</label><input id="o" name="code" type="text" autocomplete="one-time-code" value="123456" placeholder="123456">
<iframe id="f" width="480" height="120" style="margin:20px;border:0" srcdoc="<body style='margin:0;background:#fff'><input id='fp' type='password' value='frame-secret-9' style='width:300px;height:44px;font-size:22px;border:2px solid #000'></body>"></iframe>
</body></html>`;

const TALL = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tall</title><style>body{margin:0} .a{height:800px;background:rgb(220,30,30)} .b{height:800px;background:rgb(30,30,220)}</style></head><body><div class="a"></div><div class="b"></div><div class="a"></div></body></html>`;

/** What the picture shows in a region: the mean colour and how far any pixel is from it. */
async function look(jpeg: Uint8Array, regions: Array<{ x: number; y: number; w: number; h: number }>) {
    return reader.evaluate(
        async ([b64, rs]) => {
            const img = new Image();
            img.src = `data:image/jpeg;base64,${b64}`;
            await img.decode();
            const c = document.createElement("canvas");
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            const g = c.getContext("2d")!;
            g.drawImage(img, 0, 0);
            const out = (rs as Array<{ x: number; y: number; w: number; h: number }>).map((r) => {
                const d = g.getImageData(Math.round(r.x), Math.round(r.y), Math.max(1, Math.round(r.w)), Math.max(1, Math.round(r.h))).data;
                const n = d.length / 4;
                const mean = [0, 0, 0];
                for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) mean[k]! += d[i + k]! / n;
                let spread = 0;
                for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) spread = Math.max(spread, Math.abs(d[i + k]! - mean[k]!));
                return { mean, spread };
            });
            return { w: img.naturalWidth, h: img.naturalHeight, regions: out };
        },
        [Buffer.from(jpeg).toString("base64"), regions] as [string, typeof regions],
    );
}

const near = (mean: number[], want: number[], tol = 22) => want.every((v, i) => Math.abs(mean[i]! - v) <= tol);

beforeAll(async () => {
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    reader = await (await browser.newContext()).newPage();
}, 60_000);

afterAll(async () => {
    await browser?.close();
});

describe("the Explorer view camera", () => {
    it("takes a small JPEG with the page's title and a tidy address", async () => {
        await page.setContent(FORM);
        const shot = await shootPage(page, [STORED]);
        expect(shot).not.toBeNull();
        const bytes = shot!.jpeg;
        expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xff, 0xd8, 0xff]);
        expect(bytes.byteLength).toBeLessThanOrEqual(FRAME_LIMITS.maxBytes);
        expect(shot!.title).toBe("Sign in to Shop");
        const seen = await look(bytes, [{ x: 0, y: 0, w: 4, h: 4 }]);
        expect(seen.w).toBeLessThanOrEqual(FRAME_LIMITS.maxWidth);
        expect(seen.w).toBe(640);
        expect(seen.h).toBe(400);
    }, 60_000);

    it("shows no password pixels: secret fields are covered in the picture, ordinary ones are not", async () => {
        await page.setContent(FORM);
        const boxes = await page.evaluate(() => {
            const r = (id: string) => {
                const b = document.getElementById(id)!.getBoundingClientRect();
                return { x: b.x, y: b.y, w: b.width, h: b.height };
            };
            const fb = document.getElementById("f")!.getBoundingClientRect();
            return { email: r("e"), password: r("p"), nickname: r("n"), code: r("o"), framePw: { x: fb.x, y: fb.y, w: 300, h: 44 } };
        });
        const shot = (await shootPage(page, [STORED]))!;
        const scale = 0.5;
        const inner = (b: { x: number; y: number; w: number; h: number }) => ({ x: (b.x + 6) * scale, y: (b.y + 6) * scale, w: (b.w - 12) * scale, h: (b.h - 12) * scale });
        const seen = await look(shot.jpeg, [inner(boxes.email), inner(boxes.password), inner(boxes.nickname), inner(boxes.code), inner(boxes.framePw)]);
        const [email, password, nickname, code, framePw] = seen.regions;
        // Covered: a flat block of the cover colour, no text left in it.
        for (const [name, r] of [["password", password], ["a field holding a stored secret", nickname], ["a one-time-code field", code], ["a password field inside a frame", framePw]] as const) {
            expect(near(r!.mean, COVER), `${name} is the cover colour: ${r!.mean.map(Math.round)}`).toBe(true);
            expect(r!.spread, `${name} is flat`).toBeLessThan(40);
        }
        // Not covered: an ordinary field keeps its text (dark pixels on white).
        expect(near(email!.mean, COVER, 30), "the email field is not covered").toBe(false);
        expect(email!.spread).toBeGreaterThan(120);
    }, 60_000);

    it("leaves the page as it found it: no marker, the value kept, the inline style restored, including in a frame", async () => {
        await page.setContent(FORM);
        await shootPage(page, [STORED]);
        const after = await page.evaluate(() => ({
            marked: document.querySelectorAll("[data-aitp-xmask]").length,
            pw: (document.getElementById("p") as HTMLInputElement).value,
            style: document.getElementById("p")!.getAttribute("style"),
            emailStyle: document.getElementById("e")!.getAttribute("style"),
            styles: document.querySelectorAll("style").length,
        }));
        expect(after).toEqual({ marked: 0, pw: PASSWORD, style: "width:360px", emailStyle: null, styles: 1 });
        const inner = await page.frames()[1]!.evaluate(() => ({ marked: document.querySelectorAll("[data-aitp-xmask]").length, v: (document.getElementById("fp") as HTMLInputElement).value, style: document.querySelectorAll("style").length }));
        expect(inner).toEqual({ marked: 0, v: "frame-secret-9", style: 0 });
        expect(MASK_ATTR).toBe("data-aitp-xmask");
    }, 60_000);

    it("covers a field only while the picture is taken (the marker is on the field during, gone after)", async () => {
        await page.setContent(FORM);
        const sink = createFrameSink({ wanted: () => true, accept: () => undefined }, { secrets: () => [STORED] });
        // A page that records how many fields carry the marker when it repaints.
        await page.evaluate(() => {
            (window as unknown as { __seen: number[] }).__seen = [];
            new MutationObserver(() => (window as unknown as { __seen: number[] }).__seen.push(document.querySelectorAll("[data-aitp-xmask]").length)).observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ["data-aitp-xmask"] });
        });
        await sink.capture(page, { note: "Opened /", phase: "exploring", pagesSeen: 1 });
        const seen = await page.evaluate(() => (window as unknown as { __seen: number[] }).__seen);
        const during = Math.max(...seen);
        expect(sink.captures).toBe(1);
        expect(during).toBeGreaterThanOrEqual(3);
        expect(seen[seen.length - 1]).toBe(0);
    }, 60_000);

    it("takes the part of the page that is on screen, scaled, also when the page is scrolled", async () => {
        await page.setContent(TALL);
        await page.evaluate(() => window.scrollTo(0, 800));
        const shot = (await shootPage(page))!;
        const seen = await look(shot.jpeg, [{ x: 300, y: 150, w: 40, h: 40 }]);
        expect(near(seen.regions[0]!.mean, [30, 30, 220], 40), `blue part: ${seen.regions[0]!.mean.map(Math.round)}`).toBe(true);
    }, 60_000);

    it("does not enlarge a narrow page", async () => {
        const phone = await (await browser.newContext({ viewport: { width: 390, height: 700 } })).newPage();
        await phone.setContent("<!doctype html><title>Phone</title><body style='margin:0;background:#fc0'>x</body>");
        const shot = (await shootPage(phone))!;
        const seen = await look(shot.jpeg, [{ x: 0, y: 0, w: 4, h: 4 }]);
        expect(seen.w).toBe(390);
        expect(seen.h).toBe(700);
        await phone.context().close();
    }, 60_000);

    it("takes nothing, and touches nothing, when the sink is not asked for a picture", async () => {
        await page.setContent(FORM);
        let asked = 0;
        const sink = createFrameSink({ wanted: () => (asked++, false), accept: () => undefined }, { shoot: shootPage });
        for (let i = 0; i < 3; i++) await sink.capture(page, { note: "x", phase: "exploring", pagesSeen: 0 });
        expect(sink.captures).toBe(0);
        const marked = await page.evaluate(() => document.querySelectorAll("[data-aitp-xmask]").length);
        expect(marked).toBe(0);
        expect(asked).toBe(3);
    }, 60_000);

    it("gives no picture for a closed page", async () => {
        const p = await (await browser.newContext()).newPage();
        await p.close();
        expect(await shootPage(p)).toBeNull();
    }, 30_000);
});
