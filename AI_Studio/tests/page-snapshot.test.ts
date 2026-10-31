/** Reading one page's links, forms and controls (src/engine/discovery/snapshot.ts) in a real browser. */
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { captureSnapshot, SNAPSHOT_LIMITS } from "../src/engine/discovery/snapshot.js";

let browser: Browser;
beforeAll(async () => {
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
});

async function snapshotOf(html: string) {
    const page = await browser.newPage();
    try {
        await page.setContent(html);
        return await captureSnapshot(page);
    } finally {
        await page.close();
    }
}

describe("page snapshot", () => {
    it("reads forms by their attributes, with labels however they are attached", async () => {
        const snap = await snapshotOf(`<title>Sign in</title>
<form id="login" action="/session?next=%2F" method="POST">
  <label for="email">Email
    address</label><input id="email" name="email" type="email" required>
  <label>Password <input name="password" type="password"></label>
  <input name="action" type="hidden" value="x">
  <input name="id" aria-label="Customer number">
  <textarea name="note" placeholder="Anything else?"></textarea>
  <select name="plan"><option>Free</option></select>
  <button>Sign in</button>
</form>`);
        expect(snap.title).toBe("Sign in");
        expect(snap.forms).toHaveLength(1);
        const form = snap.forms[0]!;
        // A field named "id" or "action" must not stand in for the form's own id or action.
        expect(form.id).toBe("login");
        expect(form.method).toBe("post");
        expect(form.action).toMatch(/\/session\?next=%2F$/); // as written: a page from setContent has no address to resolve against
        expect(form.fields.map((f) => [f.type, f.name, f.label, f.required])).toEqual([
            ["email", "email", "Email address", true],
            ["password", "password", "Password", false],
            ["text", "id", "Customer number", false],
            ["textarea", "note", "Anything else?", false],
            ["select", "plan", undefined, false],
        ]);
        expect(form.fields[3]!.placeholder).toBe("Anything else?");
    });

    it("keeps named links and distinct controls, within the limits", async () => {
        const many = Array.from({ length: SNAPSHOT_LIMITS.links + 5 }, (_, i) => `<a href="/p/${i}">Page ${i}</a>`).join("");
        const snap = await snapshotOf(`<nav><a href="javascript:void 0">Menu</a><a href="/x"></a><button aria-label="Close">x</button><button>Close</button>
<div role="tab">  Details
  tab </div></nav>${many}`);
        expect(snap.links).toHaveLength(SNAPSHOT_LIMITS.links);
        expect(snap.links[0]).toEqual({ text: "Page 0", href: expect.stringMatching(/\/p\/0$/) });
        expect(snap.links.some((l) => l.text === "Menu")).toBe(false);
        const controls = snap.interactiveElements;
        expect(controls.length).toBeLessThanOrEqual(SNAPSHOT_LIMITS.controls);
        expect(controls.filter((c) => c.name === "Close")).toHaveLength(1);
        expect(controls.find((c) => c.name === "Details tab")).toEqual({ role: "tab", name: "Details tab", tagName: "div" });
        expect(controls.find((c) => c.name === "Page 0")).toEqual({ role: "a", name: "Page 0", tagName: "a" });
    });

    it("returns an empty reading instead of failing on a page it cannot read", async () => {
        const page = await browser.newPage();
        await page.close();
        const snap = await captureSnapshot(page);
        expect(snap).toMatchObject({ title: "", text: "", links: [], forms: [], interactiveElements: [] });
    });
});
