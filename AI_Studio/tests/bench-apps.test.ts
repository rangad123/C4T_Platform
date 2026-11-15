/**
 * The benchmark applications (examples/bench-shop, examples/bench-rbac): they start, reset only with the token, keep to loopback, and
 * never serve anything that hints at the seeded defects (no id, no catalogue text, no switch name) even with every defect on, so the
 * test-generation engine cannot learn them from the application. Ports 9460-9469 (shared with bench-verify; files run one at a time).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright";
import { login as engineLogin } from "../src/engine/discovery/auth.js";
import { BrowserSession } from "../src/engine/discovery/browser.js";
import { afterEach, describe, expect, it } from "vitest";
import { BENCH_SERVER, startBenchApp, type BenchApp, type RunningBenchApp } from "../src/eval/bench/verify/app.js";
import { BenchClient, obj } from "../src/eval/bench/verify/http.js";

const catalogue = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../src/eval/bench/catalogue.json"), "utf8")) as {
    apps: Record<BenchApp, { accounts: Array<{ email: string; password: string }> }>;
    defects: Array<{ id: string; app: BenchApp; expected: string; actual: string }>;
};
let running: RunningBenchApp | undefined;
afterEach(async () => {
    await running?.stop();
    running = undefined;
});

/** Every same-origin page a visitor (or a signed-in account) can reach by links, plus the static files and the API description. */
async function crawl(c: BenchClient): Promise<Array<{ path: string; text: string; headers: string }>> {
    const seen = new Set<string>();
    const queue = ["/", "/app.js", "/styles.css", "/openapi.json", "/robots.txt", "/sitemap.xml", "/api/products", "/api/notes", "/api/orders", "/api/cart", "/api/profile", "/api/me"];
    const out: Array<{ path: string; text: string; headers: string }> = [];
    while (queue.length && seen.size < 200) {
        const p = queue.shift()!;
        if (seen.has(p)) continue;
        seen.add(p);
        const res = await fetch(new URL(p, c.base), { headers: c.cookie("sid") ? { cookie: `sid=${c.cookie("sid")}` } : {}, redirect: "manual" });
        const text = await res.text();
        const headers: string[] = [];
        res.headers.forEach((v, k) => headers.push(`${k}: ${v}`));
        out.push({ path: p, text, headers: headers.join("\n") });
        for (const m of text.matchAll(/href="(\/[^"#?]*)/g)) if (!seen.has(m[1]!)) queue.push(m[1]!);
        const loc = res.headers.get("location");
        if (loc?.startsWith("/") && !seen.has(loc.split("?")[0]!)) queue.push(loc.split("?")[0]!);
    }
    return out;
}

describe.each(["bench-shop", "bench-rbac"] as const)("%s", (app) => {
    it("resets only with the right token, and the reset route does not exist without one", async () => {
        running = await startBenchApp(app, 9461, "none", "tok-123");
        const base = running.base;
        expect((await fetch(`${base}/__bench/reset`, { method: "POST" })).status).toBe(403);
        expect((await fetch(`${base}/__bench/reset`, { method: "POST", headers: { "x-bench-reset": "wrong" } })).status).toBe(403);
        // Change something, reset, and it is back.
        const c = new BenchClient(base);
        if (app === "bench-shop") {
            await c.signIn("alice@example.test");
            await c.call("PUT", "/api/profile", { name: "Changed", address: "Somewhere else 1" });
            expect(obj((await c.call("GET", "/api/profile")).body).name).toBe("Changed");
            await running.reset();
            expect((await c.call("GET", "/api/profile")).status).toBe(401);
            await c.signIn("alice@example.test");
            expect(obj((await c.call("GET", "/api/profile")).body).name).toBe("Alice Moreau");
        } else {
            await c.signIn("ana@example.test");
            await c.call("POST", "/api/notes", { title: "Temporary", body: "" });
            const before = (obj((await c.call("GET", "/api/notes")).body).notes as unknown[]).length;
            await running.reset();
            await c.signIn("ana@example.test");
            expect((obj((await c.call("GET", "/api/notes")).body).notes as unknown[]).length).toBe(before - 1);
        }
        await running.stop();

        // Without BENCH_RESET_TOKEN the route answers 404, like any unknown path.
        const child = spawn(process.execPath, [BENCH_SERVER[app], "9462"], { stdio: "ignore", env: { PATH: process.env.PATH ?? "", BENCH_DEFECTS: "none" } });
        try {
            for (let i = 0; i < 80; i++) {
                const up = await new Promise<boolean>((r) => {
                    const s = net.connect(9462, "127.0.0.1", () => (s.destroy(), r(true)));
                    s.on("error", () => r(false));
                });
                if (up) break;
                await new Promise((r) => setTimeout(r, 100));
            }
            expect((await fetch("http://127.0.0.1:9462/__bench/reset", { method: "POST", headers: { "x-bench-reset": "" } })).status).toBe(404);
        } finally {
            await new Promise<void>((r) => {
                child.once("exit", () => r());
                child.kill();
            });
        }
    }, 60_000);

    it("serves nothing that names or describes a seeded defect, signed out or as any account, with every defect on", async () => {
        running = await startBenchApp(app, 9463, "all");
        const forbidden = [/\bB[SR]-\d\d\b/, /defect/i, /\bseed/i, /\bbug\b/i, /BENCH_/, /catalogue/i, /switch(ed)?\b/i];
        const phrases = catalogue.defects.filter((d) => d.app === app).flatMap((d) => [d.actual]);
        const visits: Array<{ who: string; path: string; text: string; headers: string }> = [];
        visits.push(...(await crawl(new BenchClient(running.base))).map((v) => ({ who: "visitor", ...v })));
        for (const a of catalogue.apps[app].accounts) {
            await running.reset();
            const c = new BenchClient(running.base);
            await c.signIn(a.email, a.password);
            visits.push(...(await crawl(c)).map((v) => ({ who: a.email, ...v })));
        }
        expect(visits.length).toBeGreaterThan(8);
        const hits: string[] = [];
        for (const v of visits) {
            for (const re of forbidden) if (re.test(v.text) || re.test(v.headers)) hits.push(`${v.who} ${v.path} ${re}`);
            for (const ph of phrases) if (v.text.includes(ph)) hits.push(`${v.who} ${v.path} catalogue text`);
        }
        expect(hits).toEqual([]);
    }, 90_000);

    it("listens on loopback only", async () => {
        running = await startBenchApp(app, 9464, "none");
        const src = fs.readFileSync(BENCH_SERVER[app], "utf8");
        expect(src).toMatch(/server\.listen\(PORT, "127\.0\.0\.1"\)/);
        // The server makes no outbound calls of its own (the only fetch is in the page script, back to the same origin).
        expect(src).not.toMatch(/from "node:(https|net|tls|dgram)"|http\.(request|get)\(/);
        expect([...src.matchAll(/^import .+$/gm)].map((m) => m[0])).toEqual(['import http from "node:http";', 'import { randomBytes } from "node:crypto";']);
    });
});

describe("the pages work in a real browser (what the engine drives)", () => {
    it("bench-shop: sign in, add to cart, change a quantity, check out with an address, place an order, see it in history", async () => {
        running = await startBenchApp("bench-shop", 9465, "none");
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage();
            await page.goto(`${running.base}/login`);
            await page.getByLabel("Email").fill("alice@example.test");
            await page.getByLabel("Password").fill("Password1!");
            await page.getByRole("button", { name: "Sign in" }).click();
            await page.waitForURL(`${running.base}/`);
            await page.getByRole("link", { name: "Trail Mug" }).click();
            await page.getByRole("button", { name: "Add to cart" }).click();
            await page.waitForURL(/\/cart$/);
            await page.getByLabel("Quantity").fill("4");
            await page.getByRole("button", { name: "Update" }).click();
            await page.waitForFunction(() => document.querySelector('[data-testid="subtotal"]')?.textContent === "$50.00");
            expect(await page.getByTestId("shipping").textContent()).toBe("Free");
            await page.getByLabel("Quantity").fill("11");
            await page.getByRole("button", { name: "Update" }).click();
            await expect.poll(() => page.getByRole("alert").textContent()).toBe("You can order up to 10 of each item.");
            await page.getByRole("link", { name: "Check out" }).click();
            await page.getByLabel("Delivery address").fill("7 Test Road, Leeds");
            await page.getByRole("button", { name: "Continue" }).click();
            await page.waitForURL(/\/checkout\/review$/);
            await page.getByRole("button", { name: "Place order" }).click();
            await page.waitForURL(/\/orders\/ord-1002$/);
            expect(await page.getByTestId("status").textContent()).toBe("Placed");
            await page.goto(`${running.base}/orders`);
            expect(await page.getByRole("link", { name: "ord-1002" }).count()).toBe(1);
        } finally {
            await browser.close();
        }
    }, 60_000);

    it("bench-rbac: sign in, create a note, refuse an empty title with the page's message, share it", async () => {
        running = await startBenchApp("bench-rbac", 9466, "none");
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage();
            await page.goto(`${running.base}/login`);
            await page.getByLabel("Email").fill("ana@example.test");
            await page.getByLabel("Password").fill("Password1!");
            await page.getByRole("button", { name: "Sign in" }).click();
            await page.waitForURL(/\/notes$/);
            await page.getByRole("link", { name: "New note" }).first().click();
            await page.getByRole("button", { name: "Save note" }).click();
            await expect.poll(() => page.getByRole("alert").textContent()).toBe("Give the note a title.");
            await page.getByLabel("Title").fill("Shopping list");
            await page.getByRole("button", { name: "Save note" }).click();
            await page.waitForURL(/\/notes\/n4$/);
            await page.getByLabel("Colleague's email").fill("ben@example.test");
            await page.getByRole("button", { name: "Share" }).click();
            await page.waitForFunction(() => document.body.textContent?.includes("Stop sharing with Ben Carter"));
            await page.goto(`${running.base}/admin/users`);
            expect(await page.getByRole("heading", { name: "Not allowed" }).count()).toBe(1);
        } finally {
            await browser.close();
        }
    }, 60_000);
});

describe("signing in the conventional way (what the engine's own sign-in expects)", () => {
    it.each([
        ["bench-shop", "alice@example.test", 9467],
        ["bench-rbac", "ana@example.test", 9468],
    ] as const)("%s: plain HTML form: 303 with the cookie, a wrong password gives the form back with the message; no navigation on load", async (app, email, port) => {
        running = await startBenchApp(app, port, "all");
        const ok = await fetch(`${running.base}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email, password: "Password1!", next: "/" }), redirect: "manual" });
        expect(ok.status).toBe(303);
        expect(ok.headers.get("location")).toBe("/");
        expect(ok.headers.get("set-cookie")).toMatch(/^sid=[0-9a-f]{32}; Path=\/; HttpOnly; SameSite=Lax$/);
        const bad = await fetch(`${running.base}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email, password: "wrong" }), redirect: "manual" });
        expect(bad.status).toBe(400);
        const html = await bad.text();
        expect(html).toContain('<p role="alert">Email or password is wrong.</p>');
        expect(html).toContain('type="password"');
        // The page script navigates only after a form the person sent: nothing runs location changes on load.
        const js = await (await fetch(`${running.base}/app.js`)).text();
        expect(js.trim().startsWith('document.addEventListener("submit"')).toBe(true);
        expect(js.split("\n").filter((l) => /location\./.test(l)).every((l) => /^\s*if \(|^\s*location\.reload\(\);$/.test(l))).toBe(true);
    }, 30_000);

    it.each([
        ["bench-shop", "alice@example.test", 9467, "html"],
        ["bench-rbac", "ana@example.test", 9468, "html"],
        // The --login js follow-up run: the same engine sign-in through the script-sent form.
        ["bench-shop", "alice@example.test", 9467, "js"],
        ["bench-rbac", "ana@example.test", 9468, "js"],
    ] as const)("%s: the engine's own sign-in (discovery/auth.ts) succeeds with the seeded account, and lands signed in (%s, %s, %s sign-in)", async (app, email, port, login) => {
        running = await startBenchApp(app, port, "none", "bench-reset", login);
        const browser = await chromium.launch();
        try {
            const session = await BrowserSession.launch(browser, { startUrl: `${running.base}/` });
            const r = await engineLogin(session, `${running.base}/`, { username: email, password: "Password1!" });
            expect(r).toMatchObject({ ok: true, loginPath: "/login" });
            const after = await session.page.goto(`${running.base}/${app === "bench-shop" ? "orders" : "notes"}`);
            expect(after?.url()).not.toMatch(/\/login/);
            const wrong = await BrowserSession.launch(browser, { startUrl: `${running.base}/` });
            expect((await engineLogin(wrong, `${running.base}/`, { username: email, password: "nope-nope" })).ok).toBe(false);
        } finally {
            await browser.close();
        }
    }, 60_000);

    it("BENCH_LOGIN=js keeps the script-sent sign-in as an opt-in variant (a person in a browser still gets in)", async () => {
        running = await startBenchApp("bench-shop", 9469, "none", "bench-reset", "js");
        const html = await (await fetch(`${running.base}/login`)).text();
        expect(html).toContain('<form data-api="/api/login"');
        expect((await fetch(`${running.base}/login`, { method: "POST", body: "email=a" })).status).toBe(405);
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage();
            await page.goto(`${running.base}/login`);
            await page.getByLabel("Email").fill("alice@example.test");
            await page.getByLabel("Password").fill("Password1!");
            await page.getByRole("button", { name: "Sign in" }).click();
            await page.waitForURL(`${running.base}/`);
            await page.goto(`${running.base}/orders`);
            expect(page.url()).toBe(`${running.base}/orders`);
        } finally {
            await browser.close();
        }
    }, 60_000);
});
