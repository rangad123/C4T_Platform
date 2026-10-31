/**
 * Every address a test opens or calls is checked when the step runs (engine/spec/run-address.ts): a {{placeholder}} cannot turn a step into a
 * file: address or one on this server's own network after the save checks passed. Also the save-time rule for placeholders, the generated
 * scripts carrying the check, and the platform's own steps (the AI writing a test) going through it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { checkScript } from "../src/engine/custom/guard.js";
import { renderScript } from "../src/engine/generators/index.js";
import { loadRunAddressRuntime, placeholderCanMoveAddress, RUN_ADDRESS_HELPER_SOURCE, RUN_ADDRESS_RULE } from "../src/engine/spec/run-address.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { executeStep, runtimeData } from "../src/engine/web/interpreter.js";
import { isPrivateHost } from "../src/platform/net-guard.js";

const BASE = "https://app.example/";
const BLOCK = process.env.BLOCK_PRIVATE_TARGETS;
afterEach(() => {
    if (BLOCK === undefined) delete process.env.BLOCK_PRIVATE_TARGETS;
    else process.env.BLOCK_PRIVATE_TARGETS = BLOCK;
});
const names: Record<string, string[]> = { "app.example": ["93.184.216.34"], "inside.example": ["10.1.2.3"], "meta.example": ["169.254.169.254"] };
const rt = loadRunAddressRuntime(async (host) => (names[host] ?? []).map((address) => ({ address })));

describe("the check made when a step runs", () => {
    it("refuses anything but http(s), also when a placeholder value built it (f{{p}} with ile:///etc/x)", async () => {
        process.env.BLOCK_PRIVATE_TARGETS = "false";
        for (const bad of ["f" + "ile:///etc/x", "file:///var/www/c4t/api/.env", "javascript:alert(1)", "data:text/html,x", "chrome://settings"]) {
            await expect(rt.allowedAddress(bad, BASE)).rejects.toThrow(RUN_ADDRESS_RULE);
        }
        expect(await rt.allowedAddress("/cart?x=1", BASE)).toBe("https://app.example/cart?x=1");
        expect(await rt.allowedAddress("http://127.0.0.1:4000/", BASE)).toBe("http://127.0.0.1:4000/");
    });

    it("with BLOCK_PRIVATE_TARGETS refuses loopback, private ranges and 169.254.169.254, by address or by name, and allows the application's own site", async () => {
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        for (const bad of ["http://127.0.0.1:4000/", "http://localhost/", "//169.254.169.254/latest/meta-data/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://10.0.0.8/", "http://192.168.1.1/", "http://inside.example/", "http://meta.example/", "http://0x7f.1/"]) {
            await expect(rt.allowedAddress(bad, BASE), bad).rejects.toThrow(/private or loopback/);
        }
        expect(await rt.allowedAddress("https://app.example/x", BASE)).toBe("https://app.example/x");
        // the application's own site passes even when it is on a private address (a test of an app on this network was allowed when it was set)
        expect(await rt.allowedAddress("/x", "http://127.0.0.1:7300/")).toBe("http://127.0.0.1:7300/x");
    });

    it("judges hosts as platform/net-guard.ts does", () => {
        for (const h of ["localhost", "a.localhost", "db.internal", "127.0.0.1", "10.2.3.4", "172.16.0.1", "172.32.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "8.8.8.8", "::1", "::", "fd00::1", "fe80::1", "::ffff:7f00:1", "::ffff:8.8.8.8", "2606:4700::1111", "app.example"]) {
            expect(rt.privateAddress(h), h).toBe(isPrivateHost(h));
        }
    });
});

describe("the rule when a test is saved", () => {
    it("refuses a placeholder that could change the scheme or the host, and allows one in the path or query", () => {
        for (const moves of ["f{{p}}", "{{base}}/x", "/{{p}}", "\\{{p}}", "https://{{p}}.example/", "https://app.example{{p}}", "ht{{p}}tp://x/", "http:{{p}}"]) expect(placeholderCanMoveAddress(moves), moves).toBe(true);
        for (const stays of ["/users/{{id}}", "/search?q={{q}}", "https://app.example/{{p}}", "https://app.example?x={{p}}", "users/{{id}}", "#{{p}}", "/plain"]) expect(placeholderCanMoveAddress(stays), stays).toBe(false);
    });
});

describe("generated scripts", () => {
    const web = TestSpecSchema.parse({ testId: "WEB-001", title: "open", kind: "web", category: "c", testData: { p: "ile:///etc/x" }, steps: [{ action: "navigate", url: "f{{p}}" }] });
    const api = TestSpecSchema.parse({ testId: "API-001", title: "get", kind: "api", category: "c", steps: [{ action: "request", method: "GET", path: "{{where}}/x", auth: "none" }] });

    it("check every navigation and request when it runs, and still pass the guard for hand-written scripts", () => {
        const w = renderScript(web, "playwright", { baseUrl: BASE }).content;
        expect(w).toContain("await page.goto(await allowedAddress(");
        expect(w).toContain(RUN_ADDRESS_HELPER_SOURCE);
        const a = renderScript(api, "playwright-api", { baseUrl: BASE }).content;
        expect(a).toContain("const target = await allowedAddress(path, API_BASE_URL);");
        // a taken-over script runs as it is
        for (const s of [w, a]) expect(checkScript(s, { kind: "test" }).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    });
});

describe("steps the platform runs itself (the AI writing a test)", () => {
    it("are checked before the browser goes anywhere", async () => {
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        const went: string[] = [];
        const page = { goto: async (u: string) => void went.push(u) } as never;
        const nav = (url: string) => executeStep(page, { action: "navigate", url, description: "" } as never, runtimeData({ p: "ile:///etc/hosts" } as never), BASE);
        await expect(nav("f{{p}}")).rejects.toThrow(RUN_ADDRESS_RULE);
        await expect(nav("http://169.254.169.254/latest/")).rejects.toThrow(RUN_ADDRESS_RULE);
        await nav("/cart");
        expect(went).toEqual(["https://app.example/cart"]);
    });
});

describe("saving a test through the API", () => {
    it("refuses f{{env.P}} and h{{env.Q}} while private targets are blocked (the audit's save)", async () => {
        const fs = await import("node:fs");
        const os = await import("node:os");
        const path = await import("node:path");
        const { loadConfig } = await import("../src/config.js");
        const { bootstrap } = await import("../src/platform/bootstrap.js");
        const { buildServer } = await import("../src/platform/server.js");
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-addr-"));
        const app = await buildServer(bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", API_KEY: "addr-key-0123456789", SECRET_KEY: "addr-secret-key-0123456789" })));
        await app.ready();
        try {
            const h = { "x-api-key": "addr-key-0123456789" };
            const proj = (await app.inject({ method: "POST", url: "/api/projects", headers: h, payload: { name: "p" } })).json();
            const spec = (id: string, url: string) => ({ testId: id, title: "open it", kind: "web", category: "c", steps: [{ action: "navigate", url }], source: { origin: "manual" } });
            for (const url of ["f{{env.P}}", "h{{env.Q}}", "/{{env.P}}"]) {
                const r = await app.inject({ method: "POST", url: `/api/projects/${proj.id}/specs`, headers: h, payload: { specs: [spec("WEB-001", url)], validate: false, baseUrl: "https://app.example" } });
                expect(r.statusCode, url).toBe(400);
                expect(r.json().error).toMatch(/placeholder must come after the host/);
            }
            const ok = await app.inject({ method: "POST", url: `/api/projects/${proj.id}/specs`, headers: h, payload: { specs: [spec("WEB-002", "/users/{{env.P}}")], validate: false, baseUrl: "https://app.example" } });
            expect(ok.statusCode).toBeLessThan(300);
        } finally {
            await app.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
