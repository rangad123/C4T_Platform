/**
 * Failure traces without the run's secrets (src/engine/evidence/trace-scrub.ts). A trace laid out like Playwright's (action log, network
 * log, resources, attachments, screencast frames) with the password and token in every form a trace carries them: every text part is
 * masked, pictures are kept byte for byte, and a trace that cannot be cleaned (a secret in a part that is not text, an archive bigger than
 * it says, a broken zip) is refused. The same check on a trace from a real Playwright run is in tests/runner-trace-secrets.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { memoryLogger } from "../src/agent/log.js";
import { toWireRun } from "../src/agent/mapping.js";
import type { PlatformClient } from "../src/agent/client.js";
import { scrubRunTraces, scrubTraceBytes, scrubTraceFile, TRACE_LIMITS, TRACE_WITHHELD, traceSecretForms, traceSecretsOfChildEnv, traceSecretsOfRun } from "../src/engine/evidence/trace-scrub.js";
import { secretVariants } from "../src/agent-protocol/secret-variants.js";
import { readableSecrets } from "./fixtures/secret-oracle.js";

const PASSWORD = 'Tr4ce&<Pw>"x 9';
const TOKEN = "TRACE-ApiTok-5d21c8a7";
const USER = "trace@example.com";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-trace-scrub-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const env = { credentials: { username: USER, password: PASSWORD }, apiToken: TOKEN };
const forms = traceSecretForms(traceSecretsOfRun(env));
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

/** A trace laid out like Playwright's, holding the secrets the way a real one does. */
function trace(): Uint8Array {
    const action = { type: "before", callId: "call@15", class: "Frame", method: "fill", title: `Fill ${JSON.stringify(PASSWORD)}`, params: { selector: 'internal:label="Password"i', value: PASSWORD } };
    const snapshot = { type: "frame-snapshot", snapshot: { html: ["INPUT", { __playwright_value_: PASSWORD, type: "password" }] } };
    const log = { type: "log", callId: "call@15", message: `  fill(${JSON.stringify(PASSWORD)})` };
    const net = {
        type: "resource-snapshot",
        snapshot: {
            request: {
                url: `https://app.example/login?next=%2F&pw=${encodeURIComponent(PASSWORD)}`,
                headers: [
                    { name: "authorization", value: `Bearer ${TOKEN}` },
                    { name: "authorization", value: `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}` },
                ],
                postData: { mimeType: "application/x-www-form-urlencoded", params: [{ name: "password", value: PASSWORD }], _file: "resources/aa.dat" },
            },
            response: { headers: [{ name: "x-echo", value: TOKEN }] },
        },
    };
    const files = {
        "test.trace": strToU8(`${JSON.stringify({ type: "before", title: `Fill ${JSON.stringify(PASSWORD)}`, params: { value: PASSWORD } })}\n`),
        "1-trace.trace": strToU8([action, snapshot, log].map((x) => JSON.stringify(x)).join("\n")),
        "1-trace.network": strToU8(JSON.stringify(net)),
        "resources/aa.dat": strToU8(`u=${encodeURIComponent(USER)}&password=${encodeURIComponent(PASSWORD).replace(/%20/g, "+")}`),
        "resources/bb.html": strToU8(`<html><body><input value="${PASSWORD.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}"><p>${TOKEN}</p></body></html>`),
        "resources/cc.json": strToU8(JSON.stringify({ seen: `Bearer ${TOKEN}`, nested: JSON.stringify({ pw: PASSWORD }) })),
        "attachments/dd": strToU8(`# Error context\n- paragraph: ${TOKEN}\n`),
        "screencast/page@1-1.jpeg": JPEG,
        "resources/ee.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 0]),
    };
    return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [v, { level: 6 }]])));
}

const leaks = (entries: Record<string, Uint8Array>): string[] =>
    Object.entries(entries).flatMap(([name, b]) => {
        const s = Buffer.from(b).toString("latin1");
        return forms.filter((f) => s.includes(Buffer.from(f, "utf8").toString("latin1"))).map((f) => `${f} in ${name}`);
    });

