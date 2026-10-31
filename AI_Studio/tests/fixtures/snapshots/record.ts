/**
 * Records the accessibility snapshots the smaller-snapshot tests read (tests/snapshot-compact.test.ts), from a real Chromium on the
 * sample app (examples/sample-app) and on the catalog fixture (tests/fixtures/snapshot-catalog.ts). Rerun after a Playwright upgrade:
 *
 *   node scripts/with-lock.mjs browser -- node node_modules/tsx/dist/cli.mjs tests/fixtures/snapshots/record.ts
 *
 * Each file is exactly what `page.locator("body").ariaSnapshot()` returned (the call the authoring agent makes), nothing edited.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { startCatalog } from "../snapshot-catalog.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const SAMPLE_PORT = 7312;
const CATALOG_PORT = 7313;

async function waitFor(url: string): Promise<void> {
    for (let i = 0; i < 60; i++) {
        try {
            if ((await fetch(url)).ok) return;
        } catch {
            /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`${url} did not start`);
}

async function main(): Promise<void> {
    const app = spawn(process.execPath, [path.join(root, "examples/sample-app/server.mjs"), String(SAMPLE_PORT)], { stdio: "ignore" });
    const catalog = await startCatalog(CATALOG_PORT);
    const browser = await chromium.launch({ headless: true });
    try {
        await waitFor(`http://127.0.0.1:${SAMPLE_PORT}/`);
        const page = await browser.newPage();
        const save = async (name: string, p: Page) => {
            await p.waitForLoadState("networkidle").catch(() => undefined);
            const snap = await p.locator("body").ariaSnapshot({ timeout: 5_000 });
            fs.writeFileSync(path.join(here, `${name}.yml`), snap + "\n");
            console.log(`${name}.yml ${snap.length} characters`);
        };
        const S = `http://127.0.0.1:${SAMPLE_PORT}`;
        await page.goto(`${S}/`);
        await save("sample-home", page);
        await page.goto(`${S}/products`);
        await save("sample-products", page);
        await page.goto(`${S}/products/1`);
        await save("sample-product", page);
        await page.getByRole("button", { name: "Add to cart" }).click();
        await save("sample-product-added", page);
        await page.goto(`${S}/login`);
        await save("sample-login", page);
        await page.getByLabel("Email").fill("demo@example.com");
        await save("sample-login-filled", page);
        await page.getByLabel("Password").fill("wrong-password");
        await page.getByRole("button", { name: "Log in" }).click();
        await save("sample-login-error", page);
        await page.goto(`${S}/login`);
        await page.getByLabel("Email").fill("demo@example.com");
        await page.getByLabel("Password").fill("Password123!");
        await page.getByRole("button", { name: "Log in" }).click();
        await page.waitForURL(/account/);
        await save("sample-account", page);
        const C = `http://127.0.0.1:${CATALOG_PORT}`;
        await page.goto(`${C}/`);
        await save("catalog", page);
        await page.goto(`${C}/?added=7`);
        await save("catalog-added", page);
    } finally {
        await browser.close();
        catalog.close();
        app.kill();
    }
}

void main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
