/**
 * Run by tests/page-scripts-under-tsx.test.ts through tsx, the way the platform (`npm start`) and the runner's task process load the
 * engine. tsx keeps function names, so a helper declared inside a function that runs in the page is wrapped in a `__name(...)` call the
 * page does not have. This prints, as one JSON line, whether each page-side script still works when loaded that way.
 */
import { launchChromium } from "../../src/engine/discovery/browser.js";
import { coverSecretFields, MASK_ATTR, shootPage } from "../../src/engine/frames/shoot.js";
import { runtimeData } from "../../src/engine/web/interpreter.js";
import { targetIdentity } from "../../src/engine/web/author.js";

const browser = await launchChromium();
const out: Record<string, unknown> = {};
try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><title>Probe</title><main><form action="/order" method="post"><label for="pw">Password</label><input id="pw" type="text" value="Hunt3r!pw22"><button>Order</button></form></main>`);
    try {
        const release = await coverSecretFields(page, []);
        out.covered = await page.evaluate((attr) => document.querySelectorAll(`[${attr}]`).length, MASK_ATTR);
        await release();
        out.cover = "ok";
    } catch (e) {
        out.cover = String(e).split("\n")[0];
    }
    const shot = await shootPage(page, []);
    out.picture = shot !== null;
    out.identity = (await targetIdentity(page, { by: "role", role: "button", value: "Order" } as never, runtimeData({}))) ?? null;
} finally {
    await browser.close();
}
console.log(`PROBE ${JSON.stringify(out)}`);