describe("a failure trace leaves without the run's secrets", () => {
    it("the forms cover what a trace carries: exact, URL-encoded with + and lower-case hex, JSON-escaped once and twice, HTML-escaped, Basic base64", () => {
        expect(forms).toEqual(expect.arrayContaining([PASSWORD, encodeURIComponent(PASSWORD), encodeURIComponent(PASSWORD).replace(/%20/g, "+"), JSON.stringify(PASSWORD).slice(1, -1), JSON.stringify(JSON.stringify(PASSWORD).slice(1, -1)).slice(1, -1), "Tr4ce&amp;&lt;Pw&gt;&quot;x 9", Buffer.from(`${USER}:${PASSWORD}`).toString("base64"), TOKEN]));
        // longest first, nothing under 4 characters
        expect(forms.every((f, i) => f.length >= 4 && (i === 0 || forms[i - 1]!.length >= f.length))).toBe(true);
        expect(traceSecretForms(["abc", ""])).toEqual([]);
    });

    it("the planted trace really holds every secret (so the check below proves something)", () => {
        const before = leaks(unzipSync(trace()));
        for (const name of ["test.trace", "1-trace.trace", "1-trace.network", "resources/aa.dat", "resources/bb.html", "resources/cc.json", "attachments/dd"]) expect(before.some((l) => l.endsWith(` in ${name}`)), name).toBe(true);
    });

    it("masks every text part, keeps pictures byte for byte, keeps every name in its order", async () => {
        const original = trace();
        const r = await scrubTraceBytes(original, forms);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.masked).toBeGreaterThan(10);
        const before = unzipSync(original);
        const after = unzipSync(r.data);
        expect(Object.keys(after)).toEqual(Object.keys(before));
        expect(leaks(after)).toEqual([]);
        expect(after["screencast/page@1-1.jpeg"]).toEqual(JPEG);
        expect(after["resources/ee.png"]).toEqual(before["resources/ee.png"]);
        // still a trace: the fill is there, its value hidden, the JSON lines still parse
        const lines = Buffer.from(after["1-trace.trace"]!).toString("utf8").split("\n").map((l) => JSON.parse(l));
        expect(lines[0]).toMatchObject({ method: "fill", params: { value: "[hidden]" } });
        expect(lines[1].snapshot.html[1].__playwright_value_).toBe("[hidden]");
        expect(Buffer.from(after["resources/aa.dat"]!).toString()).toBe(`u=${encodeURIComponent(USER)}&password=[hidden]`);
        expect(JSON.parse(Buffer.from(after["1-trace.network"]!).toString()).snapshot.request.headers.map((h: { value: string }) => h.value)).toEqual(["Bearer [hidden]", "Basic [hidden]"]);
    });

    it("a trace with nothing to mask is left exactly as it was", async () => {
        const clean = zipSync({ "test.trace": strToU8('{"type":"before"}'), "a.jpeg": [JPEG, { level: 0 }] });
        const r = await scrubTraceBytes(clean, forms);
        expect(r).toMatchObject({ ok: true, masked: 0 });
        expect(r.ok && r.data).toBe(clean);
        // and with no secrets at all, nothing is read
        expect(await scrubTraceBytes(new Uint8Array([1, 2, 3]), [])).toMatchObject({ ok: true, masked: 0 });
    });

    it("refuses a trace whose secret sits in a part that is not text (a picture, UTF-16 bytes), rather than send it", async () => {
        const inPicture = zipSync({ "test.trace": strToU8("{}"), "frame.jpeg": new Uint8Array([...JPEG.slice(0, 4), ...Buffer.from(TOKEN), 0xff, 0xd9]) });
        expect(await scrubTraceBytes(inPicture, forms)).toMatchObject({ ok: false, reason: expect.stringMatching(/frame\.jpeg, which is not text/) });
        const utf16 = zipSync({ "resources/x.bin": new Uint8Array(Buffer.from(`pw=${PASSWORD}`, "utf16le")) });
        expect(await scrubTraceBytes(utf16, forms)).toMatchObject({ ok: false });
        // a picture without a secret is fine
        expect(await scrubTraceBytes(zipSync({ "frame.jpeg": JPEG }), forms)).toMatchObject({ ok: true });
    });

    it("refuses a broken zip, and an archive that says it unpacks to more than the limits, before unpacking it", async () => {
        expect(await scrubTraceBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]), forms)).toMatchObject({ ok: false, reason: "the trace could not be read" });
        // An entry that claims to be bigger than the limit (its declared size in the central directory).
        const z = Buffer.from(zipSync({ "test.trace": strToU8(`{"pw":"${TOKEN}"}`) }));
        const cd = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
        z.writeUInt32LE(TRACE_LIMITS.maxEntryBytes + 1, cd + 24);
        expect(await scrubTraceBytes(new Uint8Array(z), forms)).toMatchObject({ ok: false, reason: "the trace is too large to be cleaned" });
    });

    it("cleans a one-file HTML trace (Taqwright's) as text", async () => {
        const html = `<html><script>window.trace = ${JSON.stringify({ steps: [{ action: "type", value: PASSWORD }], har: { headers: [{ authorization: `Bearer ${TOKEN}` }] } })};</script></html>`;
        const r = await scrubTraceBytes(strToU8(html), forms);
        expect(r.ok).toBe(true);
        const text = r.ok ? Buffer.from(r.data).toString() : "";
        expect(forms.filter((f) => text.includes(f))).toEqual([]);
        expect(text).toContain('"value":"[hidden]"');
    });

    it("on disk: a file is cleaned in place; one that cannot be cleaned is dropped from its run, deleted, and the run says why", async () => {
        const good = path.join(tmp, "good-trace.zip");
        const bad = path.join(tmp, "bad-trace.zip");
        fs.writeFileSync(good, trace());
        fs.writeFileSync(bad, zipSync({ "frame.jpeg": new Uint8Array([...JPEG.slice(0, 4), ...Buffer.from(PASSWORD), 0xff, 0xd9]) }));
        const shot = path.join(tmp, "shot.png");
        fs.writeFileSync(shot, "png");
        const secrets = traceSecretsOfRun(env);
        expect(await scrubTraceFile(good, secrets)).toMatchObject({ ok: true });
        expect(leaks(unzipSync(fs.readFileSync(good)))).toEqual([]);
        expect(fs.readdirSync(tmp).filter((f) => f.includes(".clean"))).toEqual([]); // no temporary file left
        fs.writeFileSync(good, trace());
        const runs = [{ artifacts: [{ kind: "screenshot", path: shot }, { kind: "trace", path: good }] }, { artifacts: [{ kind: "trace", path: bad }], notes: ["earlier"] as string[] }];
        expect(await scrubRunTraces(runs, secrets)).toBe(1);
        expect(runs[0]!.artifacts.map((a) => a.kind)).toEqual(["screenshot", "trace"]);
        expect(runs[1]!.artifacts).toEqual([]);
        expect(runs[1]!.notes).toEqual(["earlier", expect.stringContaining(TRACE_WITHHELD)]);
        expect(fs.existsSync(bad)).toBe(false);
        expect(leaks(unzipSync(fs.readFileSync(good)))).toEqual([]);
    });

    it("knows a run's secrets: accounts, tokens, an auth header and its value, Basic forms, a saved sign-in's values; and a test process's environment", () => {
        const state = JSON.stringify({ cookies: [{ name: "sid", value: "SESSION-cookie-77aa", domain: "app.example", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }], origins: [] });
        const s = traceSecretsOfRun({ credentials: { username: "u", password: "pw-1234" }, roles: [{ username: "a", password: "role-pw-99", apiToken: "role-tok-88" }], apiAuthHeader: "X-Key: hdr-value-77", storageState: state });
        expect(s).toEqual(expect.arrayContaining(["pw-1234", "role-pw-99", "role-tok-88", "X-Key: hdr-value-77", Buffer.from("u:pw-1234").toString("base64"), "SESSION-cookie-77aa"]));
        expect(traceFormsInclude(s, "hdr-value-77")).toBe(true);
        expect(traceSecretsOfChildEnv({ TEST_PASSWORD: "p-1234", TEST_ADMIN_API_TOKEN: "t-1234", TEST_TOTP_SECRET: "JBSWY3DP", API_AUTH_HEADER: "X: y-123", BASE_URL: "https://x", TEST_USERNAME: "user-1", TEST_ROLE_PASSWORD: "" }).sort()).toEqual(["JBSWY3DP", "X: y-123", "p-1234", "t-1234"]);
    });
});

