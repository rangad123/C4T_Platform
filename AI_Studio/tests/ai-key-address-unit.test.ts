/**
 * An AI key saved with an address (platform/ai-config.ts) sends its calls, and its key, to that address whatever the provider: an Anthropic
 * key with the address of an Anthropic-compatible gateway goes to the gateway, never to Anthropic itself. A key without an address keeps the
 * provider's own host. Against a local stand-in that answers like the Anthropic Messages API; the name lookup is watched, and answers
 * "not found" for every name, so nothing leaves this machine.
 */
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import type { Sql } from "../src/platform/sql.js";
import { clientOfConfiguration } from "../src/platform/ai-config.js";
import type { AiConfiguration } from "../src/platform/ai-config-store.js";

const KEY = "GATEWAY-key-sentinel-4321";
let server: http.Server;
let address = "";
let dir = "";
/** What the stand-in received: path and the key header. */
let hits: Array<{ path: string; key: string }> = [];
/** Every name the guarded fetch looked up. */
let looked: string[] = [];

beforeAll(async () => {
    server = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            hits.push({ path: req.url ?? "", key: String(req.headers["x-api-key"] ?? "") });
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "stand-in", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } }));
        });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    address = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-keyaddr-"));
    const real = dns.lookup;
    vi.spyOn(dns, "lookup").mockImplementation(((host: string, opts: unknown, cb: (e: NodeJS.ErrnoException | null, a: unknown) => void) => {
        looked.push(host);
        if (host === "127.0.0.1" || host === "localhost") return (real as any)(host, opts, cb);
        process.nextTick(() => cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }), []));
    }) as never);
});
afterEach(() => {
    hits = [];
    looked = [];
});
afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
});

const configuration = (baseUrl: string | null): AiConfiguration => ({
    id: "k1",
    kind: "personal",
    ownerPersonId: "p1",
    label: "Gateway",
    provider: "anthropic",
    model: "claude-stand-in",
    fastModel: null,
    baseUrl,
    keyHint: "4321",
    status: "working",
    statusNote: null,
    lastValidatedAt: null,
    createdAt: "",
    updatedAt: "",
});
const clientFor = (baseUrl: string | null) => {
    const config = loadConfig({ DATA_DIR: dir, SECRET_KEY: "key-address-test-secret-0123456789", LLM_RETRY_ATTEMPTS: "1", LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: "http://127.0.0.1:1/server-own" });
    const c = configuration(baseUrl);
    return clientOfConfiguration({ sql: {} as Sql, config }, { billing: { owner: "personal", personId: "p1" }, source: "configuration", configuration: c, key: KEY });
};

describe("an AI key's address", () => {
    it("an Anthropic key with an address calls that address with its key, and never Anthropic's own host", async () => {
        const answer = await clientFor(address).text({ system: "s", prompt: "Reply OK.", maxOutputTokens: 8, purpose: "other" });
        expect(answer).toContain("OK");
        expect(hits).toEqual([{ path: "/v1/messages", key: KEY }]);
        expect(looked).not.toContain("api.anthropic.com");
    });

    it("an Anthropic key without an address keeps Anthropic's own host, and never the server's own address", async () => {
        await expect(clientFor(null).text({ system: "s", prompt: "Reply OK.", maxOutputTokens: 8, purpose: "other" })).rejects.toThrow();
        expect(looked).toContain("api.anthropic.com");
        expect(hits).toEqual([]);
    });
});
