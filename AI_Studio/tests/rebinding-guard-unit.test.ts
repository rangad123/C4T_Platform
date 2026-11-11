/**
 * The test-data reset request, the cleanup DELETEs and an API description download connect only to the address that was checked
 * (round 47): a name that resolves to a public address when checked and to this computer when connecting (DNS rebinding) reaches
 * nothing. A redirect is still answered with today's words. A local stand-in server on port 8881; no other address is called.
 */
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { deleteRecord } from "../src/engine/cleanup/run.js";
import { guardedFetch } from "../src/platform/guarded-fetch.js";
import { assertAllowedTarget } from "../src/platform/net-guard.js";
import { resolve } from "../src/platform/routes/contracts.js";
import { sendResetRequest, type ResetHookSecret } from "../src/platform/test-data-reset-store.js";

const PORT = 8881;
const hits: string[] = [];
let redirect = false;
let server: http.Server;
const base = `http://rebind.example:${PORT}`;
const hook: ResetHookSecret = { environment: "", enabled: true, method: "POST", url: "/test/reset", headerNames: [], headers: {}, expectedStatus: 200, last: null, updatedAt: "" };

beforeAll(async () => {
    server = http.createServer((req, res) => {
        hits.push(`${req.method} ${req.url}`);
        if (redirect) return res.writeHead(302, { location: "http://127.0.0.1:1/x" }).end();
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ openapi: "3.0.0", paths: {} }));
    });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", () => r()));
    // Checked: a public address. Connected: this computer.
    vi.spyOn(dnsPromises, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    vi.spyOn(dns, "lookup").mockImplementation(((_h: string, _o: unknown, cb: (e: null, a: dns.LookupAddress[]) => void) => cb(null, [{ address: "127.0.0.1", family: 4 }])) as never);
});

afterEach(() => {
    delete process.env.BLOCK_PRIVATE_TARGETS;
    hits.length = 0;
    redirect = false;
});

afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise((r) => server.close(r));
});

describe("a name that resolves privately only on connect", () => {
    it("reaches nothing with BLOCK_PRIVATE_TARGETS on", async () => {
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        await expect(assertAllowedTarget(`${base}/x`)).resolves.toBeUndefined(); // the check alone is fooled
        expect(await sendResetRequest(hook, base)).toMatchObject({ ok: false, message: expect.stringMatching(/could not be sent/) });
        expect(await deleteRecord({ apiBaseUrl: base, deletePath: "/api/items/1", headers: {}, guard: assertAllowedTarget, fetch: guardedFetch })).toMatchObject({ status: "failed", reason: expect.stringMatching(/Could not reach the application/) });
        await expect(resolve(`${base}/openapi.json`, "old")).rejects.toThrow("Could not download the old description.");
        expect(hits).toEqual([]);
    });

    it("still answers a redirect in today's words (guard off, so the stand-in is reached)", async () => {
        redirect = true;
        expect((await sendResetRequest(hook, base)).message).toBe("POST /test/reset answered 302 (a redirect is not followed); 200 was expected.");
        expect((await deleteRecord({ apiBaseUrl: base, deletePath: "/api/items/1", headers: {}, guard: assertAllowedTarget, fetch: guardedFetch })).reason).toBe("The application answered with a redirect (HTTP 302); redirects are not followed.");
        await expect(resolve(`${base}/openapi.json`, "old")).rejects.toThrow("Could not download the old description (HTTP 302).");
        redirect = false;
        expect(await resolve(`${base}/openapi.json`, "new")).toMatchObject({ openapi: "3.0.0" });
        expect(hits).toHaveLength(4);
    });
});