describe("the runner cleans a trace before it leaves the computer", () => {
    it("uploads the trace with the run's secrets masked, holds back one it cannot clean, and the run says so", async () => {
        const { TaskRunner } = await import("../src/agent/task-runner.js");
        const sent = new Map<string, Buffer>();
        const client = {
            upload: async (_task: string, name: string, file: string) => {
                const bytes = fs.readFileSync(file);
                sent.set(name, bytes);
                return { ref: name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
            },
        } as unknown as PlatformClient;
        const { log, lines } = memoryLogger();
        const runner = new TaskRunner({ client, cache: {} as never, log, workDir: tmp, hello: { agentId: "a", projectId: "p", protocol: 2, pollSeconds: 1, heartbeatSeconds: 1, maxFileBytes: 10_000_000, serverTime: "now" }, probe: { get: async () => ({}) } as never, env: {} });
        const good = path.join(tmp, "runner-good.zip");
        const bad = path.join(tmp, "runner-bad.zip");
        const shot = path.join(tmp, "runner-shot.png");
        fs.writeFileSync(good, trace());
        fs.writeFileSync(bad, zipSync({ "frame.jpeg": new Uint8Array([...JPEG.slice(0, 4), ...Buffer.from(TOKEN), 0xff, 0xd9]) }));
        fs.writeFileSync(shot, JPEG);
        const run = (testId: string, artifacts: Array<{ kind: "trace" | "screenshot"; path: string }>) => ({ testId, status: "failed" as const, durationMs: 1, failedStepIndex: 0, steps: [], artifacts, responses: [] });
        const runs = [run("WEB-1", [{ kind: "screenshot", path: shot }, { kind: "trace", path: good }]), run("WEB-2", [{ kind: "trace", path: bad }])];
        const uploadAll = (runner as unknown as { uploadAll: (...a: unknown[]) => Promise<{ uploaded: Map<string, string>; skipped: Map<string, string> }> }).uploadAll.bind(runner);
        const outcome = await uploadAll("task-1", runs, 10_000_000, new AbortController().signal, "task-1", new Map(), "attempt-1", traceSecretsOfRun(env));
        expect([...sent.keys()].sort()).toEqual(["WEB-1-screenshot.png", "WEB-1-trace.zip"]);
        expect(leaks(unzipSync(new Uint8Array(sent.get("WEB-1-trace.zip")!)))).toEqual([]);
        expect(outcome.skipped.get(bad)).toMatch(/^The trace was not sent because it could not be cleaned of the run's passwords and tokens: a secret is in frame\.jpeg/);
        expect(fs.existsSync(bad)).toBe(false);
        expect(toWireRun(runs[1]!, outcome).notes).toEqual([expect.stringContaining("could not be cleaned of the run's passwords and tokens")]);
        expect(lines.join("\n")).not.toContain(TOKEN);
    });

    it("announces the cleaned trace's size, not the size it had before cleaning (a wrong content-length fails every upload)", async () => {
        const { TaskRunner } = await import("../src/agent/task-runner.js");
        const announced = new Map<string, { said: number; real: number }>();
        const client = {
            upload: async (_task: string, name: string, file: string, size: number) => {
                const bytes = fs.readFileSync(file);
                announced.set(name, { said: size, real: bytes.length });
                // What fetch does with a body whose length differs from its content-length header.
                if (size !== bytes.length) throw new Error("Request body length does not match content-length header");
                return { ref: name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
            },
        } as unknown as PlatformClient;
        const { log } = memoryLogger();
        const runner = new TaskRunner({ client, cache: {} as never, log, workDir: tmp, hello: { agentId: "a", projectId: "p", protocol: 2, pollSeconds: 1, heartbeatSeconds: 1, maxFileBytes: 10_000_000, serverTime: "now" }, probe: { get: async () => ({}) } as never, env: {} });
        const file = path.join(tmp, "runner-size.zip");
        const original = trace();
        fs.writeFileSync(file, original);
        const runs = [{ testId: "WEB-3", status: "failed" as const, durationMs: 1, failedStepIndex: 0, steps: [], artifacts: [{ kind: "trace" as const, path: file }], responses: [] }];
        const uploadAll = (runner as unknown as { uploadAll: (...a: unknown[]) => Promise<{ uploaded: Map<string, string>; skipped: Map<string, string> }> }).uploadAll.bind(runner);
        const outcome = await uploadAll("task-2", runs, 10_000_000, new AbortController().signal, "task-2", new Map(), "attempt-1", traceSecretsOfRun(env));
        const a = announced.get("WEB-3-trace.zip")!;
        expect(a.real).not.toBe(original.length); // cleaning changed the file's length
        expect(a.said).toBe(a.real);
        expect(outcome.uploaded.get(file)).toBe("WEB-3-trace.zip");
    });
});

describe("round 40 review: what the cleaner missed or got wrong", () => {
    const zipOf = (files: Record<string, Uint8Array>, level: 0 | 6 = 6): Uint8Array => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [v, { level }]])));
    /** Patch the declared unpacked size of the only entry, in the central directory and the local header. */
    const declare = (z: Uint8Array, size: number): Uint8Array => {
        const b = Buffer.from(z);
        b.writeUInt32LE(size, b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
        b.writeUInt32LE(size, 22);
        return new Uint8Array(b);
    };

    it("a form-encoded password (an HTML form's body, URLSearchParams: ! ' ( ) ~ escaped, + for a space) is masked, also with lower-case hex and RFC 3986 escapes", async () => {
        const pw = "Pa!ss~(x)'9 z";
        const body = new URLSearchParams({ email: USER, password: pw }).toString();
        expect(body).toContain("Pa%21ss%7E%28x%29%279+z"); // what a browser sends
        const strict = encodeURIComponent(pw).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
        const files = { "resources/a.dat": strToU8(body), "resources/b.dat": strToU8(body.replace(/%[0-9A-F]{2}/g, (x) => x.toLowerCase())), "resources/c.json": strToU8(JSON.stringify({ q: `pw=${strict}` })) };
        const before = readableSecrets(files, [pw]);
        expect(before).toHaveLength(3); // the oracle (not the cleaner's list) sees the password in each part
        const r = await scrubTraceBytes(zipOf(files), traceSecretForms([pw]));
        expect(r.ok).toBe(true);
        const after = unzipSync(r.ok ? r.data : new Uint8Array());
        expect(readableSecrets(after, [pw])).toEqual([]);
        expect(Buffer.from(after["resources/a.dat"]!).toString()).toBe(`email=${encodeURIComponent(USER)}&password=[hidden]`);
        // the shared list also serves the platform's and the runner's log masking
        expect(secretVariants(pw)).toEqual(expect.arrayContaining(["Pa%21ss%7E%28x%29%279+z", "Pa%21ss%7e%28x%29%279+z", strict]));
    });

    it("a secret inside \"[hidden]\" (such as hidden) is masked, not a reason to refuse the trace", async () => {
        const files = { "1-trace.trace": strToU8(`${JSON.stringify({ method: "fill", params: { value: "hidden" } })}\n${JSON.stringify({ title: "Fill hidden field" })}`), "resources/a.dat": strToU8("password=hidden") };
        const r = await scrubTraceBytes(zipOf(files), traceSecretForms(["hidden"]));
        expect(r).toMatchObject({ ok: true, masked: 3 });
        const after = unzipSync(r.ok ? r.data : new Uint8Array());
        expect(Buffer.from(after["resources/a.dat"]!).toString()).toBe("password=[hidden]");
        expect(JSON.parse(Buffer.from(after["1-trace.trace"]!).toString().split("\n")[0]!).params.value).toBe("[hidden]");
    });

    it("a secret made of digits keeps the trace's JSON valid: masked with 9s (8s when it is all 9s), so a number stays a number", async () => {
        const pin = "73519284";
        const lines = [{ type: "before", wallTime: 1731735192840123, method: "fill", params: { value: pin } }, { type: "after", endTime: 99991, result: { value: 9999 } }];
        const files = { "1-trace.trace": strToU8(lines.map((l) => JSON.stringify(l)).join("\n")) };
        const r = await scrubTraceBytes(zipOf(files), traceSecretForms([pin, "9999"]));
        expect(r.ok).toBe(true);
        const after = Buffer.from(unzipSync(r.ok ? r.data : new Uint8Array())["1-trace.trace"]!).toString().split("\n").map((l) => JSON.parse(l));
        expect(after[0]).toMatchObject({ wallTime: 1731999999990123, params: { value: "99999999" } });
        expect(after[1]).toMatchObject({ endTime: 88881, result: { value: 8888 } });
        expect(JSON.stringify(after)).not.toContain(pin);
    });

    it("an entry that unpacks to more (or less) than it declares, or with the wrong checksum, refuses the trace instead of hiding what is past the declared size", async () => {
        const text = strToU8(`${"A".repeat(2_000_000)}{"token":"${TOKEN}"}`);
        expect(await scrubTraceBytes(declare(zipOf({ "resources/big.txt": text }), 1000), forms)).toMatchObject({ ok: false, reason: "the trace could not be read" });
        expect(await scrubTraceBytes(declare(zipOf({ "resources/big.txt": text }), 600_000), forms)).toMatchObject({ ok: false, reason: "the trace could not be read" });
        expect(await scrubTraceBytes(declare(zipOf({ "resources/s.txt": strToU8("short") }), 50), forms)).toMatchObject({ ok: false, reason: "the trace could not be read" });
        expect(await scrubTraceBytes(declare(zipOf({ "resources/s.txt": strToU8(`pw ${TOKEN} and more`) }, 0), 5), forms)).toMatchObject({ ok: false, reason: "the trace could not be read" });
        const crc = Buffer.from(zipOf({ "resources/s.txt": strToU8("plain words") }));
        crc.writeUInt32LE(0x12345678, crc.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 16);
        expect(await scrubTraceBytes(new Uint8Array(crc), forms)).toMatchObject({ ok: false, reason: "the trace could not be read" });
        // the same archives, honest, are cleaned
        expect(await scrubTraceBytes(zipOf({ "resources/big.txt": text }), forms)).toMatchObject({ ok: true, masked: 1 });
    });

    it("stored parts, folders and pictures come back byte for byte around a masked part; the archive opens with another zip reader", async () => {
        const files = { "resources/": new Uint8Array(), "resources/pw.txt": strToU8(`pw=${PASSWORD}`), "frame.jpeg": JPEG, "resources/plain.css": strToU8("body{}") };
        const r = await scrubTraceBytes(zipOf(files, 0), forms);
        expect(r).toMatchObject({ ok: true, masked: 1 });
        const after = unzipSync(r.ok ? r.data : new Uint8Array());
        expect(Object.keys(after)).toEqual(Object.keys(files));
        expect(after["frame.jpeg"]).toEqual(JPEG);
        expect(Buffer.from(after["resources/plain.css"]!).toString()).toBe("body{}");
        expect(Buffer.from(after["resources/pw.txt"]!).toString()).toBe("pw=[hidden]");
    });

    it("cleaning a large trace does not hold up the process: the event loop keeps answering while it runs", async () => {
        // About 48 MB of text in three parts with the password and token throughout (a long test's snapshots and network bodies), and pictures.
        const chunk = (i: number) => strToU8(Array.from({ length: 160_000 }, (_, k) => `{"i":${i},"k":${k},"v":"${k % 997 === 0 ? PASSWORD : "lorem ipsum dolor sit amet, consectetur adipiscing"}","h":"Bearer ${k % 1999 === 0 ? TOKEN : "x"}"}`).join("\n").padEnd(16 * 1024 * 1024, " "));
        const big = zipSync({ "0-trace.trace": [chunk(0), { level: 1 }], "0-trace.network": [chunk(1), { level: 1 }], "resources/big.json": [chunk(2), { level: 1 }], "frame.jpeg": [JPEG, { level: 0 }] });
        let last = performance.now();
        let worst = 0;
        const tick = setInterval(() => {
            const now = performance.now();
            worst = Math.max(worst, now - last);
            last = now;
        }, 5);
        const started = performance.now();
        try {
            const r = await scrubTraceBytes(big, forms);
            worst = Math.max(worst, performance.now() - last); // the stretch since the last tick counts too (all of it, for work that never yields)
            expect(r.ok).toBe(true);
            expect(r.ok && r.masked).toBeGreaterThan(400);
        } finally {
            clearInterval(tick);
        }
        console.log(`trace-scrub: ${(big.length / 1048576).toFixed(1)} MB zip, 48 MB text: ${Math.round(performance.now() - started)} ms in all, longest pause of the event loop ${Math.round(worst)} ms`);
        expect(worst).toBeLessThan(400);
    }, 60_000);

    const sha1 = (b: Uint8Array): string => createHash("sha1").update(b).digest("hex");
    /** A trace named the way Playwright names it: resources after the sha1 of their content, logs that point at them, screencast frames. */
    const namedTrace = (bodies: Record<string, string>, extra: Record<string, Uint8Array> = {}) => {
        const res = Object.fromEntries(Object.entries(bodies).map(([k, v]) => [k, { bytes: strToU8(v), hex: sha1(strToU8(v)) }]));
        const frame = "page@5580a69f61eaee2215bafcf76ebf9c11-1794178221840.jpeg";
        const network = Object.values(res).map((r, i) => JSON.stringify({ type: "resource-snapshot", snapshot: { request: { postData: { _file: `resources/${r.hex}.dat`, _sha1: `${r.hex}.dat` } }, response: { content: { _sha1: `${r.hex}.dat` } }, n: i } })).join("\n");
        const actions = JSON.stringify({ type: "screencast-frame", sha1: frame, file: `screencast/${frame}` });
        const files: Record<string, Uint8Array> = { "trace.trace": strToU8(actions), "trace.network": strToU8(network), [`screencast/${frame}`]: JPEG, ...extra };
        for (const r of Object.values(res)) files[`resources/${r.hex}.dat`] = r.bytes;
        return { res, frame, zip: zipOf(files) };
    };
    /** Every resource reference in the logs names a part that is in the archive. */
    const danglingRefs = (parts: Record<string, Uint8Array>): string[] => {
        const text = ["trace.trace", "trace.network"].map((n) => Buffer.from(parts[n]!).toString()).join("\n");
        const refs = [...text.matchAll(/"(?:_file|file)":"([^"]+)"/g)].map((m) => m[1]!).concat([...text.matchAll(/"_?sha1":"([^"]+)"/g)].map((m) => (m[1]!.startsWith("page@") ? `screencast/${m[1]}` : `resources/${m[1]}`)));
        return refs.filter((r) => !(r in parts));
    };

    it("a masked resource is renamed to the sha1 of its cleaned content, and every reference follows: no name or text keeps the original's sha1", async () => {
        const pw = "Pa!ss~(x)'9 z";
        const { res, zip } = namedTrace({ form: `user=bob&password=${new URLSearchParams({ p: pw }).toString().slice(2)}`, json: JSON.stringify({ password: pw }), plain: "no secret here" });
        const r = await scrubTraceBytes(zip, traceSecretForms([pw]));
        expect(r.ok).toBe(true);
        const after = unzipSync(r.ok ? r.data : new Uint8Array());
        const everything = Object.entries(after).map(([name, b]) => `${name}\n${Buffer.from(b).toString("latin1")}`).join("\n");
        // the two masked parts: their original sha1 (a one-hash check of a guessed password) is nowhere; the unchanged part keeps its name
        for (const k of ["form", "json"]) expect(everything).not.toContain(res[k]!.hex);
        expect(after[`resources/${res.plain!.hex}.dat`]).toBeDefined();
        for (const [name, b] of Object.entries(after)) if (name.startsWith("resources/")) expect(name).toBe(`resources/${sha1(b)}.dat`);
        expect(danglingRefs(after)).toEqual([]);
        expect(Object.keys(after)).toHaveLength(Object.keys(unzipSync(zip)).length);
        expect(readableSecrets(after, [pw])).toEqual([]);
    });

    it("two bodies that differed only by a secret become one part, and both references point at it", async () => {
        const { zip } = namedTrace({ a: "password=first-Secret-1", b: "password=second-Secret-2" });
        const r = await scrubTraceBytes(zip, traceSecretForms(["first-Secret-1", "second-Secret-2"]));
        const after = unzipSync(r.ok ? r.data : new Uint8Array());
        expect(Object.keys(after).filter((n) => n.startsWith("resources/"))).toEqual([`resources/${sha1(strToU8("password=[hidden]"))}.dat`]);
        expect(danglingRefs(after)).toEqual([]);
    });

    it("a short secret that happens to match inside a sha1 or a frame's name leaves the reference intact (and is still masked elsewhere)", async () => {
        const { res, frame, zip } = namedTrace({ masked: "token=abc-Tok-1234 in the body", kept: "nothing secret" });
        const inHash = res.kept!.hex.slice(10, 16); // six characters from the middle of a part's sha1
        const pin = "4178221"; // digits inside the frame's time
        expect(frame).toContain(pin);
        const r = await scrubTraceBytes(zip, traceSecretForms(["abc-Tok-1234", inHash, pin]));
        expect(r.ok).toBe(true);
        const after = unzipSync(r.ok ? r.data : new Uint8Array());
        expect(danglingRefs(after)).toEqual([]);
        expect(Buffer.from(after["trace.trace"]!).toString()).toContain(`screencast/${frame}`);
        expect(after[`resources/${res.kept!.hex}.dat`]).toBeDefined();
        const masked = Object.entries(after).find(([n]) => n.startsWith("resources/") && n !== `resources/${res.kept!.hex}.dat`)!;
        expect(Buffer.from(masked[1]).toString()).toBe("token=[hidden] in the body");
    });

    it("environment variables named like a secret are masked like a password; plain settings are not", () => {
        const s = traceSecretsOfRun({ vars: { DB_PASSWORD: "var-pw-1234", API_KEY: "var-key-5678", stripe_token: "var-tok-9012", REGION: "eu-west-1", LOCALE: "en-GB" } });
        expect(s.sort()).toEqual(["var-key-5678", "var-pw-1234", "var-tok-9012"]);
        expect(traceSecretsOfChildEnv({ TEST_ENV_API_KEY: "var-key-5678", TEST_ENV_REGION: "eu-west-1", TEST_ENV_DB_PASSWORD: "var-pw-1234" }).sort()).toEqual(["var-key-5678", "var-pw-1234"]);
    });
});

const traceFormsInclude = (secrets: string[], v: string): boolean => traceSecretForms(secrets).includes(v);
